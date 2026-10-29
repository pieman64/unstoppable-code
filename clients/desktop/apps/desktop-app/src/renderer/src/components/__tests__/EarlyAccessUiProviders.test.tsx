/**
 * @jest-environment jsdom
 */
import {
  setTestEarlyAccessFeatures,
  setTestLabsFeatures,
} from '@/test-utils/labsExperiments';

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  BusyLabel,
  LoadingPlaceholder,
  useIconStyle,
  usePrHoverCards,
} from '@canopy/ui-shared/components';

import { useContextMenuPlacement } from '@canopy/ui-shared/components/context-menu-placement';
import { EarlyAccessUiProviders } from '../EarlyAccessUiProviders';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function IconStyleProbe(): JSX.Element {
  return <span data-testid="icon-style">{useIconStyle()}</span>;
}

function PrHoverCardsProbe(): JSX.Element {
  return <span>{usePrHoverCards() ? 'on' : 'off'}</span>;
}

function MenuPlacementProbe(): JSX.Element {
  return <span>{useContextMenuPlacement()}</span>;
}

describe('EarlyAccessUiProviders', () => {
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
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  });

  function render(earlyAccess: boolean): string {
    setTestEarlyAccessFeatures({
      enabled: earlyAccess,
      hydrated: true,
    });
    act(() => {
      root.render(
        <EarlyAccessUiProviders>
          <LoadingPlaceholder />
          <button type="button">
            <BusyLabel busy busyText="Loading…">
              Load more
            </BusyLabel>
          </button>
        </EarlyAccessUiProviders>,
      );
    });
    return container.innerHTML;
  }

  it('uses loading indicators even with the old preference off', () => {
    const markup = render(false);
    expect(markup).not.toContain('Loading…');
    expect(markup).not.toContain('Loading…');
    expect(markup).toContain('aria-label="Loading"');
  });

  it('shows spinners in place of the copy with early access on', () => {
    const markup = render(true);
    expect(markup).not.toContain('Loading…');
    expect(markup).not.toContain('Loading…');
    expect(markup).toContain('aria-label="Loading"');
    // The busy label keeps its width: the label stays, hidden.
    expect(markup).toContain('Load more');
  });

  it('uses pointer menus without an Early access opt-in or ready snapshot', () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: false });
    act(() =>
      root.render(
        <EarlyAccessUiProviders>
          <MenuPlacementProbe />
        </EarlyAccessUiProviders>,
      ),
    );
    expect(container.textContent).toBe('cursor');
  });

  it('always uses the updated glyphs', () => {
    act(() => {
      root.render(
        <EarlyAccessUiProviders>
          <IconStyleProbe />
        </EarlyAccessUiProviders>,
      );
    });
    expect(container.textContent).toBe('central');
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });
    expect(container.textContent).toBe('central');
  });

  it('follows the Pull request cards choice, off by default', () => {
    act(() => {
      root.render(
        <EarlyAccessUiProviders>
          <PrHoverCardsProbe />
        </EarlyAccessUiProviders>,
      );
    });
    expect(container.textContent).toBe('off');
    act(() => setTestLabsFeatures({ 'pr-hover-cards': true }));
    expect(container.textContent).toBe('on');
    act(() => setTestLabsFeatures({}));
    expect(container.textContent).toBe('off');
  });
});
