import type {
  AgentModelConfig,
  ChatCommandResult,
  ChatStateCommandPort,
  ChatTabSettingsPatch,
  PersistedChatTab,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { withCodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import type { CodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import type {
  CoreChatModelChange,
  CoreChatSettingsHost,
  CoreChatSettingsTarget,
} from '../canopy-runtime/core-chat-command-adapter';

/** Applies one committed setting to a chat's live work (session, queued hook chat, restart hold). */
export interface ChatSettingsLiveEffects {
  planMode(target: CoreChatSettingsTarget, enabled: boolean): Promise<void>;
  thinkingLevel(
    target: CoreChatSettingsTarget,
    level: ThinkingLevel,
  ): Promise<void>;
  speed(target: CoreChatSettingsTarget, speed: CodexSpeed): Promise<void>;
}

export interface ChatSettingsHostDependencies {
  /** The per-chat lock model, thinking and speed changes already share. */
  withChatSettingsLock<T>(
    target: CoreChatSettingsTarget,
    work: () => Promise<T>,
  ): Promise<T>;
  /** The canonical tab, or undefined when the chat has none or it cannot be read. */
  readTab(
    target: CoreChatSettingsTarget,
  ): Promise<PersistedChatTab | undefined>;
  effects: ChatSettingsLiveEffects;
  changeModel(
    change: CoreChatModelChange,
    port: ChatStateCommandPort,
  ): Promise<ChatCommandResult>;
}

/**
 * Whether a replayed model change was replaced by a newer one. A chat with no
 * canonical tab (a queued hook chat) answers `already_applied` too, and still
 * takes the requested model.
 */
export function isModelChangeSuperseded(
  tab: PersistedChatTab | undefined,
  model: string,
): boolean {
  return tab !== undefined && tab.model !== model;
}

export function createCoreChatSettingsHost(
  dependencies: ChatSettingsHostDependencies,
): CoreChatSettingsHost {
  return {
    applySettings: (change, port) =>
      dependencies.withChatSettingsLock(change.target, async () => {
        const { planMode, thinkingLevel, speed, target } = change;
        let modelConfig: AgentModelConfig | undefined;
        if (thinkingLevel !== undefined || speed !== undefined) {
          const current = (await dependencies.readTab(target))?.modelConfig;
          modelConfig = { ...current };
          if (thinkingLevel !== undefined)
            modelConfig.thinkingLevel = thinkingLevel;
          if (speed !== undefined)
            modelConfig = withCodexSpeed(modelConfig, speed);
        }
        const patch: ChatTabSettingsPatch = {
          ...(planMode === undefined ? {} : { planMode }),
          ...(modelConfig === undefined ? {} : { modelConfig }),
        };
        const result = await port.command({
          schemaVersion: 1,
          commandId: change.commandId,
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          ...(change.expectedRevision === undefined
            ? {}
            : { expectedRevision: change.expectedRevision }),
          ...(change.expectedTabRevision === undefined
            ? {}
            : { expectedTabRevision: change.expectedTabRevision }),
          ...(change.origin === undefined ? {} : { origin: change.origin }),
          command: {
            type: 'chat.patch_tab_settings',
            tabId: target.chatId,
            patch,
          },
        });
        if (
          result.outcome !== 'applied' &&
          result.outcome !== 'already_applied' &&
          result.outcome !== 'not_found'
        )
          return result;
        const tab =
          result.outcome === 'not_found'
            ? undefined
            : await dependencies.readTab(target);
        const isCurrent = (
          matches: (tab: PersistedChatTab) => boolean,
        ): boolean =>
          result.outcome === 'not_found' || (tab !== undefined && matches(tab));
        if (
          planMode !== undefined &&
          isCurrent((tab) => (tab.planMode === true) === planMode)
        )
          await dependencies.effects.planMode(target, planMode);
        if (
          thinkingLevel !== undefined &&
          isCurrent((tab) => tab.modelConfig?.thinkingLevel === thinkingLevel)
        )
          await dependencies.effects.thinkingLevel(target, thinkingLevel);
        if (
          speed !== undefined &&
          isCurrent((tab) => tab.modelConfig?.speed === speed)
        )
          await dependencies.effects.speed(target, speed);
        return result;
      }),
    changeModel: (change, port) => dependencies.changeModel(change, port),
  };
}
