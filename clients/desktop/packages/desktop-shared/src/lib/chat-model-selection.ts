import {
  getChatHarnessOptions,
  inferLegacyExecutionHarness,
  isTerminalBackedInterfaceMode,
  getExecutionHarnessForModel,
  resolveRuntimeModel,
  type ModelHarness,
  type PersistedChatTab,
} from '../types';
import { isOpenCodeModel } from './opencode-models';

type SelectionTab = Pick<
  PersistedChatTab,
  | 'model'
  | 'providerType'
  | 'executionHarness'
  | 'executionHarnessExplicitlyChosen'
>;

/** Keep an explicit OpenCode chat on its captured runtime across model changes. */
export function resolveChatModelChangeHarness(
  tab: SelectionTab | undefined,
  model: string,
  requested?: ModelHarness,
): ModelHarness | undefined {
  return (
    requested ??
    (tab?.executionHarness === 'opencode' || tab?.providerType === 'opencode'
      ? 'opencode'
      : tab?.model === model && tab.executionHarnessExplicitlyChosen === true
        ? tab.executionHarness
        : undefined) ??
    getExecutionHarnessForModel(model)
  );
}

/** Native IDs name their runtime; additional choices need the host catalog. */
export function supportsChatHarnessChoice(
  model: string,
  harness: ModelHarness,
): boolean {
  return (
    getChatHarnessOptions(model).includes(harness) ||
    getExecutionHarnessForModel(model) === harness
  );
}

/** Native provider configuration and host-managed billing use distinct histories. */
export function isNativeOpenCodeSelection(model: string | undefined): boolean {
  return Boolean(model && isOpenCodeModel(resolveRuntimeModel(model) ?? model));
}

/** Terminal chats reserve an ID before their first turn; native IDs retain history. */
export function hasChatContinuationSession(
  tab: Pick<
    PersistedChatTab,
    | 'sdkSessionId'
    | 'interfaceMode'
    | 'executionHarness'
    | 'providerType'
    | 'model'
  >,
): boolean {
  return (
    Boolean(tab.sdkSessionId) &&
    !(
      isTerminalBackedInterfaceMode(tab.interfaceMode) &&
      (tab.executionHarness ??
        inferLegacyExecutionHarness({ ...tab, hasStarted: true })) === 'claude'
    )
  );
}
