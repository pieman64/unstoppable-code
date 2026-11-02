/**
 * @jest-environment jsdom
 *
 * Note: adapted from the brief's @testing-library/react style to use
 * createRoot + act, which matches this repo's jsdom test conventions
 * (see WorkspaceEnvironmentTab.test.tsx, WakeLockIndicator.test.tsx).
 * @testing-library/react is not installed in this workspace.
 *
 * The root mounts on document.body so React's event delegation covers the
 * dropdown's portal, which also renders into document.body via createPortal.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetInputModality } from '@canopy/ui-shared/lib';
import { VariableInsertDropdown } from '../VariableInsertDropdown';

// jsdom does not implement requestAnimationFrame; stub it so the dropdown's
// focus-on-open path resolves synchronously inside act().
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    },
  });
}

function fireClick(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

let root: Root | null = null;

function renderIntoBody(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

describe('VariableInsertDropdown', () => {
  it('opens from a click with no row lit; the first arrow lights the first row, the next moves', async () => {
    resetInputModality(document);
    renderIntoBody(
      <VariableInsertDropdown
        variables={[
          { name: 'FIRST', description: 'first' },
          { name: 'SECOND', description: 'second' },
        ]}
        onInsert={jest.fn()}
      />,
    );
    const trigger = document.body.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    );
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      if (trigger) fireClick(trigger);
    });
    // The menu focuses its row on the next frame.
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    const [first, second] = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    expect(first).toBeInstanceOf(HTMLButtonElement);
    expect(document.activeElement).toBe(first);
    // Focused without the keyboard look, and no fill of its own at rest.
    const openFocus = focusSpy.mock.calls.find(
      (_call, index) => focusSpy.mock.contexts[index] === first,
    );
    expect(openFocus?.[0]).toEqual(
      expect.objectContaining({ focusVisible: false }),
    );
    focusSpy.mockRestore();
    expect(first?.className.split(' ')).not.toContain('bg-accent-subtle/40');

    const press = (key: string): void => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
    };
    press('ArrowDown');
    expect(document.activeElement).toBe(first);
    press('ArrowDown');
    expect(document.activeElement).toBe(second);
  });

  it('does not call onInsert for a disabled variable and shows its tooltip', () => {
    const onInsert = jest.fn();
    renderIntoBody(
      <VariableInsertDropdown
        variables={[
          {
            name: 'CANOPY_AUTOMATION_IF_CMD_OUTPUT',
            description: 'out',
            disabled: true,
            disabledReason: 'Configure an If Command above.',
          },
        ]}
        onInsert={onInsert}
      />,
    );

    // Open the dropdown
    const trigger = document.body.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      if (trigger) fireClick(trigger);
    });

    // Menu renders into document.body via portal
    const item =
      document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');
    const menu = document.body.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Available variables"]',
    );
    expect(menu).not.toBeNull();
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.classList.contains('z-dropdown')).toBe(true);
    expect(item).not.toBeNull();
    expect(item?.disabled).toBe(false);
    expect(item?.getAttribute('aria-disabled')).toBe('true');
    // CAN-2799: the disabled reason is a rich hover tooltip, not a native title.
    expect(item?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      item?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Configure an If Command above.',
    );
    act(() => {
      item?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    act(() => {
      item?.focus();
    });
    expect(document.activeElement).toBe(item);

    act(() => {
      if (item) fireClick(item);
    });
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('inserts an enabled variable', () => {
    const onInsert = jest.fn();
    renderIntoBody(
      <VariableInsertDropdown
        variables={[{ name: 'CANOPY_PR_URL', description: 'url' }]}
        onInsert={onInsert}
      />,
    );

    const trigger = document.body.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    );
    expect(trigger).not.toBeNull();
    act(() => {
      if (trigger) fireClick(trigger);
    });

    const item =
      document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    act(() => {
      if (item) fireClick(item);
    });
    expect(onInsert).toHaveBeenCalledWith('CANOPY_PR_URL');
  });
});
