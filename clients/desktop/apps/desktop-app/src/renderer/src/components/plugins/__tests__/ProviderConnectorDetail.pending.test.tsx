/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProviderConnectorDetail } from '../ProviderConnectorDetail';
import { GMAIL_CONNECTOR } from '../../../hooks/__tests__/connectorFixtures';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a provider whose read has not answered', () => {
  it('offers no Connect button, and says it is still checking', () => {
    // Offering Connect here invites the user to go link something that may
    // already be linked — the read simply has not come back. Only Codex has
    // answered, so the Claude side must stay in the checking state rather
    // than falling through to the unlinked affordance.
    act(() => {
      root.render(
        <ProviderConnectorDetail
          displayName="Gmail"
          results={[{ provider: 'codex', connectors: [] }]}
          curatedMcpServers={[GMAIL_CONNECTOR]}
          loading={false}
          onConnected={() => undefined}
        />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="provider-connector-detail-pending-claude"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain('Checking');

    const claudeConnect = Array.from(
      container.querySelectorAll('button'),
    ).filter((button) => /connect/i.test(button.textContent ?? ''));
    expect(claudeConnect).toHaveLength(1); // Codex only — Claude offers none.
  });
});
