import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import type { TurnMessage } from '../lib/turn-utils';
import { mergeToolResults } from '../lib/message-transforms';
import type { DisplayMessage } from '../types/message-display';

const agentSent = {
  sender: {
    kind: 'project',
    projectType: 'code',
    projectId: 'sender-project',
    taskId: 'sender-task',
    chatId: 'sender-chat',
  },
  chatTitle: 'Fix flaky tests',
  projectLabel: 'Billing API',
} satisfies ChatAgentSentInfo;

const message = (
  metadata: Record<string, unknown> = {},
): PersistedChatMessage => ({
  id: 'agent-sent-message',
  role: 'user',
  timestamp: 1_760_000_000_000,
  blocks: [{ type: 'text', text: 'Please check this failure.' }],
  ...metadata,
});

describe('agent-sent display projection', () => {
  it('exposes the optional metadata on display and turn messages', () => {
    const displayMessage: DisplayMessage = {
      id: 'agent-sent-message',
      role: 'user',
      timestamp: 1_760_000_000_000,
      blocks: [{ type: 'text', text: 'Please check this failure.' }],
      agentSent,
    };
    const turnMessage: TurnMessage = {
      id: 'agent-sent-message',
      role: 'user',
      timestamp: 1_760_000_000_000,
      blocks: [{ type: 'text', text: 'Please check this failure.' }],
      agentSent,
    };

    expect(displayMessage.agentSent).toEqual(agentSent);
    expect(turnMessage.agentSent).toEqual(agentSent);
  });

  it('copies validated sender display metadata through the display allowlist', () => {
    const secret = 'hidden-instruction-must-not-render';
    const untrustedMetadata = {
      ...agentSent,
      sender: { ...agentSent.sender, originPath: secret },
      hiddenInstruction: secret,
      provenance: { sender: { rawIdentity: secret } },
    };
    const display = mergeToolResults([
      message({
        agentSent: untrustedMetadata,
        hiddenContext: { text: secret },
      }),
    ]);

    expect(display).toEqual([
      expect.objectContaining({
        id: 'agent-sent-message',
        role: 'user',
        agentSent,
      }),
    ]);
    expect(JSON.stringify(display)).not.toContain(secret);
  });

  it('drops malformed metadata and leaves old rows without a marker', () => {
    const invalid = message({
      agentSent: {
        sender: {
          kind: 'project',
          projectType: 'personal',
          projectId: 'sender-project',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        chatTitle: 'Fix flaky tests',
        projectLabel: 'Billing API',
      },
    });
    const legacy = message();

    const display = mergeToolResults([invalid, legacy]);

    expect(display).toHaveLength(2);
    expect(display[0] && 'agentSent' in display[0]).toBe(false);
    expect(display[1] && 'agentSent' in display[1]).toBe(false);
  });

  it('keeps the new marker in structural sharing and notices captured-label changes', () => {
    const original = message({ agentSent });
    const previous = mergeToolResults([original]);
    const unchanged = mergeToolResults([original], undefined, previous);
    const updated = mergeToolResults(
      [message({ agentSent: { ...agentSent, chatTitle: 'Updated title' } })],
      undefined,
      previous,
    );

    expect(unchanged[0]).toBe(previous[0]);
    expect(updated[0]).not.toBe(previous[0]);
    expect(updated).toEqual([
      expect.objectContaining({
        agentSent: { ...agentSent, chatTitle: 'Updated title' },
      }),
    ]);
  });
});
