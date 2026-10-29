/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

jest.mock('@canopy/ui-app', () => ({
  MarkdownFrontmatterContent: (): JSX.Element => <p>Private SKILL.md body</p>,
}));
jest.mock('../PluginDetailView', () => ({
  PluginDetailView: ({ plugin }: { plugin: PluginInfo }): JSX.Element => (
    <p>{plugin.description}</p>
  ),
}));
jest.mock('../McpServersTab', () => ({
  McpServerDetailOverlay: (): null => null,
}));
jest.mock('../skillContentUtils', () => ({
  readSkillContentForDisplay: jest.fn(
    () =>
      new Promise(() => {
        // Left pending: the test only inspects the overlay card.
      }),
  ),
}));

import {
  PluginDetailOverlay,
  SkillDetailOverlay,
} from '../UnifiedTableDetailOverlays';

const PLUGIN: PluginInfo = {
  name: 'private-plugin',
  description: 'Private plugin description',
  sourcePath: 'plugins/private-plugin',
  marketplaceId: 'mkt-1',
  providerSupport: { claude: 'native', codex: 'none' },
  facets: {},
};

const MARKETPLACE: MarketplaceInfo = {
  id: 'mkt-1',
  name: 'Private marketplace',
  sourceType: 'github',
  sourceUrl: 'acme/plugins',
  installLocation: '/tmp/mkt',
  pluginCount: 1,
  plugins: [],
  providerStatus: {
    claude: {
      provider: 'claude',
      state: 'valid',
      accepted: true,
      pluginCount: 1,
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
  validProviders: ['claude'],
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

describe('UnifiedTableDetailOverlays session-replay privacy', () => {
  it('records the skill detail frame and blocks SKILL.md', () => {
    act(() => {
      root.render(
        <SkillDetailOverlay
          skill={{ sourceId: 'user', name: 'private-skill' }}
          onBack={jest.fn()}
        />,
      );
    });

    const card = container.querySelector('[role="dialog"]');
    expect(card?.textContent).toContain('Private SKILL.md body');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    const title = card?.querySelector('#skill-detail-overlay-title');
    expect(title?.textContent).toBe('private-skill');
    expect(
      Array.from(
        card?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
      ).some((node) => node.textContent?.includes('Private SKILL.md body')),
    ).toBe(true);
    expect(
      card
        ?.querySelector('button[aria-label="Back"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('records the plugin detail card; the shared detail content blocks its own file text', () => {
    act(() => {
      root.render(
        <PluginDetailOverlay
          plugin={PLUGIN}
          marketplace={MARKETPLACE}
          onBack={jest.fn()}
        />,
      );
    });

    const card = container.querySelector('[role="dialog"]');
    expect(card?.textContent).toContain('Private plugin description');
    expect(card?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    // The plugin title and description are recorded; README and component
    // file blocks live inside the shared `PluginDetailContent`.
    expect(card?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
