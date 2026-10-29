/**
 * @jest-environment jsdom
 */
import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  COMPACT_CHIPS_BREAKPOINT_REM,
  COMPACT_CHIPS_HYSTERESIS_REM,
  ComposerStatusRow,
  useComposerChipsCompact,
  useOneLineComposer,
  useStatusRowCompact,
  buildChatComposerPlusItems,
} from '../ComposerLayout';
import {
  CHAT_INTERFACE_MODE_BUSY_REASONS,
  resolveChatInterfaceModeOptions,
} from '../chatInterfaceModes';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const resizeCallbacks = new Set<() => void>();
/** Runs every live observer's callback, as a resize would. */
function triggerResize(): void {
  act(() => {
    resizeCallbacks.forEach((callback) => callback());
  });
}
class TestResizeObserver implements ResizeObserver {
  private readonly run: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.run = (): void => callback([], this);
  }
  observe(): void {
    resizeCallbacks.add(this.run);
  }
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks.delete(this.run);
  }
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});

function Probe({
  allowed,
  hasDraftText,
  editableHeight,
}: {
  allowed: boolean;
  hasDraftText: boolean;
  editableHeight: number;
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const inline = useOneLineComposer({
    boxRef,
    hasDraftText,
    allowed,
    draftRevision: `${String(hasDraftText)}:${editableHeight}`,
  });
  return (
    <div ref={boxRef} data-inline={String(inline)}>
      <div
        contentEditable
        suppressContentEditableWarning
        ref={(node): void => {
          if (!node) return;
          node.style.lineHeight = '20px';
          Object.defineProperty(node, 'scrollHeight', {
            configurable: true,
            get: () => editableHeight,
          });
        }}
      />
    </div>
  );
}

/** What the cramped probe's box and editable measure, changed between renders. */
const crampedLayout = { textRoom: 300, boxWidth: 500 };

function CrampedProbe({
  sideContentKey,
}: {
  sideContentKey: string;
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const inline = useOneLineComposer({
    boxRef,
    hasDraftText: false,
    allowed: true,
    draftRevision: 0,
    minTextWidth: 160,
    sideContentKey,
  });
  return (
    <div
      ref={(node): void => {
        boxRef.current = node;
        if (!node) return;
        Object.defineProperty(node, 'clientWidth', {
          configurable: true,
          get: () => crampedLayout.boxWidth,
        });
      }}
      data-inline={String(inline)}
    >
      <div
        contentEditable
        suppressContentEditableWarning
        ref={(node): void => {
          if (!node) return;
          Object.defineProperty(node, 'clientWidth', {
            configurable: true,
            get: () => crampedLayout.textRoom,
          });
        }}
      />
    </div>
  );
}

function StatusRowProbe({
  clientWidth,
  scrollWidth,
}: {
  clientWidth: number;
  scrollWidth: number;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const compact = useStatusRowCompact(rowRef);
  return (
    <div
      data-compact={String(compact)}
      ref={(node): void => {
        rowRef.current = node;
        if (!node) return;
        Object.defineProperty(node, 'clientWidth', {
          configurable: true,
          get: () => clientWidth,
        });
        Object.defineProperty(node, 'scrollWidth', {
          configurable: true,
          get: () => scrollWidth,
        });
      }}
    />
  );
}

describe('ComposerLayout', () => {
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

  function render(props: Parameters<typeof Probe>[0]): string | null {
    act(() => {
      root.render(<Probe {...props} />);
    });
    return container.firstElementChild?.getAttribute('data-inline') ?? null;
  }

  it('stays on one line while the draft fits', () => {
    expect(
      render({ allowed: true, hasDraftText: true, editableHeight: 20 }),
    ).toBe('true');
  });

  it('opens the full layout once the draft wraps', () => {
    expect(
      render({ allowed: true, hasDraftText: true, editableHeight: 40 }),
    ).toBe('false');
    // Text the one-line slot cannot fit keeps the full layout (jsdom has no
    // line layout, so nothing here ever fits the slot).
    expect(
      render({ allowed: true, hasDraftText: true, editableHeight: 20 }),
    ).toBe('false');
    expect(
      render({ allowed: true, hasDraftText: false, editableHeight: 20 }),
    ).toBe('true');
  });

  function renderCramped(sideContentKey: string): string | null {
    act(() => {
      root.render(<CrampedProbe sideContentKey={sideContentKey} />);
    });
    return container.firstElementChild?.getAttribute('data-inline') ?? null;
  }

  it('keeps chips beside the text while the text keeps its room', () => {
    crampedLayout.textRoom = 300;
    crampedLayout.boxWidth = 500;
    expect(renderCramped('plan')).toBe('true');
  });

  it('moves chips under the text once they leave it too little room', () => {
    crampedLayout.textRoom = 120;
    crampedLayout.boxWidth = 330;
    expect(renderCramped('plan|scheduled')).toBe('false');
    // Fewer chips: the one line is tried again, and kept when it has room.
    crampedLayout.textRoom = 200;
    expect(renderCramped('plan')).toBe('true');
  });

  it('moves chips under the text when they squeeze it to nothing', () => {
    crampedLayout.textRoom = 0;
    crampedLayout.boxWidth = 330;
    expect(renderCramped('plan|scheduled|watchers:3')).toBe('false');
  });

  it('tries the one line again once the box grows, not on a small wiggle', () => {
    crampedLayout.textRoom = 120;
    crampedLayout.boxWidth = 330;
    expect(renderCramped('plan|scheduled|watchers:1')).toBe('false');
    crampedLayout.boxWidth = 340;
    triggerResize();
    expect(container.firstElementChild?.getAttribute('data-inline')).toBe(
      'false',
    );
    crampedLayout.boxWidth = 700;
    crampedLayout.textRoom = 400;
    triggerResize();
    expect(container.firstElementChild?.getAttribute('data-inline')).toBe(
      'true',
    );
  });

  it('uses the full layout whenever the box holds more than text', () => {
    expect(
      render({ allowed: false, hasDraftText: false, editableHeight: 20 }),
    ).toBe('false');
  });

  it('keeps selector labels while the status row fits', () => {
    act(() => {
      root.render(<StatusRowProbe clientWidth={400} scrollWidth={400} />);
    });
    expect(container.firstElementChild?.getAttribute('data-compact')).toBe(
      'false',
    );
  });

  it('drops selector labels once the status row overflows', () => {
    act(() => {
      root.render(<StatusRowProbe clientWidth={300} scrollWidth={360} />);
    });
    expect(container.firstElementChild?.getAttribute('data-compact')).toBe(
      'true',
    );
  });

  it('puts the permission level first and the model settings last', () => {
    act(() => {
      root.render(
        <ComposerStatusRow
          start={<span data-testid="start" />}
          end={<span data-testid="end" />}
        />,
      );
    });
    const row = container.querySelector(
      '[data-testid="chat-composer-status-row"]',
    );
    expect(
      row?.firstElementChild?.querySelector('[data-testid="start"]'),
    ).not.toBeNull();
    expect(
      row?.lastElementChild?.querySelector('[data-testid="end"]'),
    ).not.toBeNull();
  });
});

describe('buildChatComposerPlusItems interface modes', () => {
  const baseOptions = {
    onOpenPlugins: (): void => undefined,
    hasPluginSelections: false,
  };

  it('lists the modes under View, the current one checked', () => {
    const onSelect = jest.fn();
    const items = buildChatComposerPlusItems({
      ...baseOptions,
      interfaceModes: {
        options: resolveChatInterfaceModeOptions({
          mode: 'auto',
          onChange: onSelect,
          providerIsClaude: true,
          canopyNativeBusy: false,
        }),
        onSelect,
      },
    });
    const modes = items.filter((item) => item.group === 'view');
    expect(modes.map((item) => item.dataTestId)).toEqual([
      'chat-interface-mode-option-canopy',
      'chat-interface-mode-option-auto',
      'chat-interface-mode-option-claude-code',
    ]);
    expect(modes.map((item) => item.checked)).toEqual([false, true, false]);
    expect(modes.map((item) => item.label).slice(1)).toEqual([
      'Auto',
      'Claude Code',
    ]);

    // Picking the current mode is a no-op; another mode switches.
    modes[1]?.onSelect();
    expect(onSelect).not.toHaveBeenCalled();
    modes[2]?.onSelect();
    expect(onSelect).toHaveBeenCalledWith('claude-code');
  });

  it('disables the modes a running turn blocks, with the reason', () => {
    const items = buildChatComposerPlusItems({
      ...baseOptions,
      interfaceModes: {
        options: resolveChatInterfaceModeOptions({
          mode: 'canopy',
          onChange: (): void => undefined,
          providerIsClaude: true,
          canopyNativeBusy: true,
        }),
        onSelect: (): void => undefined,
      },
    });
    const byId = new Map(
      items
        .filter((item) => item.group === 'view')
        .map((item) => [item.id, item]),
    );
    expect(byId.get('interface-mode-auto')?.disabled).toBe(true);
    expect(byId.get('interface-mode-auto')?.disabledTooltip?.description).toBe(
      CHAT_INTERFACE_MODE_BUSY_REASONS.autoCanopyTurn,
    );
    expect(byId.get('interface-mode-claude-code')?.disabled).toBe(true);
    expect(byId.get('interface-mode-canopy')?.disabled).toBe(true);
  });

  it('adds no View rows without interface modes', () => {
    expect(
      buildChatComposerPlusItems(baseOptions).some(
        (item) => item.group === 'view',
      ),
    ).toBe(false);
  });
});

function ChipsCompactProbe({
  width,
}: {
  width: { current: number };
}): JSX.Element {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const compact = useComposerChipsCompact(element);
  return (
    <div
      ref={(node): void => {
        if (node && node !== element) {
          node.getBoundingClientRect = (): DOMRect =>
            ({ width: width.current }) as DOMRect;
          setElement(node);
        }
      }}
      data-compact={String(compact)}
    />
  );
}

describe('useComposerChipsCompact', () => {
  it('draws chips small below the chat breakpoint, with hysteresis on the way back', () => {
    document.documentElement.style.fontSize = '16px';
    const rem = 16;
    const breakpoint = COMPACT_CHIPS_BREAKPOINT_REM * rem;
    const hysteresis = COMPACT_CHIPS_HYSTERESIS_REM * rem;
    const width = { current: breakpoint + 100 };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<ChipsCompactProbe width={width} />));
    const probe = (): string | null =>
      container.firstElementChild?.getAttribute('data-compact') ?? null;
    expect(probe()).toBe('false');

    width.current = breakpoint - 1;
    triggerResize();
    expect(probe()).toBe('true');

    // Just past the breakpoint is not enough to grow back.
    width.current = breakpoint + hysteresis - 1;
    triggerResize();
    expect(probe()).toBe('true');

    width.current = breakpoint + hysteresis;
    triggerResize();
    expect(probe()).toBe('false');

    act(() => root.unmount());
    container.remove();
    document.documentElement.style.fontSize = '';
  });
});
