import {
  getChatHookActionOverlayKey,
  normalizeHookInputMap,
  type HookAction,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import { BRAND } from '@canopy/brand/current';
import type {
  HookSourceLayer,
  ProjectData,
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
import { readCanopyJson } from './canopy-json';
import {
  resolveWorkspaceRepoScripts,
  toScriptOverrides,
} from './script-resolver';
import {
  assignEffectiveSourceLayerStatus,
  buildHookSourceLayer,
  readWorkspaceCanopyManifest,
  readWorkspaceRepoLayerContext,
  type WorkspaceRepoLayerPaths,
} from './source-layer-resolution';
import { readWorkspaceConfig } from './workspace-persistence';
import { recordOrganizationHookBindings } from './workspace-ownership';

export interface ResolvedHookField {
  actions?: HookAction[];
  source:
    | 'local-override'
    | 'local-disabled'
    | 'repo-canopy'
    | 'workspace-manifest'
    | 'workspace-manifest-disabled'
    | 'workspace-hook'
    | 'workspace-hook-disabled'
    | 'none';
}

export type ResolvedHookMap = Record<string, ResolvedHookField>;

export interface WorkspaceHookResolutionPaths {
  workspaceRootPath?: string;
  repoPath?: string;
  localConfig?: WorkspaceConfigFile;
}

export async function resolveProjectHooks(
  project: Pick<ProjectData, 'repoPath' | 'hooks'> &
    Partial<Pick<ProjectData, 'id' | 'owner'>>,
  repoPathOverride?: string,
): Promise<ResolvedHookMap> {
  const resolved: ResolvedHookMap = {};
  const repoPath = repoPathOverride ?? project.repoPath;
  const repoManifest = await readCanopyJson(repoPath);

  applyActiveHooks(resolved, repoManifest?.hooks, 'repo-canopy');
  const { hooks: localHooks, owner } =
    project.id === undefined || project.owner === undefined
      ? { hooks: project.hooks, owner: project.owner }
      : await recordOrganizationHookBindings({
          workspaceId: project.id,
          source: 'hook_resolution',
          sourceHooks: repoManifest?.hooks,
          localHooks: project.hooks,
          owner: project.owner,
        });
  applyLocalPluginSelectionOverlays(resolved, localHooks);
  applyOverrideHooks(resolved, localHooks, 'local-override', 'local-disabled', {
    preserveSourceForPluginSelections: true,
  });

  applyLocalExecutionContextOverlays(resolved, localHooks, owner);
  return resolved;
}

export async function resolveWorkspaceRootHooks(
  workspaceId: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<ResolvedHookMap> {
  const localConfig =
    paths?.localConfig ?? (await readWorkspaceConfig(workspaceId));
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );
  const resolved: ResolvedHookMap = {};

  applyActiveHooks(resolved, workspaceManifest?.hooks, 'workspace-hook');
  const { hooks: localHooks, owner } =
    localConfig.owner === undefined
      ? { hooks: localConfig.hooks, owner: undefined }
      : await recordOrganizationHookBindings({
          workspaceId,
          source: 'hook_resolution',
          sourceHooks: workspaceManifest?.hooks,
          localHooks: localConfig.hooks,
          owner: localConfig.owner,
        });
  applyLocalPluginSelectionOverlays(resolved, localHooks);
  applyOverrideHooks(resolved, localHooks, 'local-override', 'local-disabled', {
    preserveSourceForPluginSelections: true,
  });

  applyLocalExecutionContextOverlays(resolved, localHooks, owner);
  return resolved;
}

export async function resolveWorkspaceRepoHooks(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<ResolvedHookMap> {
  const { localConfig, repo, repoManifest, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);

  const resolved: ResolvedHookMap = {};
  applyActiveHooks(resolved, repoManifest?.hooks, 'repo-canopy');
  applyOverrideHooks(
    resolved,
    workspaceManifestRepo?.hooks,
    'workspace-manifest',
    'workspace-manifest-disabled',
  );
  const { hooks: localHooks, owner } =
    localConfig.owner === undefined
      ? { hooks: repo.hooks, owner: undefined }
      : await recordOrganizationHookBindings({
          workspaceId,
          repoId,
          source: 'hook_resolution',
          sourceHooks: toHookOverrides(resolved),
          localHooks: repo.hooks,
          owner: localConfig.owner,
        });
  applyLocalPluginSelectionOverlays(resolved, localHooks);
  applyOverrideHooks(resolved, localHooks, 'local-override', 'local-disabled', {
    preserveSourceForPluginSelections: true,
  });

  applyLocalExecutionContextOverlays(resolved, localHooks, owner);
  return resolved;
}

export function getResolvedHookActions(
  resolved: ResolvedHookMap,
  triggerName: string,
): HookAction[] | null {
  const field = resolved[triggerName];
  if (Array.isArray(field?.actions)) {
    return field.actions;
  }
  if (
    field?.source === 'local-disabled' ||
    field?.source === 'workspace-manifest-disabled' ||
    field?.source === 'workspace-hook-disabled'
  ) {
    return null;
  }

  return null;
}
export function toHookOverrides(
  resolved: ResolvedHookMap,
): HookOverrides | undefined {
  const overrides: Record<string, HookAction[] | null | undefined> = {};

  for (const [triggerName, field] of Object.entries(resolved)) {
    if (Array.isArray(field.actions)) {
      overrides[triggerName] = field.actions;
    } else if (
      field.source === 'local-disabled' ||
      field.source === 'workspace-manifest-disabled' ||
      field.source === 'workspace-hook-disabled'
    ) {
      overrides[triggerName] = null;
    }
  }

  return normalizeHookInputMap(overrides);
}

function applyActiveHooks(
  resolved: ResolvedHookMap,
  hooks: Record<string, HookAction[]> | undefined,
  source: ResolvedHookField['source'],
): void {
  if (!hooks) {
    return;
  }

  for (const [triggerName, actions] of Object.entries(hooks)) {
    resolved[triggerName] = {
      actions,
      source,
    };
  }
}

function applyOverrideHooks(
  resolved: ResolvedHookMap,
  hooks: Record<string, HookAction[] | null> | undefined,
  enabledSource: ResolvedHookField['source'],
  disabledSource: ResolvedHookField['source'],
  options?: { preserveSourceForPluginSelections?: boolean },
): void {
  if (!hooks) {
    return;
  }

  for (const [triggerName, actions] of Object.entries(hooks)) {
    if (Array.isArray(actions)) {
      const executableActions = actions.filter(
        (action) =>
          !isExecutionContextOverlay(action) &&
          (!options?.preserveSourceForPluginSelections ||
            !isPluginSelectionOverlayAction(action)),
      );
      if (executableActions.length === 0) {
        continue;
      }
      resolved[triggerName] = {
        actions: executableActions,
        source: enabledSource,
      };
      continue;
    }

    resolved[triggerName] = {
      source: disabledSource,
    };
  }
}

function isExecutionContextOverlay(
  action: HookAction,
): action is Extract<HookAction, { type: 'pipeline' | 'chat' }> {
  return (
    (action.type === 'pipeline' || action.type === 'chat') &&
    action.localExecutionContextOverlay === true
  );
}

/** Scope is the containing local config; trigger, source and id identify its binding. */
function applyLocalExecutionContextOverlays(
  resolved: ResolvedHookMap,
  hooks: HookOverrides | undefined,
  owner: WorkspaceConfigFile['owner'],
): void {
  for (const [trigger, actions] of Object.entries(hooks ?? {})) {
    const field = resolved[trigger];
    if (!field?.actions || !Array.isArray(actions)) continue;
    // Organization overlays cannot outlive the owner that enabled them.
    const overlays = actions
      .filter(isExecutionContextOverlay)
      .filter(
        (action) =>
          !action.executionContext?.startsWith('org:') ||
          (owner !== undefined &&
            action.executionContext === `org:${owner.organizationId}`),
      );
    if (overlays.length === 0) continue;
    const chatKeyCounts = new Map<string, number>();
    for (const action of field.actions) {
      if (action.type !== 'chat') continue;
      const key = getChatHookActionOverlayKey(action);
      chatKeyCounts.set(key, (chatKeyCounts.get(key) ?? 0) + 1);
    }
    field.actions = field.actions.map((action): HookAction => {
      if (
        (action.type !== 'pipeline' && action.type !== 'chat') ||
        action.executionContext !== undefined
      )
        return action;
      const matches = overlays.filter((overlay) => {
        if (overlay.type !== action.type) return false;
        return action.type === 'pipeline'
          ? overlay.type === 'pipeline' &&
              overlay.source === action.source &&
              overlay.id === action.id
          : overlay.type === 'chat' &&
              getChatHookActionOverlayKey(overlay) ===
                getChatHookActionOverlayKey(action);
      });
      const overlay = matches.length === 1 ? matches[0] : undefined;
      if (
        action.type === 'chat' &&
        chatKeyCounts.get(getChatHookActionOverlayKey(action)) !== 1
      )
        return action;
      return overlay?.executionContext !== undefined
        ? { ...action, executionContext: overlay.executionContext }
        : action;
    });
  }
}

/**
 * Source-control setup retains full local hook actions only to remember each
 * machine's runtime plugin selections. Keep those selections local without
 * letting the retained action copy shadow later source-controlled edits.
 */
function applyLocalPluginSelectionOverlays(
  resolved: ResolvedHookMap,
  hooks: Record<string, HookAction[] | null> | undefined,
): void {
  if (!hooks) {
    return;
  }

  for (const [triggerName, localActions] of Object.entries(hooks)) {
    if (!Array.isArray(localActions)) {
      continue;
    }

    const sourceActions = resolved[triggerName]?.actions;
    if (!sourceActions) {
      continue;
    }

    const overlays = localActions.filter(
      (action): action is Extract<HookAction, { type: 'chat' }> =>
        isPluginSelectionOverlayAction(action) &&
        (action.pluginSelections !== undefined ||
          action.promptReferences !== undefined),
    );
    if (overlays.length === 0) {
      continue;
    }

    const sourceActionKeyCounts = new Map<string, number>();
    for (const sourceAction of sourceActions) {
      if (sourceAction.type !== 'chat') {
        continue;
      }
      const key = getChatHookActionOverlayKey(sourceAction);
      sourceActionKeyCounts.set(key, (sourceActionKeyCounts.get(key) ?? 0) + 1);
    }
    const overlaysByKey = new Map<string, typeof overlays>();
    for (const overlay of overlays) {
      const key = overlay.localPluginSelectionOverlayKey;
      if (!key) {
        continue;
      }
      const matchingOverlays = overlaysByKey.get(key) ?? [];
      matchingOverlays.push(overlay);
      overlaysByKey.set(key, matchingOverlays);
    }

    resolved[triggerName] = {
      ...resolved[triggerName],
      actions: sourceActions.map((sourceAction) => {
        if (sourceAction.type !== 'chat') {
          return sourceAction;
        }
        const key = getChatHookActionOverlayKey(sourceAction);
        const matchingOverlays = overlaysByKey.get(key);
        const overlay =
          sourceActionKeyCounts.get(key) === 1 && matchingOverlays?.length === 1
            ? matchingOverlays[0]
            : undefined;
        return overlay
          ? {
              ...sourceAction,
              ...(overlay.pluginSelections !== undefined
                ? { pluginSelections: overlay.pluginSelections }
                : {}),
              ...(overlay.promptReferences !== undefined
                ? {
                    promptReferences: [
                      ...(sourceAction.promptReferences ?? []),
                      ...overlay.promptReferences.filter(
                        (ref) =>
                          ref.kind === 'plugin' &&
                          ref.plugin.kind === 'installed' &&
                          !(sourceAction.promptReferences ?? []).some(
                            (sourceRef) =>
                              sourceRef.textStart === ref.textStart &&
                              sourceRef.displayText === ref.displayText,
                          ),
                      ),
                    ].sort((a, b) => a.textStart - b.textStart),
                  }
                : {}),
            }
          : sourceAction;
      }),
    };
  }
}

function isPluginSelectionOverlayAction(
  action: HookAction,
): action is Extract<HookAction, { type: 'chat' }> {
  return (
    action.type === 'chat' &&
    action.localPluginSelectionOverlay === true &&
    typeof action.localPluginSelectionOverlayKey === 'string'
  );
}

export async function collectProjectHookLayers(
  project: Pick<ProjectData, 'repoPath' | 'hooks'>,
  triggerName: string,
  repoPathOverride?: string,
): Promise<HookSourceLayer[]> {
  const effectiveRepoPath = repoPathOverride ?? project.repoPath;
  const repoManifest = await readCanopyJson(effectiveRepoPath);
  const layers: HookSourceLayer[] = [];

  const localLayer = buildHookSourceLayer(
    'local-override',
    `${BRAND.displayName} Local Override`,
    project.hooks,
    triggerName,
  );
  if (localLayer) {
    layers.push(localLayer);
  }

  const canopyLayer = buildHookSourceLayer(
    'repo-canopy',
    'canopy.json',
    repoManifest?.hooks,
    triggerName,
  );
  if (canopyLayer) {
    layers.push(canopyLayer);
  }

  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function collectWorkspaceRootHookLayers(
  workspaceId: string,
  triggerName: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<HookSourceLayer[]> {
  const localConfig = await readWorkspaceConfig(workspaceId);
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );
  const layers: HookSourceLayer[] = [];

  const localLayer = buildHookSourceLayer(
    'local-override',
    `${BRAND.displayName} Local Override`,
    localConfig.hooks,
    triggerName,
  );
  if (localLayer) {
    layers.push(localLayer);
  }

  const manifestLayer = buildHookSourceLayer(
    'workspace-hook',
    'canopy.json (project)',
    workspaceManifest?.hooks,
    triggerName,
  );
  if (manifestLayer) {
    layers.push(manifestLayer);
  }

  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function collectWorkspaceRepoHookLayers(
  workspaceId: string,
  repoId: string,
  triggerName: string,
  paths?: WorkspaceHookResolutionPaths,
): Promise<HookSourceLayer[]> {
  const { repo, repoManifest, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);
  const layers: HookSourceLayer[] = [];

  const localLayer = buildHookSourceLayer(
    'local-override',
    `${BRAND.displayName} Local Override`,
    repo.hooks,
    triggerName,
  );
  if (localLayer) {
    layers.push(localLayer);
  }

  const manifestLayer = buildHookSourceLayer(
    'workspace-manifest',
    'canopy.json (project manifest)',
    workspaceManifestRepo?.hooks,
    triggerName,
  );
  if (manifestLayer) {
    layers.push(manifestLayer);
  }

  const canopyLayer = buildHookSourceLayer(
    'repo-canopy',
    'canopy.json',
    repoManifest?.hooks,
    triggerName,
  );
  if (canopyLayer) {
    layers.push(canopyLayer);
  }

  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function resolveWorkspaceRepoDataHooks(
  workspaceId: string,
  repo: WorkspaceRepoData,
  paths?: WorkspaceRepoLayerPaths,
): Promise<WorkspaceRepoData> {
  const [resolvedScripts, resolvedHooks] = await settleAll([
    resolveWorkspaceRepoScripts(workspaceId, repo.id, paths),
    resolveWorkspaceRepoHooks(workspaceId, repo.id, paths),
  ]);

  return {
    ...repo,
    effectiveScripts: toScriptOverrides(resolvedScripts),
    effectiveHooks: toHookOverrides(resolvedHooks),
  };
}
