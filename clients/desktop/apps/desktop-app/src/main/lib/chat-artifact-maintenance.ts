import type { Dir } from 'node:fs';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import {
  artifactIdsOf,
  storedArtifactLocations,
  type StoredArtifactFamily,
} from './chat-artifact-references';
import type { ChatTranscriptWrite } from './chat-storage-transactions';
import type { ChatStorageTransactions } from './chat-storage-transactions';
import type { TranscriptDescriptor } from './chat-transcript-log';

interface ReferenceScan {
  offset: number;
  committedComplete: boolean;
  activeOffset: number;
  activeIdentity?: string;
  activeHeaderFinalizing?: boolean;
  activeFinalizingRows: number;
  identity: string;
  committedIdentity?: string;
  filter: CountingArtifactReferenceFilter;
}

interface ArtifactCandidate {
  family: StoredArtifactFamily;
  artifactId: string;
}

interface ArtifactState {
  inFlight: number;
  idleWaiters: Set<() => void>;
  owners: Set<symbol>;
  closing: boolean;
  closePromise?: Promise<void>;
  reserved: boolean;
  candidates: Map<string, ArtifactCandidate>;
  filter?: CountingArtifactReferenceFilter;
  identity?: string;
  scan?: ReferenceScan;
  directory?: Dir;
  directoryFamilyIndex: number;
  closeError?: unknown;
  closeWarningEmitted?: boolean;
  discoveryComplete: boolean;
}

export interface ArtifactMaintenanceProgress {
  complete: boolean;
  scannedBytes: number;
  removed: number;
}

const states = new Map<string, ArtifactState>();
const capacityListeners = new Set<() => void>();
let admissions = 0;
const MAX_STATES = 8;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const FILTER_BYTES = MAX_REFERENCE_BYTES / MAX_STATES;
const MAX_CANDIDATES = 256;
const DIRECTORY_ENTRIES_PER_SLICE = 64;
const UNLINKS_PER_SLICE = 16;
/** Delay before waking more waiters when woken ones left slots unused. */
const CAPACITY_RECHECK_MS = 50;
let capacityRecheck: ReturnType<typeof setTimeout> | undefined;
/** Woken waiters not yet matched by a slot being taken. */
let promisedWakes = 0;

const ARTIFACT_LOCATIONS = storedArtifactLocations();

export class ArtifactMaintenanceCapacityError extends Error {
  public override readonly name = 'ArtifactMaintenanceCapacityError';
}

function aggregateFailure(errors: unknown[], message: string): Error {
  return Object.assign(new Error(message), { name: 'AggregateError', errors });
}

/** Saturation is sticky: collisions may retain orphans, never hide live refs. */
export class CountingArtifactReferenceFilter {
  private readonly counters = new Uint8Array(FILTER_BYTES);
  public readonly chargedBytes = FILTER_BYTES;

  private positions(artifactId: string): number[] {
    if (!/^sha256-v1-[a-f0-9]{64}$/.test(artifactId))
      throw new Error('Invalid canonical artifact reference');
    const digest = artifactId.slice('sha256-v1-'.length);
    return Array.from(
      { length: 4 },
      (_, index) =>
        Number.parseInt(digest.slice(index * 8, index * 8 + 8), 16) %
        this.counters.length,
    );
  }

  public add(artifactId: string): void {
    for (const index of this.positions(artifactId))
      if (this.counters[index] < 255) this.counters[index] += 1;
  }

  public remove(artifactId: string): void {
    for (const index of this.positions(artifactId)) {
      if (this.counters[index] === 0)
        throw new Error('Artifact reference hint underflow');
      if (this.counters[index] < 255) this.counters[index] -= 1;
    }
  }

  public maybeHas(artifactId: string): boolean {
    return this.positions(artifactId).every(
      (index) => this.counters[index] > 0,
    );
  }
}

async function visitReferences(
  messages: readonly PersistedChatMessage[],
  visit: (artifactId: string, family: StoredArtifactFamily) => void,
): Promise<void> {
  let blocks = 0;
  for (const message of messages)
    for (const block of message.blocks) {
      for (const { family } of ARTIFACT_LOCATIONS)
        for (const artifactId of artifactIdsOf(block, family))
          visit(artifactId, family);
      if (++blocks % 256 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

async function updateReferences(
  filter: CountingArtifactReferenceFilter,
  messages: readonly PersistedChatMessage[],
  operation: 'add' | 'remove',
): Promise<void> {
  await visitReferences(messages, (id) => filter[operation](id));
}

async function addArtifactIds(
  filter: CountingArtifactReferenceFilter,
  ids: readonly string[],
): Promise<void> {
  for (let index = 0; index < ids.length; index++) {
    filter.add(ids[index]);
    if ((index + 1) % 256 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function closeDirectory(state: ArtifactState): Promise<void> {
  const directory = state.directory;
  if (directory)
    try {
      await directory.close();
    } catch (error) {
      state.closeError = error;
      throw error;
    }
  state.directory = undefined;
  state.closeError = undefined;
  state.closeWarningEmitted = false;
}

function availableCapacity(): number {
  let evictable = 0;
  for (const state of Array.from(states.values()))
    if (state.inFlight === 0 && !state.reserved && !state.closing)
      evictable += 1;
  return Math.max(0, MAX_STATES - states.size - admissions) + evictable;
}

/**
 * Wakes waiting maintainers first come, first served, at most one per free
 * or evictable slot. Waking every waiter whenever a slot frees (every scope
 * of a busy desktop) makes all but one fail and wait again. A woken waiter
 * starts its work later, so its slot stays promised until a slot is taken.
 * A woken waiter that leaves its slot unused must not strand the rest, so a
 * later check releases unused promises and wakes more while capacity remains.
 */
function notifyCapacity(): void {
  let available = availableCapacity() - promisedWakes;
  for (const listener of Array.from(capacityListeners)) {
    if (available <= 0) break;
    available -= 1;
    promisedWakes += 1;
    capacityListeners.delete(listener);
    try {
      listener();
    } catch {
      // A derived wake-up cannot change a durable storage result.
    }
  }
  if (promisedWakes > 0 && capacityListeners.size > 0 && !capacityRecheck) {
    capacityRecheck = setTimeout(() => {
      capacityRecheck = undefined;
      promisedWakes = 0;
      notifyCapacity();
    }, CAPACITY_RECHECK_MS);
    capacityRecheck.unref();
  }
}

function evictableState(
  exclude: ReadonlySet<string> = new Set(),
): [string, ArtifactState] | undefined {
  return Array.from(states).find(
    ([key, state]) =>
      !exclude.has(key) &&
      state.inFlight === 0 &&
      !state.reserved &&
      !state.closing,
  );
}

function waitForIdle(state: ArtifactState): Promise<void> {
  if (state.inFlight === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    state.idleWaiters.add(resolve);
  });
}

function hasCapacity(): boolean {
  return states.size + admissions < MAX_STATES || !!evictableState();
}

/** Derived reachability only. The repository supplies the scope lease. */
export class ChatArtifactMaintenance {
  private readonly owner = Symbol('artifact-maintenance-owner');
  /**
   * Chats this owner last left with no obsolete output, keyed to the
   * reference identity they had then. The shared slots hold eight chats, so
   * a desktop with more evicts finished ones; without this record an evicted
   * chat looks unknown again and its whole transcript is rescanned on the
   * next request. An unchanged identity means no row changed, so no
   * reference can have become obsolete. Skipping work can only retain an
   * orphan, never remove a referenced output.
   */
  private readonly clean = new Map<string, string>();
  public constructor(
    private readonly storage: ChatStorageTransactions,
    private readonly root: string,
  ) {}

  private key(chatId: string): string {
    return `${this.root}/${chatId}`;
  }

  private async state(
    chatId: string,
    pin = false,
  ): Promise<ArtifactState | undefined> {
    const key = this.key(chatId);
    let state = states.get(key);
    if (state) {
      if (state.closing) return undefined;
      state.owners.add(this.owner);
      if (pin) state.inFlight += 1;
      states.delete(key);
      states.set(key, state);
      return state;
    }
    const failedClosures: unknown[] = [];
    const attempted = new Set<string>();
    while (states.size + admissions >= MAX_STATES) {
      const evictable = evictableState(attempted);
      if (!evictable) {
        if (failedClosures.length)
          throw aggregateFailure(
            failedClosures,
            'Artifact maintenance could not close an idle directory',
          );
        return undefined;
      }
      states.delete(evictable[0]);
      evictable[1].filter = undefined;
      evictable[1].identity = undefined;
      evictable[1].scan = undefined;
      evictable[1].candidates.clear();
      evictable[1].discoveryComplete = false;
      admissions += 1;
      try {
        await closeDirectory(evictable[1]);
        evictable[1].directoryFamilyIndex = 0;
      } catch (error) {
        states.set(evictable[0], evictable[1]);
        attempted.add(evictable[0]);
        failedClosures.push(error);
        evictable[1].closeError = error;
        if (!evictable[1].closeWarningEmitted) {
          evictable[1].closeWarningEmitted = true;
          process.emitWarning(
            'Artifact maintenance directory close failed; handle retained for retry',
            { code: 'CHAT_ARTIFACT_MAINTENANCE_CLOSE' },
          );
        }
      } finally {
        admissions -= 1;
      }
    }
    state = {
      inFlight: pin ? 1 : 0,
      idleWaiters: new Set(),
      owners: new Set([this.owner]),
      closing: false,
      reserved: false,
      candidates: new Map(),
      directoryFamilyIndex: 0,
      discoveryComplete: false,
    };
    states.set(key, state);
    if (promisedWakes > 0) promisedWakes -= 1;
    return state;
  }

  private release(state: ArtifactState): void {
    state.inFlight -= 1;
    if (state.inFlight === 0) {
      for (const resolve of Array.from(state.idleWaiters)) resolve();
      state.idleWaiters.clear();
    }
    notifyCapacity();
  }

  public onCapacityAvailable(listener: () => void): () => void {
    capacityListeners.add(listener);
    if (hasCapacity())
      queueMicrotask(() => {
        if (capacityListeners.has(listener)) notifyCapacity();
      });
    return () => capacityListeners.delete(listener);
  }

  public stats(): {
    chats: number;
    inFlight: number;
    chargedReferenceBytes: number;
  } {
    return {
      chats: states.size + admissions,
      inFlight: Array.from(states.values()).reduce(
        (total, state) => total + state.inFlight,
        0,
      ),
      chargedReferenceBytes: this.referenceBytes(),
    };
  }

  private referenceBytes(): number {
    let total = 0;
    for (const state of Array.from(states.values()))
      total +=
        (state.filter?.chargedBytes ?? 0) +
        (state.scan?.filter.chargedBytes ?? 0);
    return total;
  }

  private candidate(
    state: ArtifactState,
    family: StoredArtifactFamily,
    artifactId: string,
  ): void {
    if (!/^sha256-v1-[a-f0-9]{64}$/.test(artifactId))
      throw new Error('Invalid canonical artifact identity');
    const key = `${family}:${artifactId}`;
    if (state.candidates.has(key)) return;
    if (state.candidates.size >= MAX_CANDIDATES) {
      // A later directory walk can rediscover an overflowed orphan. With no
      // walk in progress, it must start again from the first family.
      state.discoveryComplete = false;
      if (!state.directory) state.directoryFamilyIndex = 0;
      return;
    }
    state.candidates.set(key, { family, artifactId });
  }

  private async openCandidateDirectory(
    state: ArtifactState,
    chatId: string,
  ): Promise<boolean> {
    while (
      !state.directory &&
      state.directoryFamilyIndex < ARTIFACT_LOCATIONS.length
    ) {
      const location = ARTIFACT_LOCATIONS[state.directoryFamilyIndex];
      if (!location) break;
      state.directory =
        await this.storage.transcripts.artifacts.openCandidateDirectory(
          chatId,
          location.family,
        );
      if (!state.directory) state.directoryFamilyIndex += 1;
    }
    if (state.directory) return true;
    state.discoveryComplete = true;
    return false;
  }

  private async discoverCandidates(
    state: ArtifactState,
    chatId: string,
  ): Promise<void> {
    let entries = 0;
    while (
      entries < DIRECTORY_ENTRIES_PER_SLICE &&
      state.candidates.size < MAX_CANDIDATES
    ) {
      if (
        !state.directory &&
        !(await this.openCandidateDirectory(state, chatId))
      )
        return;
      const directory = state.directory;
      const location = ARTIFACT_LOCATIONS[state.directoryFamilyIndex];
      if (!directory || !location) {
        state.discoveryComplete = true;
        return;
      }
      const entry = await directory.read();
      if (!entry) {
        await closeDirectory(state);
        state.directoryFamilyIndex += 1;
        continue;
      }
      entries += 1;
      if (!entry.isFile() || !entry.name.endsWith(location.extension)) continue;
      const artifactId = entry.name.slice(0, -location.extension.length);
      if (!/^sha256-v1-[a-f0-9]{64}$/.test(artifactId)) continue;
      if (!state.filter || !state.filter.maybeHas(artifactId))
        this.candidate(state, location.family, artifactId);
    }
    if (state.directoryFamilyIndex >= ARTIFACT_LOCATIONS.length)
      state.discoveryComplete = true;
  }

  private async resetCandidateDiscovery(state: ArtifactState): Promise<void> {
    state.filter = undefined;
    state.identity = undefined;
    state.scan = undefined;
    state.discoveryComplete = false;
    await closeDirectory(state);
    state.directoryFamilyIndex = 0;
  }

  public async identityIfCached(chatId: string): Promise<string | undefined> {
    const state = await this.state(chatId);
    if (!state) return undefined;
    if (!state.filter || !state.identity) return undefined;
    return this.storage.transcripts.artifactReferenceIdentity(chatId);
  }

  /** Called only after the canonical commit returned with an empty WAL. */
  public async committed(
    chatId: string,
    write: ChatTranscriptWrite,
    oldActive: readonly PersistedChatMessage[],
    beforeIdentity?: string,
  ): Promise<void> {
    this.clean.delete(chatId);
    const state = await this.state(chatId, true);
    if (!state) return;
    try {
      if (state.directory) {
        await closeDirectory(state);
        state.directoryFamilyIndex = 0;
        state.discoveryComplete = false;
      }
      if (write.kind === 'delete') {
        await closeDirectory(state);
        state.reserved = false;
        states.delete(this.key(chatId));
        return;
      }
      if (write.kind === 'replace' || !Array.isArray(write.messages)) {
        state.reserved = false;
        state.filter = undefined;
        state.identity = undefined;
        state.scan = undefined;
        state.discoveryComplete = false;
        await closeDirectory(state);
        state.directoryFamilyIndex = 0;
        return;
      }
      const nextActive =
        write.kind === 'active' || write.kind === 'active-replace'
          ? write.messages
          : [];
      // The canonical scan verifies reachability. It is safe to submit every
      // previous active reference as a possible orphan; no duplicate maps of
      // a potentially huge active tail are needed for this hint.
      await visitReferences(oldActive, (id, family) =>
        this.candidate(state, family, id),
      );

      if (
        !state.filter ||
        !state.identity ||
        state.identity !== beforeIdentity
      ) {
        state.filter = undefined;
        state.identity = undefined;
        state.scan = undefined;
        return;
      }
      try {
        await updateReferences(state.filter, oldActive, 'remove');
        if (write.kind === 'append')
          await updateReferences(state.filter, write.messages, 'add');
        else await updateReferences(state.filter, nextActive, 'add');
        state.identity =
          await this.storage.transcripts.artifactReferenceIdentity(chatId);
      } catch {
        state.filter = undefined;
        state.identity = undefined;
        state.scan = undefined;
      }
    } finally {
      this.release(state);
    }
  }

  /**
   * A probe: it neither takes a shared slot nor evicts another chat's
   * progress. A chat without a slot has work unless it was left clean at its
   * current reference identity.
   */
  public async hasWork(chatId: string): Promise<boolean> {
    const state = states.get(this.key(chatId));
    if (state && !state.closing)
      return state.candidates.size > 0 || !state.discoveryComplete;
    const cleanIdentity = this.clean.get(chatId);
    if (cleanIdentity === undefined) return true;
    try {
      return (
        (await this.storage.transcripts.artifactReferenceIdentity(chatId)) !==
        cleanIdentity
      );
    } catch {
      return true;
    }
  }

  public async invalidate(chatId: string): Promise<void> {
    this.clean.delete(chatId);
    const state = await this.state(chatId, true);
    if (!state) return;
    try {
      state.reserved = false;
      await this.resetCandidateDiscovery(state);
    } finally {
      this.release(state);
    }
  }

  /** An ineligible or cancelled job releases its slot without unlinking. */
  public async abandon(chatId: string): Promise<void> {
    this.clean.delete(chatId);
    const state = states.get(this.key(chatId));
    if (!state || state.closing) return;
    state.owners.add(this.owner);
    state.inFlight += 1;
    try {
      state.reserved = false;
      state.scan = undefined;
      state.candidates.clear();
      state.discoveryComplete = false;
      await closeDirectory(state);
      state.directoryFamilyIndex = 0;
    } finally {
      this.release(state);
    }
  }

  public async maintain(
    chatId: string,
    maxBytes: number,
    expected?: TranscriptDescriptor | (() => Promise<TranscriptDescriptor>),
  ): Promise<ArtifactMaintenanceProgress> {
    const cleanIdentity = this.clean.get(chatId);
    if (cleanIdentity !== undefined && !states.has(this.key(chatId))) {
      // Re-queued after eviction with nothing changed: no slot, no rescan.
      const canonical =
        typeof expected === 'function' ? await expected() : expected;
      if (
        (await this.storage.transcripts.artifactReferenceIdentity(
          chatId,
          canonical,
        )) === cleanIdentity
      )
        return { complete: true, scannedBytes: 0, removed: 0 };
      this.clean.delete(chatId);
    }
    const state = await this.state(chatId, true);
    if (!state)
      throw new ArtifactMaintenanceCapacityError(
        'Artifact maintenance capacity is busy',
      );
    const progress = (
      result: ArtifactMaintenanceProgress,
      identity?: string,
    ): ArtifactMaintenanceProgress => {
      state.reserved = !result.complete;
      if (
        result.complete &&
        identity !== undefined &&
        state.candidates.size === 0
      )
        this.clean.set(chatId, identity);
      else this.clean.delete(chatId);
      return result;
    };
    try {
      if (!(await this.storage.journalIsClear()))
        throw new Error(
          'Artifact maintenance deferred while replay is pending',
        );
      const canonical =
        typeof expected === 'function' ? await expected() : expected;
      const transcript = this.storage.transcripts;
      if (
        !state.candidates.size &&
        !state.scan &&
        !state.filter &&
        !state.discoveryComplete &&
        !(await this.openCandidateDirectory(state, chatId))
      )
        return progress(
          { complete: true, scannedBytes: 0, removed: 0 },
          await transcript.artifactReferenceIdentity(chatId, canonical),
        );
      const actualIdentity = await transcript.artifactReferenceIdentity(
        chatId,
        canonical,
      );
      if (state.filter && state.identity !== actualIdentity) {
        await this.resetCandidateDiscovery(state);
      }
      let scannedBytes = 0;
      // Complete one canonical reference pass before new directory batches.
      if (
        !state.discoveryComplete &&
        !state.scan &&
        (state.candidates.size === 0 || !!state.filter)
      ) {
        await this.discoverCandidates(state, chatId);
        if (!state.discoveryComplete && state.candidates.size === 0)
          return progress({ complete: false, scannedBytes, removed: 0 });
      }
      if (!state.filter) {
        if (state.candidates.size === 0)
          return progress(
            {
              complete: state.discoveryComplete,
              scannedBytes,
              removed: 0,
            },
            actualIdentity,
          );
        const scan = (state.scan ??= {
          offset: 0,
          committedComplete: false,
          activeOffset: 0,
          activeFinalizingRows: 0,
          identity: actualIdentity,
          filter: new CountingArtifactReferenceFilter(),
        });
        if (scan.identity !== actualIdentity) {
          await this.resetCandidateDiscovery(state);
          return progress({ complete: false, scannedBytes: 0, removed: 0 });
        }
        const slice = scan.committedComplete
          ? await transcript.artifactActiveReferenceSlice(
              chatId,
              scan.activeOffset,
              maxBytes,
            )
          : await transcript.artifactReferenceSlice(
              chatId,
              scan.offset,
              maxBytes,
              canonical,
            );
        const previousIdentity = scan.committedComplete
          ? scan.activeIdentity
          : scan.committedIdentity;
        if (
          previousIdentity !== undefined &&
          previousIdentity !== slice.identity
        ) {
          await this.resetCandidateDiscovery(state);
          return progress({
            complete: false,
            scannedBytes: slice.scannedBytes,
            removed: 0,
          });
        }
        if (scan.committedComplete) {
          scan.activeIdentity = slice.identity;
          scan.activeOffset = slice.nextOffset;
          if (slice.activeHeaderFinalizing !== undefined)
            scan.activeHeaderFinalizing = slice.activeHeaderFinalizing;
          scan.activeFinalizingRows += slice.activeFinalizingRows ?? 0;
        } else {
          scan.committedIdentity = slice.identity;
          scan.offset = slice.nextOffset;
        }
        scannedBytes = slice.scannedBytes;
        await addArtifactIds(scan.filter, slice.artifactIds);
        if (!slice.complete)
          return progress({ complete: false, scannedBytes, removed: 0 });
        if (!scan.committedComplete) {
          scan.committedComplete = true;
          return progress({ complete: false, scannedBytes, removed: 0 });
        }
        if (
          scan.activeHeaderFinalizing !== undefined &&
          scan.activeFinalizingRows > 0 !== scan.activeHeaderFinalizing
        )
          throw new Error('Invalid active transcript finalization state');
        const finishedIdentity = await transcript.artifactReferenceIdentity(
          chatId,
          canonical,
        );
        if (
          !finishedIdentity.startsWith(`${scan.committedIdentity}:`) ||
          finishedIdentity !== scan.identity
        ) {
          await this.resetCandidateDiscovery(state);
          return progress({ complete: false, scannedBytes, removed: 0 });
        }
        state.filter = scan.filter;
        state.identity = finishedIdentity;
        state.scan = undefined;
      }
      if (!(await this.storage.journalIsClear()))
        throw new Error(
          'Artifact maintenance deferred while replay is pending',
        );
      if (
        (await transcript.artifactReferenceIdentity(chatId, canonical)) !==
        state.identity
      ) {
        await this.resetCandidateDiscovery(state);
        return progress({ complete: false, scannedBytes, removed: 0 });
      }
      const filter = state.filter;
      if (!filter)
        return progress({ complete: false, scannedBytes, removed: 0 });
      const obsolete: ArtifactCandidate[] = [];
      for (const [key, candidate] of Array.from(state.candidates)) {
        if (filter.maybeHas(candidate.artifactId)) state.candidates.delete(key);
        else obsolete.push(candidate);
        if (obsolete.length >= UNLINKS_PER_SLICE) break;
      }
      // The digest-only filter may retain a cross-family orphan, never a live artifact.
      for (const { family } of ARTIFACT_LOCATIONS) {
        const ids = obsolete.flatMap((candidate) =>
          candidate.family === family ? [candidate.artifactId] : [],
        );
        if (ids.length)
          await transcript.artifacts.reclaimCandidates(chatId, ids, family);
      }
      for (const candidate of obsolete)
        state.candidates.delete(`${candidate.family}:${candidate.artifactId}`);
      return progress(
        {
          complete: state.candidates.size === 0 && state.discoveryComplete,
          scannedBytes,
          removed: obsolete.length,
        },
        state.identity,
      );
    } catch (error) {
      state.reserved = false;
      this.clean.delete(chatId);
      throw error;
    } finally {
      this.release(state);
    }
  }

  public async dispose(): Promise<void> {
    this.clean.clear();
    const errors: unknown[] = [];
    for (const [key, state] of Array.from(states))
      if (key.startsWith(`${this.root}/`) && state.owners.has(this.owner)) {
        state.owners.delete(this.owner);
        if (state.owners.size === 0) state.closing = true;
        try {
          // A second repository can hold a bounded slice over the same
          // derived state. Wait for its pin, but never await an entire cleanup
          // job or close a newer owner's state through a reused path.
          await waitForIdle(state);
          if (states.get(key) !== state || state.owners.size > 0) continue;
          state.closing = true;
          if (!state.closePromise) {
            state.closePromise = (async (): Promise<void> => {
              state.inFlight += 1;
              try {
                state.reserved = false;
                state.filter = undefined;
                state.identity = undefined;
                state.scan = undefined;
                state.candidates.clear();
                state.discoveryComplete = false;
                await closeDirectory(state);
                state.directoryFamilyIndex = 0;
                if (states.get(key) === state) states.delete(key);
              } finally {
                this.release(state);
              }
            })();
          }
          await state.closePromise;
        } catch (error) {
          if (states.get(key) === state) {
            state.owners.add(this.owner);
            state.closing = false;
          }
          errors.push(error);
        } finally {
          if (state.inFlight === 0) state.closePromise = undefined;
        }
      }
    if (errors.length)
      throw aggregateFailure(
        errors,
        'Artifact maintenance handle close failed',
      );
  }
}
