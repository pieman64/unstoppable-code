import { createHash, randomUUID } from 'node:crypto';
import {
  writeCopilotRotationAttempt,
  removeCopilotRotationAttempt,
} from './rotation-attempt';
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import { sameCopilotAccount } from '@canopy/desktop-shared/node/copilot/auth';
import type { DeviceFlowGrant } from '@canopy/desktop-shared/node/copilot/device-flow';
import {
  CopilotSignInChangedError,
  CopilotSignInExpiredError,
  CopilotCredentialUnreadableError,
  createCopilotCredentialBroker,
  type CopilotCredentialBroker,
} from './credential-broker';
import {
  clearCopilotCredential,
  createCopilotCredential,
  deleteCopilotCredential,
  isCopilotCredentialStorageAvailable,
  readCopilotCredential,
  replaceCopilotCredential,
  type CopilotCredential,
  type CopilotCredentialDelete,
  type CopilotCredentialRead,
  type CopilotCredentialReplace,
  type CopilotGrant,
} from './credential-store';

// Reads carry no grant authority; they are re-exported so the store has one
// importer.
export { isCopilotCredentialStorageAvailable, readCopilotCredential };
export type { CopilotCredential, CopilotGrant };

/** D24: the account and the store-minted entry; a new entry is a new epoch. */
export interface CopilotAccountEpoch {
  host: string;
  id: string;
  entryId: string;
}

export interface CopilotGrantAuthorityDeps {
  refresh(refreshToken: string, signal: AbortSignal): Promise<DeviceFlowGrant>;
  /** Runs after a rejected refresh deleted the grant. */
  onCleared(): void;
}

function epochOf(credential: CopilotCredential): CopilotAccountEpoch {
  return {
    host: credential.host,
    id: credential.id,
    entryId: credential.entryId,
  };
}

function sameEpoch(
  left: CopilotAccountEpoch,
  right: CopilotAccountEpoch,
): boolean {
  return (
    left.host === right.host &&
    left.id === right.id &&
    left.entryId === right.entryId
  );
}

function samePin(
  left: CopilotAccount | undefined,
  right: CopilotAccount | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return sameCopilotAccount(left, right);
}

export interface CopilotGrantHandle extends CopilotCredentialBroker {
  binding(): Promise<CopilotAccountEpoch>;
}

/**
 * The account epoch's sole presenter, writer and clearer (D17). Rotations
 * already in flight survive recipient revocation and stay single-flight.
 */
class CopilotGrantAuthority {
  readonly auth: CopilotGrantHandle;
  /** Latched at the first read of an entry its pin may present. */
  private epoch: CopilotAccountEpoch | undefined;
  private retired = false;
  private attemptId: string | undefined;

  constructor(
    readonly pin: CopilotAccount | undefined,
    deps: CopilotGrantAuthorityDeps,
  ) {
    const broker = createCopilotCredentialBroker({
      pin,
      read: () => this.read(),
      save: async (from, grant): Promise<CopilotCredentialReplace> => {
        if (this.retired) return { status: 'conflict' };
        const attemptId = this.attemptId;
        const result = await replaceCopilotCredential(from, grant);
        if (result.status === 'written')
          void this.finishAttempt(attemptId).catch(() => undefined);
        return result;
      },
      clear: async (from): Promise<CopilotCredentialDelete> => {
        if (this.retired) return { status: 'conflict' };
        const attemptId = this.attemptId;
        const cleared = await deleteCopilotCredential(from);
        if (cleared.status === 'deleted') {
          void this.finishAttempt(attemptId).catch(() => undefined);
          deps.onCleared();
        }
        return cleared;
      },
      refresh: async (refreshToken, signal) => {
        if (this.retired || !this.epoch) throw new CopilotSignInChangedError();
        const attempt = {
          attemptId: randomUUID(),
          bootId,
          accountEpoch: this.epoch,
          fromDigest: createHash('sha256').update(refreshToken).digest('hex'),
        };
        await writeCopilotRotationAttempt(attempt);
        this.attemptId = attempt.attemptId;
        if (this.retired) throw new CopilotSignInChangedError();
        return deps.refresh(refreshToken, signal);
      },
    });
    this.auth = {
      ...broker,
      binding: async (): Promise<CopilotAccountEpoch> => {
        const read = await this.read();
        if (read.status !== 'present' || !this.epoch) {
          if (read.status === 'unreadable')
            throw new CopilotCredentialUnreadableError(
              read.secureStorageFailure,
            );
          if (read.status === 'absent') throw new CopilotSignInExpiredError();
          throw new CopilotSignInChangedError();
        }
        return { ...this.epoch };
      },
    };
  }

  private async finishAttempt(attemptId: string | undefined): Promise<void> {
    if (attemptId) await removeCopilotRotationAttempt(attemptId);
  }

  get entryId(): string | undefined {
    return this.epoch?.entryId;
  }

  get active(): boolean {
    return !this.retired;
  }

  retire(): void {
    this.retired = true;
  }

  private async read(): Promise<CopilotCredentialRead> {
    if (this.retired) throw new CopilotSignInChangedError();
    const read = await readCopilotCredential();
    if (this.retired) throw new CopilotSignInChangedError();
    if (read.status !== 'present') return read;
    const { credential } = read;
    if (this.epoch) {
      if (sameEpoch(this.epoch, epochOf(credential))) return read;
      // Another entry is another epoch, written outside this authority. Its
      // own authority starts on the next open.
      this.retire();
      throw new CopilotSignInChangedError();
    }
    if (
      sameCopilotAccount(
        { host: credential.host, login: credential.login },
        this.pin,
      )
    )
      this.epoch = epochOf(credential);
    return read;
  }
}

const bootId = randomUUID();
let current: CopilotGrantAuthority | undefined;
/** Set by the quit drain; it also fences authorities that start after it. */
let permanentlyFenced = false;

export function resetCopilotGrantFenceForTests(): void {
  permanentlyFenced = false;
}

export function resumeCopilotGrant(): void {
  current?.auth.resume();
}

/** D30 bounds only the rotation wait; teardown runs alongside it. */
export async function drainCopilotGrant(permanent = false): Promise<void> {
  permanentlyFenced ||= permanent;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      current?.auth.quiesce(permanent),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The current epoch's grant handle for `pin`. `deps` apply only when this
 * call starts the epoch's authority.
 */
export function copilotGrantAuthority(
  pin: CopilotAccount | undefined,
  deps: CopilotGrantAuthorityDeps,
): CopilotGrantHandle {
  if (current?.active && samePin(current.pin, pin)) return current.auth;
  // Each authority presents only entries matching its pin exactly, so the
  // one replaced for another pin never shares an entry with its successor.
  current?.retire();
  current = new CopilotGrantAuthority(pin, deps);
  // Quiescing fences synchronously; with nothing pending it settles at once.
  if (permanentlyFenced) void current.auth.quiesce(true);
  return current.auth;
}

function endEpoch(): void {
  current?.retire();
  current = undefined;
}

/**
 * Setup commit: the created entry starts a new epoch. A failed create keeps
 * the current epoch and any successor it holds; one that landed anyway is
 * ended by the setup rollback.
 */
export async function commitCopilotGrant(
  grant: CopilotGrant,
): Promise<CopilotCredential> {
  const created = await createCopilotCredential(grant);
  endEpoch();
  return created;
}

/** Setup rollback: deletes the entry only while it is still `expected`. */
export function deleteCopilotGrant(expected: {
  entryId: string;
  revision?: number;
}): Promise<CopilotCredentialDelete> {
  endEpoch();
  return deleteCopilotCredential(expected);
}

/** Disconnect and Change account: deletes the latest revision. */
export async function clearCopilotGrant(): Promise<void> {
  let entryId = current?.entryId;
  endEpoch();
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await readCopilotCredential();
    if (read.status === 'absent') return;
    if (read.status === 'unreadable') {
      // Explicit removal keeps the base escape hatch for unreadable ciphertext.
      await clearCopilotCredential();
      return;
    }
    entryId ??= read.credential.entryId;
    if (read.credential.entryId !== entryId) return;
    // The store holds its writer queue across this same-entry CAS, so any
    // successor already saving is removed too, without racing a revision read.
    const result = await deleteCopilotCredential({ entryId });
    if (result.status === 'deleted') return;
    if (result.status === 'unreadable')
      throw new Error("Couldn't read the Copilot sign-in on this device.");
  }
  throw new Error('Copilot sign-in changed. Try again.');
}
