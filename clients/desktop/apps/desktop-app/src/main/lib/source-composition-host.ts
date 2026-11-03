import {
  CoreSharedContainerForkResultSchema,
  CoreWorkspaceSourceRepoInitializeResultSchema,
  WORKER_GIT_GRANTS,
  type CoreWorkspaceSourceChangesApplyParams,
  type CoreWorkspaceSourceChangesApplyResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  normalizeShareablePluginRef,
  type ShareablePluginRef,
} from '@canopy/protocol/plugins';
import {
  isScriptDefinition,
  type ScriptInputMap,
} from '@canopy/protocol/scripts';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import type { HookInputMap } from '@canopy/desktop-shared/hooks';
import type {
  ProjectApplySourceChangesRequest,
  WorkspaceApplySourceChangesRequest,
} from '@canopy/desktop-shared/types';
import type {
  CoreSourceCompositionCall,
  CoreSourceCompositionHost,
} from '@canopy/core-runtime/node/workspace/source-composition-commands';
import {
  CoreLifecycleRefusedError,
  isCoreLifecycleRefusal,
} from '@canopy/core-runtime/node/workspace/source-composition-wire-errors';
import type { LifecycleEffectDispatcher } from '../canopy-runtime/core-source-composition-adapter';
import {
  answerWorkspaceLifecycleProjection,
  takeWorkspaceLifecycleProjection,
} from '../canopy-runtime/workspace-lifecycle-dispatch';
import { getFeatureFlagService } from '../feature-flags';
import {
  invalidateWorktreeDiffStats,
  refreshWorktreeDiffStats,
} from '../services/worktree-diff-stats-cache';
import { SharedContainerForkError } from '../shared-containers/fork/destination';
import { forkSharedContainer } from '../shared-containers/fork';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { promoteTemporaryWorkspace } from './adhoc-multi-repo-workspaces';
import { getMainWindow } from './main-window-focus';
import { OrgMultiRepoSyncRefusedError } from './org-member-multi-repo-sync';
import { getOrgMemberMultiRepoSync } from './org-member-multi-repo-sync-deps';
import { readAllSidebarItems } from './sidebar-items';
import { isStartPageFeatureEnabled } from './start-page-feature-flag';
import { w5DaemonReceiptCaller } from '@canopy/core-runtime/node/w5/workspace-metadata/receipt-caller';
import type { W5WireCall } from './w5-boundary-operation';
import { admitWorkspace } from './workspace-metadata-host';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';
import { requestRefresh } from './workspace-reference-repo-poller';
import { checkRepoAddsWithoutPaths } from './workspace-source-change-apply';
import {
  applySourceChanges,
  WorkspaceSourceChangesRefusedError,
} from './workspace-source-changes';
import {
  initializeWorkspaceSourceRepo,
  WorkspaceSourceRepoRefusedError,
} from './workspace-source-control';
import {
  convertWorkspaceType,
  WorkspaceTypeConversionRefusedError,
} from './workspace-type-conversion';
import {
  renameWorktreeBranch,
  WorktreeBranchRenameRefusedError,
} from './worktree-branch-rename';

/*
 * The desktop host behind the registered keyed source, composition, rename
 * and fork lifecycles (W7b-4, CAN-5552). An IPC projection's call runs the
 * host request its projection carries, unchanged
 * (`source-composition-dispatch.ts`). Any other admitted caller is a wire
 * call: it is addressed before any key is reserved (RR5), its receipts name
 * its principal (A13), and it runs the same Electron boundary with the same
 * post-commit effects. Lifecycle execution stays here until CAN-4737.
 */

function wireCall(
  source: string,
  call: CoreSourceCompositionCall,
  admit: () => Promise<void>,
): W5WireCall {
  return {
    caller: w5DaemonReceiptCaller(call.caller.principalId, source),
    admit,
  };
}

function refuse(
  reason: ConstructorParameters<typeof CoreLifecycleRefusedError>[0],
  message: string,
): never {
  throw new CoreLifecycleRefusedError(reason, message);
}

/** A desktop boundary's typed refusal, as the wire mapping reads it. */
function wireFailure(error: unknown): unknown {
  const reason =
    error instanceof WorktreeBranchRenameRefusedError ||
    error instanceof WorkspaceSourceRepoRefusedError ||
    error instanceof WorkspaceTypeConversionRefusedError ||
    error instanceof WorkspaceSourceChangesRefusedError ||
    error instanceof OrgMultiRepoSyncRefusedError
      ? error.reason
      : error instanceof SharedContainerForkError
        ? error.code
        : undefined;
  return reason !== undefined &&
    error instanceof Error &&
    isCoreLifecycleRefusal(reason)
    ? new CoreLifecycleRefusedError(reason, error.message, error)
    : error;
}

async function asWire<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw wireFailure(error);
  }
}

/** RR5: the worktree's row is readable and present, before any key is used. */
async function admitWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  await admitWorkspace(workspaceId, 'not-found');
  const { worktrees, authority } = await readWorkspaceWorktreesDetailed(
    workspaceId,
    { persistRemovalCleanup: false },
  );
  if (authority === 'unreadable' || authority === 'partial')
    refuse(
      'worktrees-unavailable',
      "Couldn't read this project's worktrees. Try again.",
    );
  if (!worktrees.some((worktree) => worktree.id === worktreeId))
    refuse('not-found', `Worktree ${worktreeId} not found.`);
}

function refreshDiffStats(workspaceId: string, worktreeId: string): void {
  invalidateWorktreeDiffStats(workspaceId, worktreeId);
  trackDetachedWork(() => refreshWorktreeDiffStats(workspaceId, worktreeId));
}

function scriptInputMap(
  scripts: Readonly<Record<string, unknown>> | undefined,
): ScriptInputMap | undefined {
  if (scripts === undefined) return undefined;
  const map: ScriptInputMap = {};
  for (const [name, value] of Object.entries(scripts))
    if (
      value === null ||
      typeof value === 'string' ||
      isScriptDefinition(value)
    )
      map[name] = value;
  return map;
}

/**
 * Hooks exactly as the IPC request carries them: the boundary normalizes
 * them, and an empty map clears the saved hooks, so it must not collapse to
 * "unchanged" here.
 */
function hookInputMap(
  hooks:
    | NonNullable<CoreWorkspaceSourceChangesApplyParams['hooks']>
    | undefined,
): HookInputMap | undefined {
  return hooks;
}

function pluginRefs(
  plugins: CoreWorkspaceSourceChangesApplyParams['plugins'],
): ShareablePluginRef[] | undefined {
  if (plugins === undefined) return undefined;
  // A wire ref is untrusted: only its normalized fields reach canopy.json.
  return plugins.map((plugin): ShareablePluginRef => {
    try {
      return normalizeShareablePluginRef(plugin);
    } catch {
      return refuse(
        'invalid-request',
        'Only portable skill and plugin references can be saved to source control.',
      );
    }
  });
}

type SourceChangesInput = Omit<CoreWorkspaceSourceChangesApplyParams, '_meta'>;

function startPage(input: SourceChangesInput): {
  startPage?: WorkspaceApplySourceChangesRequest['startPage'];
} {
  if (input.startPage === undefined) return {};
  if (input.startPage !== null && !isProjectStartPage(input.startPage))
    refuse('invalid-request', 'Invalid start page');
  return { startPage: input.startPage };
}

/** A multi-repo root change, as `workspace:apply-source-changes` sends it. */
function workspaceSourceChanges(
  input: SourceChangesInput,
): WorkspaceApplySourceChangesRequest {
  const scripts = scriptInputMap(input.scripts);
  const hooks = hookInputMap(input.hooks);
  const plugins = pluginRefs(input.plugins);
  return {
    workspaceId: input.workspaceId,
    target: input.target,
    ...(input.claudeMd !== undefined && { claudeMd: input.claudeMd }),
    ...(scripts !== undefined && { workspaceScripts: scripts }),
    ...(hooks !== undefined && { workspaceHooks: hooks }),
    ...(plugins !== undefined && { workspacePlugins: plugins }),
    ...startPage(input),
    ...(input.repoScriptChanges !== undefined && {
      repoScriptChanges: input.repoScriptChanges.map((change) => ({
        repoId: change.repoId,
        scripts: scriptInputMap(change.scripts) ?? {},
      })),
    }),
    ...(input.repoHookChanges !== undefined && {
      repoHookChanges: input.repoHookChanges.map((change) => ({
        repoId: change.repoId,
        hooks: hookInputMap(change.hooks) ?? {},
      })),
    }),
    ...(input.repoAdds !== undefined && {
      repoAdds: input.repoAdds.map((add) => {
        const addScripts = scriptInputMap(add.scripts);
        const addHooks = hookInputMap(add.hooks);
        return {
          ...(add.repoId !== undefined && { repoId: add.repoId }),
          repoName: add.repoName,
          remoteUrl: add.remoteUrl,
          ...(addScripts !== undefined && { scripts: addScripts }),
          ...(addHooks !== undefined && { hooks: addHooks }),
        };
      }),
    }),
    ...(input.repoRemovals !== undefined && {
      repoRemovals: input.repoRemovals,
    }),
  };
}

/** A single-repo change, as `project:apply-source-changes` sends it. */
function projectSourceChanges(
  input: SourceChangesInput,
): ProjectApplySourceChangesRequest {
  if (
    input.claudeMd !== undefined ||
    input.repoScriptChanges !== undefined ||
    input.repoHookChanges !== undefined ||
    input.repoAdds !== undefined ||
    input.repoRemovals !== undefined
  )
    refuse(
      'not-multi-repo',
      'Only a multi-repo project has repository and instruction changes.',
    );
  const scripts = scriptInputMap(input.scripts);
  const hooks = hookInputMap(input.hooks);
  const plugins = pluginRefs(input.plugins);
  return {
    projectId: input.workspaceId,
    target: input.target,
    ...(scripts !== undefined && { scripts }),
    ...(hooks !== undefined && { hooks }),
    ...(plugins !== undefined && { plugins }),
    ...startPage(input),
  };
}

/** The variant the workspace's own type selects; a Cowork one has none. */
async function sourceChangesVariant(
  workspaceId: string,
): Promise<'workspace' | 'project'> {
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority === 'absent')
    refuse('not-found', `Project ${workspaceId} not found.`);
  if (detail.authority === 'unreadable')
    refuse(
      'configuration-unavailable',
      "Couldn't read this project's settings. Try again.",
    );
  if (detail.config.type === 'multi-repo') return 'workspace';
  if (detail.config.type === 'single-repo') return 'project';
  return refuse(
    'cowork-workspace',
    'A Cowork project has no source-controlled settings.',
  );
}

function sourceChangesRevisions(input: SourceChangesInput): Array<{
  resource:
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'worktrees'; workspaceId: string };
  revision: number;
}> {
  const { workspaceId } = input;
  return [
    ...(input.expectedRevision === undefined
      ? []
      : [
          {
            resource: { kind: 'workspace' as const, workspaceId },
            revision: input.expectedRevision,
          },
        ]),
    ...(input.expectedWorktreesRevision === undefined
      ? []
      : [
          {
            resource: { kind: 'worktrees' as const, workspaceId },
            revision: input.expectedWorktreesRevision,
          },
        ]),
  ];
}

/**
 * RR5 for a source change, for a new key only: a replay answers its saved
 * outcome even after the start page is turned off.
 */
async function admitSourceChanges(input: SourceChangesInput): Promise<void> {
  await admitWorkspace(input.workspaceId, 'not-found');
  if (input.startPage !== undefined && !isStartPageFeatureEnabled())
    refuse('feature-unavailable', 'Start page is unavailable');
}

/** RR5 for a promotion: a temporary multi-repo project, by its index row. */
async function admitTemporaryWorkspace(workspaceId: string): Promise<void> {
  await admitWorkspace(workspaceId, 'not-found');
  const { items } = await readAllSidebarItems({ persistRemovalCleanup: false });
  const workspace = items.find((item) => item.id === workspaceId);
  if (!workspace || workspace.type !== 'multi-repo')
    refuse(
      'not-temporary',
      `Project ${workspaceId} is not a multi-repo project`,
    );
  if (workspace.temporary !== true)
    refuse('not-temporary', `Project ${workspaceId} is not temporary`);
}

function isSharedContainersEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key,
  );
}

/** The host, with `dispatcher` running a wire call's own Git effect. */
export function createDesktopSourceCompositionHost(
  dispatcher: LifecycleEffectDispatcher,
): CoreSourceCompositionHost {
  return {
    async initializeSourceRepo(input, call) {
      const projection = takeWorkspaceLifecycleProjection(
        'core.workspace.sourceRepo.initialize',
      );
      if (projection) return answerWorkspaceLifecycleProjection(projection);
      const outcome = await asWire(() =>
        initializeWorkspaceSourceRepo({
          workspaceId: input.workspaceId,
          ...(input.repoName !== undefined && { repoName: input.repoName }),
          source: 'workspace_settings',
          ...(input.expectedRevision !== undefined && {
            expectedRevision: input.expectedRevision,
          }),
          idempotencyKey: call.idempotencyKey,
          wireCall: wireCall('workspace-source-initialization', call, () =>
            admitWorkspace(input.workspaceId, 'not-found'),
          ),
        }),
      );
      // The saved manifest as JSON; the source repository path stays here.
      const manifest: unknown = JSON.parse(JSON.stringify(outcome.manifest));
      return CoreWorkspaceSourceRepoInitializeResultSchema.parse({
        workspaceId: input.workspaceId,
        manifest,
        warnings: outcome.warnings,
      });
    },
    async convertType(input, call) {
      const projection = takeWorkspaceLifecycleProjection(
        'core.workspace.type.convert',
      );
      if (projection) return answerWorkspaceLifecycleProjection(projection);
      await asWire(() =>
        convertWorkspaceType({
          workspaceId: input.workspaceId,
          targetType:
            input.targetKind === 'multi_repo' ? 'multi-repo' : 'single-repo',
          ...(input.claudeMdMode !== undefined && {
            claudeMdMode: input.claudeMdMode,
          }),
          source: 'workspace_settings',
          ...(input.expectedRevision !== undefined && {
            expectedRevision: input.expectedRevision,
          }),
          idempotencyKey: call.idempotencyKey,
          wireCall: wireCall('workspace-type-conversion', call, () =>
            admitWorkspace(input.workspaceId, 'not-found'),
          ),
        }),
      );
      return { workspaceId: input.workspaceId, kind: input.targetKind };
    },
    async applySourceChanges(
      input,
      call,
    ): Promise<CoreWorkspaceSourceChangesApplyResult> {
      const projection = takeWorkspaceLifecycleProjection(
        'core.workspace.sourceChanges.apply',
      );
      if (projection) return answerWorkspaceLifecycleProjection(projection);
      const { workspaceId } = input;
      // The variant selects the boundary's request, so it is read before the
      // receipt lookup; addressing still runs after it (RR5).
      const variant = await asWire(() => sourceChangesVariant(workspaceId));
      const options = {
        expectedRevisions: sourceChangesRevisions(input),
        idempotencyKey: call.idempotencyKey,
        wireCall: wireCall('workspace-source-changes', call, () =>
          admitSourceChanges(input),
        ),
        // Setup progress reaches the main window. The applied event only
        // closes the settings dialog whose request id it echoes, so a wire
        // call, which has none, sends no event.
        getWindow: getMainWindow,
      };
      if (variant === 'project') {
        const request = projectSourceChanges(input);
        const response = await asWire(() =>
          applySourceChanges({
            ...options,
            kind: 'project',
            source: 'project_settings',
            request,
          }),
        );
        return {
          workspaceId,
          worktreeId: response.worktreeId,
          branchName: response.branchName,
          createdWorktree: response.createdWorktree,
        };
      }
      const request = workspaceSourceChanges(input);
      // Its additions carry no repoPath, so the organization's gate only
      // checks, and the apply's own repository refusals are raised here.
      const response = await asWire(() =>
        applySourceChanges({
          ...options,
          wireCall: wireCall('workspace-source-changes', call, async () => {
            await admitSourceChanges(input);
            await getOrgMemberMultiRepoSync().checkSourceChanges(
              workspaceId,
              request,
            );
            await checkRepoAddsWithoutPaths(request);
          }),
          kind: 'workspace',
          source: 'workspace_settings',
          request,
          onApplied: () => requestRefresh(workspaceId, true),
        }),
      );
      return {
        workspaceId,
        worktreeId: response.worktreeId,
        branchName: response.branchName,
        createdWorktree: response.createdWorktree,
        localRepoBindingsUpdated: response.localRepoBindingsUpdated,
      };
    },
    async promote(input, call) {
      const projection = takeWorkspaceLifecycleProjection(
        'core.workspace.composition.promote',
      );
      if (projection) return answerWorkspaceLifecycleProjection(projection);
      const name = input.name.trim();
      if (!name) refuse('invalid-request', 'Project name is required');
      const promoted = await asWire(() =>
        promoteTemporaryWorkspace({
          workspaceId: input.workspaceId,
          name,
          expectedRevision: input.expectedRevision,
          idempotencyKey: call.idempotencyKey,
          wireCall: wireCall('composition-promote', call, () =>
            admitTemporaryWorkspace(input.workspaceId),
          ),
        }),
      );
      return { workspaceId: promoted.id };
    },
    async renameBranch(input, call) {
      const projection = takeWorkspaceLifecycleProjection(
        'core.worktree.branch.rename',
      );
      if (projection) return answerWorkspaceLifecycleProjection(projection);
      const { workspaceId, worktreeId } = input;
      const outcome = await asWire(() =>
        renameWorktreeBranch(
          {
            source: 'desktop',
            workspaceId,
            worktreeId,
            ...(input.repoId !== undefined && { repoId: input.repoId }),
            newBranchName: input.branchName,
            ...(input.expectedRevision !== undefined && {
              expectedRevision: input.expectedRevision,
            }),
            idempotencyKey: call.idempotencyKey,
            wireCall: wireCall('desktop', call, () =>
              admitWorktree(workspaceId, worktreeId),
            ),
          },
          // The rename's Git effect runs as this caller, as the IPC one does.
          {
            onRenamed: () => refreshDiffStats(workspaceId, worktreeId),
            renameCheckoutBranch: async (scope, name): Promise<void> => {
              try {
                await dispatcher().instruction(
                  'worker.git.branch.rename',
                  { scope, name },
                  {
                    caller: {
                      ...call.caller,
                      grants: [WORKER_GIT_GRANTS.write],
                    },
                  },
                );
              } catch (error) {
                throw error instanceof CanopyOperationError &&
                  error.runtimeCause !== undefined
                  ? error.runtimeCause
                  : error;
              }
            },
          },
        ),
      );
      return { workspaceId, worktreeId, branchName: outcome.branchName };
    },
    async fork(input, call) {
      const projection = takeWorkspaceLifecycleProjection(
        'core.sharedContainer.fork',
      );
      if (projection) return answerWorkspaceLifecycleProjection(projection);
      const { destination } = input;
      const response = await asWire(() =>
        forkSharedContainer({
          containerId: input.containerId,
          revisionId: input.revisionId,
          ...(input.organizationId !== undefined && {
            organizationId: input.organizationId,
          }),
          sourceOwnerDisplayName: input.sourceOwnerDisplayName.trim(),
          // A new workspace takes the host's default location (A5).
          destination:
            destination.kind === 'existing-workspace'
              ? destination
              : { kind: 'new-workspace', owner: destination.owner },
          ...(input.expectedPackageDigest !== undefined && {
            expectedPackageDigest: input.expectedPackageDigest,
          }),
          ...(input.expectedRevision !== undefined && {
            expectedRevision: input.expectedRevision,
          }),
          idempotencyKey: call.idempotencyKey,
          // The fork service resolves and authorizes its source and owner.
          wireCall: wireCall('shared-container-fork', call, () => {
            if (!isSharedContainersEnabled())
              refuse('feature-unavailable', 'Shared containers are disabled.');
            return Promise.resolve();
          }),
        }),
      );
      return CoreSharedContainerForkResultSchema.parse({
        containerType: response.containerType,
        workspaceId: response.projectId,
        worktreeId: response.worktreeId,
        warnings: response.warnings,
        provenance: response.provenance,
      });
    },
  };
}
