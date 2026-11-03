/** @jest-environment jsdom */
// Test-only source inspection; production ui-shared remains browser-only.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetInputModality } from '../../lib/input-modality';
import { ChatComposerOverflowMenu } from '../ChatComposerOverflowMenu';
import { DropdownMenuItem } from '../DropdownMenu';
import { FloatingMenu } from '../FloatingMenu';
import { FloatingPickerMenu } from '../PickerMenu';
import { TabContextMenu } from '../TabContextMenu';
import { WorktreeActionsMenu } from '../WorktreeActionsMenu';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * One rule for every menu: opened with a pointer, the menu's first row takes
 * focus without being painted (no ring, no fill), the first arrow paints it,
 * the next arrow moves, and Enter picks the painted row. Opened from the
 * keyboard, the first row is painted at once. Keyboard focus is a fill, never
 * the ring. One sample per family of menu that moves focus on open.
 */

interface FamilyHarness {
  readonly name: string;
  /** Renders the closed menu (or, for a right-click menu, nothing yet). */
  render(onPick: (key: string) => void): JSX.Element;
  /** Opens the menu the way the user does, by pointer or keyboard. */
  open(container: HTMLElement, by: 'pointer' | 'keyboard'): void;
}

function press(target: EventTarget, type: string, init: object = {}): void {
  target.dispatchEvent(
    type.startsWith('key')
      ? new KeyboardEvent(type, { bubbles: true, ...init })
      : new MouseEvent(type, { bubbles: true, ...init }),
  );
}

function clickTrigger(trigger: HTMLElement, by: 'pointer' | 'keyboard'): void {
  if (by === 'pointer') {
    press(trigger, 'pointerdown');
    press(trigger, 'mousedown');
    trigger.click();
  } else {
    press(trigger, 'keydown', { key: 'Enter' });
    // A button turns Enter into a click with `detail` 0.
    trigger.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 0 }),
    );
  }
}

function triggerIn(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector<HTMLElement>(
    '[data-testid="trigger"]',
  );
  if (!trigger) throw new Error('Missing trigger');
  return trigger;
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
}

function ActionMenu({
  onPick,
}: {
  onPick: (key: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        onClick={() => setOpen((value) => !value)}
      >
        More
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        aria-label="More"
      >
        <DropdownMenuItem data-testid="first" onClick={() => onPick('first')}>
          First
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="second" onClick={() => onPick('second')}>
          Second
        </DropdownMenuItem>
      </FloatingMenu>
    </>
  );
}

function Picker({ onPick }: { onPick: (key: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        onClick={() => setOpen((value) => !value)}
      >
        Pick
      </button>
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        interaction="listbox"
        aria-label="Pick"
      >
        {(['first', 'second'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={false}
            data-testid={key}
            onClick={() => onPick(key)}
          >
            {key}
          </button>
        ))}
      </FloatingPickerMenu>
    </>
  );
}

function RightClickMenu({
  onPick,
}: {
  onPick: (key: string) => void;
}): JSX.Element {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <div
        data-testid="trigger"
        onContextMenu={(event) => setAt({ x: event.clientX, y: event.clientY })}
      >
        A message
      </div>
      {at ? (
        <TabContextMenu
          x={at.x}
          y={at.y}
          focusOnOpen
          onClose={() => setAt(null)}
          items={(['first', 'second'] as const).map((key) => ({
            key,
            label: key,
            icon: null,
            testId: key,
            onSelect: () => onPick(key),
          }))}
        />
      ) : null}
    </>
  );
}

const FAMILIES: readonly FamilyHarness[] = [
  {
    name: 'action menu (FloatingMenu: browser ⋯, sidebar, approval and model pickers)',
    render: (onPick) => <ActionMenu onPick={onPick} />,
    open: (container, by) => clickTrigger(triggerIn(container), by),
  },
  {
    name: 'picker (FloatingPickerMenu listbox)',
    render: (onPick) => <Picker onPick={onPick} />,
    open: (container, by) => clickTrigger(triggerIn(container), by),
  },
  {
    name: 'right-click menu (TabContextMenu on FloatingMenu: tabs, chat messages)',
    render: (onPick) => <RightClickMenu onPick={onPick} />,
    open: (container, by): void => {
      const target = triggerIn(container);
      if (by === 'pointer') {
        press(target, 'pointerdown', { button: 2 });
        press(target, 'mousedown', { button: 2 });
      } else {
        press(target, 'keydown', { key: 'ContextMenu' });
      }
      press(target, 'contextmenu', { clientX: 20, clientY: 20 });
    },
  },
  {
    name: 'roving menu (WorktreeActionsMenu: the sidebar row menu)',
    render: (onPick) => (
      <WorktreeActionsMenu
        accessibleLabel="Worktree actions"
        triggerTestId="trigger"
        menuTestId="menu"
        alwaysVisible
        items={[
          {
            key: 'toggle-pin',
            label: 'Pin to top',
            icon: null,
            testId: 'first',
            onSelect: () => onPick('first'),
          },
          {
            key: 'archive',
            label: 'Archive',
            icon: null,
            testId: 'second',
            onSelect: () => onPick('second'),
          },
        ]}
      />
    ),
    open: (container, by) => clickTrigger(triggerIn(container), by),
  },
  {
    name: 'composer menu (ChatComposerOverflowMenu)',
    render: (onPick) => (
      <ChatComposerOverflowMenu
        triggerDataTestId="trigger"
        items={(['first', 'second'] as const).map((key) => ({
          key,
          icon: null,
          label: key,
          stateLabel: 'Off',
          active: false,
          ariaLabel: key,
          dataTestId: key,
          onSelect: () => onPick(key),
        }))}
      />
    ),
    open: (container, by) => clickTrigger(triggerIn(container), by),
  },
];

describe('menus opened by pointer vs keyboard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let composer: HTMLTextAreaElement;

  beforeEach(() => {
    resetInputModality(document);
    // The composer held focus before the menu opened, as in the app.
    composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  function keyOnFocus(key: string): void {
    act(() =>
      press(document.activeElement ?? document.body, 'keydown', { key }),
    );
  }

  it.each(FAMILIES)(
    '$name: a pointer open leaves the first row unpainted',
    (family) => {
      const onPick = jest.fn();
      act(() => root.render(family.render(onPick)));
      const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');

      act(() => family.open(container, 'pointer'));

      const first = byTestId('first');
      expect(document.activeElement).toBe(first);
      // Chromium's option: focused, without the keyboard look.
      const firstFocus = focusSpy.mock.calls.find(
        (_call, index) => focusSpy.mock.contexts[index] === first,
      );
      expect(firstFocus?.[0]).toEqual(
        expect.objectContaining({ focusVisible: false }),
      );

      // The first arrow paints the focused row instead of moving past it.
      const paintsFrom = focusSpy.mock.calls.length;
      keyOnFocus('ArrowDown');
      expect(document.activeElement).toBe(first);
      const repaint = focusSpy.mock.calls
        .slice(paintsFrom)
        .find(
          (_call, index) =>
            focusSpy.mock.contexts[paintsFrom + index] === first,
        );
      expect(repaint?.[0]).not.toEqual(
        expect.objectContaining({ focusVisible: false }),
      );

      // Then the arrows move, and Enter picks the painted row.
      keyOnFocus('ArrowDown');
      expect(document.activeElement).toBe(byTestId('second'));
      keyOnFocus('Enter');
      expect(onPick).toHaveBeenLastCalledWith('second');
    },
  );

  it.each(FAMILIES)(
    '$name: a keyboard open paints the first row, so the first arrow moves',
    (family) => {
      act(() => root.render(family.render(jest.fn())));
      const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');

      act(() => family.open(container, 'keyboard'));

      const first = byTestId('first');
      expect(document.activeElement).toBe(first);
      const firstFocus = focusSpy.mock.calls.find(
        (_call, index) => focusSpy.mock.contexts[index] === first,
      );
      expect(firstFocus?.[0]).not.toEqual(
        expect.objectContaining({ focusVisible: false }),
      );

      keyOnFocus('ArrowDown');
      expect(document.activeElement).toBe(byTestId('second'));
    },
  );

  it('draws keyboard focus on every menu row as a fill, never the ring', () => {
    const css = readFileSync(
      join(__dirname, '../../styles/canopy-tokens-core.css'),
      'utf8',
    ).replace(/\s+/g, ' ');
    const rowSelector =
      ":is([role='menu'], [role='listbox']) :is( [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'] ):focus-visible";
    // Unlayered, so it beats `.focus-ring` on any row that still carries it.
    expect(css).toContain(`${rowSelector} { outline: none; }`);
    // Layered under the utilities, so a row's own background still wins.
    expect(css).toMatch(
      new RegExp(
        `@layer base \\{ ${rowSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ background-color: var\\(--bg-subtle\\); \\} \\}`,
      ),
    );
  });
});
