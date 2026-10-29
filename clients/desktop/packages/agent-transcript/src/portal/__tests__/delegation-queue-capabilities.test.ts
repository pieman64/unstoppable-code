import {
  isAgentDelegationCardData,
  type AgentDelegationSnapshot,
  type AgentDelegationTranscript,
  type DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import { parseAgentTranscriptLines } from '../../lib/transcript-parser';
import {
  persistedMessageToPortalMessage,
  persistedParts,
  portalChatMessagesToPersisted,
} from '../persisted-chat-projection';

const capabilities: DelegationCapabilitySummary = {
  inherit: true,
  discovery: false,
  items: [
    { kind: 'skill', name: 'code-review', source: 'inherited' },
    { kind: 'mcp', name: 'github', source: 'explicit' },
    { kind: 'plugin', name: 'figma', source: 'loaded' },
  ],
  skipped: [{ kind: 'plugin', name: 'linter', reason: 'unsupported_hooks' }],
  omittedItems: 2,
};

function envelope(snapshot: Partial<AgentDelegationSnapshot>): {
  type: string;
  delegation: AgentDelegationTranscript;
} {
  return {
    type: 'canopy_delegation',
    delegation: {
      delegationId: 'child-queued',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'user-1',
      parentToolCallId: 'call-1',
      createdAt: 1000,
      task: {
        description: 'Queued review',
        prompt: 'Read the source.',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'child-queued',
        status: 'pending',
        requestedModelId: 'reviewer',
        outputTruncated: false,
        ...snapshot,
      },
      transcript: [],
    },
  };
}

describe('delegation queue and capability fields in the Portal projection', () => {
  it('keeps phase, queue, and capabilities on the Portal agent part', () => {
    const parsed = parseAgentTranscriptLines(
      [
        JSON.stringify(
          envelope({
            phase: 'queued',
            queue: { id: 'default', name: 'Default' },
            capabilities,
          }),
        ),
      ],
      'claude',
    );
    const [root] = parsed.messages;
    expect(root).toBeDefined();
    if (!root) return;
    const [part] = persistedParts(root, undefined, {
      includeText: true,
    });
    expect(part).toMatchObject({
      kind: 'agent',
      data: {
        delegation: {
          status: 'pending',
          phase: 'queued',
          queue: { id: 'default', name: 'Default' },
          capabilities,
        },
      },
    });
    const delegation: unknown =
      part && typeof part.data === 'object' && part.data !== null
        ? Reflect.get(part.data, 'delegation')
        : undefined;
    expect(isAgentDelegationCardData(delegation)).toBe(true);
  });

  it('round-trips the new fields through Portal import', () => {
    const state = parseAgentTranscriptLines(
      [
        JSON.stringify(
          envelope({
            status: 'cancelled',
            phase: 'idle',
            queue: { id: 'default', name: 'Default' },
            capabilities,
          }),
        ),
      ],
      'codex',
    );
    const [root] = state.messages;
    expect(root).toBeDefined();
    if (!root) return;
    const message = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      message: root,
      relatedMessages: state.messages,
    });
    const restored = portalChatMessagesToPersisted([message]).messages;
    expect(restored).toEqual(state.messages);
    expect(restored[0]?.blocks[0]).toMatchObject({
      type: 'delegated_agent_call',
      phase: 'idle',
      queue: { id: 'default', name: 'Default' },
      capabilities,
    });
  });
});
