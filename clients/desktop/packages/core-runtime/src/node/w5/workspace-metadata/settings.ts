import type { WorkspacePlanDetectionConfig } from '@canopy/protocol/plan-detection';
import {
  isScriptDefinition,
  normalizeScriptInputMap,
  normalizeScriptName,
  type ScriptInputMap,
  type ScriptOverrides,
  type ScriptValue,
} from '@canopy/protocol/scripts';
import {
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '../boundary-operation';
import type { W5CommitOptions } from '../commit-scope';
import { createW5CompositionLocks } from '../composition-operation';
import { createW5SingleDecisionOperation } from '../single-decision-operation';
import { WorkspaceConfigUnreadableError } from '../workspace-manifest-repository';
import type {
  W5ManifestEdit,
  W5ManifestEditOutcome,
  W5ManifestRepositoryView,
  W5WorkspaceCommandHost,
  W5WorkspaceManifestEditor,
  W5WorkspaceManifestView,
} from './ports';

/**
 * The caller of a script, hook, plan detection or paused-hook change: the
 * desktop renderer, the browser Remote Control portal, or an agent's App
 * Advisor action. A closed set; a keyed receipt's caller is named from it.
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

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspaceScriptsUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  change: WorkspaceScriptsChange;
  source: ScriptHookSettingsSource;
}

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspacePlanDetectionUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  /** The whole plan detection configuration; an empty one clears it. */
  planDetection: WorkspacePlanDetectionConfig;
  source: ScriptHookSettingsSource;
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

export interface WorkspaceSettingsCommandHost extends W5WorkspaceCommandHost<ScriptHookSettingsSource> {
  manifest: W5WorkspaceManifestEditor;
  /** Whether a caller-selected scope may reach a settings writer. */
  isWritableScope: (workspaceId: string) => boolean;
  readOnlyScopeMessage: string;
}

export interface WorkspaceSettingsCommands {
  updateScripts(request: WorkspaceScriptsUpdateRequest): Promise<void>;
  updatePlanDetection(
    request: WorkspacePlanDetectionUpdateRequest,
  ): Promise<void>;
}

function refuse(reason: ScriptHookSettingsRefusal, message: string): never {
  throw new ScriptHookSettingsRefusedError(reason, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `merge-commands`: an empty command removes that script, and a
 * `ScriptDefinition`'s other fields are kept.
 */
export function mergeScriptCommands(
  current: ScriptOverrides | undefined,
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
 * One script's change, normalized as it is stored, so a keyed replay of the
 * same edit fingerprints the same request.
 */
function admitDefinitionChange(
  change: Extract<
    WorkspaceScriptsChange,
    { kind: 'definition' | 'remove-definition' }
  >,
  validateId: WorkspaceSettingsCommandHost['validateId'],
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

function withRepositoryScripts(
  repos: readonly W5ManifestRepositoryView[],
  scripts: ReadonlyMap<W5ManifestRepositoryView, ScriptOverrides | undefined>,
): W5ManifestRepositoryView[] {
  return repos.map((repo) =>
    scripts.has(repo) ? { ...repo, scripts: scripts.get(repo) } : repo,
  );
}

/** The scripts edit of one read; every edit writes, as it always did. */
function applyScriptsChange(
  view: W5WorkspaceManifestView,
  workspaceId: string,
  change: WorkspaceScriptsChange,
): W5ManifestEdit<undefined> {
  switch (change.kind) {
    case 'replace':
      return {
        result: undefined,
        change: { scripts: normalizeScriptInputMap(change.scripts) },
      };
    case 'merge-commands':
      return {
        result: undefined,
        change: {
          scripts: normalizeScriptInputMap(
            mergeScriptCommands(view.scripts, change.commands),
          ),
        },
      };
    case 'repositories': {
      const scripts = new Map<
        W5ManifestRepositoryView,
        ScriptOverrides | undefined
      >();
      for (const update of change.repos) {
        const repo = view.repos.find(
          (candidate) => candidate.id === update.repoId,
        );
        if (repo) scripts.set(repo, normalizeScriptInputMap(update.scripts));
      }
      return {
        result: undefined,
        change: { repos: withRepositoryScripts(view.repos, scripts) },
      };
    }
    case 'definition':
    case 'remove-definition': {
      const edited = (
        current: ScriptOverrides | undefined,
      ): ScriptOverrides | undefined => {
        const scripts: ScriptInputMap = { ...current };
        if (change.kind === 'definition') scripts[change.name] = change.value;
        else delete scripts[change.name];
        return normalizeScriptInputMap(scripts);
      };
      if (change.repoId === undefined)
        return { result: undefined, change: { scripts: edited(view.scripts) } };
      const repo = view.repos.find(
        (candidate) => candidate.id === change.repoId,
      );
      if (!repo) {
        refuse(
          'not-found',
          `Repo ${change.repoId} not found in project ${workspaceId}`,
        );
      }
      return {
        result: undefined,
        change: {
          repos: withRepositoryScripts(
            view.repos,
            new Map([[repo, edited(repo.scripts)]]),
          ),
        },
      };
    }
  }
}

/**
 * `core.workspace.scripts.update` (CAN-3816) and
 * `core.workspace.planDetection.update` over the host's manifest editor. Each
 * changes only the fields it names, from a fresh read inside the manifest
 * write queue, so a competing settings write is never lost, and never changes
 * the workspace type. A missing manifest is refused rather than created, and
 * an unreadable one is refused and left as it is. An optional workspace
 * revision and key are checked in the same commit (CAN-4370).
 */
export function createWorkspaceSettingsCommands(
  host: WorkspaceSettingsCommandHost,
): WorkspaceSettingsCommands {
  const run = createW5SingleDecisionOperation<ScriptHookSettingsSource>(
    host.decision,
    (error) => error instanceof ScriptHookSettingsRefusedError,
  );
  const locks = createW5CompositionLocks(host.paths);

  function admitScope(workspaceId: string): void {
    host.validateId(workspaceId, 'workspaceId');
    if (!host.isWritableScope(workspaceId)) {
      refuse('read-only-scope', host.readOnlyScopeMessage);
    }
  }

  /** A settings change never creates a manifest. */
  async function admitManifest(workspaceId: string): Promise<void> {
    if ((await host.manifest.readAuthority(workspaceId)) === 'absent') {
      refuse(
        'configuration-unavailable',
        new WorkspaceConfigUnreadableError().message,
      );
    }
  }

  function refuseUnreadable<T>(outcome: W5ManifestEditOutcome<T>): T {
    if (outcome.status === 'unreadable')
      refuse('configuration-unavailable', outcome.message);
    return outcome.result;
  }

  /**
   * One commit of `workspace.json`, checking an optional workspace revision;
   * the decision records the void outcome.
   */
  function commitManifestEdit(
    workspaceId: string,
    expectedRevision: number | undefined,
    options: W5CommitOptions,
    save: (result: undefined) => undefined,
    apply: (view: W5WorkspaceManifestView) => W5ManifestEdit<undefined>,
  ): Promise<undefined> {
    const resource = { kind: 'workspace', workspaceId } as const;
    return host.withCommit(
      {
        ...options,
        locks: locks({ manifests: [workspaceId] }),
        expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
      },
      async () => {
        await host.checkExpectedRevision(resource, expectedRevision);
        refuseUnreadable(
          await host.manifest.edit(workspaceId, (view) => apply(view)),
        );
        return save(undefined);
      },
    );
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
      return admitDefinitionChange(change, host.validateId);
    }
    return change;
  }

  async function updateScripts(
    request: WorkspaceScriptsUpdateRequest,
  ): Promise<void> {
    const { workspaceId, expectedRevision } = request;
    admitScope(workspaceId);
    const change = admitScriptsChange(request.change);
    return run(
      {
        operation: 'core.workspace.scripts.update',
        source: request.source,
        idempotencyKey: request.idempotencyKey,
        parameters: () => ({ workspaceId, change }),
      },
      () => admitManifest(workspaceId),
      () => undefined,
      (_admitted, options, save) =>
        commitManifestEdit(
          workspaceId,
          expectedRevision,
          options,
          save,
          (view) => applyScriptsChange(view, workspaceId, change),
        ),
    );
  }

  async function updatePlanDetection(
    request: WorkspacePlanDetectionUpdateRequest,
  ): Promise<void> {
    const { workspaceId, expectedRevision } = request;
    admitScope(workspaceId);
    const planDetection: unknown = request.planDetection;
    if (!isRecord(planDetection)) {
      refuse('invalid-request', 'Invalid plan detection settings.');
    }
    return run(
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
      // Stored as given; the host's manifest write normalizes it.
      (_admitted, options, save) =>
        commitManifestEdit(
          workspaceId,
          expectedRevision,
          options,
          save,
          () => ({
            result: undefined,
            change: { planDetection: request.planDetection },
          }),
        ),
    );
  }

  return { updateScripts, updatePlanDetection };
}
