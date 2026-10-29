/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DetailPageActions } from '@canopy/ui-shared/components/DetailActionBar';
import { MarketplaceDetailPageShell } from '../MarketplaceDetailPageShell';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('MarketplaceDetailPageShell', () => {
  it('keeps the Back row when no header is requested', () => {
    act(() =>
      root.render(
        <MarketplaceDetailPageShell
          title="Code Reviewer"
          onNavigateBack={(): undefined => undefined}
        >
          <p>Body</p>
        </MarketplaceDetailPageShell>,
      ),
    );
    expect(byTestId('plugins-entry-detail-back')).not.toBeNull();
    expect(byTestId('plugins-entry-detail-header')).toBeNull();
  });

  it('renders the item header with ⋯ first and the body primary last, and no Back', () => {
    act(() =>
      root.render(
        <MarketplaceDetailPageShell
          title="Code Reviewer"
          onNavigateBack={(): undefined => undefined}
          header={{
            description: 'Agent using Sonnet 5.5',
            meta: ['By Priya', 'Organization'],
          }}
          moreItems={[
            {
              id: 'unshare',
              label: 'Unshare',
              testId: 'marketplace-unshare',
              onSelect: (): undefined => undefined,
              destructive: true,
            },
          ]}
          share={<button data-testid="share">Share</button>}
        >
          <DetailPageActions
            primary={<button data-testid="install">Install</button>}
          />
          <p>Body</p>
        </MarketplaceDetailPageShell>,
      ),
    );
    expect(byTestId('plugins-entry-detail-back')).toBeNull();
    const header = byTestId('plugins-entry-detail-header');
    expect(header).not.toBeNull();
    expect(byTestId('plugins-entry-detail-header-title')?.textContent).toBe(
      'Code Reviewer',
    );
    expect(
      byTestId('plugins-entry-detail-header-description')?.textContent,
    ).toBe('Agent using Sonnet 5.5');
    expect(byTestId('plugins-entry-detail-header-meta')?.textContent).toContain(
      'Organization',
    );
    // [⋯ More] [Share] [Install]: the menu leads, the primary is last.
    const actions = byTestId('plugins-entry-detail-header-actions');
    const order = Array.from(
      actions?.querySelectorAll('[data-testid]') ?? [],
    ).map((node) => node.getAttribute('data-testid'));
    expect(order.indexOf('plugins-entry-detail-more')).toBe(0);
    expect(order.indexOf('share')).toBeLessThan(order.indexOf('install'));
    expect(order.at(-1)).toBe('install');
    // The visible title labels the page.
    expect(
      document
        .querySelector('[data-testid="plugins-entry-detail"]')
        ?.getAttribute('aria-labelledby'),
    ).toBe('plugins-entry-detail-title');
    expect(document.getElementById('plugins-entry-detail-title')).toBe(
      byTestId('plugins-entry-detail-header-title'),
    );
  });

  it('omits the ⋯ menu when no item applies', () => {
    act(() =>
      root.render(
        <MarketplaceDetailPageShell title="Writer" header={{}} moreItems={[]}>
          <p>Body</p>
        </MarketplaceDetailPageShell>,
      ),
    );
    expect(byTestId('plugins-entry-detail-header')).not.toBeNull();
    expect(byTestId('plugins-entry-detail-more')).toBeNull();
  });
});
