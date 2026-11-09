import { randomUUID } from 'node:crypto';
import { readFile, rename, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  normalizeSidebarItemGroups,
  parseSidebarItemGroupsFile,
  type SidebarItemGroup,
  type SidebarItemGroupInventory,
} from '@canopy/protocol/sidebar';
export { sidebarGroupStackUnits } from '@canopy/desktop-shared/lib/worktree-grouping';
import { getSidebarItemGroupsFilePath } from './paths';
import { writeFileAtomically } from './atomic-file';
import { isErrnoException } from './type-guards';
import { logMainProcessWarn } from './main-process-logging';

// Registry owners serialize writes; read-only projections read without their
// lock. Cache the raw envelope only, keyed by its exact text: every use still
// reconciles against the complete current registry inventory.
const envelopes = new Map<string, { text: string; value: unknown }>();

const pendingChanges = new Set<string>();
const changeListeners = new Set<(workspaceId: string) => void>();

/** The registry owner executes these phases inside its existing write lock. */
export interface SidebarGroupRegistryReconciliation<T> {
  rows: T[];
  beforeWrite?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
  rollback?: () => Promise<void>;
}

/** Restore a creation prewrite when its owning registry cannot commit. */
export async function restoreSidebarItemGroupsEnvelope(
  workspaceId: string,
  envelope: unknown,
): Promise<void> {
  const path = getSidebarItemGroupsFilePath(workspaceId);
  // External writers may have installed newer data since the prewrite.
  await readSidebarItemGroups(workspaceId, { liveItemIds: [] });
  if (envelope === undefined) await rm(path, { force: true });
  else
    await writeFileAtomically(path, JSON.stringify(envelope, null, 2), {
      encoding: 'utf8',
    });
  envelopes.delete(path);
  pendingChanges.delete(workspaceId);
}

export function onSidebarItemGroupsChanged(
  listener: (workspaceId: string) => void,
): () => void {
  changeListeners.add(listener);
  return (): void => {
    changeListeners.delete(listener);
  };
}

/** Publish pending workspace invalidation, not a correlated command receipt. */
export function publishSidebarItemGroupsChanged(workspaceId: string): void {
  if (!pendingChanges.delete(workspaceId)) return;
  for (const listener of Array.from(changeListeners)) {
    try {
      listener(workspaceId);
    } catch {
      /* Observers cannot fail a durable write. */
    }
  }
}

export class SidebarItemGroupsVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported sidebar item groups version: ${version}`);
    this.name = 'SidebarItemGroupsVersionError';
  }
}

/** `readOnly` skips quarantining an unreadable file; its owner does that. */
export interface SidebarItemGroupsReadOptions {
  readOnly?: boolean;
}

export async function readSidebarItemGroupsEnvelope(
  workspaceId: string,
  options?: SidebarItemGroupsReadOptions,
): Promise<unknown> {
  const path = getSidebarItemGroupsFilePath(workspaceId);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      envelopes.delete(path);
      return undefined;
    }
    throw error;
  }
  const cached = envelopes.get(path);
  if (cached?.text === text) return cached.value;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = {};
  }
  const parsed = parseSidebarItemGroupsFile(value, { liveItemIds: [] });
  if (parsed.status === 'malformed' || parsed.status === 'missing') {
    if (options?.readOnly) return undefined;
    await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`);
    await pruneDamagedCopies(
      damagedCopiesOf(path, '.corrupt-', { uniqueTail: true }),
    );
    envelopes.delete(path);
    logMainProcessWarn('sidebar_item_groups_unreadable');
    return undefined;
  }
  envelopes.set(path, { text, value });
  return value;
}

export async function readSidebarItemGroups(
  workspaceId: string,
  inventory: SidebarItemGroupInventory,
  options?: SidebarItemGroupsReadOptions,
): Promise<SidebarItemGroup[]> {
  const parsed = parseSidebarItemGroupsFile(
    await readSidebarItemGroupsEnvelope(workspaceId, options),
    inventory,
  );
  if (parsed.status === 'unsupported-version')
    throw new SidebarItemGroupsVersionError(parsed.version);
  return parsed.status === 'ok' ? parsed.value.groups : [];
}

export async function writeSidebarItemGroups(
  workspaceId: string,
  groups: readonly SidebarItemGroup[],
  inventory: SidebarItemGroupInventory,
): Promise<void> {
  // Refuse to overwrite future data, including data installed externally since
  // the preceding read. Transient I/O failures also abort the mutation.
  await readSidebarItemGroups(workspaceId, inventory);
  const path = getSidebarItemGroupsFilePath(workspaceId);
  const value = {
    version: 1,
    groups: normalizeSidebarItemGroups(groups, inventory),
  };
  const text = JSON.stringify(value, null, 2);
  await mkdir(dirname(path), { recursive: true });
  await waitForE2eGroupWriteFence(path);
  await writeFileAtomically(path, text, { encoding: 'utf8' });
  envelopes.set(path, { text, value });
  pendingChanges.add(workspaceId);
}

/** Test-only fence around the real writer, never an alternate persistence path. */
async function waitForE2eGroupWriteFence(path: string): Promise<void> {
  if (
    !__CANOPY_E2E__ ||
    process.env.CANOPY_E2E_SIDEBAR_ITEM_GROUP_HOLD_WRITES !== '1'
  )
    return;
  const hold = `${path}.e2e-hold`;
  const entered = `${path}.e2e-entered`;
  const deadline = Date.now() + 10_000;
  let observed = false;
  try {
    for (;;) {
      try {
        await readFile(hold, 'utf8');
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return;
        throw error;
      }
      if (!observed) {
        await writeFile(entered, '1', 'utf8');
        observed = true;
      }
      if (Date.now() >= deadline)
        throw new Error('Sidebar item groups test fence timed out');
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (observed) await rm(entered, { force: true });
  }
}

export interface SidebarGroupRegistryItem {
  id: string;
  pinned?: boolean;
  hidden?: boolean;
}

export function sidebarGroupInventory(
  items: readonly SidebarGroupRegistryItem[],
  childIds: readonly string[] = [],
): SidebarItemGroupInventory {
  return {
    liveItemIds: items.map((item) => item.id),
    ineligibleItemIds: [
      ...childIds,
      ...items
        .filter((item) => item.pinned || item.hidden)
        .map((item) => item.id),
    ],
  };
}

/** Called inside the existing registry lock, before visibility or ACK. */
export async function reconcileSidebarItemGroups(
  workspaceId: string,
  inventory: SidebarItemGroupInventory,
): Promise<void> {
  const envelope = await readSidebarItemGroupsEnvelope(workspaceId);
  const parsed = parseSidebarItemGroupsFile(envelope, inventory);
  if (parsed.status !== 'ok') return; // preserve unsupported future versions
  if (JSON.stringify(envelope) !== JSON.stringify(parsed.value))
    await writeSidebarItemGroups(workspaceId, parsed.value.groups, inventory);
}
