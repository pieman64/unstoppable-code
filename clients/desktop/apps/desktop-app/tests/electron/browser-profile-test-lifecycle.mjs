import {
  appendFileSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
} from 'node:fs';
import {
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  mkdtemp as mkdtempAsync,
  open as openAsync,
  rename as renameAsync,
  rm as rmAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Browser-profile flows with potentially long Windows teardown use this
// fixture. Windows final close gets Playwright's separate fixture slot;
// product deadlines stay intact.
export function createTerminalCleanupFixture(platform = process.platform) {
  return [
    async ({}, use) => {
      let terminalCleanup;
      try {
        await use(async (cleanup) => {
          if (platform === 'win32') terminalCleanup = cleanup;
          else await cleanup();
        });
      } finally {
        await terminalCleanup?.();
      }
    },
    platform === 'win32' ? { timeout: 30_000 } : {},
  ];
}

const LARGE_INVENTORY_FILES = 10_000;
const LARGE_INVENTORY_BYTES = 107_375;
const LARGE_INVENTORY_BATCH_SIZE = 32;

function createLargeInventoryFixtureDiagnostic(
  directory = process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR,
) {
  if (!directory?.trim()) return undefined;
  try {
    mkdirSync(directory, { recursive: true });
    const base = path.resolve(
      directory,
      `large-inventory-fixture-${process.pid}-${randomUUID()}`,
    );
    return {
      base,
      record: createBoundaryRecorder(`${base}-fixture.jsonl`),
    };
  } catch {
    return undefined;
  }
}

// Preparation and fixture-owned cleanup share this fixture's explicit slot.
// The product flow keeps its independent test timeout.
export function createLargeInventoryFixture({
  record: initialRecord,
  temporaryDirectory = tmpdir(),
  mkdtemp = mkdtempAsync,
  mkdir = mkdirAsync,
  open = openAsync,
  lstat = lstatAsync,
  stat = statAsync,
  rename = renameAsync,
  rm = rmAsync,
  now = () => performance.now(),
} = {}) {
  return [
    async ({}, use) => {
      let stagingRoot;
      let fixtureDirectory;
      const fixtureDiagnostic = initialRecord
        ? undefined
        : createLargeInventoryFixtureDiagnostic();
      const records = new Set(
        [initialRecord, fixtureDiagnostic?.record].filter(Boolean),
      );
      let primaryError;
      let installAttempted = false;
      let transferred = false;
      const note = (stage, details = {}) => {
        for (const record of records) record(stage, details);
      };
      const attachRecord = (nextRecord, { launchBoundaryBase } = {}) => {
        for (const record of records)
          record('launch-boundary-link', {
            launchBoundaryBase,
            fixtureEvidenceBase: fixtureDiagnostic?.base,
          });
        if (!nextRecord) return;
        nextRecord('large-inventory-fixture-link', {
          launchBoundaryBase,
          fixtureEvidenceBase: fixtureDiagnostic?.base,
        });
        records.add(nextRecord);
      };
      try {
        stagingRoot = await mkdtemp(
          path.join(temporaryDirectory, 'canopy-browser-profile-inventory-'),
        );
        fixtureDirectory = path.join(stagingRoot, 'inventory-fixture');
        const preparationStart = now();
        const timing = {
          completedFiles: 0,
          logicalBytes: LARGE_INVENTORY_FILES * LARGE_INVENTORY_BYTES,
          open: { count: 0, totalMs: 0, maxMs: 0 },
          truncate: { count: 0, totalMs: 0, maxMs: 0 },
          close: { count: 0, totalMs: 0, maxMs: 0 },
          slowBatches: [],
        };
        let preparationError;
        const timedIo = (stage, index, operation) => {
          const started = now();
          const finish = (error) => {
            const elapsed = now() - started;
            timing[stage].count++;
            timing[stage].totalMs += elapsed;
            timing[stage].maxMs = Math.max(timing[stage].maxMs, elapsed);
            if (error && !preparationError) preparationError = { stage, index };
          };
          try {
            const result = operation();
            void result.then(
              () => finish(),
              (error) => finish(error),
            );
            return result;
          } catch (error) {
            finish(error);
            throw error;
          }
        };
        note('preparation', {
          outcome: 'entered',
          files: LARGE_INVENTORY_FILES,
          bytes: LARGE_INVENTORY_BYTES,
          batchSize: LARGE_INVENTORY_BATCH_SIZE,
        });
        try {
          await mkdir(fixtureDirectory);
          for (
            let first = 0;
            first < LARGE_INVENTORY_FILES;
            first += LARGE_INVENTORY_BATCH_SIZE
          ) {
            const batchStart = now();
            let batchError;
            const retainBatchError = (error) => {
              batchError ??= error;
            };
            try {
              await Promise.allSettled(
                Array.from(
                  {
                    length: Math.min(
                      LARGE_INVENTORY_BATCH_SIZE,
                      LARGE_INVENTORY_FILES - first,
                    ),
                  },
                  async (_, offset) => {
                    const index = first + offset;
                    let handle;
                    let fileError;
                    try {
                      handle = await timedIo('open', index, () =>
                        open(
                          path.join(fixtureDirectory, `fixture-${index}`),
                          'wx',
                        ),
                      );
                    } catch (error) {
                      fileError = error;
                      retainBatchError(error);
                    }
                    if (handle) {
                      try {
                        await timedIo('truncate', index, () =>
                          handle.truncate(LARGE_INVENTORY_BYTES),
                        );
                      } catch (error) {
                        fileError = error;
                        retainBatchError(error);
                      }
                      try {
                        await timedIo('close', index, () => handle.close());
                      } catch (error) {
                        if (fileError)
                          note('preparation-secondary-error', {
                            index,
                            primaryStage: 'truncate',
                            secondaryStage: 'close',
                            message: String(error?.message ?? error).slice(
                              0,
                              2_048,
                            ),
                          });
                        else {
                          fileError = error;
                          retainBatchError(error);
                        }
                      }
                    }
                    if (fileError) throw fileError;
                    timing.completedFiles++;
                    if (timing.completedFiles % 1024 === 0)
                      note('preparation-progress', {
                        completedFiles: timing.completedFiles,
                        wallMs: now() - preparationStart,
                      });
                  },
                ),
              );
              if (batchError) throw batchError;
            } finally {
              timing.slowBatches.push({
                first,
                files: Math.min(
                  LARGE_INVENTORY_BATCH_SIZE,
                  LARGE_INVENTORY_FILES - first,
                ),
                wallMs: now() - batchStart,
              });
              timing.slowBatches.sort(
                (left, right) => right.wallMs - left.wallMs,
              );
              timing.slowBatches.length = Math.min(
                8,
                timing.slowBatches.length,
              );
            }
          }
          note('preparation-summary', {
            ...timing,
            outcome: 'fulfilled',
            wallMs: now() - preparationStart,
            parallelDurationsAreWallTime: false,
          });
        } catch (error) {
          note('preparation-summary', {
            ...timing,
            outcome: 'rejected',
            error: preparationError ?? { stage: 'mkdir' },
            wallMs: now() - preparationStart,
            parallelDurationsAreWallTime: false,
          });
          throw error;
        }
        const inventory = Object.freeze({
          files: LARGE_INVENTORY_FILES,
          bytes: LARGE_INVENTORY_BYTES,
          logicalBytes: LARGE_INVENTORY_FILES * LARGE_INVENTORY_BYTES,
          preparationMs: now() - preparationStart,
          attachRecord,
          install: async (nativePath) => {
            if (installAttempted)
              throw new Error(
                'Large inventory installation was already attempted',
              );
            installAttempted = true;
            const destination = path.join(nativePath, 'inventory-fixture');
            try {
              await lstat(destination);
              throw new Error(
                `Large inventory destination already exists: ${destination}`,
              );
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error;
            }
            const [sourceIdentity, destinationIdentity] = await Promise.all([
              stat(fixtureDirectory),
              stat(nativePath),
            ]);
            const sameDevice = sourceIdentity.dev === destinationIdentity.dev;
            note('inventory-transfer', {
              outcome: 'entered',
              sameDevice,
              sourceDevice: String(sourceIdentity.dev),
              destinationDevice: String(destinationIdentity.dev),
            });
            if (!sameDevice)
              throw new Error(
                'Large inventory staging and destination must be on the same device',
              );
            const transferStart = now();
            try {
              await rename(fixtureDirectory, destination);
              transferred = true;
              note('inventory-transfer', {
                outcome: 'fulfilled',
                sameDevice: true,
                wallMs: now() - transferStart,
              });
            } catch (error) {
              note('inventory-transfer', {
                outcome: 'rejected',
                sameDevice: true,
                wallMs: now() - transferStart,
              });
              throw error;
            }
          },
        });
        await use(inventory);
      } catch (error) {
        primaryError = error;
      } finally {
        if (stagingRoot) {
          note('fixture-cleanup', {
            outcome: 'entered',
            ownership: transferred ? 'staging-root-only' : 'staged-inventory',
          });
          try {
            await rm(stagingRoot, { recursive: true, force: true });
            note('fixture-cleanup', { outcome: 'fulfilled' });
          } catch (error) {
            note('fixture-cleanup', { outcome: 'rejected' });
            primaryError ??= error;
          }
        }
      }
      if (primaryError) throw primaryError;
    },
    { timeout: 120_000 },
  ];
}

export async function runObservedCleanupSteps(steps, record) {
  let primaryError;
  for (const [stage, operation] of steps) {
    try {
      await observeBoundary(stage, operation, record);
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
}

// The selection hook runs before seedPanelWorktree rethrows the original error.
// Retain ownership first: even diagnostic capture can fail.
export function retainSelectionFailureOwner(owner, diagnostic) {
  return async (context) => {
    owner.electronApp = context.electronApp;
    owner.userDataDir = context.userDataDir;
    await diagnostic?.(context);
  };
}

// All callbacks are fixture-owned. Capture and cleanup failures cannot replace
// the primary setup error; cleanup always receives exactly the launched owner.
export async function reportOwnedSetupFailure(
  context,
  error,
  { capture, close, record } = {},
) {
  for (const [phase, action] of [
    ['setup-capture', () => capture?.({ ...context, error })],
    ['setup-cleanup', () => close?.(context.electronApp, context.userDataDir)],
  ]) {
    try {
      await action();
    } catch (failure) {
      try {
        record?.(phase, {
          outcome: 'rejected',
          message: String(failure?.message ?? failure).slice(0, 2048),
        });
      } catch {
        /* Observer only. */
      }
    }
  }
  throw error;
}

export function captureFixtureCatalog(userDataDir, workspaceIds) {
  const files = [path.join(userDataDir, 'workspaces', 'index.json')];
  const boundedWorkspaceIds = [];
  for (
    let index = 0;
    index < workspaceIds.length && index < 16 && boundedWorkspaceIds.length < 8;
    index++
  ) {
    const id = workspaceIds[index];
    if (typeof id === 'string' && id.length <= 128 && /^[a-z0-9-]+$/i.test(id))
      boundedWorkspaceIds.push(id);
  }
  for (const id of boundedWorkspaceIds)
    for (const name of ['workspace.json', 'worktrees.json'])
      files.push(path.join(userDataDir, 'workspaces', id, name));
  const identity = (value) =>
    Object.fromEntries(
      ['id', 'kind', 'type', 'workspaceId', 'worktreeId'].flatMap((key) =>
        typeof value?.[key] === 'string'
          ? [[key, value[key].slice(0, 128)]]
          : [],
      ),
    );
  return {
    userDataDir,
    indexPath: files[0],
    files: files.map((file) => {
      let fd, byteEvidence;
      try {
        try {
          fd = openSync(file, 'r');
        } catch (error) {
          return {
            path: file,
            status: error?.code === 'ENOENT' ? 'absent' : 'read-error',
            identityTotalCount: 0,
            identityAvailableCount: 0,
            identityOmittedCount: 0,
          };
        }
        const buffer = Buffer.alloc(65537);
        let count;
        try {
          count = readSync(fd, buffer, 0, buffer.length, 0);
        } catch {
          return {
            path: file,
            status: 'read-error',
            identityTotalCount: 0,
            identityAvailableCount: 0,
            identityOmittedCount: 0,
          };
        }
        const body = buffer.subarray(0, count);
        byteEvidence = {
          sizeBytes: count,
          sha256: createHash('sha256').update(body).digest('hex'),
        };
        if (count > 65536)
          return {
            path: file,
            status: 'oversize',
            ...byteEvidence,
            identityTotalCount: 0,
            identityAvailableCount: 0,
            identityOmittedCount: 0,
            truncated: true,
          };
        let value;
        try {
          value = JSON.parse(body.toString('utf8'));
        } catch {
          return {
            path: file,
            status: 'parse-error',
            ...byteEvidence,
            identityTotalCount: 0,
            identityAvailableCount: 0,
            identityOmittedCount: 0,
          };
        }
        const invalidShape = () => ({
          path: file,
          status: 'invalid-shape',
          ...byteEvidence,
          identityTotalCount: 0,
          identityAvailableCount: 0,
          identityOmittedCount: 0,
        });
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return invalidShape();
        let rows;
        if (Object.hasOwn(value, 'workspaces')) rows = value.workspaces;
        else if (Object.hasOwn(value, 'worktrees')) rows = value.worktrees;
        else rows = [value];
        if (!rows || typeof rows !== 'object') return invalidShape();
        let entries, identities;
        try {
          entries = Array.isArray(rows) ? rows : Object.values(rows);
          identities = entries.slice(0, 32).map(identity);
        } catch {
          return invalidShape();
        }
        return {
          path: file,
          status: 'success',
          ...byteEvidence,
          version:
            typeof value.version === 'number' ? value.version : undefined,
          identities,
          identityTotalCount: entries.length,
          identityAvailableCount: identities.length,
          identityOmittedCount: Math.max(0, entries.length - identities.length),
          truncated: entries.length > 32,
        };
      } catch {
        return {
          path: file,
          status: byteEvidence ? 'invalid-shape' : 'read-error',
          ...byteEvidence,
          identityTotalCount: 0,
          identityAvailableCount: 0,
          identityOmittedCount: 0,
        };
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }),
  };
}

function recordFirstProjectsLoadCatalog(record, phase, catalog, workspaceIds) {
  if (!record?.prepare || !record?.appendPrepared) return;
  const validWorkspaceIds = [];
  for (
    let index = 0;
    index < workspaceIds.length && index < 16 && validWorkspaceIds.length < 8;
    index++
  ) {
    const id = workspaceIds[index];
    if (
      typeof id === 'string' &&
      id.length <= 128 &&
      /^[a-z0-9._-]+$/i.test(id)
    )
      validWorkspaceIds.push(id);
  }
  const roles = [{ role: 'workspace-index' }];
  for (const workspaceId of validWorkspaceIds)
    for (const role of ['workspace-config', 'workspace-worktrees'])
      roles.push({ role, workspaceId });
  const files = Array.isArray(catalog?.files) ? catalog.files.slice(0, 17) : [];
  let remainingWorkspaceIds = 8;
  let remainingWorktreeIds = 32;
  let invalidIdCount = 0;
  const safeId = (value) =>
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[a-z0-9._-]+$/i.test(value);
  const detailsByFile = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const role = roles[index] ?? { role: 'unavailable' };
    const status = [
      'success',
      'absent',
      'read-error',
      'parse-error',
      'invalid-shape',
      'oversize',
    ].includes(file?.status)
      ? file.status
      : 'read-error';
    const details = {
      phase,
      role: role.role,
      ...(safeId(role.workspaceId) ? { workspaceId: role.workspaceId } : {}),
      status,
      ...(Number.isSafeInteger(file?.sizeBytes) && file.sizeBytes >= 0
        ? { sizeBytes: file.sizeBytes }
        : {}),
      ...(typeof file?.sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(file.sha256)
        ? { sha256: file.sha256 }
        : {}),
      ...(Number.isSafeInteger(file?.version) && file.version >= 0
        ? { version: file.version }
        : {}),
      workspaceIds: [],
      worktreeIds: [],
      truncated: file?.truncated === true,
    };
    const identities = Array.isArray(file?.identities) ? file.identities : [];
    let inspectedIdentityCount = 0;
    let availableIdentityCount = 0;
    for (
      let identityIndex = 0;
      identityIndex < identities.length && inspectedIdentityCount < 32;
      identityIndex++
    ) {
      inspectedIdentityCount++;
      let identity;
      try {
        identity = identities[identityIndex];
      } catch {
        invalidIdCount++;
        continue;
      }
      const workspaceId =
        identity?.workspaceId ??
        (role.role === 'workspace-index' ? identity?.id : undefined);
      const worktreeId =
        identity?.worktreeId ??
        (role.role === 'workspace-worktrees' ? identity?.id : undefined);
      let retained = false;
      if (workspaceId !== undefined && remainingWorkspaceIds > 0) {
        if (safeId(workspaceId)) {
          details.workspaceIds.push(workspaceId);
          remainingWorkspaceIds--;
          retained = true;
        } else invalidIdCount++;
      }
      if (worktreeId !== undefined && remainingWorktreeIds > 0) {
        if (safeId(worktreeId)) {
          details.worktreeIds.push(worktreeId);
          remainingWorktreeIds--;
          retained = true;
        } else invalidIdCount++;
      }
      if (retained) availableIdentityCount++;
    }
    const identityTotalCount = Number.isSafeInteger(file?.identityTotalCount)
      ? file.identityTotalCount
      : identities.length;
    details.identityTotalCount = identityTotalCount;
    details.identityAvailableCount = availableIdentityCount;
    details.identityOmittedCount = Math.max(
      0,
      identityTotalCount - availableIdentityCount,
    );
    details.truncated = details.truncated || details.identityOmittedCount > 0;
    detailsByFile.push(details);
  }
  const totalFileCount = Math.max(files.length, roles.length);
  const availableFileCount = files.filter(
    (file) => file?.status === 'success',
  ).length;
  const unavailableFileCount = totalFileCount - availableFileCount;
  const preparedRows = [];
  let fileBytes = 0;
  const summaryDetails = (recordedFileCount) => {
    const omittedFileCount = totalFileCount - recordedFileCount;
    return {
      phase,
      status: catalog?.status === 'unavailable' ? 'unavailable' : 'complete',
      totalFileCount,
      recordedFileCount,
      omittedFileCount,
      availableFileCount,
      unavailableFileCount,
      projectedBytes: fileBytes,
      invalidIdCount,
      truncated:
        omittedFileCount > 0 ||
        detailsByFile.some((details) => details.truncated === true),
    };
  };
  for (const details of detailsByFile) {
    if (preparedRows.length >= 19) break;
    const prepared = record.prepare('projects-load-catalog-file', details);
    if (!prepared) return;
    const prospectiveBytes = fileBytes + prepared.bytes;
    const reservedSummary = record.prepare(
      'projects-load-catalog-summary',
      summaryDetails(preparedRows.length + 1),
    );
    if (!reservedSummary) return;
    if (prospectiveBytes + reservedSummary.bytes > 16_384) break;
    preparedRows.push(prepared);
    fileBytes = prospectiveBytes;
  }
  let summary = record.prepare(
    'projects-load-catalog-summary',
    summaryDetails(preparedRows.length),
  );
  if (!summary) return;
  while (preparedRows.length > 0 && fileBytes + summary.bytes > 16_384) {
    fileBytes -= preparedRows.pop().bytes;
    summary = record.prepare(
      'projects-load-catalog-summary',
      summaryDetails(preparedRows.length),
    );
    if (!summary) return;
  }
  for (const prepared of preparedRows) record.appendPrepared(prepared);
  record.appendPrepared(summary);
}

// Immediate append, bounded per fixture, so a worker timeout cannot erase the
// final entered boundary. Missing settlement records are never called success.
export function createBoundaryRecorder(file) {
  if (!file) return undefined;
  const start = process.hrtime.bigint();
  let count = 0,
    bytes = 0,
    stopped = false;
  const prepare = (stage, details = {}) => {
    if (stopped) return undefined;
    try {
      const line =
        JSON.stringify({
          stage,
          monotonicNs: process.hrtime.bigint().toString(),
          elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
          ...details,
        }) + '\n';
      return { line, bytes: Buffer.byteLength(line) };
    } catch {
      stopped = true;
      return undefined;
    }
  };
  const appendPrepared = (prepared) => {
    if (stopped || !prepared) return;
    try {
      let { line } = prepared;
      let lineBytes = prepared.bytes;
      if (count >= 255 || lineBytes > 16384 || bytes + lineBytes > 127 * 1024) {
        line =
          JSON.stringify({ stage: 'observer-truncated', records: count }) +
          '\n';
        lineBytes = Buffer.byteLength(line);
        stopped = true;
      }
      appendFileSync(file, line);
      bytes += lineBytes;
      count++;
    } catch {
      stopped = true;
    }
  };
  const record = (stage, details = {}) => {
    if (stopped) return;
    try {
      const prepared = prepare(stage, details);
      if (prepared) appendPrepared(prepared);
    } catch {
      stopped = true;
    }
  };
  record.prepare = prepare;
  record.appendPrepared = appendPrepared;
  // Carry the existing observer to the shared close harness by injection;
  // launchCanopy never imports this fixture-only module.
  record.observe = (stage, operation) =>
    observeBoundary(stage, operation, record);
  return record;
}

export function observeBoundary(stage, operation, record) {
  if (!record) return operation();
  const note = (details) => {
    try {
      record?.(stage, details);
    } catch {
      /* Passive observer. */
    }
  };
  note({ outcome: 'entered' });
  try {
    const result = operation();
    if (result instanceof Promise)
      void result.then(
        () => note({ outcome: 'fulfilled' }),
        (error) =>
          note({
            outcome: 'rejected',
            message: boundaryErrorMessage(error),
            code: boundaryErrorCode(error),
          }),
      );
    else note({ outcome: 'fulfilled' });
    return result;
  } catch (error) {
    note({
      outcome: 'rejected',
      message: boundaryErrorMessage(error),
      code: boundaryErrorCode(error),
    });
    throw error;
  }
}

function boundaryErrorMessage(error) {
  try {
    return String(error?.message ?? error).slice(0, 2_048);
  } catch {
    return 'Unreadable diagnostic error';
  }
}

function boundaryErrorCode(error) {
  try {
    const code = error?.code;
    return code === undefined ? undefined : String(code).slice(0, 128);
  } catch {
    return undefined;
  }
}

// This observer owns only fixture-local server/socket state and is installed
// only when its selected boundary recorder exists.
export function createLocalHttpBoundaryObserver(server, heldResponses, record) {
  if (!record) return undefined;
  const sockets = new Set();
  let acceptedSockets = 0;
  let closedSockets = 0;
  let acceptedAfterListenerClose = 0;
  let listenerCloseEntered = false;
  const snapshot = () => ({
    listening: Boolean(server.listening),
    acceptedSockets,
    closedSockets,
    openSockets: sockets.size,
    acceptedAfterListenerClose,
    heldResponses: {
      total: heldResponses.length,
      destroyed: heldResponses.filter(({ response }) => response.destroyed)
        .length,
      writableEnded: heldResponses.filter(
        ({ response }) => response.writableEnded,
      ).length,
    },
  });
  const note = (stage, details) => {
    try {
      record(stage, { ...details, ...snapshot() });
    } catch {
      /* Passive observer. */
    }
  };
  server.on('connection', (socket) => {
    acceptedSockets++;
    if (listenerCloseEntered) acceptedAfterListenerClose++;
    sockets.add(socket);
    note('server-connection', { outcome: 'accepted' });
    socket.once('close', () => {
      closedSockets++;
      sockets.delete(socket);
      note('server-connection', { outcome: 'closed' });
    });
  });
  server.once('close', () =>
    note('server-natural-close', { outcome: 'observed' }),
  );
  return {
    snapshot,
    markListenerCloseEntered() {
      listenerCloseEntered = true;
    },
    recordCloseCallback(error, synchronous = false) {
      note('server-close-callback', {
        outcome: error ? 'rejected' : 'fulfilled',
        ...(error
          ? {
              message: boundaryErrorMessage(error),
              code: boundaryErrorCode(error),
            }
          : {}),
        ...(synchronous ? { synchronous: true } : {}),
      });
    },
  };
}

export function createObservedCleanupRecorder({
  evidence,
  record,
  serverBoundary,
  launchIdentity,
}) {
  return (stage, detail) => {
    evidence.cleanup.push({ stage, ...detail });
    if (stage === 'server-close' && detail.outcome === 'entered')
      serverBoundary?.markListenerCloseEntered();
    try {
      record?.(stage, {
        ...detail,
        ...(stage === 'server-connections-close' || stage === 'server-close'
          ? serverBoundary?.snapshot()
          : {}),
        ...(stage === 'owner-close' ? { launchIdentity } : {}),
      });
    } catch {
      /* Passive observer. */
    }
  };
}

export function closeServerWithBoundary(server, serverBoundary) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        serverBoundary.recordCloseCallback(error);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      serverBoundary.recordCloseCallback(error, true);
      throw error;
    }
  });
}

// One immutable launch identity; callers retain the exact returned owner across
// close attempts. No registry, transport probe, or new cleanup budget.
export function createSelectedLaunchBoundary(
  caseId,
  label,
  {
    close,
    owners = [],
    firstProjectsLoad = false,
    directory = process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR,
  } = {},
) {
  const launchId = `${caseId}-${label}-${process.pid}-${randomUUID()}`;
  let base, record;
  if (directory?.trim()) {
    try {
      mkdirSync(directory, { recursive: true });
      base = path.resolve(directory, launchId);
      const append = createBoundaryRecorder(`${base}-fixture.jsonl`);
      const envelope = (details = {}) => ({
        caseId,
        launchId,
        fixturePid: process.pid,
        wallTime: new Date().toISOString(),
        ...details,
      });
      record = (stage, details = {}) => append(stage, envelope(details));
      record.prepare = (stage, details = {}) =>
        append.prepare(stage, envelope(details));
      record.appendPrepared = (prepared) => append.appendPrepared(prepared);
      record.observe = (stage, operation) =>
        observeBoundary(stage, operation, record);
    } catch {
      /* Output is optional; owner cleanup is not. */
    }
  }
  const mainFile = base && `${base}-main.jsonl`;
  const firstProjectsLoadFile =
    firstProjectsLoad && base ? `${base}-first-projects-load.jsonl` : undefined;
  const options = mainFile
    ? {
        env: {
          CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
            file: mainFile,
            mode: 'close',
            caseId,
            launchId,
            fixturePid: process.pid,
            owners,
            ...(firstProjectsLoadFile
              ? {
                  firstProjectsLoad: true,
                  firstProjectsLoadFile,
                }
              : {}),
          }),
        },
      }
    : {};
  let prelaunchCatalog;
  let prelaunchWorkspaceIds = [];
  if (firstProjectsLoadFile) {
    options.onBeforeLaunch = ({ userDataDir, workspaceIds }) => {
      try {
        prelaunchWorkspaceIds = workspaceIds.slice(0, 16);
        prelaunchCatalog = captureFixtureCatalog(userDataDir, workspaceIds);
        recordFirstProjectsLoadCatalog(
          record,
          'prelaunch',
          prelaunchCatalog,
          workspaceIds,
        );
      } catch {
        recordFirstProjectsLoadCatalog(
          record,
          'prelaunch',
          { status: 'unavailable', files: [] },
          workspaceIds,
        );
      }
    };
  }
  let attempts = 0,
    closed = false,
    primary;
  const closeOwner = async (owner, options = {}) => {
    if (!owner || closed) return;
    record?.('fixture-close', {
      outcome: 'entered',
      attempt: ++attempts,
      userDataDir: owner.userDataDir,
    });
    try {
      await close(owner.electronApp, owner.userDataDir, {
        ...options,
        boundaryRecord: record,
      });
      closed = true;
    } catch (error) {
      primary ??= error;
      throw primary;
    }
  };
  options.onSetupFailure = (context) =>
    reportOwnedSetupFailure(context, context.error, {
      capture: firstProjectsLoadFile
        ? () => {
            const workspaceIds = (
              prelaunchWorkspaceIds.length > 0
                ? prelaunchWorkspaceIds
                : owners.map((owner) => owner.projectId)
            ).filter((id, index, all) => all.indexOf(id) === index);
            let failureCatalog;
            try {
              failureCatalog = captureFixtureCatalog(
                context.userDataDir,
                workspaceIds,
              );
            } catch {
              failureCatalog = { status: 'unavailable', files: [] };
            }
            recordFirstProjectsLoadCatalog(
              record,
              'failure',
              failureCatalog,
              workspaceIds,
            );
            if (!prelaunchCatalog)
              record?.('projects-load-catalog-prelaunch-status', {
                status: 'unavailable',
              });
          }
        : undefined,
      close: () => closeOwner(context),
      record,
    });
  return {
    base,
    mainFile,
    firstProjectsLoadFile,
    record,
    options,
    close: closeOwner,
  };
}
