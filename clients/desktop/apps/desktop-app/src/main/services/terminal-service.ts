import { isScriptActionRelativePath } from '@canopy/protocol/script-actions';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { resolveTerminalRelativeCwd } from '@canopy/desktop-shared/node/terminal-relative-cwd';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  TERMINAL_USER_CLOSE_SIGNAL,
  type ManagedTerminalCommand,
  type PortalEntityEnvelope,
  type PortalEventEnvelope,
  type PortalTarget,
  type PortalTerminalOutputPayload,
  type TerminalKillRequest,
  type TerminalResizeRequest,
  type TerminalRestoreRequest,
  type TerminalSession,
  type TerminalShellProfile,
  type TerminalShellProfileId,
  type TerminalSpawnRequest,
  type TerminalWriteRequest,
  type TerminalWriteDisposition,
} from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { assertNotSplitLocked } from './split-lock-service';
import {
  isBlockedManagedEnvName,
  type WorkerTerminalEvent,
} from '@canopy/core-runtime/node/terminal';
import { workerTerminal } from '../terminal/worker-terminal';
import { createPortalEvent } from '../portal/portal-event-bus';
import { getBundledClaudeBinaryPath } from '../pipelines/config-paths';
import { detectGitExecutable } from '../lib/git-executable';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import {
  isSharedContainerAccepted,
  isSharedContainerRunAllowed,
  withSharedContainerRunLifecycle,
} from '../shared-containers/acceptance-store';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import {
  ensureSharedContainerRunCopy,
  getSharedContainerRunCopyState,
} from '../shared-containers/run/run-copy';
import { readSharedContainerRunEnvironment } from '../shared-containers/run-env-store';
import { buildSharedContainerRunEnv } from '../lib/shared-container-run-env';

const MAX_TERMINAL_WRITE_BYTES = 64 * 1024;
const MAX_TERMINAL_WRITE_RECEIPTS = 4096;
const terminalOutputDecoders = new Map<string, StringDecoder>();
const terminalWriteReceipts = new Map<string, true>();

function rememberTerminalWriteReceipt(receiptKey: string): void {
  terminalWriteReceipts.set(receiptKey, true);
  while (terminalWriteReceipts.size > MAX_TERMINAL_WRITE_RECEIPTS) {
    const oldestKey = terminalWriteReceipts.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    terminalWriteReceipts.delete(oldestKey);
  }
}

export function rememberTerminalInitialPrompt(
  terminalId: string,
  idempotencyKey: string,
): void {
  validateTerminalId(terminalId);
  try {
    validateId(idempotencyKey, 'initialPromptIdempotencyKey');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const suffix of ['clear-0', 'clear-1', 'clear-2', 'paste', 'submit']) {
    rememberTerminalWriteReceipt(`${terminalId}:${idempotencyKey}-${suffix}`);
  }
}

export class TerminalServiceError extends Error {
  public constructor(
    public readonly code: 'invalid_payload' | 'invalid_target' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'TerminalServiceError';
  }
}

function validateTerminalDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TerminalServiceError(
      'invalid_payload',
      `Invalid ${label}: must be a positive integer`,
    );
  }
}

function validateTerminalId(terminalId: string): void {
  try {
    validateId(terminalId, 'terminalId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function validateInitialCommand(initialCommand: unknown): void {
  if (initialCommand === undefined) return;
  if (
    typeof initialCommand !== 'string' ||
    initialCommand.trim().length === 0 ||
    Buffer.byteLength(initialCommand, 'utf8') > MAX_TERMINAL_WRITE_BYTES
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid initial terminal command',
    );
  }
}

interface TerminalOperationScope {
  projectId?: string;
  worktreeId?: string;
}

function validateTerminalOperationScope(scope: TerminalOperationScope): void {
  try {
    if (scope.projectId) validateId(scope.projectId, 'projectId');
    if (scope.worktreeId) validateId(scope.worktreeId, 'worktreeId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertTerminalAuthorized(
  terminalId: string,
  scope: TerminalOperationScope,
): void {
  const session = workerTerminal
    .list()
    .find((candidate) => candidate.id === terminalId);
  if (!session) {
    throw new TerminalServiceError(
      'not_found',
      `Terminal not found: ${terminalId}`,
    );
  }
  if (
    (scope.projectId && session.projectId !== scope.projectId) ||
    (scope.worktreeId && session.worktreeId !== scope.worktreeId)
  ) {
    throw new TerminalServiceError(
      'not_found',
      `Terminal not found: ${terminalId}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTerminalProfileId(
  value: unknown,
): asserts value is TerminalShellProfileId | undefined {
  if (value === undefined) {
    return;
  }
  if (
    value === 'default' ||
    value === 'zsh' ||
    value === 'bash' ||
    value === 'cmd' ||
    value === 'powershell' ||
    value === 'git-bash'
  ) {
    return;
  }
  throw new TerminalServiceError(
    'invalid_payload',
    'Invalid terminal profile id',
  );
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateManagedCommand(
  command: ManagedTerminalCommand,
  options: { allowPathPrepend?: boolean } = {},
): void {
  if (command.kind !== 'claude-code' && command.kind !== 'claude-worker') {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal command kind',
    );
  }
  if (
    typeof command.executable !== 'string' ||
    !path.isAbsolute(command.executable)
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal executable: must be an absolute path',
    );
  }
  const bundledClaudePath = getBundledClaudeBinaryPath();
  if (
    normalizeComparablePath(command.executable) !==
    normalizeComparablePath(bundledClaudePath)
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal executable: must use the bundled Claude binary',
    );
  }
  if (
    !Array.isArray(command.args) ||
    !command.args.every((arg) => typeof arg === 'string')
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal args: must be an array of strings',
    );
  }
  if (command.env !== undefined) {
    if (!isRecord(command.env)) {
      throw new TerminalServiceError(
        'invalid_payload',
        'Invalid managed terminal env: must be a string record',
      );
    }
    for (const [name, value] of Object.entries(command.env)) {
      if (typeof name !== 'string' || typeof value !== 'string') {
        throw new TerminalServiceError(
          'invalid_payload',
          'Invalid managed terminal env: must be a string record',
        );
      }
      if (isBlockedManagedEnvName(name)) {
        throw new TerminalServiceError(
          'invalid_payload',
          `Invalid managed terminal env: blocked key ${name}`,
        );
      }
    }
  }
  if (command.pathPrepend !== undefined) {
    if (!options.allowPathPrepend) {
      throw new TerminalServiceError(
        'invalid_payload',
        'Invalid managed terminal pathPrepend: only internal launches may set path overrides',
      );
    }
    if (
      !Array.isArray(command.pathPrepend) ||
      !command.pathPrepend.every(
        (entry) => typeof entry === 'string' && path.isAbsolute(entry),
      )
    ) {
      throw new TerminalServiceError(
        'invalid_payload',
        'Invalid managed terminal pathPrepend: entries must be absolute paths',
      );
    }
  }
  if (typeof command.title !== 'string' || command.title.trim().length === 0) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Invalid managed terminal title',
    );
  }
}

function sessionMatchesTarget(
  session: TerminalSession,
  target?: PortalTarget,
): boolean {
  if (!target) {
    return true;
  }
  if (
    target.workspaceLocalId &&
    target.workspaceLocalId !== session.projectId
  ) {
    return false;
  }
  if (target.worktreeLocalId && target.worktreeLocalId !== session.worktreeId) {
    return false;
  }
  if (target.terminalLocalId && target.terminalLocalId !== session.id) {
    return false;
  }
  return true;
}

export function spawnTerminal(request: TerminalSpawnRequest): TerminalSession {
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    throw new TerminalServiceError(
      'invalid_target',
      'Shared-container terminals require run consent.',
    );
  }
  return spawnTerminalWithEnvironment(request);
}

function spawnTerminalWithEnvironment(
  request: TerminalSpawnRequest,
  environmentOverride?: NodeJS.ProcessEnv,
): TerminalSession {
  try {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
  assertNotSplitLocked(
    request.projectId,
    request.worktreeId,
    'opening a terminal',
  );
  validateTerminalDimension(request.cols, 'cols');
  validateTerminalDimension(request.rows, 'rows');
  validateTerminalProfileId(request.terminalProfileId);
  validateInitialCommand(request.initialCommand);
  if (
    request.managedCommand &&
    (request.terminalProfileId !== undefined ||
      request.initialCommand !== undefined)
  ) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Managed terminal commands cannot set a shell profile or initial command',
    );
  }
  let relativeCwd: string | undefined;
  if (request.relativeCwd !== undefined && request.relativeCwd !== '') {
    try {
      relativeCwd = resolveTerminalRelativeCwd(
        resolveWorktreeCwd(
          request.projectId,
          request.worktreeId,
          request.selectedRepoId,
        ),
        request.relativeCwd,
      );
    } catch {
      throw new TerminalServiceError(
        'invalid_target',
        'Invalid relative terminal directory.',
      );
    }
  }
  if (request.managedCommand) {
    validateManagedCommand(request.managedCommand);
  }
  return workerTerminal.create({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    cols: request.cols,
    rows: request.rows,
    repoId: request.selectedRepoId,
    managedCommand: request.managedCommand,
    cwd: relativeCwd,
    ...(request.managedCommand
      ? {}
      : {
          profileId: request.terminalProfileId,
          initialCommand: request.initialCommand,
        }),
    environment: environmentOverride,
  });
}

async function authorizeRelativeTerminalTarget(
  request: TerminalSpawnRequest,
): Promise<void> {
  if (request.relativeCwd === undefined || request.relativeCwd === '') return;
  if (!isScriptActionRelativePath(request.relativeCwd))
    throw new TerminalServiceError(
      'invalid_target',
      'Invalid relative terminal directory.',
    );
  try {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
    const { config, authority } = await readWorkspaceConfigDetailed(
      request.projectId,
    );
    if (authority !== 'ok' || config.type === 'cowork') throw new Error();
    const worktrees = await readWorkspaceWorktrees(request.projectId);
    if (!worktrees.some((worktree) => worktree.id === request.worktreeId))
      throw new Error();
    if (
      request.selectedRepoId &&
      request.selectedRepoId !== WORKSPACE_ROOT_REPO_ID
    ) {
      const valid =
        config.type === 'single-repo'
          ? request.selectedRepoId === SINGLE_REPO_USAGE_REPO_ID
          : config.repos.some((repo) => repo.id === request.selectedRepoId);
      if (!valid) throw new Error();
    }
  } catch {
    throw new TerminalServiceError(
      'invalid_target',
      'Terminal target does not belong to this workspace.',
    );
  }
}

/**
 * Opens a terminal for a user entry point (renderer IPC, Portal). On Linux x64
 * a Default shell may need the account lookup, so it is awaited off the main
 * thread first; shell selection remains synchronous and cache-only.
 */
export async function spawnTerminalAfterShellPrewarm(
  request: TerminalSpawnRequest,
): Promise<TerminalSession> {
  await authorizeRelativeTerminalTarget(request);
  if (
    request.managedCommand === undefined &&
    (request.terminalProfileId === undefined ||
      request.terminalProfileId === 'default')
  ) {
    await workerTerminal.prewarmShell();
  }
  return spawnTerminal(request);
}

export async function spawnTerminalForRenderer(
  request: TerminalSpawnRequest,
): Promise<TerminalSession> {
  if (request.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return spawnTerminalAfterShellPrewarm(request);
  }
  if (request.relativeCwd !== undefined && request.relativeCwd !== '') {
    throw new TerminalServiceError(
      'invalid_target',
      'Package terminal directories require a code workspace.',
    );
  }
  return withSharedContainerRunLifecycle(
    request.worktreeId,
    async (): Promise<TerminalSession> => {
      if (
        process.platform !== 'darwin' ||
        !getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
        ) ||
        !(await isSharedContainerAccepted(request.worktreeId)) ||
        !(await isSharedContainerRunAllowed(request.worktreeId))
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container terminals require run consent.',
        );
      }
      const reader = getSharedContainerReader();
      const state = await reader.store.get(request.worktreeId);
      if (state?.status !== 'available' && state?.status !== 'pinned') {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container revision is not available.',
        );
      }
      const run = await reader.readRunConfig({
        containerId: request.worktreeId,
        revisionId: state.revisionId,
      });
      if (!run) {
        throw new TerminalServiceError(
          'invalid_target',
          'This share did not publish run configuration.',
        );
      }
      const runCopy = await getSharedContainerRunCopyState(request.worktreeId);
      if (
        runCopy.state === 'committed' &&
        runCopy.revisionId !== state.revisionId
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Update the shared-container run copy before opening a terminal.',
        );
      }
      await ensureSharedContainerRunCopy(
        request.worktreeId,
        reader.store,
        state.revisionId,
      );
      const declared = new Set(run.requiredEnv);
      const values = (
        await readSharedContainerRunEnvironment(request.worktreeId)
      ).filter((entry) => declared.has(entry.key));
      return spawnTerminalWithEnvironment(
        request,
        buildSharedContainerRunEnv(request.worktreeId, values),
      );
    },
  );
}

export async function restoreTerminalForRenderer(
  request: TerminalRestoreRequest,
  session: TerminalSession | undefined,
): Promise<TerminalSession> {
  if (session?.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return workerTerminal.restore({
      terminalId: request.terminalId,
      cols: request.cols,
      rows: request.rows,
    });
  }
  return withSharedContainerRunLifecycle(
    session.worktreeId,
    async (): Promise<TerminalSession> => {
      if (
        process.platform !== 'darwin' ||
        !getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
        ) ||
        !(await isSharedContainerAccepted(session.worktreeId)) ||
        !(await isSharedContainerRunAllowed(session.worktreeId))
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container terminals require run consent.',
        );
      }
      const reader = getSharedContainerReader();
      const state = await reader.store.get(session.worktreeId);
      if (state?.status !== 'available' && state?.status !== 'pinned') {
        throw new TerminalServiceError(
          'invalid_target',
          'Shared-container revision is not available.',
        );
      }
      const run = await reader.readRunConfig({
        containerId: session.worktreeId,
        revisionId: state.revisionId,
      });
      if (!run) {
        throw new TerminalServiceError(
          'invalid_target',
          'This share did not publish run configuration.',
        );
      }
      const runCopy = await getSharedContainerRunCopyState(session.worktreeId);
      if (
        runCopy.state === 'committed' &&
        runCopy.revisionId !== state.revisionId
      ) {
        throw new TerminalServiceError(
          'invalid_target',
          'Update the shared-container run copy before restoring this terminal.',
        );
      }
      await ensureSharedContainerRunCopy(
        session.worktreeId,
        reader.store,
        state.revisionId,
      );
      const declared = new Set(run.requiredEnv);
      const values = (
        await readSharedContainerRunEnvironment(session.worktreeId)
      ).filter((entry) => declared.has(entry.key));
      return workerTerminal.restore({
        terminalId: request.terminalId,
        cols: request.cols,
        rows: request.rows,
        environment: buildSharedContainerRunEnv(session.worktreeId, values),
      });
    },
  );
}

export async function listTerminalProfiles(): Promise<TerminalShellProfile[]> {
  if (process.platform === 'win32') {
    await detectGitExecutable().catch(() => undefined);
  }
  await workerTerminal.prewarmShell();
  return workerTerminal.profiles();
}

export function spawnManagedTerminal(
  request: TerminalSpawnRequest & { cwd?: string },
): TerminalSession {
  if (!request.managedCommand) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Managed terminal command is required',
    );
  }
  try {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateOptionalRepoId(request.selectedRepoId, 'selectedRepoId');
  } catch (error) {
    throw new TerminalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : String(error),
    );
  }
  assertNotSplitLocked(
    request.projectId,
    request.worktreeId,
    'opening a terminal',
  );
  validateTerminalDimension(request.cols, 'cols');
  validateTerminalDimension(request.rows, 'rows');
  validateManagedCommand(request.managedCommand, { allowPathPrepend: true });
  return workerTerminal.create({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    cols: request.cols,
    rows: request.rows,
    repoId: request.selectedRepoId,
    managedCommand: request.managedCommand,
    cwd:
      request.relativeCwd === undefined || request.relativeCwd === ''
        ? request.cwd
        : ((): string | undefined => {
            if (request.cwd !== undefined)
              throw new TerminalServiceError(
                'invalid_target',
                'Cannot combine relative and absolute terminal directories.',
              );
            try {
              return resolveTerminalRelativeCwd(
                resolveWorktreeCwd(
                  request.projectId,
                  request.worktreeId,
                  request.selectedRepoId,
                ),
                request.relativeCwd,
              );
            } catch {
              throw new TerminalServiceError(
                'invalid_target',
                'Invalid relative terminal directory.',
              );
            }
          })(),
  });
}

/** Read-only receipt probe so callers can skip pre-write policy on a replay. */
export function hasTerminalWriteReceipt(
  terminalId: string,
  idempotencyKey: string,
): boolean {
  return terminalWriteReceipts.has(`${terminalId}:${idempotencyKey}`);
}

export function writeTerminal(
  request: TerminalWriteRequest & TerminalOperationScope,
): TerminalWriteDisposition {
  validateTerminalId(request.terminalId);
  validateTerminalOperationScope(request);
  if (request.idempotencyKey) {
    try {
      validateId(request.idempotencyKey, 'idempotencyKey');
    } catch (error) {
      throw new TerminalServiceError(
        'invalid_payload',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (Buffer.byteLength(request.data, 'utf8') > MAX_TERMINAL_WRITE_BYTES) {
    throw new TerminalServiceError(
      'invalid_payload',
      'Terminal write exceeds maximum data size',
    );
  }
  assertTerminalAuthorized(request.terminalId, request);
  const receiptKey = request.idempotencyKey
    ? `${request.terminalId}:${request.idempotencyKey}`
    : undefined;
  if (receiptKey && terminalWriteReceipts.has(receiptKey)) {
    return 'already_written';
  }
  workerTerminal.write(request.terminalId, request.data);
  if (receiptKey) {
    rememberTerminalWriteReceipt(receiptKey);
  }
  return 'written';
}

export function resizeTerminal(
  request: TerminalResizeRequest & TerminalOperationScope,
): void {
  validateTerminalId(request.terminalId);
  validateTerminalOperationScope(request);
  validateTerminalDimension(request.cols, 'cols');
  validateTerminalDimension(request.rows, 'rows');
  assertTerminalAuthorized(request.terminalId, request);
  workerTerminal.resize(request.terminalId, request.cols, request.rows);
}

export function closeTerminal(
  request: TerminalKillRequest & TerminalOperationScope,
): void {
  validateTerminalId(request.terminalId);
  validateTerminalOperationScope(request);
  assertTerminalAuthorized(request.terminalId, request);
  workerTerminal.kill(request.terminalId, {
    signal: TERMINAL_USER_CLOSE_SIGNAL,
  });
}

export function terminalSessionToPortalEntity(
  session: TerminalSession,
  options: {
    includeBuffer?: boolean;
    running?: boolean;
    exited?: boolean;
  } = {},
): PortalEntityEnvelope {
  const buffer = options.includeBuffer
    ? workerTerminal.replayText(session.id)
    : null;
  return {
    entityType: 'terminal_session',
    localId: session.id,
    parentLocalId: worktreeScopedParentLocalId(
      session.projectId,
      session.worktreeId,
    ),
    payload: {
      id: session.id,
      terminalLocalId: session.id,
      workspaceLocalId: session.projectId,
      worktreeLocalId: session.worktreeId,
      cwd: session.cwd,
      title: session.shellBasename,
      running: options.running ?? true,
      exited: options.exited ?? false,
      ...(buffer !== null ? { buffer } : {}),
    },
  };
}

export function listTerminalPortalEntities(
  target?: PortalTarget,
): PortalEntityEnvelope[] {
  return workerTerminal
    .list()
    .filter((session) => sessionMatchesTarget(session, target))
    .map((session) =>
      terminalSessionToPortalEntity(session, {
        includeBuffer: target?.terminalLocalId === session.id,
      }),
    );
}

function toPortalTerminalOutputEvent(
  event: WorkerTerminalEvent,
): PortalEventEnvelope | null {
  if (event.type !== 'output') {
    return null;
  }
  const output = event.payload;
  const portalPayload: PortalTerminalOutputPayload = {
    terminalLocalId: output.terminalId,
    workspaceLocalId: output.projectId,
    worktreeLocalId: output.worktreeId,
    chunk: decodeTerminalOutput(output.terminalId, output.data),
    seq: output.seq,
  };
  return createPortalEvent('portal.terminal.output', portalPayload);
}

function decodeTerminalOutput(terminalId: string, data: Uint8Array): string {
  let decoder = terminalOutputDecoders.get(terminalId);
  if (!decoder) {
    decoder = new StringDecoder('utf8');
    terminalOutputDecoders.set(terminalId, decoder);
  }
  return decoder.write(Buffer.from(data));
}

function clearTerminalOutputDecoder(terminalId: string): void {
  const decoder = terminalOutputDecoders.get(terminalId);
  if (decoder) {
    decoder.end();
    terminalOutputDecoders.delete(terminalId);
  }
}

function toPortalTerminalLifecycleEvent(
  event: WorkerTerminalEvent,
): PortalEventEnvelope | null {
  if (event.type === 'exit') {
    const exit = event.payload;
    clearTerminalOutputDecoder(exit.terminalId);
    return createPortalEvent('portal.state.delta', {
      scope: 'terminal',
      target: {
        workspaceLocalId: exit.projectId,
        worktreeLocalId: exit.worktreeId,
        terminalLocalId: exit.terminalId,
      },
      entities: [
        {
          entityType: 'terminal_session',
          localId: exit.terminalId,
          parentLocalId: worktreeScopedParentLocalId(
            exit.projectId,
            exit.worktreeId,
          ),
          payload: {
            terminalLocalId: exit.terminalId,
            workspaceLocalId: exit.projectId,
            worktreeLocalId: exit.worktreeId,
            running: false,
            exited: true,
            exitCode: exit.exitCode,
            signal: exit.signal,
            endedAt: new Date().toISOString(),
          },
        },
      ],
      generatedAt: new Date().toISOString(),
    });
  }

  if (event.type === 'runningChanged') {
    const running = event.payload;
    return createPortalEvent('portal.state.delta', {
      scope: 'terminal',
      target: {
        workspaceLocalId: running.projectId,
        worktreeLocalId: running.worktreeId,
        terminalLocalId: running.terminalId,
      },
      entities: [
        {
          entityType: 'terminal_session',
          localId: running.terminalId,
          parentLocalId: worktreeScopedParentLocalId(
            running.projectId,
            running.worktreeId,
          ),
          payload: {
            terminalLocalId: running.terminalId,
            workspaceLocalId: running.projectId,
            worktreeLocalId: running.worktreeId,
            running: running.running,
            processName: running.processName,
          },
        },
      ],
      generatedAt: new Date().toISOString(),
    });
  }

  return null;
}

export function subscribeTerminalPortalEvents(
  enqueue: (event: PortalEventEnvelope) => void,
): () => void {
  return workerTerminal.addEventListener((terminalEvent) => {
    const event =
      toPortalTerminalOutputEvent(terminalEvent) ??
      toPortalTerminalLifecycleEvent(terminalEvent);
    if (event) {
      enqueue(event);
    }
  });
}
