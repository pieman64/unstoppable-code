/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShareLayoutRow, type ShareLayoutRowProps } from '..';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ShareLayoutRow', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onToggle: jest.Mock;
  let onUpdate: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onToggle = jest.fn();
    onUpdate = jest.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(element: JSX.Element): void {
    act(() => root.render(element));
  }

  function renderRow(props: Partial<ShareLayoutRowProps>): void {
    render(
      <ShareLayoutRow
        enabled
        saving={false}
        label="Open to my layout"
        onToggle={onToggle}
        onUpdate={onUpdate}
        testId="layout-row"
        {...props}
      />,
    );
  }

  function q<T extends Element = HTMLElement>(testId: string): T | null {
    return container.querySelector<T>(`[data-testid="${testId}"]`);
  }

  it('renders only the label, a named switch and the update action when a layout is saved', () => {
    renderRow({ updateLabel: 'Update to current layout' });

    const toggle = q<HTMLButtonElement>('layout-row-switch');
    expect(toggle?.getAttribute('role')).toBe('switch');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Open to my layout');
    expect(q('layout-row')?.textContent).toBe(
      'Open to my layoutUpdate to current layout',
    );

    act(() => q<HTMLButtonElement>('layout-row-update')?.click());
    expect(onUpdate).toHaveBeenCalledTimes(1);
    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('renders just the label and switch before a layout is saved', () => {
    renderRow({});

    expect(q('layout-row-switch')?.getAttribute('aria-checked')).toBe('true');
    expect(q('layout-row-update')).toBeNull();
    expect(q('layout-row')?.textContent).toBe('Open to my layout');
  });

  it('renders the off state without the update action and turns on from the switch', () => {
    renderRow({ enabled: false, updateLabel: 'Update to current layout' });

    const toggle = q<HTMLButtonElement>('layout-row-switch');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(q('layout-row-update')).toBeNull();
    expect(q('layout-row')?.textContent).toBe('Open to my layout');

    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('disables the switch and the action while a save is in flight', () => {
    renderRow({ saving: true, updateLabel: 'Update to current layout' });

    expect(q<HTMLButtonElement>('layout-row-switch')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('layout-row-update')?.disabled).toBe(true);
  });
});
