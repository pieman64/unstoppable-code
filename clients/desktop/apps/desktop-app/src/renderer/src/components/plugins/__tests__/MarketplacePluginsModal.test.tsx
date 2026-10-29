/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { MarketplacePluginsModal } from '../PluginsManagementView';

const MARKETPLACE: MarketplaceInfo = {
  id: 'mkt-1',
  name: 'Private marketplace',
  description: 'Private marketplace description',
  sourceType: 'github',
  sourceUrl: 'acme/plugins',
  installLocation: '/tmp/mkt',
  pluginCount: 0,
  plugins: [],
  providerStatus: {
    claude: {
      provider: 'claude',
      state: 'valid',
      accepted: true,
      pluginCount: 0,
      lastCheckedAt: '2026-05-01T00:00:00.000Z',
    },
    codex: {
      provider: 'codex',
      state: 'valid',
      accepted: true,
      pluginCount: 0,
      lastCheckedAt: '2026-05-01T00:00:00.000Z',
    },
  },
  validProviders: ['claude', 'codex'],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('MarketplacePluginsModal session-replay privacy', () => {
  it('records the card with a user-added marketplace name and description', () => {
    act(() => {
      root.render(
        <MarketplacePluginsModal
          marketplace={MARKETPLACE}
          onClose={jest.fn()}
        />,
      );
    });

    const card = container.querySelector('[role="dialog"]');
    expect(card?.textContent).toContain('Private marketplace description');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      card?.parentElement?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(false);
    const title = card?.querySelector('#marketplace-plugins-modal-title');
    expect(title?.textContent).toBe('Private marketplace');
  });

  it('records a curated marketplace name', () => {
    act(() => {
      root.render(
        <MarketplacePluginsModal
          marketplace={{ ...MARKETPLACE, name: 'Curated', curated: true }}
          onClose={jest.fn()}
        />,
      );
    });

    const title = container.querySelector('#marketplace-plugins-modal-title');
    expect(title?.textContent).toBe('Curated');
  });
});
