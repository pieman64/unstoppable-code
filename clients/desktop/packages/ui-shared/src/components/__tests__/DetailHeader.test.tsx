/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DetailHeader } from '../DetailHeader';
import { DetailMoreMenu } from '../DetailMoreMenu';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let root: Root | null = null;
let container: HTMLDivElement;

function render(element: JSX.Element): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe('DetailHeader', () => {
  it('lays out title, description, meta, actions and one notice', () => {
    render(
      <DetailHeader
        dataTestId="h"
        titleId="title-id"
        title="Lint Helper"
        description="Explains lint failures."
        meta={['owner/repo', null, '', 'v1.2']}
        actions={<button type="button">Try it</button>}
        notice={<p data-testid="notice">Update available</p>}
      />,
    );
    const title = byTestId('h-title');
    expect(title?.tagName).toBe('H1');
    expect(title?.id).toBe('title-id');
    expect(byTestId('h-description')?.textContent).toBe(
      'Explains lint failures.',
    );
    // Empty facts are skipped, so no separator dangles.
    expect(byTestId('h-meta')?.textContent).toBe('owner/repo·v1.2');
    expect(byTestId('h-actions')?.textContent).toBe('Try it');
    expect(byTestId('notice')).not.toBeNull();
  });

  it('omits the empty parts', () => {
    render(<DetailHeader dataTestId="h" title="Bare" />);
    expect(byTestId('h-description')).toBeNull();
    expect(byTestId('h-meta')).toBeNull();
    expect(byTestId('h-actions')).toBeNull();
  });
});

describe('DetailMoreMenu', () => {
  it('lists items, puts the destructive one last, and explains disabled ones', () => {
    const onCheck = jest.fn();
    const onRemove = jest.fn();
    render(
      <DetailMoreMenu
        name="Lint Helper"
        triggerTestId="more"
        menuTestId="menu"
        items={[
          {
            id: 'check',
            label: 'Check for updates',
            icon: <svg data-testid="check-icon" />,
            testId: 'check',
            onSelect: onCheck,
            disabled: true,
            reason: 'Check from the desktop app.',
          },
          {
            id: 'remove',
            label: 'Remove',
            icon: <svg data-testid="remove-icon" />,
            testId: 'remove',
            onSelect: onRemove,
            destructive: true,
          },
        ]}
      />,
    );
    const trigger = byTestId('more');
    expect(trigger?.getAttribute('aria-label')).toBe(
      'More actions for Lint Helper',
    );
    act(() => trigger?.click());
    const menu = byTestId('menu');
    expect(menu).not.toBeNull();
    expect(byTestId('check')?.hasAttribute('disabled')).toBe(true);
    expect(menu?.textContent).toContain('Check from the desktop app.');
    act(() => byTestId('remove')?.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onCheck).not.toHaveBeenCalled();
    expect(byTestId('menu')).toBeNull();
  });

  it('renders nothing without items', () => {
    render(
      <DetailMoreMenu
        name="Empty"
        triggerTestId="more"
        menuTestId="menu"
        items={[]}
      />,
    );
    expect(byTestId('more')).toBeNull();
  });
});
