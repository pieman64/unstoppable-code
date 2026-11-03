/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { McpServerLogoProps } from '@canopy/ui-shared';
import { MarketplaceDetailPageShell } from '../MarketplaceDetailPageShell';
import {
  PluginCatalogAddButton,
  PluginCatalogDetail,
} from '../PluginCatalogDetail';
import { DetailPageActions } from '@canopy/ui-shared/components';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const entry = {
  name: 'Useful plugin',
  author: 'Ada',
  description: 'Does useful work.',
  homepage: 'https://example.com/plugin',
  logoUrl: 'https://example.com/logo.png',
  categories: ['Development'],
  components: { skills: 1, mcpServers: 1, commands: 2, agents: 0 },
};

function LogoSlot({ name }: McpServerLogoProps): JSX.Element {
  return <div data-testid="injected-logo">{name}</div>;
}

describe('MarketplaceDetailPageShell and catalog detail cores', () => {
  it('renders page shell semantics, title, back affordance, and content', () => {
    const out = renderToString(
      <MarketplaceDetailPageShell
        title="Useful plugin"
        onNavigateBack={(): void => {}}
      >
        <div data-testid="detail-body">Body</div>
      </MarketplaceDetailPageShell>,
    );

    expect(out).toContain('data-testid="plugins-entry-detail"');
    expect(out).toContain('aria-labelledby="plugins-entry-detail-title"');
    expect(out).toContain(
      '<h1 id="plugins-entry-detail-title" class="sr-only">Useful plugin</h1>',
    );
    expect(out).toContain('data-testid="plugins-entry-detail-back"');
    expect(out).toContain('data-testid="detail-body"');
    // Existing desktop and portal hosts rely on the centered reading column.
    expect(out).toContain(
      'class="mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8"',
    );
  });

  it('fills the host container only when asked for the fluid width (CAN-2989)', () => {
    const out = renderToString(
      <MarketplaceDetailPageShell title="Useful plugin" width="fluid">
        <div data-testid="detail-body">Body</div>
      </MarketplaceDetailPageShell>,
    );

    expect(out).toContain('class="flex min-h-0 w-full flex-col pt-8"');
    expect(out).not.toContain('max-w-3xl');
    expect(out).not.toContain('mx-auto');
  });

  it('prefers breadcrumbs to Back and keeps header actions', () => {
    const out = renderToString(
      <MarketplaceDetailPageShell
        title="Useful plugin"
        onNavigateBack={(): void => {}}
        breadcrumbs={<nav aria-label="Breadcrumb">Marketplace</nav>}
        headerActions={<button type="button">Install</button>}
      >
        Body
      </MarketplaceDetailPageShell>,
    );
    expect(out).toContain('aria-label="Breadcrumb"');
    expect(out).toContain('Install');
    expect(out).not.toContain('plugins-entry-detail-back');
  });

  it('renders breadcrumbs without a back callback', () => {
    const out = renderToString(
      <MarketplaceDetailPageShell
        title="Useful plugin"
        breadcrumbs={<nav>Marketplace</nav>}
      >
        Body
      </MarketplaceDetailPageShell>,
    );
    expect(out).toContain('<nav>Marketplace</nav>');
    expect(out).not.toContain('plugins-entry-detail-back');
  });

  it('keeps a shell fallback while full plugin detail content owns the region label', () => {
    const out = renderToString(
      <MarketplaceDetailPageShell title="Useful plugin" contentOwnsTitle>
        <h2 id="plugin-detail-title">Useful plugin</h2>
      </MarketplaceDetailPageShell>,
    );

    expect(out).toContain('aria-labelledby="plugin-detail-title"');
    expect(out.match(/<h[1-6]\b/g)).toHaveLength(1);
    expect(out).toContain(
      '<span id="plugins-entry-detail-title" class="sr-only">Useful plugin</span>',
    );
    expect(out).toContain('class="sr-only"');
  });

  it('renders the catalog summary and injected logo slot', () => {
    const out = renderToString(
      <PluginCatalogDetail entry={entry} McpServerLogoComponent={LogoSlot} />,
    );

    expect(out).toContain('data-testid="plugin-catalog-detail"');
    expect(out).toContain('data-testid="injected-logo"');
    expect(out).toContain('Useful plugin');
    expect(out.replace(/<!-- -->/g, '')).toContain('By Ada');
    expect(out).toContain('4 plugin components available after adding.');
  });

  it('lays out the Back row action bar as [secondary] [Share] [Primary]', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onAdd = jest.fn();
    act(() => {
      root.render(
        <MarketplaceDetailPageShell
          title="Useful plugin"
          onNavigateBack={(): void => {}}
          headerActions={<button data-testid="header-edit">Edit</button>}
          share={<button data-testid="header-share">Share</button>}
        >
          <DetailPageActions
            primary={<PluginCatalogAddButton onAdd={onAdd} />}
          />
          <PluginCatalogDetail
            entry={entry}
            McpServerLogoComponent={LogoSlot}
          />
        </MarketplaceDetailPageShell>,
      );
    });
    const back = container.querySelector(
      '[data-testid="plugins-entry-detail-back"]',
    );
    const bar = container.querySelector('[data-testid="detail-action-bar"]');
    // One row: Back on the left, the action bar on the right, above the body.
    expect(bar?.parentElement).toBe(back?.parentElement);
    const order = Array.from(bar?.querySelectorAll('button') ?? []).map(
      (button) => button.getAttribute('data-testid'),
    );
    // The body's Add joins the shell's bar, last, after Share.
    expect(order).toEqual([
      'header-edit',
      'header-share',
      'plugin-catalog-detail-add',
    ]);
    const detail = container.querySelector(
      '[data-testid="plugin-catalog-detail"]',
    );
    expect(detail?.querySelector('button')).toBeNull();
    act(() => {
      bar
        ?.querySelector('[data-testid="plugin-catalog-detail-add"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    // The header recipe: the compact primary capsule, like Share beside it.
    const addButton = bar?.querySelector(
      '[data-testid="plugin-catalog-detail-add"]',
    );
    expect(addButton?.className).toContain('bg-accent');
    expect(addButton?.className).toContain('rounded-full');
    expect(addButton?.className).toContain('h-7');
    // The detail must not be its own scroller: every host already scrolls
    // (page root, dialog body), and a nested scroll box clips the hairline
    // ring and shadow of the controls that sit flush against its top edge.
    expect(detail?.className ?? '').not.toMatch(/overflow-/);
    act(() => root.unmount());
  });
});
