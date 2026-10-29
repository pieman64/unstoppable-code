/**
 * Recipient acceptance of shared containers.
 *
 * Materializing a shared container clones the publisher's repositories onto the
 * recipient's disk using the recipient's own Git credentials. That is the
 * recipient's machine and the recipient's bandwidth, so it happens only after
 * they say so. This store is the record of that consent, and
 * `shared-containers:open` fails closed without it.
 *
 * Consent is per device. A container accepted on a laptop says nothing about
 * whether the same person wants a multi-gigabyte checkout on a different
 * machine, so this is deliberately local state rather than a server-side grant
 * flag.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  SharedContainerAcceptanceFile,
  SharedContainerAcceptedIdentity,
  SharedContainerAccess,
  SharedContainerAcceptanceRecord,
} from '@canopy/desktop-shared/types';
import { getSharedContainerAcceptanceFilePath } from '../lib/paths';

const EMPTY: SharedContainerAcceptanceFile = { version: 1, accepted: {} };

interface SharedContainerRunLifecycleLock {
  tail: Promise<void>;
}

const runLifecycleLocks = new Map<string, SharedContainerRunLifecycleLock>();
const heldRunLifecycleLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Acquire the per-container boundary shared by process startup and teardown.
 * Callers starting a long-running process release as soon as it is registered;
 * cleanup then observes and stops it without holding the lock for its lifetime.
 */
export async function acquireSharedContainerRunLifecycle(
  containerId: string,
): Promise<() => void> {
  let lock = runLifecycleLocks.get(containerId);
  if (!lock) {
    lock = { tail: Promise.resolve() };
    runLifecycleLocks.set(containerId, lock);
  }
  const previous = lock.tail;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  lock.tail = previous.then(() => gate);
  await previous;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    releaseGate();
  };
}

/** Serialize destructive transitions and allow same-call cleanup to re-enter. */
export async function withSharedContainerRunLifecycle<T>(
  containerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const held = heldRunLifecycleLocks.getStore();
  if (held?.has(containerId)) return operation();
  const release = await acquireSharedContainerRunLifecycle(containerId);
  const nextHeld = new Set(held);
  nextHeld.add(containerId);
  try {
    return await heldRunLifecycleLocks.run(nextHeld, operation);
  } finally {
    release();
  }
}

function normalize(value: unknown): SharedContainerAcceptanceFile {
  if (!value || typeof value !== 'object') return { ...EMPTY, accepted: {} };
  const file: Record<string, unknown> = { ...value };
  if (file.version !== 1) return { ...EMPTY, accepted: {} };
  const raw = file.accepted;
  if (!raw || typeof raw !== 'object') return { ...EMPTY, accepted: {} };
  const accepted: Record<string, SharedContainerAcceptanceRecord> = {};
  for (const [containerId, record] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!record || typeof record !== 'object') continue;
    const entry: Record<string, unknown> = { ...record };
    // `organizationId` is absent for a personal container shared directly;
    // `access` postdates this file (still version 1) and is absent on legacy
    // records, which were all organization shares.
    if (
      (entry.organizationId !== undefined &&
        (typeof entry.organizationId !== 'string' ||
          entry.organizationId.length === 0)) ||
      typeof entry.acceptedAt !== 'string' ||
      entry.acceptedAt.length === 0
    ) {
      continue;
    }
    const organizationId =
      typeof entry.organizationId === 'string'
        ? entry.organizationId
        : undefined;
    const hasRunConsent =
      typeof entry.runAllowedAt === 'string' &&
      entry.runAllowedAt.length > 0 &&
      typeof entry.runAllowedPublisherUserId === 'string' &&
      entry.runAllowedPublisherUserId.length > 0;
    accepted[containerId] = {
      ...(organizationId !== undefined ? { organizationId } : {}),
      ...(entry.access === 'direct' || entry.access === 'organization'
        ? { access: entry.access }
        : {}),
      acceptedAt: entry.acceptedAt,
      ...(hasRunConsent ? { runAllowedAt: entry.runAllowedAt as string } : {}),
      ...(hasRunConsent
        ? {
            runAllowedPublisherUserId:
              entry.runAllowedPublisherUserId as string,
          }
        : {}),
    };
  }
  return { version: 1, accepted };
}

async function read(): Promise<SharedContainerAcceptanceFile> {
  try {
    const raw = await readFile(getSharedContainerAcceptanceFilePath(), 'utf8');
    return normalize(JSON.parse(raw));
  } catch {
    // A missing or unreadable file means nothing has been accepted, which is
    // the safe answer: the worst outcome is asking the recipient again.
    return { ...EMPTY, accepted: {} };
  }
}

async function write(file: SharedContainerAcceptanceFile): Promise<void> {
  const path = getSharedContainerAcceptanceFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Serializes read-modify-write cycles so concurrent accepts cannot clobber. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Identity only: consent timestamps and run consent stay in main. */
function identityOf(
  record: SharedContainerAcceptanceRecord,
): SharedContainerAcceptedIdentity {
  return {
    ...(record.organizationId !== undefined
      ? { organizationId: record.organizationId }
      : {}),
    ...(record.access !== undefined ? { access: record.access } : {}),
    ...(typeof record.acceptedAt === 'string'
      ? { acceptedAt: record.acceptedAt }
      : {}),
  };
}

/**
 * Every accepted container with the identity it was accepted under. One read
 * backs both the id list and the identities, so the two cannot disagree.
 */
export async function listAcceptedSharedContainers(): Promise<
  Record<string, SharedContainerAcceptedIdentity>
> {
  const identities: Record<string, SharedContainerAcceptedIdentity> = {};
  for (const [containerId, record] of Object.entries((await read()).accepted)) {
    identities[containerId] = identityOf(record);
  }
  return identities;
}

export async function isSharedContainerAccepted(
  containerId: string,
): Promise<boolean> {
  return (await read()).accepted[containerId] !== undefined;
}

export async function getSharedContainerAcceptance(
  containerId: string,
): Promise<SharedContainerAcceptanceRecord | null> {
  return (await read()).accepted[containerId] ?? null;
}

export async function isSharedContainerRunAllowed(
  containerId: string,
): Promise<boolean> {
  return (await read()).accepted[containerId]?.runAllowedAt !== undefined;
}

export function allowSharedContainerRun(
  containerId: string,
  publisherUserId: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  return enqueue(async () => {
    const file = await read();
    const current = file.accepted[containerId];
    if (!current) throw new Error('Shared container has not been accepted');
    await write({
      version: 1,
      accepted: {
        ...file.accepted,
        [containerId]: {
          ...current,
          runAllowedAt: now().toISOString(),
          runAllowedPublisherUserId: publisherUserId,
        },
      },
    });
  });
}

export function revokeSharedContainerRun(containerId: string): Promise<void> {
  return enqueue(async () => {
    const file = await read();
    const current = file.accepted[containerId];
    if (!current?.runAllowedAt) return;
    const rest = { ...current };
    delete rest.runAllowedAt;
    delete rest.runAllowedPublisherUserId;
    await write({
      version: 1,
      accepted: { ...file.accepted, [containerId]: rest },
    });
  });
}

/**
 * Records consent for a container. The recorded identity (`organizationId`,
 * `access`, `acceptedAt`) is written once: it anchors which workspace context
 * lists the accepted share, and a listing round can classify the same share
 * differently from one moment to the next. Accepting an already accepted
 * container therefore keeps the existing identity; only a dismiss, which drops
 * the record, lets the next accept write a new one.
 *
 * Resolves with the identity the record holds afterwards: the one just
 * written, or the one a repeat accept kept. A caller that mirrors the record
 * uses this answer, since the identity it passed in may not be the one stored.
 */
export function acceptSharedContainer(
  containerId: string,
  /** Absent for a personal container shared directly. */
  organizationId: string | undefined,
  now: () => Date = () => new Date(),
  access?: SharedContainerAccess,
): Promise<SharedContainerAcceptedIdentity> {
  return enqueue(async () => {
    const file = await read();
    const previous = file.accepted[containerId];
    if (previous) {
      // Run consent survives a re-accept only for the same owner identity.
      if (
        previous.organizationId === organizationId ||
        previous.runAllowedAt === undefined
      ) {
        return identityOf(previous);
      }
      const withoutRunConsent = { ...previous };
      delete withoutRunConsent.runAllowedAt;
      delete withoutRunConsent.runAllowedPublisherUserId;
      await write({
        version: 1,
        accepted: { ...file.accepted, [containerId]: withoutRunConsent },
      });
      return identityOf(previous);
    }
    const record: SharedContainerAcceptanceRecord = {
      ...(organizationId !== undefined ? { organizationId } : {}),
      ...(access !== undefined ? { access } : {}),
      acceptedAt: now().toISOString(),
    };
    await write({
      version: 1,
      accepted: { ...file.accepted, [containerId]: record },
    });
    return identityOf(record);
  });
}

/**
 * Drops consent for a container the recipient dismissed, or that was revoked or
 * purged. Re-appearing later means being asked again, which is correct: the
 * replica it authorized no longer exists.
 */
export function forgetSharedContainerAcceptance(
  containerId: string,
): Promise<void> {
  return enqueue(async () => {
    const file = await read();
    if (file.accepted[containerId] === undefined) return;
    const accepted = { ...file.accepted };
    delete accepted[containerId];
    await write({ version: 1, accepted });
  });
}
