import {
  buildShareablePluginDisplay,
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import {
  SUPPORTED_HOOK_TRIGGERS,
  type ChatHookAction,
  type HookAction,
  type HookSourceLayer,
} from '@canopy/desktop-shared/types';
import type {
  HookChatPluginDependencyItem,
  HookChatPluginDependencyUsage,
  InspectHookChatPluginDependenciesRequest,
  InspectHookChatPluginDependenciesResponse,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorktreeDir,
} from './paths';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  collectProjectHookLayers,
  collectWorkspaceRepoHookLayers,
  collectWorkspaceRootHookLayers,
} from './hook-resolver';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
} from '../plugins/shareable-plugin-resolution';

function isChatHookAction(action: HookAction): action is ChatHookAction {
  return action.type === 'chat';
}

function isSourceAuthoredLayer(layer: HookSourceLayer): boolean {
  return (
    layer.status === 'active' &&
    layer.sourceKey !== 'local-override' &&
    Array.isArray(layer.actions)
  );
}

function collectPluginsFromLayer(layer: HookSourceLayer): ShareablePluginRef[] {
  if (!Array.isArray(layer.actions)) {
    return [];
  }
  return layer.actions
    .filter(isChatHookAction)
    .flatMap((action) => action.plugins ?? []);
}

function buildUsage(
  scope: HookChatPluginDependencyUsage['scope'],
  triggerName: string,
  repo?: { id: string; name: string },
): HookChatPluginDependencyUsage {
  return {
    triggerName,
    scope,
    ...(repo ? { repoId: repo.id, repoName: repo.name } : {}),
  };
}

function upsertMissingItem(
  items: Map<string, HookChatPluginDependencyItem>,
  ref: ShareablePluginRef,
  usage: HookChatPluginDependencyUsage,
): void {
  const key = getShareablePluginRefKey(ref);
  const existing = items.get(key);
  if (existing) {
    existing.usedBy.push(usage);
    return;
  }

  const display = buildShareablePluginDisplay(ref);
  // Built-in marketplace plugins are bundled locally and need no dependency install action.
  const installSpec =
    ref.type === 'skill' && ref.source.type === 'github'
      ? {
          kind: 'skill' as const,
          repo: ref.source.repo,
          skillName: ref.skill_name,
        }
      : (ref.type === 'plugin' || ref.type === 'claude_plugin') &&
          ref.marketplace.type === 'github'
        ? {
            kind: 'plugin' as const,
            repo: ref.marketplace.repo,
            pluginName: ref.plugin_name,
          }
        : undefined;

  items.set(key, {
    key,
    kind: ref.type === 'skill' ? 'skill' : 'plugin',
    displayName: display.title,
    displayDescription: display.title,
    displaySource: display.subtitle,
    installState: installSpec ? 'installable' : 'unavailable',
    ...(installSpec ? { installSpec } : {}),
    usedBy: [usage],
  });
}

function collectLayerDependencies(args: {
  layers: HookSourceLayer[];
  triggerName: string;
  usage: HookChatPluginDependencyUsage;
  items: Map<string, HookChatPluginDependencyItem>;
  catalog: Awaited<ReturnType<typeof loadShareablePluginCatalog>>;
}): void {
  for (const layer of args.layers) {
    if (!isSourceAuthoredLayer(layer)) {
      continue;
    }
    for (const ref of collectPluginsFromLayer(layer)) {
      const match = matchShareablePluginRef(ref, args.catalog);
      if (match.matchState === 'unmatched') {
        upsertMissingItem(args.items, ref, args.usage);
      }
    }
  }
}

export async function inspectHookChatPluginDependencies(
  request: InspectHookChatPluginDependenciesRequest,
): Promise<InspectHookChatPluginDependenciesResponse> {
  const config = await readWorkspaceConfig(request.projectId);
  const catalog = await loadShareablePluginCatalog();
  const items = new Map<string, HookChatPluginDependencyItem>();

  for (const triggerName of SUPPORTED_HOOK_TRIGGERS) {
    if (config.type === 'single-repo') {
      const layers = await collectProjectHookLayers(
        {
          repoPath:
            config.repoPath ??
            getWorktreeDir(request.projectId, request.worktreeId),
          hooks: config.hooks,
        },
        triggerName,
        getWorktreeDir(request.projectId, request.worktreeId),
      );
      collectLayerDependencies({
        layers,
        triggerName,
        usage: buildUsage('project', triggerName),
        items,
        catalog,
      });
      continue;
    }

    const workspaceRootPath = getWorkspaceWorktreeRootRepoDir(
      request.projectId,
      request.worktreeId,
    );
    const rootLayers = await collectWorkspaceRootHookLayers(
      request.projectId,
      triggerName,
      { workspaceRootPath },
    );
    collectLayerDependencies({
      layers: rootLayers,
      triggerName,
      usage: buildUsage('workspace-root', triggerName),
      items,
      catalog,
    });

    for (const repo of config.repos) {
      const layers = await collectWorkspaceRepoHookLayers(
        request.projectId,
        repo.id,
        triggerName,
        {
          workspaceRootPath,
          repoPath: getWorkspaceWorktreeRepoDir(
            request.projectId,
            request.worktreeId,
            repo.id,
          ),
        },
      );
      collectLayerDependencies({
        layers,
        triggerName,
        usage: buildUsage('workspace-repo', triggerName, {
          id: repo.id,
          name: repo.name,
        }),
        items,
        catalog,
      });
    }
  }

  return {
    items: Array.from(items.values()).sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    ),
  };
}
