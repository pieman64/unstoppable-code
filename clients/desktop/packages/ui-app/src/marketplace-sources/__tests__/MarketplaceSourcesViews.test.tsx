/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MarketplaceSource } from '@canopy/app-core/client';
import { MarketplaceSourcesList } from '../MarketplaceSourcesList';
import { MarketplaceSourceDetail } from '../MarketplaceSourceDetail';
import type { UseMarketplaceSourcesResult } from '../useMarketplaceSources';
import {
  installedState,
  marketplaceSource,
  missingInstallState,
  sourcePlugin,
} from './fixtures';

function sourcesState(
  sources: readonly MarketplaceSource[] | null,
  overrides: Partial<UseMarketplaceSourcesResult> = {},
): UseMarketplaceSourcesResult {
  return {
    sources,
    lastRefreshedAt: '2026-10-19T00:00:00.000Z',
    loading: false,
    refreshing: false,
    listError: null,
    listProgress: null,
    operations: {},
    sourceErrors: {},
    sourceWarnings: {},
    sourceProgress: {},
    installingPlugins: {},
    pluginErrors: {},
    canInstall: false,
    reload: jest.fn(async () => undefined),
    refresh: jest.fn(async () => undefined),
    update: jest.fn(async () => true),
    remove: jest.fn(async () => true),
    installPlugin: jest.fn(async () => true),
    dismissSourceMessage: jest.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(element: JSX.Element): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

function byTestId(id: string): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  );
}

function click(element: HTMLElement | undefined): void {
  if (!element) throw new Error('missing element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MarketplaceSourcesList', () => {
  it('distinguishes loading, load failure and empty states', async () => {
    await render(
      <MarketplaceSourcesList
        state={sourcesState(null, { loading: true })}
        onOpenSource={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-sources-loading')).toHaveLength(1);

    const failed = sourcesState(null, { listError: 'Offline' });
    await render(
      <MarketplaceSourcesList state={failed} onOpenSource={jest.fn()} />,
    );
    expect(
      byTestId('marketplace-sources-load-error')[0]?.textContent,
    ).toContain('Offline');

    await render(
      <MarketplaceSourcesList
        state={sourcesState([])}
        onOpenSource={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-sources-empty')).toHaveLength(1);
  });

  it('keeps rows beside a refresh failure', async () => {
    await render(
      <MarketplaceSourcesList
        state={sourcesState([marketplaceSource('a')], { listError: 'Offline' })}
        onOpenSource={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-source-row')).toHaveLength(1);
    expect(byTestId('marketplace-sources-refresh-error')).toHaveLength(1);
  });

  it('hides Update and Remove on protected rows', async () => {
    await render(
      <MarketplaceSourcesList
        state={sourcesState([
          marketplaceSource('system', {
            actions: { update: false, remove: false },
          }),
        ])}
        onOpenSource={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-source-update')).toHaveLength(0);
    expect(byTestId('marketplace-source-remove')).toHaveLength(0);
  });

  it('shows invalid recovery without Remove, and Update only when permitted', async () => {
    const invalid = marketplaceSource('bad', {
      actions: { update: false, remove: false },
      status: {
        state: 'invalid',
        errors: [{ label: 'Sync', message: 'Repository not found' }],
      },
    });
    await render(
      <MarketplaceSourcesList
        state={sourcesState([invalid])}
        onOpenSource={jest.fn()}
      />,
    );
    const banner = byTestId('marketplace-source-invalid')[0];
    expect(banner?.textContent).toContain('Repository not found');
    expect(byTestId('marketplace-source-invalid-update')).toHaveLength(0);
    expect(byTestId('marketplace-source-invalid-refresh')).toHaveLength(1);
    expect(banner?.textContent).not.toContain('Remove');
  });

  it('confirms before removing and can be cancelled', async () => {
    const state = sourcesState([marketplaceSource('a')]);
    await render(
      <MarketplaceSourcesList state={state} onOpenSource={jest.fn()} />,
    );
    click(byTestId('marketplace-source-remove')[0]);
    expect(byTestId('marketplace-source-remove-dialog')).toHaveLength(1);
    // The shared confirmation's Cancel (its esc chip is part of its text).
    const cancel =
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="confirm-dialog-cancel"]',
      ) ?? undefined;
    click(cancel);
    expect(state.remove).not.toHaveBeenCalled();

    click(byTestId('marketplace-source-remove')[0]);
    click(byTestId('marketplace-source-remove-confirm')[0]);
    expect(state.remove).toHaveBeenCalledWith('a');
  });

  it('counts missing plugins only when installation is supported', async () => {
    const source = marketplaceSource('a', {
      plugins: [sourcePlugin('p', { installState: missingInstallState() })],
    });
    await render(
      <MarketplaceSourcesList
        state={sourcesState([source])}
        onOpenSource={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-source-missing-count')).toHaveLength(0);
    await render(
      <MarketplaceSourcesList
        state={sourcesState([source], { canInstall: true })}
        onOpenSource={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-source-missing-count')[0]?.textContent).toBe(
      '1',
    );
  });
});

describe('MarketplaceSourceDetail', () => {
  const source = marketplaceSource('a', {
    plugins: [
      sourcePlugin('alpha', { installState: missingInstallState() }),
      sourcePlugin('beta', { installState: missingInstallState() }),
      sourcePlugin('gamma', { installState: installedState() }),
    ],
  });

  it('renders no install affordances without the capability', async () => {
    await render(
      <MarketplaceSourceDetail
        state={sourcesState([source])}
        sourceId="a"
        onNavigateBack={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-source-plugin')).toHaveLength(3);
    expect(byTestId('bulk-install-plugins')).toHaveLength(0);
    expect(byTestId('marketplace-source-detail-missing-count')).toHaveLength(0);
    expect(byTestId('plugin-install-alpha')).toHaveLength(0);
  });

  it('scopes bulk install to filtered plugins while the badge counts all', async () => {
    const state = sourcesState([source], { canInstall: true });
    await render(
      <MarketplaceSourceDetail
        state={state}
        sourceId="a"
        onNavigateBack={jest.fn()}
        filters={{ query: 'alp', category: null, author: null }}
      />,
    );
    expect(
      byTestId('marketplace-source-detail-missing-count')[0]?.textContent,
    ).toBe('2');
    expect(byTestId('bulk-install-plugins')[0]?.textContent).toBe(
      'Install 1 plugin',
    );
    click(byTestId('plugin-install-alpha')[0]);
    expect(state.installPlugin).toHaveBeenCalledWith('a', 'alpha');
  });

  it('distinguishes an empty source from no matches', async () => {
    await render(
      <MarketplaceSourceDetail
        state={sourcesState([marketplaceSource('empty')])}
        sourceId="empty"
        onNavigateBack={jest.fn()}
      />,
    );
    expect(byTestId('marketplace-source-no-plugins')).toHaveLength(1);

    await render(
      <MarketplaceSourceDetail
        state={sourcesState([source])}
        sourceId="a"
        onNavigateBack={jest.fn()}
        filters={{ query: 'zzz', category: null, author: null }}
      />,
    );
    expect(byTestId('marketplace-source-no-matches')).toHaveLength(1);
  });

  it('shows an unavailable state when the source disappears', async () => {
    const onBack = jest.fn();
    await render(
      <MarketplaceSourceDetail
        state={sourcesState([])}
        sourceId="gone"
        onNavigateBack={onBack}
      />,
    );
    expect(byTestId('marketplace-source-unavailable')).toHaveLength(1);
    const back = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Back to marketplaces');
    click(back);
    expect(onBack).toHaveBeenCalled();
  });

  it('only makes plugins interactive when the host resolves them', async () => {
    const onOpenPlugin = jest.fn();
    await render(
      <MarketplaceSourceDetail
        state={sourcesState([source])}
        sourceId="a"
        onNavigateBack={jest.fn()}
        onOpenPlugin={onOpenPlugin}
        canOpenPlugin={(_id, key) => key === 'beta'}
      />,
    );
    const rows = byTestId('marketplace-source-plugin');
    expect(rows[0]?.querySelector('button')).toBeNull();
    click(rows[1]?.querySelector('button') ?? undefined);
    expect(onOpenPlugin).toHaveBeenCalledWith('a', 'beta');
  });
});
