import { decodeW5WorktreeHooksPausedOutcome } from '@canopy/core-runtime/node/w5/worktree-outcome';
import type {
  WorkspaceConfigFile,
  WorkspacePlanDetectionConfig,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { normalizeHookInputMap } from '@canopy/desktop-shared/types';
import type { HookInputMap, HookOverrides } from '@canopy/desktop-shared/hooks';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  isScriptDefinition,
  normalizeScriptInputMap,
  normalizeScriptName,
  type ScriptInputMap,
  type ScriptValue,
} from '@canopy/desktop-shared/scripts';
import {
  bindHookContextsWithCapturedContext,
  captureBackgroundExecutionContext,
} from '../services/background-execution-context';
import { getWorkspaceConfigPath, getWorkspaceWorktreesFilePath } from './paths';
import { isWritableScope, READ_ONLY_SCOPE_ERROR } from './read-only-scope';
import { validateId } from './validation';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';
import type { W5CommitOptions } from './w5-commit-scope';
import { createW5SingleDecisionOperation } from './w5-single-decision-operation';
import {
  readWorkspaceConfigDetailed,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
  WorkspaceConfigUnreadableError,
  type WorktreeListAuthority,
} from './workspace-persistence';

/**
 * The caller of a script, hook, plan detection or paused-hook change: the
 * desktop renderer, the browser Remote Control portal, or an agent's App
 * Advisor action. A closed set; a keyed receipt names it as
 * `desktop-host:<source>`.
 */
export type ScriptHookSettingsSource = 'desktop' | 'portal' | 'app_advisor';

/**
 * A change to a workspace's persisted script overrides
 * (`core.workspace.scripts.update`, CAN-3799).
 *
 * - `replace` sets the workspace-level (root or single repository) scripts.
 * - `merge-commands` edits only the named scripts by command string: an empty
 *   command removes that script, and a `ScriptDefinition`'s other fields
 *   (timeout, shell, dev server) are kept.
 * - `repositories` replaces the scripts of each named member repository; a
 *   repository the workspace does not have is skipped, as it always was.
 * - `definition` sets one script of the workspace, or of `repoId`, keeping the
 *   others; `null` disables an inherited script. `remove-definition` drops
 *   that script's setting so the inherited one applies again. Both refuse a
 *   repository the workspace does not have
 *   (`core.script.definition.upsert` and `.delete`, CAN-4153).
 */
export type WorkspaceScriptsChange =
  | { kind: 'replace'; scripts: ScriptInputMap | undefined }
  | { kind: 'merge-commands'; commands: Readonly<Record<string, string>> }
  | {
      kind: 'repositories';
      repos: ReadonlyArray<{
        repoId: string;
        scripts: ScriptInputMap | undefined;
      }>;
    }
  | { kind: 'definition'; repoId?: string; name: string; value: ScriptValue }
  | { kind: 'remove-definition'; repoId?: string; name: string };

/**
 * A change to a workspace's persisted hook overrides
 * (`core.workspace.hooks.update`). `replace` sets the workspace-level hooks;
 * `repositories` replaces each named member repository's hooks and refuses
 * a repository the workspace does not have. An enabled pipeline or chat
 * action keeps the execution context it was bound to; a new one is bound to
 * the current one.
 */
export type WorkspaceHooksChange =
  | { kind: 'replace'; hooks: HookInputMap | undefined }
  | {
      kind: 'repositories';
      repos: ReadonlyArray<{ repoId: string; hooks: HookInputMap | undefined }>;
    };

/**
 * A change to one worktree's paused hooks (`core.worktree.hooks.setPaused`).
 * `replace` sets the whole paused set (the renderer's toggle). `pause` and
 * `resume` add or remove only the named keys, applied to the latest row, so
 * two competing changes never undo each other.
 */
export type WorktreeHookPauseChange =
  | { kind: 'replace'; pausedHookKeys: readonly unknown[] }
  | { kind: 'pause' | 'resume'; hookKeys: readonly string[] };

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspaceScriptsUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  change: WorkspaceScriptsChange;
  source: ScriptHookSettingsSource;
}

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspaceHooksUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  change: WorkspaceHooksChange;
  source: ScriptHookSettingsSource;
}

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspacePlanDetectionUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  /** The whole plan detection configuration; an empty one clears it. */
  planDetection: WorkspacePlanDetectionConfig;
  source: ScriptHookSettingsSource;
}

/** `expectedRevision` is the row revision (`worktree:{ws}/{wt}`). */
export interface WorktreeHooksSetPausedRequest extends W5BoundaryOptions {
  workspaceId: string;
  worktreeId: string;
  change: WorktreeHookPauseChange;
  source: ScriptHookSettingsSource;
}

export interface WorktreeHooksSetPausedOutcome {
  /** The persisted row after the change. */
  worktree: WorktreeData;
  /** The row's paused hook keys after the change, sorted. */
  pausedHookKeys: string[];
  /** False when the row already had this paused set; nothing was written. */
  changed: boolean;
}

export type ScriptHookSettingsRefusal =
  | 'read-only-scope'
  | 'invalid-request'
  | 'not-found'
  | 'configuration-unavailable'
  | 'worktrees-unavailable';

/** The change was refused before anything was written. */
export class ScriptHookSettingsRefusedError extends Error {
  constructor(
    readonly reason: ScriptHookSettingsRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptHookSettingsRefusedError';
  }
}

const WORKTREES_UNAVAILABLE_MESSAGE =
  "Couldn't change this worktree's paused hooks because its worktree list couldn't be read. Try again.";

function refuse(reason: ScriptHookSettingsRefusal, message: string): never {
  throw new ScriptHookSettingsRefusedError(reason, message);
}

const runSettingsCommand =
  createW5SingleDecisionOperation<ScriptHookSettingsSource>(
    (error) => error instanceof ScriptHookSettingsRefusedError,
  );

function workspaceResource(workspaceId: string): W5Resource {
  return { kind: 'workspace', workspaceId };
}

/** One commit of `workspace.json`, checking an optional workspace revision. */
function manifestCommit(
  options: W5CommitOptions,
  workspaceId: string,
  expectedRevision: number | undefined,
): W5CommitOptions {
  return {
    ...options,
    locks: [{ kind: 'manifest', path: getWorkspaceConfigPath(workspaceId) }],
    expectedRevisions: w5ExpectedRevision(
      workspaceResource(workspaceId),
      expectedRevision,
    ),
  };
}

function admitScope(workspaceId: string): void {
  validateId(workspaceId, 'workspaceId');
  if (!isWritableScope(workspaceId)) {
    refuse('read-only-scope', READ_ONLY_SCOPE_ERROR);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unique non-empty keys, sorted: the persisted form of `pausedHookKeys`. */
export function normalizePausedHookKeys(keys: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      keys.filter(
        (key): key is string => typeof key === 'string' && key.length > 0,
      ),
    ),
  ).sort();
}

/**
 * A missing manifest would read as the default configuration, of another
 * workspace type, so a settings change never creates one: it is refused
 * before anything is written.
 */
async function admitManifest(workspaceId: string): Promise<void> {
  const { authority } = await readWorkspaceConfigDetailed(workspaceId);
  if (authority === 'absent') {
    refuse(
      'configuration-unavailable',
      new WorkspaceConfigUnreadableError().message,
    );
  }
}

/**
 * Awaits one guarded read-modify-write of `workspace.json`, which runs in the
 * manifest write queue. An unreadable manifest is never replaced (CAN-3563):
 * the guarded write records its refusal diagnostic, and the refusal is
 * typed here. A failed write rejects with its own error and leaves the file
 * as it was.
 */
async function refuseUnreadableManifest(
  write: Promise<unknown>,
): Promise<void> {
  try {
    await write;
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      refuse('configuration-unavailable', error.message);
    }
    throw error;
  }
}

function admitScriptsChange(
  change: WorkspaceScriptsChange,
): WorkspaceScriptsChange {
  if (change.kind === 'merge-commands') {
    const commands: unknown = change.commands;
    if (
      !isRecord(commands) ||
      !Object.values(commands).every((command) => typeof command === 'string')
    ) {
      refuse('invalid-request', 'Invalid script commands.');
    }
    return change;
  }
  if (change.kind === 'repositories') {
    const repos: unknown = change.repos;
    if (!Array.isArray(repos)) {
      refuse('invalid-request', 'Invalid repository scripts.');
    }
  }
  if (change.kind === 'definition' || change.kind === 'remove-definition') {
    return admitDefinitionChange(change);
  }
  return change;
}

/**
 * One script's change, normalized as it is stored, so a keyed replay of the
 * same edit fingerprints the same request.
 */
function admitDefinitionChange(
  change: Extract<
    WorkspaceScriptsChange,
    { kind: 'definition' | 'remove-definition' }
  >,
): WorkspaceScriptsChange {
  if (change.repoId !== undefined) validateId(change.repoId, 'repoId');
  const rawName: unknown = change.name;
  const name =
    typeof rawName === 'string' ? normalizeScriptName(rawName) : undefined;
  if (!name) refuse('invalid-request', 'Invalid script name.');
  const repo = change.repoId === undefined ? {} : { repoId: change.repoId };
  if (change.kind === 'remove-definition') {
    return { kind: 'remove-definition', ...repo, name };
  }
  const value = normalizeScriptInputMap({ [name]: change.value })?.[name];
  if (value === undefined) refuse('invalid-request', 'Invalid script.');
  return { kind: 'definition', ...repo, name, value };
}

function applyDefinitionChange(
  config: WorkspaceConfigFile,
  workspaceId: string,
  change: Extract<
    WorkspaceScriptsChange,
    { kind: 'definition' | 'remove-definition' }
  >,
): void {
  const holder =
    change.repoId === undefined
      ? config
      : config.repos.find((candidate) => candidate.id === change.repoId);
  if (!holder) {
    refuse(
      'not-found',
      `Repo ${change.repoId} not found in project ${workspaceId}`,
    );
  }
  const scripts: ScriptInputMap = { ...holder.scripts };
  if (change.kind === 'definition') scripts[change.name] = change.value;
  else delete scripts[change.name];
  holder.scripts = normalizeScriptInputMap(scripts);
}

function mergeScriptCommands(
  current: WorkspaceConfigFile['scripts'],
  commands: Readonly<Record<string, string>>,
): ScriptInputMap {
  const merged: ScriptInputMap = { ...current };
  for (const [name, rawCommand] of Object.entries(commands)) {
    if (rawCommand.trim().length === 0) {
      delete merged[name];
      continue;
    }
    const previous = merged[name];
    merged[name] = isScriptDefinition(previous)
      ? { ...previous, command: rawCommand }
      : rawCommand;
  }
  return merged;
}

/**
 * The typed in-process boundary of `core.workspace.scripts.update`
 * (CAN-3816): every script override edit, from the renderer
 * (`project:save-scripts`, `workspace:save-scripts`, `workspace:merge-scripts`,
 * `workspace:save-repo-scripts`) and the portal
 * (`portal.workspace.scripts.save`). It changes only the scripts it names,
 * from a fresh read inside the manifest write queue, so a competing settings
 * write is never lost, and it never changes the workspace type. Script
 * execution stays in the scripts service. An optional workspace revision and
 * key are checked in the same commit (CAN-4370); the operation stays
 * unregistered.
 */
export async function updateWorkspaceScripts(
  request: WorkspaceScriptsUpdateRequest,
): Promise<void> {
  const { workspaceId, expectedRevision } = request;
  admitScope(workspaceId);
  const change = admitScriptsChange(request.change);
  return runSettingsCommand(
    {
      operation: 'core.workspace.scripts.update',
      source: request.source,
      idempotencyKey: request.idempotencyKey,
      parameters: () => ({ workspaceId, change }),
    },
    () => admitManifest(workspaceId),
    () => undefined,
    (_admitted, options, save) => {
      async function stageWorkspaceScripts(): Promise<undefined> {
        await checkW5ExpectedRevision(
          workspaceResource(workspaceId),
          expectedRevision,
        );
        await refuseUnreadableManifest(
          updateWorkspaceConfig(workspaceId, (config): void => {
            switch (change.kind) {
              case 'replace':
                config.scripts = normalizeScriptInputMap(change.scripts);
                return;
              case 'merge-commands':
                config.scripts = normalizeScriptInputMap(
                  mergeScriptCommands(config.scripts, change.commands),
                );
                return;
              case 'repositories':
                for (const update of change.repos) {
                  const repo = config.repos.find(
                    (candidate) => candidate.id === update.repoId,
                  );
                  if (repo)
                    repo.scripts = normalizeScriptInputMap(update.scripts);
                }
                return;
              case 'definition':
              case 'remove-definition':
                applyDefinitionChange(config, workspaceId, change);
            }
          }),
        );
        return save(undefined);
      }
      return withW5Commit(
        manifestCommit(options, workspaceId, expectedRevision),
        stageWorkspaceScripts,
      );
    },
  );
}

/**
 * The hooks a change names, normalized and without execution contexts: a
 * caller's context is never stored, and the bound one is host state, so
 * neither belongs to the request a key fingerprints.
 */
function admittedHooks(
  hooks: HookInputMap | undefined,
): HookOverrides | undefined {
  return bindHookContextsWithCapturedContext(
    normalizeHookInputMap(hooks),
    undefined,
    undefined,
  );
}

function admittedHooksChange(change: WorkspaceHooksChange): unknown {
  return change.kind === 'replace'
    ? { kind: change.kind, hooks: admittedHooks(change.hooks) }
    : {
        kind: change.kind,
        repos: change.repos.map((repo) => ({
          repoId: repo.repoId,
          hooks: admittedHooks(repo.hooks),
        })),
      };
}

/**
 * The typed in-process boundary of `core.workspace.hooks.update`: the
 * renderer's `project:save-hooks`, `workspace:save-hooks` and
 * `workspace:save-repo-hooks`. Hooks are bound to their execution context
 * inside the manifest write queue, from the stored hooks, so a binding is
 * never taken from a stale read. Inherited organization hook bindings are
 * recorded by the hook resolver in the same queue
 * (`internal.workspace.ownership.record`); scheduling and running hooks stay
 * in the hooks service. A keyed replay never captures the context again.
 */
export async function updateWorkspaceHooks(
  request: WorkspaceHooksUpdateRequest,
): Promise<void> {
  const { workspaceId, change, expectedRevision } = request;
  admitScope(workspaceId);
  if (change.kind === 'repositories') {
    const repos: unknown = change.repos;
    if (!Array.isArray(repos)) {
      refuse('invalid-request', 'Invalid repository hooks.');
    }
    for (const update of change.repos) validateId(update.repoId, 'repoId');
  }
  return runSettingsCommand(
    {
      operation: 'core.workspace.hooks.update',
      source: request.source,
      idempotencyKey: request.idempotencyKey,
      parameters: () => ({ workspaceId, change: admittedHooksChange(change) }),
    },
    async () => {
      await admitManifest(workspaceId);
      const needsContext =
        change.kind === 'replace'
          ? change.hooks !== undefined
          : change.repos.some((repo) => repo.hooks !== undefined);
      return needsContext ? captureBackgroundExecutionContext() : undefined;
    },
    () => undefined,
    (context, options, save) => {
      async function stageWorkspaceHooks(): Promise<undefined> {
        await checkW5ExpectedRevision(
          workspaceResource(workspaceId),
          expectedRevision,
        );
        await refuseUnreadableManifest(
          updateWorkspaceConfig(workspaceId, (config, read): void => {
            if (read.authority === 'absent')
              refuse(
                'configuration-unavailable',
                new WorkspaceConfigUnreadableError().message,
              );
            if (change.kind === 'replace') {
              config.hooks = bindHookContextsWithCapturedContext(
                normalizeHookInputMap(change.hooks),
                config.hooks,
                context,
              );
              return;
            }
            for (const update of change.repos) {
              const repo = config.repos.find(
                (candidate) => candidate.id === update.repoId,
              );
              if (!repo) {
                refuse(
                  'not-found',
                  `Repo ${update.repoId} not found in project ${workspaceId}`,
                );
              }
              repo.hooks = bindHookContextsWithCapturedContext(
                normalizeHookInputMap(update.hooks),
                repo.hooks,
                context,
              );
            }
          }),
        );
        return save(undefined);
      }
      return withW5Commit(
        manifestCommit(options, workspaceId, expectedRevision),
        stageWorkspaceHooks,
      );
    },
  );
}

/**
 * The typed in-process boundary of `core.workspace.planDetection.update`:
 * the renderer's `workspace:save-plan-detection`. The configuration is
 * normalized when written; an empty one removes the key.
 */
export async function updateWorkspacePlanDetection(
  request: WorkspacePlanDetectionUpdateRequest,
): Promise<void> {
  const { workspaceId, expectedRevision } = request;
  admitScope(workspaceId);
  const planDetection: unknown = request.planDetection;
  if (!isRecord(planDetection)) {
    refuse('invalid-request', 'Invalid plan detection settings.');
  }
  return runSettingsCommand(
    {
      operation: 'core.workspace.planDetection.update',
      source: request.source,
      idempotencyKey: request.idempotencyKey,
      parameters: () => ({
        workspaceId,
        planDetection: request.planDetection,
      }),
    },
    () => admitManifest(workspaceId),
    () => undefined,
    (_admitted, options, save) => {
      async function stageWorkspacePlanDetection(): Promise<undefined> {
        await checkW5ExpectedRevision(
          workspaceResource(workspaceId),
          expectedRevision,
        );
        await refuseUnreadableManifest(
          updateWorkspaceConfig(workspaceId, (config): void => {
            config.planDetection = request.planDetection;
          }),
        );
        return save(undefined);
      }
      return withW5Commit(
        manifestCommit(options, workspaceId, expectedRevision),
        stageWorkspacePlanDetection,
      );
    },
  );
}

function admitPauseChange(
  change: WorktreeHookPauseChange,
): WorktreeHookPauseChange {
  if (change.kind === 'replace') {
    const keys: unknown = change.pausedHookKeys;
    if (!Array.isArray(keys)) {
      refuse('invalid-request', 'Invalid paused hooks.');
    }
    return { kind: 'replace', pausedHookKeys: normalizePausedHookKeys(keys) };
  }
  const keys: unknown = change.hookKeys;
  if (!Array.isArray(keys)) {
    refuse('invalid-request', 'Invalid hook keys.');
  }
  return { kind: change.kind, hookKeys: normalizePausedHookKeys(keys) };
}

function nextPausedHookKeys(
  current: readonly string[],
  change: WorktreeHookPauseChange,
): string[] {
  if (change.kind === 'replace') {
    return normalizePausedHookKeys(change.pausedHookKeys);
  }
  const next = new Set(current);
  for (const key of change.hookKeys) {
    if (change.kind === 'pause') next.add(key);
    else next.delete(key);
  }
  return normalizePausedHookKeys(Array.from(next));
}

/**
 * Applies a paused-hook change with the desktop's persistence conventions:
 * an empty set removes the key, and the same row object is returned when
 * the set is unchanged, so nothing is written.
 */
function applyPauseChange(
  worktree: WorktreeData,
  change: WorktreeHookPauseChange,
): WorktreeData {
  const current = normalizePausedHookKeys(worktree.pausedHookKeys ?? []);
  const next = nextPausedHookKeys(current, change);
  if (
    current.length === next.length &&
    current.every((key, index) => key === next[index])
  ) {
    return worktree;
  }
  if (next.length === 0) {
    const cleared = { ...worktree };
    delete cleared.pausedHookKeys;
    return cleared;
  }
  return { ...worktree, pausedHookKeys: next };
}

/**
 * The typed in-process boundary of `core.worktree.hooks.setPaused`: the
 * renderer's `worktree:set-paused-hooks`, the portal's `portal.hook.pause`
 * and `portal.hook.resume`, and the App Advisor `hook.pause` and
 * `hook.resume` actions. The change is applied to the latest row under the
 * worktree list lock in one write. A whole-sidebar save keeps the stored
 * paused set, so a stale snapshot never undoes a pause or brings a resumed
 * key back. Hook execution reads the set; it is not scheduled here.
 *
 * An optional row revision and key are checked in the same commit
 * (CAN-4370). A keyed attempt returns, and replays, the portable projection
 * of the row; a replacement set and a pause or resume of the same keys are
 * distinct requests.
 */
export async function setWorktreeHooksPaused(
  request: WorktreeHooksSetPausedRequest,
): Promise<WorktreeHooksSetPausedOutcome> {
  const { workspaceId, worktreeId, expectedRevision } = request;
  admitScope(workspaceId);
  validateId(worktreeId, 'worktreeId');
  const change = admitPauseChange(request.change);
  const resource: W5Resource = { kind: 'worktree', workspaceId, worktreeId };

  return runSettingsCommand(
    {
      operation: 'core.worktree.hooks.setPaused',
      source: request.source,
      idempotencyKey: request.idempotencyKey,
      parameters: () => ({ workspaceId, worktreeId, change }),
    },
    () => Promise.resolve(),
    decodeW5WorktreeHooksPausedOutcome,
    (_admitted, options, save) => {
      async function stageWorktreeHooksPaused(): Promise<WorktreeHooksSetPausedOutcome> {
        await checkW5ExpectedRevision(resource, expectedRevision);
        const result: {
          worktree?: WorktreeData;
          changed: boolean;
          authority?: WorktreeListAuthority;
        } = { changed: false };
        await updateWorkspaceWorktrees(workspaceId, (worktrees, read) => {
          result.authority = read?.authority;
          const index = worktrees.findIndex(
            (worktree) => worktree.id === worktreeId,
          );
          const target = worktrees[index];
          if (!target) return worktrees;
          const next = applyPauseChange(target, change);
          result.worktree = next;
          result.changed = next !== target;
          return result.changed
            ? worktrees.map((worktree, position) =>
                position === index ? next : worktree,
              )
            : worktrees;
        });
        const { worktree } = result;
        if (!worktree) {
          // An unreadable list, or a row this version cannot read, is not
          // proof that the worktree is gone.
          if (
            result.authority === 'unreadable' ||
            result.authority === 'partial'
          ) {
            refuse('worktrees-unavailable', WORKTREES_UNAVAILABLE_MESSAGE);
          }
          refuse(
            'not-found',
            `Worktree ${worktreeId} not found in project ${workspaceId}`,
          );
        }
        return save({
          worktree,
          pausedHookKeys: normalizePausedHookKeys(
            worktree.pausedHookKeys ?? [],
          ),
          changed: result.changed,
        });
      }
      return withW5Commit(
        {
          ...options,
          locks: [
            { kind: 'list', path: getWorkspaceWorktreesFilePath(workspaceId) },
          ],
          expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
        },
        stageWorktreeHooksPaused,
      );
    },
  );
}
