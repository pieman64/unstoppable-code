/** @jest-environment jsdom */
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CapabilityTile, type CapabilityTileAction } from '../CapabilityTile';
import type { CapabilityTileModel } from '../capability-tile-model';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const MODEL: CapabilityTileModel = {
  iconKind: 'skill',
  kindLabel: 'Skill',
  operationLabel: 'Recommended',
  name: 'Code review',
  summary: 'Reviews a diff',
  sourceLabel: 'Installed',
  state: { label: 'Installed', tone: 'success' },
  reason: 'Matches your review request',
  external: false,
  removed: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  action: CapabilityTileAction,
  model: CapabilityTileModel = MODEL,
  accessory?: ReactElement,
): HTMLElement {
  act(() => {
    root.render(
      <CapabilityTile
        model={model}
        action={action}
        testId="agent-artifact-capability_reference"
        accessory={accessory}
      />,
    );
  });
  const tile = container.querySelector<HTMLElement>(
    '[data-testid="agent-artifact-capability_reference"]',
  );
  if (!tile) throw new Error('tile not rendered');
  return tile;
}

describe('CapabilityTile', () => {
  it('renders a button whose accessible name starts with the item name', () => {
    const onActivate = jest.fn();
    const tile = render({ kind: 'action', onActivate });
    expect(tile.tagName).toBe('BUTTON');
    expect(tile.getAttribute('aria-label')).toBe(
      'Code review, Skill, Recommended, Installed',
    );
    expect(tile.textContent).toContain('Matches your review request');
    act(() => tile.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    for (const key of ['Enter', ' ']) {
      act(() => {
        tile.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('renders a native anchor and routes plain clicks client-side', () => {
    const onNavigate = jest.fn();
    const tile = render({
      kind: 'link',
      href: '/portal/plugins/skills/shared/s1',
      onNavigate,
    });
    expect(tile.tagName).toBe('A');
    expect(tile.getAttribute('href')).toBe('/portal/plugins/skills/shared/s1');
    act(() => {
      tile.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(onNavigate).toHaveBeenCalledWith('/portal/plugins/skills/shared/s1');
    // A modified click keeps the browser's own behavior.
    const modified = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    act(() => {
      tile.dispatchEvent(modified);
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('opens external links in a new tab without opener access', () => {
    const tile = render(
      { kind: 'link', href: 'https://example.com/skill', external: true },
      { ...MODEL, external: true, state: undefined },
    );
    expect(tile.getAttribute('target')).toBe('_blank');
    expect(tile.getAttribute('rel')).toBe('noopener noreferrer');
    expect(tile.getAttribute('aria-label')).toContain('External');
  });

  it('renders an unlinked group with its desktop hint', () => {
    const tile = render({ kind: 'none', hint: 'Open on desktop' });
    expect(tile.tagName).toBe('DIV');
    expect(tile.getAttribute('role')).toBe('group');
    expect(tile.textContent).toContain('Open on desktop');
    expect(tile.getAttribute('aria-label')).toMatch(
      /^Code review, .*Open on desktop$/,
    );
  });

  it('drops navigation from removed items', () => {
    const onActivate = jest.fn();
    const tile = render(
      { kind: 'action', onActivate },
      { ...MODEL, removed: true, state: { label: 'Removed', tone: 'muted' } },
    );
    expect(tile.tagName).toBe('DIV');
    expect(tile.dataset.unavailable).toBe('true');
    expect(container.querySelector('button, a')).toBeNull();
  });

  it('keeps the accessory outside the interactive trigger', () => {
    const onShare = jest.fn();
    const onActivate = jest.fn();
    const tile = render(
      { kind: 'action', onActivate },
      MODEL,
      <button type="button" data-testid="share" onClick={onShare}>
        Share
      </button>,
    );
    const share = container.querySelector<HTMLButtonElement>(
      '[data-testid="share"]',
    );
    expect(share).not.toBeNull();
    expect(tile.contains(share)).toBe(false);
    act(() => share?.click());
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
