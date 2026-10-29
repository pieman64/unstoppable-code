/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTab } from '../SkillFileExplorer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('FileTab', () => {
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

  it('renders the file name as the tab label', () => {
    act(() => {
      root.render(
        <FileTab
          label="notes.md"
          title="references/notes.md"
          active
          onSelect={jest.fn()}
          dataTestId="file-tab"
        />,
      );
    });
    const button = container.querySelector('[data-testid="file-tab"] button');
    expect(button?.textContent).toBe('notes.md');
  });

  it('renders the active state and selects the tab', () => {
    const onSelect = jest.fn();
    act(() => {
      root.render(
        <FileTab
          label="notes.md"
          title="references/notes.md"
          active
          onSelect={onSelect}
          dataTestId="file-tab"
          dataPath="references/notes.md"
        />,
      );
    });
    const tab = container.querySelector('[data-testid="file-tab"]');
    expect(tab?.getAttribute('data-active')).toBe('true');
    expect(tab?.classList).not.toContain('border-border');
    act(() => tab?.querySelector('button')?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders the inactive state without an active marker', () => {
    act(() => {
      root.render(
        <FileTab
          label="notes.md"
          title="references/notes.md"
          active={false}
          onSelect={jest.fn()}
          dataTestId="file-tab"
        />,
      );
    });
    const tab = container.querySelector('[data-testid="file-tab"]');
    expect(tab?.hasAttribute('data-active')).toBe(false);
    expect(tab?.classList).toContain('border-transparent');
  });
});
