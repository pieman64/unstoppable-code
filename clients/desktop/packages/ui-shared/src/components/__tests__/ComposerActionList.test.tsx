/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerActionList } from '../ComposerActionList';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function pointerMove(target: Element, movementX: number): void {
  const event = new MouseEvent('pointermove', { bubbles: true });
  Object.defineProperty(event, 'movementX', { value: movementX });
  Object.defineProperty(event, 'movementY', { value: 0 });
  target.dispatchEvent(event);
}

describe('ComposerActionList pointer highlighting', () => {
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
  });

  it('hands the menu to the mouse on a real move and reports the hovered row', () => {
    const onActiveIdChange = jest.fn();
    const onHoveredIdChange = jest.fn();
    act(() =>
      root.render(
        <ComposerActionList
          rows={[
            {
              id: 'attach',
              label: 'Files and folders',
              group: 'Add',
              icon: null,
              dataTestId: 'row-attach',
              onSelect: (): void => undefined,
            },
            {
              id: 'plan',
              label: 'Plan mode',
              group: 'Add',
              icon: null,
              dataTestId: 'row-plan',
              onSelect: (): void => undefined,
            },
          ]}
          activeId="keyboard-row"
          onActiveIdChange={onActiveIdChange}
          onHoveredIdChange={onHoveredIdChange}
          dataTestIdPrefix="test"
        />,
      ),
    );
    const plan = container.querySelector<HTMLButtonElement>(
      '[data-testid="row-plan"]',
    );
    expect(plan).not.toBeNull();
    if (!plan) return;

    // A stationary pointer (layout/scroll jitter) never touches the keyboard's
    // highlight.
    act(() => pointerMove(plan, 0));
    expect(onActiveIdChange).not.toHaveBeenCalled();

    // A real move clears the keyboard highlight so the hover style shows...
    act(() => pointerMove(plan, 3));
    expect(onActiveIdChange).toHaveBeenCalledWith(null);

    // ...and the hovered row is reported by its DOM id — the id the host
    // resolves on Enter — then cleared when the pointer leaves it.
    // React synthesizes enter/leave from bubbling over/out pairs.
    act(() => {
      plan.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true, relatedTarget: null }),
      );
    });
    expect(onHoveredIdChange).toHaveBeenLastCalledWith(plan.id);
    act(() => {
      plan.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }),
      );
    });
    expect(onHoveredIdChange).toHaveBeenLastCalledWith(null);
  });
});

describe('ComposerActionList replay privacy', () => {
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
  });

  function renderList(blockRowsFromReplay?: boolean): void {
    act(() =>
      root.render(
        <ComposerActionList
          rows={[
            {
              id: 'skill-a',
              label: 'Skill A',
              group: 'Skills',
              icon: null,
              onSelect: (): void => undefined,
            },
            {
              id: 'model',
              label: 'Model',
              group: 'Current settings',
              icon: null,
              onSelect: (): void => undefined,
            },
          ]}
          dataTestIdPrefix="test"
          blockRowsFromReplay={blockRowsFromReplay}
        />,
      ),
    );
  }

  it('blocks each group’s rows but keeps its heading recorded', () => {
    renderList(true);
    const groups = container.querySelectorAll('[role="group"]');
    expect(groups).toHaveLength(2);
    for (const group of Array.from(groups)) {
      expect(group.closest('.ph-no-capture')).toBeNull();
      const heading = group.firstElementChild;
      expect(heading?.textContent).toBe(group.getAttribute('aria-label'));
      expect(heading?.closest('.ph-no-capture')).toBeNull();
      const rows = Array.from(group.querySelectorAll('[data-action-row]'));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.closest('.ph-no-capture')).not.toBeNull();
      }
    }
  });

  it('adds no replay marker unless the host asks for it', () => {
    renderList();
    expect(container.querySelector('.ph-no-capture')).toBeNull();
  });
});

describe('ComposerActionList radio rows', () => {
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
  });

  function renderRadios(
    onSelect: (speed: string) => void = jest.fn<void, [string]>(),
    selectedSpeed = 'fast',
    ultraDisabled = true,
  ): void {
    act(() =>
      root.render(
        <ComposerActionList
          rows={[
            {
              id: 'standard',
              label: 'Regular',
              group: 'Speed',
              icon: null,
              checked: selectedSpeed === 'standard',
              dataTestId: 'radio-standard',
              onSelect: (): void => onSelect('standard'),
            },
            {
              id: 'fast',
              label: 'Fast',
              group: 'Speed',
              icon: null,
              checked: selectedSpeed === 'fast',
              dataTestId: 'radio-fast',
              onSelect: (): void => onSelect('fast'),
            },
            {
              id: 'ultrafast',
              label: 'Ultra fast',
              description: 'Not offered for this model',
              group: 'Speed',
              icon: null,
              checked: selectedSpeed === 'ultrafast',
              disabled: ultraDisabled,
              dataTestId: 'radio-ultrafast',
              onSelect: (): void => onSelect('ultrafast'),
            },
            {
              id: 'plan',
              label: 'Plan mode',
              group: 'Add',
              icon: null,
              ariaChecked: true,
              dataTestId: 'toggle-plan',
              onSelect: (): void => undefined,
            },
          ]}
          dataTestIdPrefix="test"
        />,
      ),
    );
  }

  it('exposes checked rows as radios in a radio group, never as pressed toggles', () => {
    renderRadios();
    const group = container.querySelector('[aria-label="Speed"]');
    expect(group?.getAttribute('role')).toBe('radiogroup');
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    for (const radio of radios) {
      expect(radio.hasAttribute('aria-pressed')).toBe(false);
    }
    // Unavailable choices stay visible with their reason.
    const ultra = container.querySelector<HTMLButtonElement>(
      '[data-testid="radio-ultrafast"]',
    );
    expect(ultra?.disabled).toBe(true);
    expect(ultra?.textContent).toContain('Not offered for this model');
  });

  it('marks the selected radio with a checkmark rather than a persistent highlight', () => {
    renderRadios();
    const fast = container.querySelector('[data-testid="radio-fast"]');
    const standard = container.querySelector('[data-testid="radio-standard"]');
    expect(fast?.querySelector('[data-radio-check]')).not.toBeNull();
    expect(standard?.querySelector('[data-radio-check]')).toBeNull();
    expect(fast?.classList.contains('bg-subtle')).toBe(false);
  });

  it('gives the selected radio the only tab stop in its group', () => {
    renderRadios();
    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="toggle-plan"]')
        ?.tabIndex,
    ).toBe(0);
  });

  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])(
    '%s selects within the radio group, skipping unavailable choices and other actions',
    (key) => {
      const onSelect = jest.fn();
      renderRadios(onSelect);
      const fast = container.querySelector<HTMLButtonElement>(
        '[data-testid="radio-fast"]',
      );
      const regular = container.querySelector<HTMLButtonElement>(
        '[data-testid="radio-standard"]',
      );
      expect(fast).not.toBeNull();
      expect(regular).not.toBeNull();
      if (!fast || !regular) throw new Error('Missing speed radio');
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        fast.focus();
        fast.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(regular);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith('standard');
      renderRadios(onSelect, 'standard');
      expect(regular.getAttribute('aria-checked')).toBe('true');
      expect(regular.tabIndex).toBe(0);
      expect(fast.getAttribute('aria-checked')).toBe('false');
      expect(fast.tabIndex).toBe(-1);
    },
  );

  it('selects available Ultra fast with ArrowRight and gives it the sole tab stop', () => {
    const onSelect = jest.fn();
    renderRadios(onSelect, 'fast', false);
    const fast = container.querySelector<HTMLButtonElement>(
      '[data-testid="radio-fast"]',
    );
    const ultra = container.querySelector<HTMLButtonElement>(
      '[data-testid="radio-ultrafast"]',
    );
    if (!fast || !ultra) throw new Error('Missing speed radio');
    act(() => {
      fast.focus();
      fast.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith('ultrafast');
    expect(document.activeElement).toBe(ultra);
    renderRadios(onSelect, 'ultrafast', false);
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).map((radio) => radio.tabIndex),
    ).toEqual([-1, -1, 0]);
  });

  it('uses the first enabled radio as the tab stop when the checked choice is unavailable', () => {
    renderRadios(jest.fn(), 'ultrafast');
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).map((radio) => radio.tabIndex),
    ).toEqual([0, -1, -1]);
  });

  it('keeps toggle rows and ordinary groups unchanged beside radio groups', () => {
    renderRadios();
    const plan = container.querySelector('[data-testid="toggle-plan"]');
    expect(plan?.getAttribute('aria-pressed')).toBe('true');
    expect(plan?.hasAttribute('role')).toBe(false);
    expect(
      container.querySelector('[aria-label="Add"]')?.getAttribute('role'),
    ).toBe('group');
  });

  it('activates a radio with the keyboard', () => {
    const onSelect = jest.fn();
    renderRadios(onSelect);
    const standard = container.querySelector<HTMLButtonElement>(
      '[data-testid="radio-standard"]',
    );
    act(() => standard?.click());
    expect(onSelect).toHaveBeenCalledWith('standard');
  });
});
