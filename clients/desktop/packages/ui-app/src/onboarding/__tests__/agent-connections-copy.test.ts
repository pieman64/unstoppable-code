import { agentConnectionsIntro } from '../agent-connections-copy';

describe('agent connections intro', () => {
  it('names free AI Credits only when the section offers them', () => {
    expect(
      agentConnectionsIntro({ offersCredits: true, appName: 'Acme' }),
    ).toBe('Use free AI Credits, or connect a subscription you already have.');
    expect(
      agentConnectionsIntro({ offersCredits: false, appName: 'Acme' }),
    ).toBe('Bring your own subscription or use your Acme account.');
    expect(agentConnectionsIntro({ appName: 'Acme' })).toBe(
      agentConnectionsIntro({ offersCredits: false, appName: 'Acme' }),
    );
  });
});
