/** @jest-environment jsdom */
import { act, createRef, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FIND_SURFACE_PLACEHOLDERS,
  FindInSurfaceBar,
  type FindSurfaceMode,
} from '../FindInSurfaceBar';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type BarProps = ComponentProps<typeof FindInSurfaceBar>;

describe('FindInSurfaceBar', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function props(overrides: Partial<BarProps> = {}): BarProps {
    return {
      mode: 'chat',
      availableModes: ['chat'],
      onModeChange: jest.fn(),
      query: '',
      onQueryChange: jest.fn(),
      currentIndex: 0,
      totalCount: 0,
      onNext: jest.fn(),
      onPrevious: jest.fn(),
      onClose: jest.fn(),
      inputRef: createRef<HTMLInputElement>(),
      focusNonce: 0,
      ...overrides,
    };
  }

  function render(next: BarProps): void {
    act(() => root.render(<FindInSurfaceBar {...next} />));
  }

  function input(doc: Document = document): HTMLInputElement {
    const element = doc.querySelector<HTMLInputElement>(
      '[data-testid="surface-find-bar"] input',
    );
    if (!element) throw new Error('find bar input missing');
    return element;
  }

  it.each<[FindSurfaceMode, string]>([
    ['chat', 'Search the chat history.'],
    ['browser', 'Search the browser tab.'],
    ['file', 'Search the file.'],
    ['plan', 'Search the plan.'],
    ['diagram', 'Search the diagram.'],
    ['terminal', 'Search the terminal.'],
  ])('uses the exact %s placeholder', (mode, copy) => {
    render(props({ mode, availableModes: [mode] }));

    expect(FIND_SURFACE_PLACEHOLDERS[mode]).toBe(copy);
    expect(input().placeholder).toBe(copy);
    expect(input().getAttribute('aria-label')).toBe(copy);
    expect(
      document
        .querySelector('[data-testid="surface-find-bar"]')
        ?.getAttribute('role'),
    ).toBe('search');
  });

  it('floats on a design-system layer without freezing the browser view', () => {
    render(props({ mode: 'browser', availableModes: ['browser'] }));

    const bar = document.querySelector('[data-testid="surface-find-bar"]');
    expect(bar?.classList.contains('z-drawer')).toBe(true);
    // Browser mode needs the live page underneath to show its highlights.
    expect(bar?.getAttribute('data-canopy-browser-native-overlay')).toBe(
      'false',
    );
  });

  it('hides the mode row when only one mode is available', () => {
    render(props());

    expect(
      document.querySelector('[data-testid^="surface-find-mode-"]'),
    ).toBeNull();
  });

  it('renders only available modes with the current one pressed', () => {
    const onModeChange = jest.fn();
    render(
      props({ mode: 'file', availableModes: ['file', 'chat'], onModeChange }),
    );

    const chat = document.querySelector(
      '[data-testid="surface-find-mode-chat"]',
    );
    const file = document.querySelector(
      '[data-testid="surface-find-mode-file"]',
    );
    expect(
      document.querySelector('[data-testid="surface-find-mode-browser"]'),
    ).toBeNull();
    expect(chat?.getAttribute('aria-pressed')).toBe('false');
    expect(file?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      chat?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onModeChange).toHaveBeenCalledWith('chat');
  });

  it('orders every mode and names the plan, diagram, and terminal toggles', () => {
    render(
      props({
        mode: 'diagram',
        availableModes: [
          'terminal',
          'diagram',
          'plan',
          'file',
          'browser',
          'chat',
        ],
      }),
    );

    const toggles = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="surface-find-mode-"]',
      ),
    );
    expect(toggles.map((toggle) => toggle.dataset.testid)).toEqual([
      'surface-find-mode-chat',
      'surface-find-mode-browser',
      'surface-find-mode-file',
      'surface-find-mode-plan',
      'surface-find-mode-diagram',
      'surface-find-mode-terminal',
    ]);
    const plan = toggles[3];
    const diagram = toggles[4];
    const terminal = toggles[5];
    expect(plan.getAttribute('aria-label')).toBe('Search plan');
    expect(plan.getAttribute('aria-pressed')).toBe('false');
    expect(diagram.getAttribute('aria-label')).toBe('Search diagram');
    expect(diagram.getAttribute('aria-pressed')).toBe('true');
    expect(terminal.getAttribute('aria-label')).toBe('Search terminal');
    expect(terminal.getAttribute('aria-pressed')).toBe('false');
    expect(terminal.querySelector('svg')).not.toBeNull();
    expect(
      document
        .querySelector('[data-testid="surface-find-bar"]')
        ?.getAttribute('data-find-mode'),
    ).toBe('diagram');
  });

  it('shows both a plan and a diagram toggle when both are registered', () => {
    const onModeChange = jest.fn();
    render(
      props({
        mode: 'plan',
        availableModes: ['plan', 'diagram'],
        onModeChange,
      }),
    );

    const diagram = document.querySelector(
      '[data-testid="surface-find-mode-diagram"]',
    );
    expect(
      document.querySelector('[data-testid="surface-find-mode-plan"]'),
    ).not.toBeNull();
    act(() => {
      diagram?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onModeChange).toHaveBeenCalledWith('diagram');
  });

  it.each<[FindSurfaceMode, string]>([
    ['plan', 'Search plan 2: Payroll plan'],
    ['diagram', 'Search diagram 2: Payroll plan'],
    ['terminal', 'Search terminal 2: Payroll plan'],
  ])(
    "keeps a %s toggle's authored title out of its attributes",
    (mode, name) => {
      render(
        props({
          mode,
          availableModes: [mode],
          scopes: {
            [mode]: [
              { key: 'p1', title: 'Offsite ideas' },
              { key: 'p2', title: 'Payroll plan' },
            ],
          },
          activeScopeKey: 'p1',
        }),
      );
      const toggle = document.querySelector<HTMLButtonElement>(
        `[data-testid="surface-find-scope-${mode}-p2"]`,
      );
      if (!toggle) throw new Error(`${mode} toggle missing`);

      for (const attribute of Array.from(toggle.attributes)) {
        expect(attribute.value).not.toContain('Payroll plan');
      }
      const labelId = toggle.getAttribute('aria-labelledby');
      const label = labelId === null ? null : document.getElementById(labelId);
      expect(label?.textContent).toBe(name);
      expect(label?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
        'Payroll plan',
      );
    },
  );

  it('focuses and selects the input on mount, mode change, and focus nonce', () => {
    const inputRef = createRef<HTMLInputElement>();
    render(props({ inputRef, query: 'abc' }));
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(3);

    input().blur();
    render(props({ inputRef, query: 'abc', focusNonce: 1 }));
    expect(document.activeElement).toBe(input());

    input().blur();
    render(
      props({
        inputRef,
        query: 'abc',
        focusNonce: 1,
        mode: 'file',
        availableModes: ['chat', 'file'],
      }),
    );
    expect(document.activeElement).toBe(input());
  });

  it('routes Enter, Shift+Enter, and Escape', () => {
    const next = props({ query: 'needle', totalCount: 2 });
    render(next);

    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      input().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
        }),
      );
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(next.onNext).toHaveBeenCalledTimes(1);
    expect(next.onPrevious).toHaveBeenCalledTimes(1);
    expect(next.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape from any control inside the bar, not only the input', () => {
    const next = props({ query: 'needle', totalCount: 2 });
    render(next);
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="surface-find-bar"] button',
    );
    if (!button) throw new Error('find bar button missing');

    act(() => {
      button.focus();
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(next.onClose).toHaveBeenCalledTimes(1);
  });

  it('lays out one numbered toggle per surface when a mode has several', () => {
    const next = props({
      mode: 'browser',
      availableModes: ['browser'],
      scopes: {
        browser: [
          { key: 'b1', title: 'Docs' },
          { key: 'b2', title: 'Local' },
        ],
      },
      activeScopeKey: 'b1',
    });
    render(next);

    // The row shows even with one mode, because that mode has two surfaces.
    expect(
      document.querySelector('[data-testid="surface-find-mode-browser"]'),
    ).toBeNull();
    const toggles = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="surface-find-scope-browser-"]',
      ),
    );
    expect(toggles.map((toggle) => toggle.textContent?.trim())).toEqual([
      '1',
      '2',
    ]);
    expect(toggles.map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
      'Search browser tab 1: Docs',
      'Search browser tab 2: Local',
    ]);
    expect(
      toggles.map((toggle) => toggle.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false']);

    act(() => toggles[1].click());
    expect(next.onModeChange).toHaveBeenCalledWith('browser', 'b2');
  });

  it('names each numbered toggle by mode, ordinal, and title in its tooltip', () => {
    render(
      props({
        mode: 'browser',
        availableModes: ['browser'],
        scopes: {
          browser: [
            { key: 'b1', title: 'Docs' },
            { key: 'b2', title: 'Local' },
          ],
        },
        activeScopeKey: 'b1',
      }),
    );
    const second = document.querySelector<HTMLButtonElement>(
      '[data-testid="surface-find-scope-browser-b2"]',
    );
    if (!second) throw new Error('second toggle missing');

    // The shared tooltip opens on keyboard focus (a Tab keydown reaches the
    // document before focus moves).
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      second.focus();
    });

    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Browser tab 2: Local',
    );
  });

  it("masks a chat toggle's user-authored title in its tooltip for session replay", () => {
    render(
      props({
        mode: 'chat',
        availableModes: ['chat'],
        scopes: {
          chat: [
            { key: 'c1', title: 'Payroll plan' },
            { key: 'c2', title: 'Offsite ideas' },
          ],
        },
        activeScopeKey: 'c1',
      }),
    );
    const second = document.querySelector<HTMLButtonElement>(
      '[data-testid="surface-find-scope-chat-c2"]',
    );
    if (!second) throw new Error('second toggle missing');

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      second.focus();
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Chat 2: Offsite ideas');
    expect(tooltip?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'Offsite ideas',
    );
  });

  it("keeps a chat toggle's title out of its attributes, naming it from a masked label", () => {
    render(
      props({
        mode: 'chat',
        availableModes: ['chat'],
        scopes: {
          chat: [
            { key: 'c1', title: 'Payroll plan' },
            { key: 'c2', title: 'Offsite ideas' },
          ],
        },
        activeScopeKey: 'c1',
      }),
    );
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-testid="surface-find-scope-chat-c2"]',
    );
    if (!toggle) throw new Error('chat toggle missing');

    for (const attribute of Array.from(toggle.attributes)) {
      expect(attribute.value).not.toContain('Offsite ideas');
    }
    expect(toggle.textContent?.trim()).toBe('2');
    const labelId = toggle.getAttribute('aria-labelledby');
    const label = labelId === null ? null : document.getElementById(labelId);
    expect(label?.textContent).toBe('Search chat 2: Offsite ideas');
    expect(label?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'Offsite ideas',
    );
  });

  it('numbers ten toggles in order when a mode has ten surfaces', () => {
    render(
      props({
        mode: 'browser',
        availableModes: ['browser'],
        scopes: {
          browser: Array.from({ length: 10 }, (_, index) => ({
            key: `b${index + 1}`,
            title: `Page ${index + 1}`,
          })),
        },
        activeScopeKey: 'b10',
      }),
    );
    const toggles = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="surface-find-scope-browser-"]',
      ),
    );
    expect(toggles.map((toggle) => toggle.textContent?.trim())).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 1)),
    );
    expect(toggles[9].getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the plain mode button for a mode with one surface', () => {
    render(
      props({
        mode: 'chat',
        availableModes: ['chat', 'browser'],
        scopes: { chat: [{ key: 'c1', title: 'Chat' }] },
        activeScopeKey: 'c1',
      }),
    );

    expect(
      document.querySelector('[data-testid="surface-find-mode-chat"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="surface-find-scope-menu-chat"]'),
    ).toBeNull();
  });

  it('shows n of m, including 0 of 0', () => {
    render(props({ query: 'needle', currentIndex: 1, totalCount: 4 }));
    expect(document.body.textContent).toContain('2 of 4');

    render(props({ query: 'needle', currentIndex: 0, totalCount: 0 }));
    expect(document.body.textContent).toContain('0 of 0');
  });

  it('shows an error with a retry action', () => {
    const onRetry = jest.fn();
    render(props({ error: { message: 'Search failed.', onRetry } }));

    const error = document.querySelector('[data-testid="surface-find-error"]');
    expect(error?.textContent).toContain('Search failed.');
    const retry = Array.from(error?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Retry',
    );
    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('portals into the given container of another document', () => {
    const other = document.implementation.createHTMLDocument('aux');
    render(props({ portalContainer: other.body }));

    expect(
      document.querySelector('[data-testid="surface-find-bar"]'),
    ).toBeNull();
    expect(
      other.querySelector('[data-testid="surface-find-bar"]'),
    ).not.toBeNull();
  });
});
