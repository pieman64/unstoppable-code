/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { TurnFooterRow, TurnTimer, type TurnTimerProps } from '../TurnTimer';
import { ChatLookProvider } from '../chat-look';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderTimer(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ChatLookProvider value="classic">{node}</ChatLookProvider>);
  });
  return { container, root };
}

describe('TurnTimer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  it('keeps paused timers stopped even when streaming is explicitly true', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={5_000}
        pausedAt={8_000}
        isStreaming
        spinner={<span data-testid="spinner" />}
      />,
    );

    try {
      expect(container.textContent).toBe('Waiting for you · 0:03');
      expect(container.querySelector('[data-testid="spinner"]')).toBeNull();

      act(() => {
        jest.advanceTimersByTime(3_000);
      });

      expect(container.textContent).toBe('Waiting for you · 0:03');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('deducts paused time from resumed live timers', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={1_000} pausedAt={4_000} resumedAt={8_000} />,
    );

    try {
      expect(container.textContent).toBe('Working… 0:05');

      act(() => {
        jest.advanceTimersByTime(2_000);
      });

      expect(container.textContent).toBe('Working… 0:07');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('deducts paused time from completed timers', () => {
    jest.setSystemTime(12_000);
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={1_000}
        pausedAt={4_000}
        resumedAt={8_000}
        finishedAt={12_000}
      />,
    );

    try {
      expect(
        container.querySelector('[data-testid="turn-timer-label"]')
          ?.textContent,
      ).toBe('Completed in 0:07');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  // CAN-2301: completed turns surface how long ago the response landed so a
  // stalled agent is visually distinct from one that just finished.
  it('shows a relative completion timestamp on completed turns', () => {
    jest.setSystemTime(1_700_000_300_000);
    const finishedAt = 1_700_000_000_000; // 5 minutes before "now"
    const { container, root } = renderTimer(
      <TurnTimer startedAt={finishedAt - 5_000} finishedAt={finishedAt} />,
    );

    try {
      const relative = container.querySelector(
        '[data-testid="turn-timer-relative"]',
      );
      const elapsed = container.querySelector(
        '[data-testid="turn-timer-label"]',
      );
      expect(relative?.textContent).toBe('5m ago');
      expect(elapsed?.className).toContain('whitespace-nowrap');
      expect(elapsed?.className).toContain('truncate');
      expect(relative?.className).toContain('whitespace-nowrap');
      expect(relative?.className).toContain('shrink-0');
      // CAN-4278: the stamp leads the row and is never faded.
      expect(relative?.className).not.toContain('opacity-0');
      expect(relative?.className).not.toContain('group-hover/turn');
      const row = container.querySelector('[data-testid="turn-timer"]');
      expect(row?.firstElementChild).toBe(relative);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('ticks the relative completion timestamp as time passes', () => {
    jest.setSystemTime(1_700_000_005_000);
    const finishedAt = 1_700_000_000_000; // 5 seconds before "now"
    const { container, root } = renderTimer(
      <TurnTimer startedAt={finishedAt - 5_000} finishedAt={finishedAt} />,
    );

    try {
      const relative = (): string | null | undefined =>
        container.querySelector('[data-testid="turn-timer-relative"]')
          ?.textContent;
      expect(relative()).toBe('just now');

      // The "just now" tier flips to the minutes tier at exactly one minute.
      act(() => {
        jest.advanceTimersByTime(56_000);
      });
      expect(relative()).toBe('1m ago');

      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(relative()).toBe('2m ago');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows the clock time for completions older than an hour on the same day', () => {
    // Local noon keeps the whole scenario inside one calendar day.
    jest.setSystemTime(new Date(2026, 7, 20, 12, 0, 0));
    const finishedAt = Date.now() - 3 * 3_600_000;
    const { container, root } = renderTimer(
      <TurnTimer startedAt={finishedAt - 5_000} finishedAt={finishedAt} />,
    );

    try {
      const expected = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(finishedAt);
      expect(
        container.querySelector('[data-testid="turn-timer-relative"]')
          ?.textContent,
      ).toBe(expected);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders no rich tooltip on the completion stamp, only a native title', () => {
    jest.setSystemTime(1_700_000_300_000);
    const finishedAt = 1_700_000_000_000;
    const { container, root } = renderTimer(
      <TurnTimer startedAt={finishedAt - 5_000} finishedAt={finishedAt} />,
    );

    try {
      const relative = container.querySelector(
        '[data-testid="turn-timer-relative"]',
      );
      if (!relative) throw new Error('completion stamp not rendered');

      expect(relative.getAttribute('title')).toBe(
        `Completed at ${new Date(finishedAt).toLocaleString()}`,
      );

      act(() => {
        relative.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  // CAN-4278: a successfully completed row keeps its timestamp visible and
  // reveals the rest on turn hover, mirrored sticky-prompt hover, focus within
  // the turn or the row, or on devices without usable hover.
  describe('row reveal', () => {
    it('retains the footer while focus moves into a portaled control and releases it on blur', () => {
      const portal = document.createElement('div');
      document.body.appendChild(portal);
      const { container, root } = renderTimer(
        <TurnTimer
          startedAt={0}
          finishedAt={60_000}
          stampAccessory={createPortal(<button>Menu action</button>, portal)}
        />,
      );
      try {
        const button = portal.querySelector('button');
        if (!button) throw new Error('portal action missing');
        act(() => button.focus());
        const row = container.querySelector('[data-testid="turn-timer"]');
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        // The document-level recheck keeps a still-focused portaled control.
        act(() => {
          document.body.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true }),
          );
          jest.runOnlyPendingTimers();
        });
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        act(() => button.blur());
        expect(row?.hasAttribute('data-focus-within')).toBe(false);
      } finally {
        act(() => root.unmount());
      }
    });
    it('releases the footer when the focused portaled control unmounts without a blur', () => {
      // React delivers no onBlur for an unmounted element (facebook/react#12363),
      // as when a menu item closes its own menu without restoring focus.
      const portal = document.createElement('div');
      document.body.appendChild(portal);
      function SelfClosingMenu(): JSX.Element | null {
        const [open, setOpen] = useState(true);
        return open
          ? createPortal(
              <button onClick={(): void => setOpen(false)}>Unshare</button>,
              portal,
            )
          : null;
      }
      const { container, root } = renderTimer(
        <TurnTimer
          startedAt={0}
          finishedAt={60_000}
          stampAccessory={<SelfClosingMenu />}
        />,
      );
      try {
        const button = portal.querySelector('button');
        if (!button) throw new Error('portal action missing');
        act(() => button.focus());
        const row = container.querySelector('[data-testid="turn-timer"]');
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        act(() => button.click());
        expect(portal.querySelector('button')).toBeNull();
        act(() => {
          jest.runOnlyPendingTimers();
        });
        expect(row?.hasAttribute('data-focus-within')).toBe(false);
      } finally {
        act(() => root.unmount());
        portal.remove();
      }
    });
    it('releases the footer when Escape unmounts the focused portaled control', () => {
      const portal = document.createElement('div');
      document.body.appendChild(portal);
      function EscapableMenu(): JSX.Element | null {
        const [open, setOpen] = useState(true);
        return open
          ? createPortal(
              <button
                onKeyDown={(event): void => {
                  if (event.key === 'Escape') setOpen(false);
                }}
              >
                Menu action
              </button>,
              portal,
            )
          : null;
      }
      const { container, root } = renderTimer(
        <TurnTimer
          startedAt={0}
          finishedAt={60_000}
          stampAccessory={<EscapableMenu />}
        />,
      );
      try {
        const button = portal.querySelector('button');
        if (!button) throw new Error('portal action missing');
        act(() => button.focus());
        const row = container.querySelector('[data-testid="turn-timer"]');
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        act(() => {
          button.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
        });
        expect(portal.querySelector('button')).toBeNull();
        act(() => {
          jest.runOnlyPendingTimers();
        });
        expect(row?.hasAttribute('data-focus-within')).toBe(false);
      } finally {
        act(() => root.unmount());
        portal.remove();
      }
    });
    it('re-checks focus against the document that owns the row', () => {
      // Desktop panels can pop out into their own window, so the row may live
      // in a document other than the global one.
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const frameDocument = frame.contentDocument;
      if (!frameDocument) throw new Error('frame document missing');
      const container = frameDocument.createElement('div');
      frameDocument.body.appendChild(container);
      function SelfClosingMenu(): JSX.Element | null {
        const [open, setOpen] = useState(true);
        return open ? (
          <button onClick={(): void => setOpen(false)}>Unshare</button>
        ) : null;
      }
      const root = createRoot(container);
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer
              startedAt={0}
              finishedAt={60_000}
              stampAccessory={<SelfClosingMenu />}
            />
          </ChatLookProvider>,
        );
      });
      try {
        const button = container.querySelector('button');
        if (!button) throw new Error('menu action missing');
        act(() => button.focus());
        const row = container.querySelector('[data-testid="turn-timer"]');
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        // A press in the main window does not move focus in the other one.
        act(() => {
          document.body.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true }),
          );
          jest.runOnlyPendingTimers();
        });
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        act(() => button.click());
        expect(container.querySelector('button')).toBeNull();
        act(() => {
          jest.runOnlyPendingTimers();
        });
        expect(row?.hasAttribute('data-focus-within')).toBe(false);
      } finally {
        act(() => root.unmount());
        frame.remove();
      }
    });
    const REVEAL_CLASSES = [
      'opacity-0',
      'group-hover/turn:opacity-100',
      'group-data-[hover]/turn:opacity-100',
      'group-focus-within/turn:opacity-100',
      'group-data-[focus-within]/footer:opacity-100',
      'pointer-coarse:opacity-100',
      '[@media(hover:none)]:opacity-100',
    ];

    interface FooterParts {
      row: string[];
      stamp: string[];
      label: string[];
      trailing: string[];
      pinned: string[];
    }

    function classesOf(element: Element | null | undefined): string[] {
      return element?.className.split(/\s+/) ?? [];
    }

    function readParts(container: HTMLElement): FooterParts {
      const row = container.querySelector('[data-testid="turn-timer"]');
      if (row === null) throw new Error('turn-timer row not rendered');
      return {
        row: classesOf(row),
        stamp: classesOf(
          container.querySelector('[data-testid="turn-timer-relative"]'),
        ),
        label: classesOf(
          container.querySelector('[data-testid="turn-timer-label"]'),
        ),
        trailing: classesOf(
          container.querySelector('[data-testid="trailing"]')?.parentElement,
        ),
        pinned: classesOf(
          container.querySelector('[data-testid="pinned"]')?.parentElement,
        ),
      };
    }

    function footerParts(node: JSX.Element): FooterParts {
      const { container, root } = renderTimer(node);
      try {
        return readParts(container);
      } finally {
        act(() => {
          root.unmount();
        });
      }
    }

    const fullTimer = (props: Partial<TurnTimerProps> = {}): JSX.Element => (
      <TurnTimer
        startedAt={0}
        trailing={<b data-testid="trailing">fork</b>}
        stampAccessory={<i data-testid="pinned">rate</i>}
        {...props}
      />
    );

    function expectFaded(classes: string[]): void {
      for (const cls of REVEAL_CLASSES) expect(classes).toContain(cls);
      expect(classes).not.toContain('transition');
      expect(classes).not.toContain('transition-opacity');
      expect(classes).not.toContain('invisible');
      expect(classes).not.toContain('hidden');
      expect(classes).not.toContain('pointer-events-none');
    }

    function expectShown(classes: string[]): void {
      for (const cls of REVEAL_CLASSES) expect(classes).not.toContain(cls);
    }

    // The timestamp and the thumbs beside it always show; the label and
    // trailing actions fade. The row itself never fades, so it never changes
    // height.
    function expectHoverOnly(parts: FooterParts): void {
      expectShown(parts.row);
      expectShown(parts.stamp);
      expect(parts.stamp.length).toBeGreaterThan(0);
      expectShown(parts.pinned);
      expect(parts.pinned.length).toBeGreaterThan(0);
      expectFaded(parts.label);
      expectFaded(parts.trailing);
    }

    function expectAllShown(parts: FooterParts): void {
      expectShown(parts.row);
      expectShown(parts.stamp);
      expectShown(parts.label);
      expectShown(parts.trailing);
      expectShown(parts.pinned);
    }

    it('keeps the timestamp and thumbs visible when the completion status is omitted', () => {
      expectHoverOnly(footerParts(fullTimer({ finishedAt: 60_000 })));
    });

    it('keeps the timestamp and thumbs visible when the status is explicitly complete', () => {
      expectHoverOnly(
        footerParts(
          fullTimer({ finishedAt: 60_000, completionStatus: 'complete' }),
        ),
      );
    });

    it('fades the label without a stamp accessory too', () => {
      const parts = footerParts(
        <TurnTimer
          startedAt={0}
          finishedAt={60_000}
          trailing={<b data-testid="trailing">fork</b>}
        />,
      );
      expectShown(parts.row);
      expectShown(parts.stamp);
      expectFaded(parts.label);
      expectFaded(parts.trailing);
    });

    it('renders the stamp accessory right after the timestamp', () => {
      const { container, root } = renderTimer(
        fullTimer({ finishedAt: 60_000 }),
      );
      try {
        const row = container.querySelector('[data-testid="turn-timer"]');
        const children = Array.from(row?.children ?? []);
        expect(children[0]?.getAttribute('data-testid')).toBe(
          'turn-timer-relative',
        );
        expect(children[1]?.getAttribute('data-testid')).toBe(
          'turn-timer-stamp-accessory',
        );
        expect(
          children[1]?.querySelector('[data-testid="pinned"]'),
        ).not.toBeNull();
        expect(children[2]?.getAttribute('data-testid')).toBe(
          'turn-timer-label',
        );
      } finally {
        act(() => root.unmount());
      }
    });

    it.each([
      [false, 'mb-5'],
      [true, 'mb-3'],
    ] as const)(
      'with hostTurnGap=%s leaves a %s gap below the row',
      (hostTurnGap, expected) => {
        const { container, root } = renderTimer(
          <TurnTimer
            startedAt={1_000}
            finishedAt={60_000}
            hostTurnGap={hostTurnGap}
          />,
        );
        try {
          const classes =
            container
              .querySelector('[data-testid="turn-timer"]')
              ?.className.split(/\s+/) ?? [];
          expect(classes).toContain(expected);
          expect(classes).not.toContain(expected === 'mb-5' ? 'mb-3' : 'mb-5');
        } finally {
          act(() => root.unmount());
        }
      },
    );

    it.each(['timer', 'actions'] as const)(
      'gives every control in a %s footer row the thumbs icon treatment',
      (variant) => {
        const { container, root } = renderTimer(
          variant === 'timer' ? (
            <TurnTimer
              startedAt={1_000}
              finishedAt={60_000}
              trailing={<button type="button">Fork</button>}
            />
          ) : (
            <TurnFooterRow variant="actions" data-testid="turn-timer">
              <button type="button">Fork</button>
            </TurnFooterRow>
          ),
        );
        try {
          // One shared reset on the row, so a new action cannot drift from
          // the thumbs (CAN-4278).
          const classes =
            container
              .querySelector('[data-testid="turn-timer"]')
              ?.className.split(/\s+/) ?? [];
          for (const token of [
            '[&_button:not([aria-pressed=true]):not([data-attention])]:fg-quaternary',
            '[&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):hover]:fg-secondary',
            '[&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):hover:not(:active)]:bg-fg-primary/[0.04]',
            '[&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):active]:bg-fg-primary/[0.08]',
            '[&_button:not([aria-pressed=true]):not([data-attention])]:border-0',
            '[&_button:not([aria-pressed=true]):not([data-attention])]:bg-transparent',
            'pointer-fine:[&_button:not([data-attention])]:size-5',
          ])
            expect(classes).toContain(token);
        } finally {
          act(() => root.unmount());
        }
      },
    );

    it('marks the row while React reports focus inside it', () => {
      const { container, root } = renderTimer(
        fullTimer({
          finishedAt: 60_000,
          stampAccessory: <button data-testid="pinned">rate</button>,
        }),
      );
      try {
        const row = container.querySelector('[data-testid="turn-timer"]');
        expect(classesOf(row)).toContain('group/footer');
        expect(row?.hasAttribute('data-focus-within')).toBe(false);
        const button = container.querySelector('button');
        act(() => button?.focus());
        expect(row?.hasAttribute('data-focus-within')).toBe(true);
        act(() => button?.blur());
        expect(row?.hasAttribute('data-focus-within')).toBe(false);
      } finally {
        act(() => root.unmount());
      }
    });

    it('keeps failed and cancelled rows visible', () => {
      expectAllShown(
        footerParts(
          fullTimer({ finishedAt: 60_000, completionStatus: 'failed' }),
        ),
      );
      expectAllShown(
        footerParts(
          fullTimer({ finishedAt: 60_000, completionStatus: 'cancelled' }),
        ),
      );
    });

    it('keeps pending, live, and paused rows visible', () => {
      expectShown(footerParts(<TurnTimer />).label);
      expectAllShown(footerParts(fullTimer({ startedAt: 5_000 })));
      expectAllShown(
        footerParts(fullTimer({ startedAt: 5_000, pausedAt: 8_000 })),
      );
    });

    it('keeps the whole row visible when alwaysVisible is set', () => {
      expectAllShown(
        footerParts(fullTimer({ finishedAt: 60_000, alwaysVisible: true })),
      );
    });

    it('reapplies the policy when the turn changes state', () => {
      const { container, root } = renderTimer(fullTimer());
      try {
        expectAllShown(readParts(container));
        act(() => {
          root.render(
            <ChatLookProvider value="classic">
              {fullTimer({ finishedAt: 60_000 })}
            </ChatLookProvider>,
          );
        });
        expectHoverOnly(readParts(container));
        act(() => {
          root.render(
            <ChatLookProvider value="classic">
              {fullTimer({ finishedAt: 60_000, completionStatus: 'failed' })}
            </ChatLookProvider>,
          );
        });
        expectAllShown(readParts(container));
        act(() => {
          root.render(
            <ChatLookProvider value="classic">
              {fullTimer({ finishedAt: 60_000, completionStatus: 'cancelled' })}
            </ChatLookProvider>,
          );
        });
        expectAllShown(readParts(container));
      } finally {
        act(() => {
          root.unmount();
        });
      }
    });
  });

  it('renders no relative timestamp while live or paused', () => {
    const liveTimer = renderTimer(<TurnTimer startedAt={5_000} />);
    const pausedTimer = renderTimer(
      <TurnTimer startedAt={5_000} pausedAt={8_000} />,
    );

    try {
      expect(
        liveTimer.container.querySelector(
          '[data-testid="turn-timer-relative"]',
        ),
      ).toBeNull();
      expect(
        pausedTimer.container.querySelector(
          '[data-testid="turn-timer-relative"]',
        ),
      ).toBeNull();
    } finally {
      act(() => {
        liveTimer.root.unmount();
        pausedTimer.root.unmount();
      });
    }
  });

  it('shows the local completion time on hover when completed', () => {
    const finishedAt = 1_700_000_000_000;
    const { container, root } = renderTimer(
      <TurnTimer startedAt={finishedAt - 5_000} finishedAt={finishedAt} />,
    );

    try {
      const label = container.querySelector('[data-state="completed"] span');
      expect(label?.getAttribute('title')).toBe(
        `Completed at ${new Date(finishedAt).toLocaleString()}`,
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('omits the hover title while the turn is still working', () => {
    const { container, root } = renderTimer(<TurnTimer startedAt={5_000} />);

    try {
      const label = container.querySelector('[data-testid="turn-timer"] span');
      expect(label?.getAttribute('title')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('deducts accumulated and active paused time', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={1_000}
        pausedAt={12_000}
        accumulatedPausedDurationMs={4_000}
        isStreaming
      />,
    );

    try {
      expect(container.textContent).toBe('Waiting for you · 0:07');

      act(() => {
        jest.advanceTimersByTime(3_000);
      });

      expect(container.textContent).toBe('Waiting for you · 0:07');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders trailing actions while the timer is working', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={5_000}
        spinner={<span data-testid="spinner" />}
        trailing={<button type="button">Fork</button>}
      />,
    );

    try {
      expect(container.textContent).toContain('Working… 0:05');
      expect(container.textContent).toContain('Fork');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('omits the hours place below 60 minutes', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={0} finishedAt={3_599_000} />,
    );

    try {
      expect(
        container.querySelector('[data-testid="turn-timer-label"]')
          ?.textContent,
      ).toBe('Completed in 59:59');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows hours once elapsed time reaches 60 minutes', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={0} finishedAt={3_600_000} />,
    );

    try {
      expect(
        container.querySelector('[data-testid="turn-timer-label"]')
          ?.textContent,
      ).toBe('Completed in 1:00:00');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps minutes and seconds padded after the hours place appears', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={0} finishedAt={3_661_000} />,
    );

    try {
      expect(
        container.querySelector('[data-testid="turn-timer-label"]')
          ?.textContent,
      ).toBe('Completed in 1:01:01');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  // CAN-1521: an explicitly undefined `stampAccessory` renders nothing extra.
  it('renders identical markup when stampAccessory is omitted', () => {
    const withoutProp = renderTimer(
      <TurnTimer startedAt={0} finishedAt={60_000} trailing={<b>fork</b>} />,
    );
    const explicitUndefined = renderTimer(
      <TurnTimer
        startedAt={0}
        finishedAt={60_000}
        trailing={<b>fork</b>}
        stampAccessory={undefined}
      />,
    );

    try {
      expect(explicitUndefined.container.innerHTML).toBe(
        withoutProp.container.innerHTML,
      );
      expect(withoutProp.container.innerHTML).not.toContain('justify-between');
    } finally {
      act(() => {
        withoutProp.root.unmount();
        explicitUndefined.root.unmount();
      });
    }
  });

  it('keeps one row layout when stampAccessory is supplied', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={0}
        finishedAt={60_000}
        trailing={<b>fork</b>}
        stampAccessory={<i data-testid="pinned">rate</i>}
      />,
    );

    try {
      const row = container.querySelector<HTMLElement>(
        '[data-testid="turn-timer"]',
      );
      expect(row?.className).not.toContain('justify-between');
      expect(container.querySelector('[data-testid="pinned"]')).not.toBeNull();
      expect(container.textContent).toContain('Completed in 1:00');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('swaps the live Working label for the host status while streaming', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={0}
        isStreaming
        workingLabel="Compacting context…"
      />,
    );
    try {
      expect(container.textContent).toContain('Compacting context… 0:10');
      expect(container.textContent).not.toContain('Working…');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('ignores the working label once the turn completed', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={0}
        finishedAt={5_000}
        workingLabel="Compacting context…"
      />,
    );
    try {
      expect(container.textContent).toContain('Completed in 0:05');
      expect(container.textContent).not.toContain('Compacting');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('TurnTimer reply Copy (CAN-4704)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(120_000);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  function copies(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="turn-copy-message"]',
      ),
    );
  }

  it('keeps a historical clean reply row, Copy included, visible at rest', () => {
    const { container, root } = renderTimer(
      <ChatLookProvider value="clean">
        <TurnTimer
          startedAt={0}
          finishedAt={60_000}
          copyText="Done"
          trailing={<button>Fork</button>}
        />
      </ChatLookProvider>,
    );
    try {
      const [copy] = copies(container);
      if (!copy) throw new Error('copy missing');
      for (
        let node: HTMLElement | null = copy;
        node;
        node = node.parentElement
      ) {
        expect(node.className.split(/\s+/)).not.toContain('opacity-0');
      }
      // Clean chat look: the whole reply row stays in view, not only Copy.
      expect(
        container.querySelector('[data-testid="turn-actions-reveal"]')
          ?.className,
      ).not.toContain('opacity-0');
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows one Copy on a finished classic reply, outside the hover reveal', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={0}
        finishedAt={60_000}
        copyText={'# Done\n\n- **one**'}
        stampAccessory={<button type="button">Thumbs</button>}
        trailing={<button type="button">Fork</button>}
      />,
    );
    try {
      const [copy, ...rest] = copies(container);
      expect(rest).toHaveLength(0);
      if (!copy) throw new Error('copy missing');
      expect(copy.getAttribute('aria-label')).toBe('Copy message');
      // Every ancestor up to the row stays at full opacity at rest.
      const row = container.querySelector('[data-testid="turn-timer"]');
      for (
        let node: HTMLElement | null = copy;
        node && node !== row;
        node = node.parentElement
      ) {
        expect(node.className).not.toContain('opacity-0');
      }
      // Between the completion stamp and the thumbs.
      const relative = container.querySelector(
        '[data-testid="turn-timer-relative"]',
      );
      const thumbs = container.querySelector(
        '[data-testid="turn-timer-stamp-accessory"]',
      );
      if (!relative || !thumbs) throw new Error('row parts missing');
      expect(
        relative.compareDocumentPosition(copy) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        copy.compareDocumentPosition(thumbs) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });

  it('offers no Copy while the turn runs or when the reply has no text', () => {
    for (const props of [
      { startedAt: 0, copyText: 'Working on it' },
      { startedAt: 0, pausedAt: 1000, copyText: 'Paused reply' },
      {
        startedAt: 0,
        pausedAt: 1000,
        isStreaming: true,
        copyText: 'Paused reply',
      },
      { startedAt: 0, finishedAt: 60_000, copyText: ' \n\t ' },
      { startedAt: 0, finishedAt: 60_000 },
    ] satisfies TurnTimerProps[]) {
      const { container, root } = renderTimer(<TurnTimer {...props} />);
      try {
        expect(copies(container)).toHaveLength(0);
      } finally {
        act(() => root.unmount());
      }
    }
  });

  it('adds Copy once a running turn finishes, with the final reply', async () => {
    const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container, root } = renderTimer(
      <TurnTimer startedAt={0} copyText="Part" />,
    );
    try {
      expect(copies(container)).toHaveLength(0);
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer startedAt={0} finishedAt={60_000} copyText="  Final  " />
          </ChatLookProvider>,
        );
      });
      const [copy] = copies(container);
      if (!copy) throw new Error('copy missing');
      await act(async () => {
        copy.click();
        await Promise.resolve();
      });
      // Trimming only decides whether to show Copy; the text copies as is.
      expect(writeText).toHaveBeenCalledWith('  Final  ');
      expect(copy.getAttribute('aria-label')).toBe('Copied');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('TurnTimer waiting for the user (CAN-4996)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  function stateOf(container: HTMLElement): string | null | undefined {
    return container
      .querySelector('[data-testid="turn-timer"]')
      ?.getAttribute('data-state');
  }

  it('pauses in the render the host starts waiting, with no working visuals', () => {
    const spinner = <span data-testid="spinner" />;
    const { container, root } = renderTimer(
      <TurnTimer startedAt={5_000} spinner={spinner} />,
    );
    try {
      expect(container.textContent).toBe('Working… 0:05');
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer startedAt={5_000} spinner={spinner} waitingForUser />
          </ChatLookProvider>,
        );
      });
      expect(container.textContent).toBe('Waiting for you · 0:05');
      expect(stateOf(container)).toBe('paused');
      expect(container.querySelector('[data-testid="spinner"]')).toBeNull();

      act(() => {
        jest.advanceTimersByTime(3_000);
      });
      expect(container.textContent).toBe('Waiting for you · 0:05');
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the wait boundary across rerenders and reconciles the committed pause', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={5_000} waitingForUser />,
    );
    try {
      expect(container.textContent).toBe('Waiting for you · 0:05');
      for (let step = 0; step < 4; step += 1) {
        act(() => {
          jest.advanceTimersByTime(2_000);
        });
        // A replaced timer object, with and without a pause total.
        act(() => {
          root.render(
            <ChatLookProvider value="classic">
              <TurnTimer
                startedAt={5_000}
                waitingForUser
                {...(step % 2 === 0 ? { accumulatedPausedDurationMs: 0 } : {})}
              />
            </ChatLookProvider>,
          );
        });
        expect(container.textContent).toBe('Waiting for you · 0:05');
      }

      // The canonical pause opened at the wait's boundary arrives late.
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer
              startedAt={5_000}
              pausedAt={10_000}
              accumulatedPausedDurationMs={0}
              waitingForUser
            />
          </ChatLookProvider>,
        );
      });
      expect(container.textContent).toBe('Waiting for you · 0:05');

      // Answered at 18s: the 8s wait is subtracted once.
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer
              startedAt={5_000}
              pausedAt={10_000}
              resumedAt={18_000}
              accumulatedPausedDurationMs={8_000}
            />
          </ChatLookProvider>,
        );
      });
      act(() => {
        jest.advanceTimersByTime(2_000);
      });
      expect(container.textContent).toBe('Working… 0:07');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([undefined, 8_000])(
    'reconciles a closed pause arriving during a host-only wait (total %s)',
    (accumulatedPausedDurationMs) => {
      const { container, root } = renderTimer(
        <TurnTimer startedAt={5_000} waitingForUser />,
      );
      try {
        expect(container.textContent).toBe('Waiting for you · 0:05');
        act(() => jest.advanceTimersByTime(8_000));
        const timing = {
          startedAt: 5_000,
          pausedAt: 10_000,
          resumedAt: 18_000,
          accumulatedPausedDurationMs,
        };
        // The open pause was never rendered; its closed interval arrives
        // before the pending-approval flag clears.
        act(() =>
          root.render(
            <ChatLookProvider value="classic">
              <TurnTimer {...timing} waitingForUser />
            </ChatLookProvider>,
          ),
        );
        expect(container.textContent).toBe('Waiting for you · 0:05');
        act(() => jest.advanceTimersByTime(2_000));
        act(() =>
          root.render(
            <ChatLookProvider value="classic">
              <TurnTimer {...timing} waitingForUser />
            </ChatLookProvider>,
          ),
        );
        expect(container.textContent).toBe('Waiting for you · 0:05');
        act(() =>
          root.render(
            <ChatLookProvider value="classic">
              <TurnTimer {...timing} />
            </ChatLookProvider>,
          ),
        );
        expect(container.textContent).toBe('Working… 0:07');
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('keeps a recorded pause when the host has nothing waiting', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={5_000} pausedAt={8_000} waitingForUser={false} />,
    );
    try {
      expect(container.textContent).toBe('Waiting for you · 0:03');
      expect(stateOf(container)).toBe('paused');
    } finally {
      act(() => root.unmount());
    }
  });

  it('lets a finished turn win over a stale waiting flag', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={5_000}
        finishedAt={9_000}
        waitingForUser
        isStreaming
      />,
    );
    try {
      expect(container.textContent).toContain('Completed in 0:04');
      expect(stateOf(container)).toBe('completed');
    } finally {
      act(() => root.unmount());
    }
  });

  it('says only that it is waiting without a start time', () => {
    const { container, root } = renderTimer(<TurnTimer waitingForUser />);
    try {
      expect(container.textContent).toBe('Waiting for you');
      expect(container.textContent).not.toContain('NaN');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    { startedAt: NaN },
    { startedAt: Infinity },
    { startedAt: 5_000, pausedAt: NaN },
    { startedAt: 5_000, accumulatedPausedDurationMs: NaN },
  ])('omits unavailable elapsed time for invalid timestamps: %j', (props) => {
    const { container, root } = renderTimer(
      <TurnTimer {...props} waitingForUser />,
    );
    try {
      expect(container.textContent).toBe('Waiting for you');
    } finally {
      act(() => root.unmount());
    }
  });

  it('reconciles an earlier canonical boundary and remounts without resetting', () => {
    const props = { startedAt: 5_000, waitingForUser: true };
    const { container, root } = renderTimer(<TurnTimer {...props} />);
    try {
      expect(container.textContent).toBe('Waiting for you · 0:05');
      act(() => jest.advanceTimersByTime(4_000));
      const canonical = { ...props, pausedAt: 9_000 };
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer {...canonical} />
          </ChatLookProvider>,
        ),
      );
      // Authoritative timing corrects the provisional display by one second.
      expect(container.textContent).toBe('Waiting for you · 0:04');
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer key="remounted" {...canonical} />
          </ChatLookProvider>,
        ),
      );
      expect(container.textContent).toBe('Waiting for you · 0:04');
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer
              key="remounted"
              {...canonical}
              resumedAt={14_000}
              accumulatedPausedDurationMs={5_000}
            />
          </ChatLookProvider>,
        ),
      );
      act(() => jest.advanceTimersByTime(2_000));
      expect(container.textContent).toBe('Waiting for you · 0:04');
      act(() =>
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer
              key="remounted"
              startedAt={5_000}
              pausedAt={9_000}
              resumedAt={14_000}
              accumulatedPausedDurationMs={5_000}
            />
          </ChatLookProvider>,
        ),
      );
      expect(container.textContent).toBe('Working… 0:06');
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps one start and exact active time through three approvals', () => {
    jest.setSystemTime(1_000);
    const startedAt = 1_000;
    const { container, root } = renderTimer(
      <TurnTimer startedAt={startedAt} />,
    );
    const show = (props: Partial<TurnTimerProps>): void => {
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer startedAt={startedAt} {...props} />
          </ChatLookProvider>,
        );
      });
    };
    const advance = (ms: number): void => {
      act(() => {
        jest.advanceTimersByTime(ms);
      });
    };
    try {
      let accumulated = 0;
      const activeMs = [2_000, 3_000, 1_000, 2_000];
      const waitMs = [5_000, 4_000, 10_000];
      let activeTotal = 0;
      for (let step = 0; step < waitMs.length; step += 1) {
        advance(activeMs[step]);
        activeTotal += activeMs[step];
        const shown = `0:0${activeTotal / 1000}`;
        expect(container.textContent).toBe(`Working… ${shown}`);

        // The card appears before the committed pause, then with it.
        show({
          accumulatedPausedDurationMs: accumulated,
          waitingForUser: true,
        });
        expect(container.textContent).toBe(`Waiting for you · ${shown}`);
        const pausedAt = Date.now();
        show({
          pausedAt,
          accumulatedPausedDurationMs: accumulated,
          waitingForUser: true,
        });
        advance(waitMs[step]);
        expect(container.textContent).toBe(`Waiting for you · ${shown}`);

        // Answered: the committed resume closes the wait.
        accumulated += waitMs[step];
        show({
          pausedAt,
          resumedAt: Date.now(),
          accumulatedPausedDurationMs: accumulated,
        });
        expect(container.textContent).toBe(`Working… ${shown}`);
      }
      advance(activeMs[3]);
      activeTotal += activeMs[3];
      show({
        accumulatedPausedDurationMs: accumulated,
        finishedAt: Date.now(),
      });
      expect(activeTotal).toBe(8_000);
      expect(container.textContent).toContain('Completed in 0:08');
    } finally {
      act(() => root.unmount());
    }
  });

  it('stays paused until both the host wait and the recorded pause clear', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={5_000} pausedAt={8_000} waitingForUser />,
    );
    try {
      expect(container.textContent).toBe('Waiting for you · 0:03');
      // The host wait clears; another owner keeps the turn paused.
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer startedAt={5_000} pausedAt={8_000} />
          </ChatLookProvider>,
        );
      });
      expect(stateOf(container)).toBe('paused');
      expect(container.textContent).toBe('Waiting for you · 0:03');

      // The recorded pause closes while another request still waits.
      act(() => {
        jest.advanceTimersByTime(2_000);
      });
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer
              startedAt={5_000}
              pausedAt={8_000}
              resumedAt={12_000}
              accumulatedPausedDurationMs={4_000}
              waitingForUser
            />
          </ChatLookProvider>,
        );
      });
      expect(stateOf(container)).toBe('paused');
      act(() => {
        jest.advanceTimersByTime(3_000);
      });
      expect(container.textContent).toBe('Waiting for you · 0:03');
    } finally {
      act(() => root.unmount());
    }
  });

  it('restarts the wait boundary for a new turn', () => {
    const { container, root } = renderTimer(
      <TurnTimer startedAt={5_000} waitingForUser />,
    );
    try {
      expect(container.textContent).toBe('Waiting for you · 0:05');
      act(() => {
        jest.advanceTimersByTime(4_000);
      });
      act(() => {
        root.render(
          <ChatLookProvider value="classic">
            <TurnTimer startedAt={12_000} waitingForUser />
          </ChatLookProvider>,
        );
      });
      expect(container.textContent).toBe('Waiting for you · 0:02');
    } finally {
      act(() => root.unmount());
    }
  });

  it('drops the clean live line for host and recorded pauses', () => {
    const liveLine = <span data-testid="live-line">Thinking</span>;
    for (const props of [
      { waitingForUser: true },
      { pausedAt: 8_000 },
    ] satisfies Partial<TurnTimerProps>[]) {
      const { container, root } = renderTimer(
        <ChatLookProvider value="clean">
          <TurnTimer startedAt={5_000} liveLine={liveLine} {...props} />
        </ChatLookProvider>,
      );
      try {
        expect(stateOf(container)).toBe('paused');
        expect(container.querySelector('[data-testid="live-line"]')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    }
  });
});

describe('TurnTimer interrupted turn (CAN-5178)', () => {
  function label(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="turn-timer-label"]',
    );
  }

  it('says "Interrupted after", visible at rest, titled with the time', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={1_000}
        finishedAt={15_000}
        completionStatus="interrupted"
      />,
    );
    try {
      const shown = label(container);
      expect(shown?.textContent).toBe('Interrupted after 0:14');
      expect(shown?.className.split(/\s+/)).not.toContain('opacity-0');
      expect(shown?.title).toBe(
        `Interrupted at ${new Date(15_000).toLocaleString()}`,
      );
      expect(container.textContent).not.toContain('Completed');
    } finally {
      act(() => root.unmount());
    }
  });

  it('says "Interrupted" without inventing a duration', () => {
    const { container, root } = renderTimer(
      <TurnTimer finishedAt={15_000} completionStatus="interrupted" />,
    );
    try {
      expect(label(container)?.textContent).toBe('Interrupted');
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps a zero-length interrupted turn’s duration', () => {
    const { container, root } = renderTimer(
      <TurnTimer
        startedAt={15_000}
        finishedAt={15_000}
        completionStatus="interrupted"
      />,
    );
    try {
      expect(label(container)?.textContent).toBe('Interrupted after 0:00');
    } finally {
      act(() => root.unmount());
    }
  });
});
