import { agentConnectionsIntro } from '../agent-connections-copy';
import { brandText } from '@/lib/brand';

describe('agent connections intro', () => {
  it('names free AI Credits only when the section offers them', () => {
    expect(agentConnectionsIntro({ offersCredits: true })).toBe(
      'Use free AI Credits, or connect a subscription you already have.',
    );
    expect(agentConnectionsIntro({ offersCredits: false })).toBe(
      `Bring your own subscription or use your ${brandText.appName} account.`,
    );
    expect(agentConnectionsIntro()).toBe(
      agentConnectionsIntro({ offersCredits: false }),
    );
  });
});
