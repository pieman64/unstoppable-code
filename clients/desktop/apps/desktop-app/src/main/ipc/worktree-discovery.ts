import {
  BrowserWindow,
  type BrowserWindow as ElectronBrowserWindow,
} from 'electron';
import {
  IPC_CHANNELS,
  APP_ADVISOR_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  hasAnySelections,
  type AgentProviderType,
  type ChatTabPluginSelections,
  type CodexSelectedCapabilityRoot,
  type WorktreeDiscovery,
  type WorktreeDiscoveryEvent,
  type WorktreeDiscoveryRequest,
} from '@canopy/desktop-shared/types';
import { discoverCodexWorktreeEnvironment } from '../agents/codex-discovery';
import { discoverWorktreeEnvironment } from '../agents/sdk-discovery';
import type { ClaudeModLaunchPluginRequest } from '../agents/claude-mod-admission-launch';
import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { validateId } from '../lib/validation';
import { recordWorktreeDiscovery } from '../lib/worktree-repair';
import { registerIpcHandler } from './register';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';

// In-flight discoveries keyed by "projectId/worktreeId" to prevent duplicates.
const inflight = new Map<string, AbortController>();

async function resolveDiscoveryCwd(
  projectId: string,
  worktreeId: string,
  selectedRepoId?: string,
): Promise<string> {
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    await ensureAppAdvisorHomeScaffold();
    return resolveWorktreeCwd(projectId, worktreeId, selectedRepoId);
  }

  return resolveWorktreeCwd(projectId, worktreeId, selectedRepoId);
}

function emit(
  getWindow: () => SendableBrowserWindow | null,
  event: WorktreeDiscoveryEvent,
  requesterWindow?: SendableBrowserWindow | null,
): void {
  const primaryWindow = getWindow();
  sendToWindow(primaryWindow, IPC_CHANNELS.worktreeDiscoveryEvent, event);
  if (requesterWindow && requesterWindow !== primaryWindow) {
    sendToWindow(requesterWindow, IPC_CHANNELS.worktreeDiscoveryEvent, event);
  }
}

export interface RunProviderDiscoveryOptions {
  cwd: string;
  providerType: AgentProviderType;
  projectId: string;
  worktreeId: string;
  chatId: string;
  pluginSelections?: ChatTabPluginSelections;
  /**
   * Applies the global default-plugin overlay during resolution so discovery
   * surfaces the commands/servers a session would actually get. Chat and
   * Home discovery set this.
   */
  applyGlobalDefaults?: boolean;
  /**
   * `pluginSelections` is a Home draft for a chat not created yet: discovery
   * resolves it as that chat will (see `ChatPluginOverlayOptions`).
   */
  draftPluginSelections?: boolean;
  strictEmptyMcpConfig?: boolean;
  safeProjectDiscovery?: boolean;
  signal: AbortSignal;
}

/**
 * Core provider discovery: resolve plugin selections into provider-specific
 * inputs, dispatch to the claude/codex/ollama discovery implementation, and
 * map the result into a {@link WorktreeDiscovery}. Pure — no persistence and
 * no window-event emission; callers own both.
 */
export async function runProviderDiscovery(
  options: RunProviderDiscoveryOptions,
): Promise<WorktreeDiscovery> {
  const {
    cwd,
    providerType,
    projectId,
    worktreeId,
    chatId,
    pluginSelections,
    applyGlobalDefaults,
    draftPluginSelections,
    strictEmptyMcpConfig,
    safeProjectDiscovery,
    signal,
  } = options;

  // Resolve plugin selections into provider-specific discovery inputs. One
  // overlay pass: effective selections are computed here (with all overlay
  // IO) and passed straight into resolvePlugins.
  const pluginContext = await resolveEffectiveChatPluginContext(
    pluginSelections,
    { projectId, worktreeId, chatId },
    applyGlobalDefaults && draftPluginSelections
      ? { draft: true }
      : applyGlobalDefaults,
  );
  const effectiveSelections = pluginContext.selections;
  let sdkPlugins: ClaudeModLaunchPluginRequest[] | undefined;
  let selectedCapabilityRoots: CodexSelectedCapabilityRoot[] | undefined;
  if (hasAnySelections(effectiveSelections)) {
    try {
      const resolved = await resolvePlugins(
        effectiveSelections,
        projectId,
        worktreeId,
        chatId,
        {
          // Discovery only materializes metadata, so HTTP MCP auth falls
          // back to provider-side handling when no proxy service is present.
          purpose: providerType === 'codex' ? 'codex-discovery' : 'discovery',
          cwd,
          ...(pluginContext.preferences
            ? { preferences: pluginContext.preferences }
            : {}),
        },
      );
      if (providerType !== 'codex' && resolved.sdkPlugins.length > 0) {
        sdkPlugins = resolved.identifiedSdkPlugins ?? resolved.sdkPlugins;
      }
      if (
        providerType === 'codex' &&
        resolved.selectedCapabilityRoots.length > 0
      ) {
        selectedCapabilityRoots = resolved.selectedCapabilityRoots;
      }
      for (const warning of resolved.warnings) {
        // eslint-disable-next-line no-console
        console.warn('[discovery]', warning);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[discovery] Failed to resolve plugins:', err);
    }
  }

  const result =
    providerType === 'codex'
      ? await discoverCodexWorktreeEnvironment({
          cwd,
          projectId,
          worktreeId,
          chatId,
          signal,
          selectedCapabilityRoots,
          strictEmptyMcpConfig,
          safeProjectDiscovery,
        })
      : await discoverWorktreeEnvironment(
          cwd,
          signal,
          undefined,
          sdkPlugins,
          providerType === 'ollama'
            ? await resolveClaudeCompatibleInvocation(undefined, {
                providerType: 'ollama',
                ensureRunningReason: 'chat',
              })
            : undefined,
          projectId,
          strictEmptyMcpConfig || safeProjectDiscovery
            ? {
                ...(strictEmptyMcpConfig ? { strictEmptyMcpConfig: true } : {}),
                ...(safeProjectDiscovery ? { safeProjectDiscovery: true } : {}),
              }
            : undefined,
        );

  return {
    slashCommands: result.slashCommands,
    mcpServers: result.mcpServers,
    discoveredAt: new Date().toISOString(),
    providerType,
    ...('skippedMods' in result && result.skippedMods
      ? { skippedMods: result.skippedMods }
      : {}),
  };
}

async function runDiscovery(
  projectId: string,
  worktreeId: string,
  getWindow: () => SendableBrowserWindow | null,
  pluginSelections?: ChatTabPluginSelections,
  chatId?: string,
  providerType: AgentProviderType = 'claude',
  selectedRepoId?: string,
  requesterWindow?: SendableBrowserWindow | null,
): Promise<void> {
  // When chatId is provided, key by chat tab to avoid clobbering other tabs.
  const key = chatId
    ? `${projectId}/${worktreeId}/${chatId}`
    : `${projectId}/${worktreeId}`;

  // Cancel any existing in-flight discovery for this key.
  inflight.get(key)?.abort();
  const ac = new AbortController();
  inflight.set(key, ac);

  // Signal loading to the renderer.
  emit(
    getWindow,
    { projectId, worktreeId, chatId, discovery: null },
    requesterWindow,
  );

  try {
    const cwd = await resolveDiscoveryCwd(
      projectId,
      worktreeId,
      selectedRepoId,
    );

    const discovery = await runProviderDiscovery({
      cwd,
      providerType,
      projectId,
      worktreeId,
      chatId: chatId ?? '__discovery__',
      pluginSelections,
      applyGlobalDefaults: chatSurfaceUsesGlobalPluginDefaults(projectId),
      signal: ac.signal,
    });

    if (ac.signal.aborted) return;

    // Only persist to the worktrees file for worktree-level discoveries
    // (no chatId, no repo scoping). Per-tab and repo-scoped discoveries are
    // transient renderer state — the persisted worktree-level discovery is
    // always rooted at the workspace.
    if (
      !chatId &&
      (selectedRepoId === undefined ||
        selectedRepoId === WORKSPACE_ROOT_REPO_ID)
    ) {
      // A Mod forecast is current state; the saved record never keeps it.
      const { skippedMods: _forecast, ...persistedDiscovery } = discovery;
      void _forecast;
      await recordWorktreeDiscovery({
        kind: 'environment',
        workspaceId: projectId,
        worktreeId,
        discovery: persistedDiscovery,
      });
    }
    emit(
      getWindow,
      { projectId, worktreeId, chatId, discovery },
      requesterWindow,
    );
  } catch (err) {
    if (!ac.signal.aborted) {
      // eslint-disable-next-line no-console
      console.warn('Worktree discovery failed:', err);
      emit(
        getWindow,
        {
          projectId,
          worktreeId,
          chatId,
          discovery: {
            slashCommands: [],
            mcpServers: [],
            discoveredAt: new Date().toISOString(),
            providerType,
          },
        },
        requesterWindow,
      );
    }
  } finally {
    if (inflight.get(key) === ac) {
      inflight.delete(key);
    }
  }
}

export function triggerDiscovery(
  projectId: string,
  worktreeId: string,
  getWindow: () => SendableBrowserWindow | null,
  pluginSelections?: ChatTabPluginSelections,
  chatId?: string,
  providerType?: AgentProviderType,
  selectedRepoId?: string,
): void {
  trackDetachedWork(() =>
    runDiscovery(
      projectId,
      worktreeId,
      getWindow,
      pluginSelections,
      chatId,
      providerType,
      selectedRepoId,
    ),
  );
}

export function cancelAllDiscoveries(): void {
  for (const ac of Array.from(inflight.values())) {
    ac.abort();
  }
  inflight.clear();
}

export function registerWorktreeDiscoveryHandlers(
  getWindow: () => ElectronBrowserWindow | null,
): void {
  registerIpcHandler(
    IPC_CHANNELS.worktreeDiscover,
    (event, request: WorktreeDiscoveryRequest): void => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      if (request.chatId) {
        validateId(request.chatId, 'chatId');
      }
      const requesterWindow = BrowserWindow.fromWebContents(event.sender);
      // Fire and forget — results arrive via worktreeDiscoveryEvent.
      trackDetachedWork(() =>
        runDiscovery(
          request.projectId,
          request.worktreeId,
          getWindow,
          request.pluginSelections,
          request.chatId,
          request.providerType,
          request.selectedRepoId,
          requesterWindow,
        ),
      );
    },
  );
}
