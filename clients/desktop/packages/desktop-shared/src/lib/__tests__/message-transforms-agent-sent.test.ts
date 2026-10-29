import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import { mergeToolResults } from '../message-transforms';

const agentSent: AgentSentInfo = {
  kind: 'external_agent',
  connectionId: '11111111-1111-4111-8111-111111111111',
  clientName: 'External test client',
  verified: false,
  userId: '22222222-2222-4222-8222-222222222222',
};

describe('external-agent display provenance', () => {
  it('preserves the persisted sender without changing user content', () => {
    const message: PersistedChatMessage = {
      id: 'user-1',
      role: 'user',
      timestamp: 1,
      agentSent,
      blocks: [{ type: 'text', text: 'Please inspect this project' }],
    };
    expect(mergeToolResults([message])[0]).toMatchObject(message);
  });

  it('keeps ordinary messages free of a sender marker', () => {
    const [display] = mergeToolResults([
      {
        id: 'user-2',
        role: 'user',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Normal message' }],
      },
    ]);
    expect(display).not.toHaveProperty('agentSent');
  });
});
