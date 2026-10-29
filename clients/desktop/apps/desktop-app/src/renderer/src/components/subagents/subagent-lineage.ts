import {
  isSubagentChatKind,
  isSubagentGroupKind,
} from '@canopy/agent-transcript';
import type { SubagentLineageTarget } from '@canopy/ui-app/subagents';
import { revealWorktreeChatPanel } from '@/lib/panels/plan-panel-open';
import {
  openSubagentChatPanel,
  openSubagentsPanel,
} from '@/lib/panels/subagent-panel-open';
import { useSubagentViewStateStore } from '@canopy/ui-app/subagents';
import { subagentScopeKey, type SubagentHostScope } from './subagent-scope';

/** Opens the desktop panel or chat represented by one breadcrumb target. */
export function openSubagentLineageTarget(
  scope: SubagentHostScope,
  rootChatId: string,
  target: SubagentLineageTarget,
): void {
  if (target.kind === 'root') {
    revealWorktreeChatPanel(scope, rootChatId);
    return;
  }

  if (isSubagentGroupKind(target.kind)) {
    const scopeKey = subagentScopeKey(scope);
    useSubagentViewStateStore.getState().setSelectedRoot(scopeKey, rootChatId);
    useSubagentViewStateStore
      .getState()
      .setFocus(scopeKey, rootChatId, target.id);
    void openSubagentsPanel(scope, {
      origin: { chatTabId: rootChatId },
    }).catch((): void => undefined);
    return;
  }

  if (isSubagentChatKind(target.kind)) {
    void openSubagentChatPanel(scope, {
      rootChatId,
      subagentId: target.id,
      subagentKind: target.kind,
      title: target.title,
    }).catch((): void => undefined);
  }
}
