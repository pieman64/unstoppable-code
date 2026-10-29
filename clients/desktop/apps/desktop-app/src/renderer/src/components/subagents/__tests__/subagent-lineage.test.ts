import { useSubagentViewStateStore } from '@canopy/ui-app/subagents';
import type { SubagentLineageTarget } from '@canopy/ui-app/subagents';
import { revealWorktreeChatPanel } from '@/lib/panels/plan-panel-open';
import {
  openSubagentChatPanel,
  openSubagentsPanel,
} from '@/lib/panels/subagent-panel-open';
import { openSubagentLineageTarget } from '../subagent-lineage';
import { subagentScopeKey, type SubagentHostScope } from '../subagent-scope';

jest.mock('@/lib/panels/plan-panel-open', () => ({
  revealWorktreeChatPanel: jest.fn(),
}));
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: jest.fn(() => Promise.resolve({ status: 'placed' })),
  openSubagentsPanel: jest.fn(() => Promise.resolve({ status: 'placed' })),
}));

const SCOPE: SubagentHostScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const ROOT_ID = 'root-chat';
const SCOPE_KEY = subagentScopeKey(SCOPE);

beforeEach(() => {
  jest.clearAllMocks();
  useSubagentViewStateStore.setState(
    useSubagentViewStateStore.getInitialState(),
  );
});

afterEach(() => {
  useSubagentViewStateStore.setState(
    useSubagentViewStateStore.getInitialState(),
  );
});

describe('openSubagentLineageTarget', () => {
  it('reveals the root chat', () => {
    const target: SubagentLineageTarget = {
      kind: 'root',
      id: ROOT_ID,
      title: 'Root chat',
    };

    openSubagentLineageTarget(SCOPE, ROOT_ID, target);

    expect(revealWorktreeChatPanel).toHaveBeenCalledWith(SCOPE, ROOT_ID);
    expect(openSubagentsPanel).not.toHaveBeenCalled();
    expect(openSubagentChatPanel).not.toHaveBeenCalled();
  });

  it('selects and focuses a workflow group before opening Subagents', () => {
    const target: SubagentLineageTarget = {
      kind: 'workflow-phase',
      id: 'workflow-phase:wf_1:Research',
      title: 'Research',
    };

    openSubagentLineageTarget(SCOPE, ROOT_ID, target);

    const scopeState = useSubagentViewStateStore.getState().scopes[SCOPE_KEY];
    expect(scopeState?.selectedRootId).toBe(ROOT_ID);
    expect(scopeState?.roots[ROOT_ID]?.focusId).toBe(target.id);
    expect(openSubagentsPanel).toHaveBeenCalledWith(SCOPE, {
      origin: { chatTabId: ROOT_ID },
    });
    expect(openSubagentChatPanel).not.toHaveBeenCalled();
  });

  it('opens a workflow-agent chat with its root binding', () => {
    const target: SubagentLineageTarget = {
      kind: 'workflow-agent',
      id: 'workflow-agent:wf_1:agent-1',
      title: 'Fact-check the report',
    };

    openSubagentLineageTarget(SCOPE, ROOT_ID, target);

    expect(openSubagentChatPanel).toHaveBeenCalledWith(SCOPE, {
      rootChatId: ROOT_ID,
      subagentId: target.id,
      subagentKind: 'workflow-agent',
      title: target.title,
    });
    expect(openSubagentsPanel).not.toHaveBeenCalled();
  });
});
