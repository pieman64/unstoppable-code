/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { DialogModal } from '../DialogModal';
import {
  SettingsSelect,
  settingsSelectOptions,
  type SettingsSelectProps,
} from '../SettingsSelect';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

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

const OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
] as const;

function render(props: Partial<SettingsSelectProps> = {}): HTMLButtonElement {
  act(() =>
    root.render(
      <SettingsSelect
        aria-label="Member role"
        value="member"
        options={OPTIONS}
        onValueChange={() => undefined}
        data-testid="role"
        {...props}
      />,
    ),
  );
  const trigger = container.querySelector('[role="combobox"]');
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error('Missing combobox trigger');
  }
  return trigger;
}

function listbox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="listbox"]');
}

it('draws a 144px capsule trigger instead of a native select', () => {
  const trigger = render();
  expect(container.querySelector('select')).toBeNull();
  expect(trigger.classList.contains('w-36')).toBe(true);
  expect(trigger.classList.contains('rounded-full')).toBe(true);
  expect(trigger.classList.contains('h-7')).toBe(true);
  expect(trigger.getAttribute('aria-label')).toBe('Member role');
  expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
  expect(trigger.getAttribute('data-value')).toBe('member');
  expect(trigger.textContent).toBe('Member');
});

it('fits or fills when the caller asks', () => {
  expect(render({ width: 'fit' }).classList.contains('w-36')).toBe(false);
  const fill = render({ width: 'fill' });
  expect(fill.classList.contains('w-full')).toBe(true);
  expect(fill.classList.contains('w-36')).toBe(false);
});

it('marks the chosen row with a checkmark only and reports a pick', () => {
  const change = jest.fn();
  const trigger = render({ onValueChange: change });
  act(() => trigger.click());
  const menu = listbox();
  expect(menu).toBeInstanceOf(HTMLElement);
  const rows = Array.from(
    menu?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
  );
  expect(rows.map((row) => row.dataset.value)).toEqual(['member', 'admin']);
  expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
  expect(
    menu?.querySelectorAll('[data-picker-selected-check="true"]'),
  ).toHaveLength(1);
  act(() => rows[1]?.click());
  expect(change).toHaveBeenCalledWith('admin');
  expect(listbox()).toBeNull();
});

it('reports nothing when the current value is chosen again, like a native select', () => {
  const change = jest.fn();
  const trigger = render({ onValueChange: change });
  act(() => trigger.click());
  const current = listbox()?.querySelector<HTMLButtonElement>(
    '[role="option"][data-value="member"]',
  );
  act(() => current?.click());
  expect(change).not.toHaveBeenCalled();
  expect(listbox()).toBeNull();
});

it('hands focus back to the trigger when Tab leaves the open menu', () => {
  const trigger = render();
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  const option = listbox()?.querySelector<HTMLElement>('[role="option"]');
  expect(document.activeElement).toBe(option);
  act(() => {
    option?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
  });
  expect(listbox()).toBeNull();
  // The browser's Tab then moves on from the trigger to the next control.
  expect(document.activeElement).toBe(trigger);
});

it.each([false, true])(
  'in a dialog, Tab (shift: %s) from the open menu closes it and returns to the trigger',
  (shiftKey) => {
    act(() =>
      root.render(
        <DialogModal onClose={() => undefined} title="Grants" trapFocus>
          <button type="button">Before</button>
          <SettingsSelect
            aria-label="Role"
            value="member"
            options={OPTIONS}
            onValueChange={() => undefined}
            data-testid="role"
          />
          <button type="button">After</button>
        </DialogModal>,
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="role"]',
    );
    act(() => {
      trigger?.focus();
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    const option = listbox()?.querySelector<HTMLElement>('[role="option"]');
    expect(document.activeElement).toBe(option);
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      option?.dispatchEvent(tab);
    });
    // The dialog's focus trap leaves the menu's Tab alone: the menu closes
    // with focus back on its trigger inside the dialog, and the browser's
    // own Tab (not prevented) moves on from there.
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(tab.defaultPrevented).toBe(false);
  },
);

it.each([
  ['last control, Tab', false, 'last'],
  ['first control, Shift+Tab', true, 'first'],
] as const)(
  'in a dialog, a dropdown as the %s from its open menu wraps inside the dialog',
  (_name, shiftKey, position) => {
    const select = (
      <SettingsSelect
        aria-label="Role"
        value="member"
        options={OPTIONS}
        onValueChange={() => undefined}
        data-testid="role"
      />
    );
    act(() =>
      root.render(
        <DialogModal
          onClose={() => undefined}
          title="Grants"
          trapFocus
          showCloseButton={false}
        >
          {position === 'first' ? select : null}
          <button type="button">Middle</button>
          {position === 'last' ? select : null}
        </DialogModal>,
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="role"]',
    );
    act(() => {
      trigger?.focus();
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    const option = listbox()?.querySelector<HTMLElement>('[role="option"]');
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      option?.dispatchEvent(tab);
    });
    expect(listbox()).toBeNull();
    expect(tab.defaultPrevented).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
  },
);

it.each(['ArrowDown', 'ArrowUp'])(
  'opens on the chosen option with %s, so Enter keeps the choice',
  (key) => {
    const change = jest.fn();
    const trigger = render({ value: 'member', onValueChange: change });
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });
    const focused = document.activeElement;
    expect(focused?.getAttribute('data-value')).toBe('member');
    act(() => {
      focused?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(change).not.toHaveBeenCalled();
  },
);

it('draws groups as labelled runs, like optgroups', () => {
  const trigger = render({
    value: 'b',
    options: [
      { label: 'Claude', options: [{ value: 'a', label: 'Opus' }] },
      { label: 'Codex', options: [{ value: 'b', label: 'GPT' }] },
    ],
  });
  expect(trigger.textContent).toBe('GPT');
  act(() => trigger.click());
  const text = listbox()?.textContent ?? '';
  expect(text).toBe('ClaudeOpusCodexGPT');
  expect(listbox()?.querySelectorAll('[role="option"]')).toHaveLength(2);
});

it('opens on the chosen option from the keyboard', () => {
  const trigger = render({ value: 'admin' });
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  expect(listbox()).toBeInstanceOf(HTMLElement);
});

it('puts the replay marker on label text only, never on the control or menu', () => {
  const trigger = render({
    'aria-label': 'Role for Ada Lovelace',
    replayPrivacy: { blockClassName: REPLAY_BLOCK_CLASS },
  });
  expect(trigger.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
  expect(trigger.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent).toBe(
    trigger.textContent,
  );
  act(() => trigger.click());
  const menu = listbox();
  expect(menu?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
  const options = menu?.querySelectorAll('[role="option"]') ?? [];
  expect(options.length).toBeGreaterThan(0);
  for (const option of Array.from(options)) {
    expect(option.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeInstanceOf(
      HTMLElement,
    );
  }
});

it('masks user-authored label text with the mask marker, never blocking it', () => {
  const MASK = 'replay-mask-under-test';
  const trigger = render({
    'aria-label': 'Project',
    replayPrivacy: { maskClassName: MASK },
  });
  expect(trigger.classList.contains(MASK)).toBe(false);
  expect(trigger.querySelector(`.${MASK}`)?.textContent).toBe(
    trigger.textContent,
  );
  act(() => trigger.click());
  const options = listbox()?.querySelectorAll('[role="option"]') ?? [];
  expect(options.length).toBeGreaterThan(0);
  for (const option of Array.from(options)) {
    expect(option.querySelector(`.${MASK}`)).toBeInstanceOf(HTMLElement);
  }
});

it('names the menu like its trigger, and by ids only when labelled by elements', () => {
  const labelled = render({ 'aria-label': 'Member role' });
  act(() => labelled.click());
  expect(listbox()?.getAttribute('aria-label')).toBe('Member role');
  act(() => labelled.click());

  const byIds = render({
    'aria-label': undefined,
    'aria-labelledby': 'role-caption member-name',
  });
  act(() => byIds.click());
  expect(listbox()?.getAttribute('aria-label')).toBeNull();
  expect(listbox()?.getAttribute('aria-labelledby')).toBe(
    'role-caption member-name',
  );
  act(() => byIds.click());

  const unnamed = render({ 'aria-label': undefined, id: 'role-trigger' });
  act(() => unnamed.click());
  expect(listbox()?.getAttribute('aria-labelledby')).toBe('role-trigger');
});

it('stays closed while disabled', () => {
  const trigger = render({ disabled: true });
  expect(trigger.disabled).toBe(true);
  act(() => trigger.click());
  expect(listbox()).toBeNull();
});

it('shows a placeholder for an unknown value, else the first option', () => {
  expect(render({ value: null, placeholder: 'Choose' }).textContent).toBe(
    'Choose',
  );
  expect(render({ value: null }).textContent).toBe('Member');
});

it('flattens groups in order', () => {
  expect(
    settingsSelectOptions([
      { value: 'x', label: 'X' },
      { label: 'G', options: [{ value: 'y', label: 'Y' }] },
    ]).map((option) => option.value),
  ).toEqual(['x', 'y']);
});
