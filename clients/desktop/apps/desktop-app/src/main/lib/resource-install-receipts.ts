/**
 * Device-local, account-partitioned origin ledger (CAN-2962).
 * Editing, managed import, cache failure, sign-out, or revocation must never
 * erase organization origin. There is no general delete/clear API and
 * org-to-Personal conversion is rejected. Receipts are not access grants and
 * must stay out of telemetry, catalog sync, and default diagnostics.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isInstallReceipt,
  normalizeInstallReceiptDisplayNames,
  type InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import { writeFileAtomically } from './atomic-file';
import { getDataDir } from './paths';

interface ReceiptFile {
  version: 1;
  byAccount: Record<string, unknown[]>;
}

function normalizeReceipt(receipt: InstallReceipt): InstallReceipt {
  return {
    ...(receipt.localResourceIds
      ? { localResourceIds: Array.from(new Set(receipt.localResourceIds)) }
      : {}),
    ...(receipt.uninstalledLocalResourceIds
      ? {
          uninstalledLocalResourceIds: [...receipt.uninstalledLocalResourceIds],
        }
      : {}),
    family: receipt.family,
    remoteId: receipt.remoteId,
    ...(receipt.sourceKind ? { sourceKind: receipt.sourceKind } : {}),
    shareScope: receipt.shareScope,
    ownerContext:
      receipt.ownerContext.kind === 'personal'
        ? { kind: 'personal' }
        : {
            kind: 'organization',
            organizationId: receipt.ownerContext.organizationId,
          },
    hash: receipt.hash,
    authorizedAt: receipt.authorizedAt,
    ...(receipt.localContentHashes
      ? { localContentHashes: { ...receipt.localContentHashes } }
      : {}),
    ...(receipt.localResourceRoles
      ? { localResourceRoles: { ...receipt.localResourceRoles } }
      : {}),
    ...normalizeInstallReceiptDisplayNames(receipt),
  };
}

function mergedUninstalledIds(
  previous: InstallReceipt[],
  receipt: InstallReceipt,
): string[] | undefined {
  const touched = new Set(receipt.localResourceIds ?? []);
  const removed = new Set(
    previous
      .flatMap((row) => row.uninstalledLocalResourceIds ?? [])
      .filter((id) => !touched.has(id)),
  );
  for (const id of receipt.uninstalledLocalResourceIds ?? []) removed.add(id);
  return removed.size ||
    receipt.uninstalledLocalResourceIds !== undefined ||
    previous.some((row) => row.uninstalledLocalResourceIds !== undefined)
    ? Array.from(removed)
    : undefined;
}

async function readReceipts(
  file: string,
  strict = false,
): Promise<ReceiptFile> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return { version: 1, byAccount: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid resource install receipt file');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('byAccount' in value) ||
    typeof value.byAccount !== 'object' ||
    value.byAccount === null ||
    Array.isArray(value.byAccount)
  ) {
    throw new Error('Invalid resource install receipt file');
  }
  const entries = Object.entries(value.byAccount).map(
    ([account, receipts]: [string, unknown]): [string, unknown[]] => {
      if (!Array.isArray(receipts)) {
        if (strict) throw new Error('Invalid resource install receipt file');
        return [account, []];
      }
      // Mutations retain raw rows, including malformed or future-version data.
      // Only lookup results are filtered and normalized.
      return [account, receipts];
    },
  );
  return { version: 1, byAccount: Object.fromEntries(entries) };
}

// One writer per file across account-bound handles; account switches cannot
// redirect a queued write, and a rejected write does not poison later writes.
const writes = new Map<string, Promise<void>>();

export function createResourceInstallReceiptsStore(
  accountId: string,
  dataDir = getDataDir(),
): {
  record(receipt: InstallReceipt): Promise<void>;
  rollbackInstall(
    receipt: InstallReceipt,
    previous: InstallReceipt | undefined,
  ): Promise<void>;
  find(
    family: string,
    remoteId: string,
    strict?: boolean,
  ): Promise<InstallReceipt | undefined>;
  listForAccount(strict?: boolean): Promise<InstallReceipt[]>;
  listOrganizationContentOwners(
    family: string,
    hash: string,
  ): Promise<string[]>;
  findLocal(
    family: string,
    localId: string,
  ): Promise<{ accountId: string; receipt: InstallReceipt } | undefined>;
} {
  if (!accountId.trim())
    throw new Error('An account is required for install receipts');
  const file = join(dataDir, 'resource-install-receipts.json');
  async function listForAccount(strict = false): Promise<InstallReceipt[]> {
    await writes.get(file);
    const state = await readReceipts(file, strict);
    if (
      strict &&
      Object.prototype.hasOwnProperty.call(state.byAccount, accountId) &&
      state.byAccount[accountId].some((row) => !isInstallReceipt(row))
    )
      throw new Error('Invalid resource install receipt');
    return Object.prototype.hasOwnProperty.call(state.byAccount, accountId)
      ? state.byAccount[accountId]
          .filter(isInstallReceipt)
          .map(normalizeReceipt)
      : [];
  }
  return {
    record(receipt): Promise<void> {
      if (!isInstallReceipt(receipt))
        return Promise.reject(new Error('Invalid resource install receipt'));
      let normalized = normalizeReceipt(receipt);
      const run = (writes.get(file) ?? Promise.resolve()).then(
        async (): Promise<void> => {
          const state = await readReceipts(file, true);
          const rows = Object.prototype.hasOwnProperty.call(
            state.byAccount,
            accountId,
          )
            ? state.byAccount[accountId]
            : [];
          const previous = rows
            .filter(isInstallReceipt)
            .filter(
              (row) =>
                row.family === normalized.family &&
                row.remoteId === normalized.remoteId,
            );
          if (
            previous.some(
              (row) =>
                row.ownerContext.kind === 'organization' &&
                !isSameWorkspaceContext(
                  row.ownerContext,
                  normalized.ownerContext,
                ),
            )
          ) {
            throw new Error('Resource install origin cannot be replaced');
          }
          if (
            normalized.uninstalledLocalResourceIds?.length &&
            previous.length
          ) {
            // A removal records only lifecycle state. It cannot advance or
            // rewind source metadata captured before this queued mutation.
            const latest = previous[previous.length - 1];
            normalized = {
              ...normalizeReceipt(latest),
              localResourceIds: normalized.localResourceIds,
              uninstalledLocalResourceIds:
                normalized.uninstalledLocalResourceIds,
            };
          }
          const aliases = Array.from(
            new Set([
              ...previous.flatMap((row) => row.localResourceIds ?? []),
              ...(normalized.localResourceIds ?? []),
            ]),
          );
          const removed = mergedUninstalledIds(previous, normalized);
          if (removed !== undefined)
            normalized.uninstalledLocalResourceIds = removed;
          if (aliases.length) normalized.localResourceIds = aliases;
          const previousHashes: Record<string, string> = {};
          const previousRoles: NonNullable<
            InstallReceipt['localResourceRoles']
          > = {};
          for (const row of previous) {
            Object.assign(previousRoles, row.localResourceRoles);
            for (const [id, hash] of Object.entries(
              row.localContentHashes ?? {},
            ))
              previousHashes[id] = hash;
          }
          // Older writers cannot justify a new baseline for existing copies.
          if (
            normalized.localContentHashes ||
            Object.keys(previousHashes).length
          )
            normalized.localContentHashes = {
              ...previousHashes,
              ...normalized.localContentHashes,
            };
          if (
            normalized.localResourceRoles ||
            Object.keys(previousRoles).length
          )
            normalized.localResourceRoles = {
              ...previousRoles,
              ...normalized.localResourceRoles,
            };
          for (const [ownerAccount, receipts] of Object.entries(
            state.byAccount,
          )) {
            if (
              receipts
                .filter(isInstallReceipt)
                .some(
                  (row) =>
                    row.family === normalized.family &&
                    (ownerAccount !== accountId ||
                      row.remoteId !== normalized.remoteId) &&
                    row.localResourceIds?.some((id) => aliases.includes(id)),
                )
            )
              throw new Error('Resource install origin cannot be replaced');
          }
          const next = rows.filter(
            (row) =>
              !isInstallReceipt(row) ||
              row.family !== normalized.family ||
              row.remoteId !== normalized.remoteId,
          );
          const accounts: [string, unknown[]][] = Object.entries(
            state.byAccount,
          );
          accounts.push([accountId, [...next, normalized]]);
          const updated: ReceiptFile = {
            version: 1,
            byAccount: Object.fromEntries(accounts),
          };
          await mkdir(dataDir, { recursive: true });
          await writeFileAtomically(
            file,
            `${JSON.stringify(updated, null, 2)}\n`,
            { mode: 0o600 },
          );
        },
      );
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      writes.set(file, settled);
      void settled.then(() => {
        if (writes.get(file) === settled) writes.delete(file);
      });
      return run;
    },
    rollbackInstall(receipt, previous): Promise<void> {
      // Only an aborted install may undo its newly created aliases. Preserve
      // older origins and any aliases added by another operation meanwhile.
      const run = (writes.get(file) ?? Promise.resolve()).then(
        async (): Promise<void> => {
          // Strict like every other mutation: a malformed account entry must
          // fail the rollback instead of being rewritten as an empty array.
          const state = await readReceipts(file, true);
          const rows = Object.prototype.hasOwnProperty.call(
            state.byAccount,
            accountId,
          )
            ? state.byAccount[accountId]
            : [];
          const next = rows.map((row): unknown => {
            // Malformed rows are provenance too: carry them through untouched.
            if (!isInstallReceipt(row)) return row;
            if (
              row.family !== receipt.family ||
              row.remoteId !== receipt.remoteId
            )
              return row;
            const added = (receipt.localResourceIds ?? []).filter(
              (id) => !previous?.localResourceIds?.includes(id),
            );
            const aliases = (row.localResourceIds ?? []).filter(
              (id) => !added.includes(id),
            );
            // A failed skill replacement must not advance its installed hash
            // or attribution. Compare the whole attempted snapshot so rollback
            // cannot erase a later update; aliases are reconciled separately.
            if (
              row.family === 'skills' &&
              previous &&
              JSON.stringify(
                normalizeReceipt({ ...row, localResourceIds: [] }),
              ) ===
                JSON.stringify(
                  normalizeReceipt({
                    ...receipt,
                    localResourceIds: [],
                    uninstalledLocalResourceIds: mergedUninstalledIds(
                      [previous],
                      receipt,
                    ),
                    localContentHashes:
                      receipt.localContentHashes || previous.localContentHashes
                        ? {
                            ...previous.localContentHashes,
                            ...receipt.localContentHashes,
                          }
                        : undefined,
                    localResourceRoles:
                      receipt.localResourceRoles || previous.localResourceRoles
                        ? {
                            ...previous.localResourceRoles,
                            ...receipt.localResourceRoles,
                          }
                        : undefined,
                  }),
                )
            ) {
              return {
                ...normalizeReceipt(previous),
                localResourceIds: aliases,
              };
            }
            return {
              ...row,
              localResourceIds: aliases,
              ...(row.localContentHashes
                ? {
                    localContentHashes: Object.fromEntries(
                      Object.entries(row.localContentHashes).filter(([id]) =>
                        aliases.includes(id),
                      ),
                    ),
                  }
                : {}),
              ...(row.localResourceRoles
                ? {
                    localResourceRoles: Object.fromEntries(
                      Object.entries(row.localResourceRoles).filter(([id]) =>
                        aliases.includes(id),
                      ),
                    ),
                  }
                : {}),
            };
          });
          state.byAccount[accountId] = next;
          await mkdir(dataDir, { recursive: true });
          await writeFileAtomically(
            file,
            `${JSON.stringify(state, null, 2)}\n`,
            { mode: 0o600 },
          );
        },
      );
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      writes.set(file, settled);
      void settled.then(() => {
        if (writes.get(file) === settled) writes.delete(file);
      });
      return run;
    },
    async find(
      family,
      remoteId,
      strict = false,
    ): Promise<InstallReceipt | undefined> {
      return (await listForAccount(strict)).find(
        (row) => row.family === family && row.remoteId === remoteId,
      );
    },
    async findLocal(
      family,
      localId,
    ): Promise<{ accountId: string; receipt: InstallReceipt } | undefined> {
      await writes.get(file);
      const state = await readReceipts(file);
      for (const [ownerAccount, receipts] of Object.entries(state.byAccount)) {
        const receipt = receipts
          .filter(isInstallReceipt)
          .find(
            (row) =>
              row.family === family && row.localResourceIds?.includes(localId),
          );
        if (receipt)
          return {
            accountId: ownerAccount,
            receipt: normalizeReceipt(receipt),
          };
      }
      return undefined;
    },
    async listOrganizationContentOwners(family, hash): Promise<string[]> {
      await writes.get(file);
      const state = await readReceipts(file);
      return Array.from(
        new Set(
          Object.values(state.byAccount).flatMap((rows) =>
            rows
              .filter(isInstallReceipt)
              .flatMap((row) =>
                row.family === family &&
                row.hash === hash &&
                row.ownerContext.kind === 'organization'
                  ? [row.ownerContext.organizationId]
                  : [],
              ),
          ),
        ),
      );
    },
    listForAccount,
  };
}
