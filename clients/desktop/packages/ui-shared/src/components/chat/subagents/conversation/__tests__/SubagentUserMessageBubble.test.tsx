import type { ChatAgentSentInfo } from '@canopy/protocol/portal';
import { renderToString } from 'react-dom/server';
import { SubagentUserMessageBubble } from '../SubagentUserMessageBubble';

const AGENT_SENT: ChatAgentSentInfo = {
  sender: {
    kind: 'project',
    projectType: 'code',
    projectId: 'sender-project',
    taskId: 'sender-task',
    chatId: 'sender-chat',
  },
  chatTitle: 'Captured sender chat',
  projectLabel: 'Source project',
};

describe('SubagentUserMessageBubble', () => {
  it('keeps captured attribution beside Steering without a human-author title', () => {
    const html = renderToString(
      <SubagentUserMessageBubble
        copyText="Continue the review."
        steering
        agentSent={AGENT_SENT}
      >
        Continue the review.
      </SubagentUserMessageBubble>,
    );

    expect(html).toContain('data-testid="agent-sent-title"');
    expect(html).toContain('Captured sender chat');
    expect(html).toContain('Source project');
    expect(html).toContain('data-testid="steering-title"');
    expect(html.indexOf('Captured sender chat')).toBeLessThan(
      html.indexOf('>Steering</span>'),
    );
    expect(html).not.toContain('shared-chat-turn-author');
  });
});
