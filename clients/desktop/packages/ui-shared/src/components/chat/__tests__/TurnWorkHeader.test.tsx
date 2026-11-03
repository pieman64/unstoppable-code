/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPLAY_MASK_CLASS } from '../../../lib/replay-privacy';
import {
  TURN_STARTING_LABEL,
  TurnWorkHeader,
  resolveTurnStartingStatus,
} from '../TurnWorkHeader';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');

describe('TurnWorkHeader setup status', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (node: ReactNode): void => {
    act(() => root.render(node));
  };
  const header = (): HTMLElement => {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="turn-starting-status"]',
    );
    if (!element) throw new Error('header not rendered');
    return element;
  };
  const status = (): Element | null =>
    container.querySelector('[role="status"]');
  const clock = (): Element | null =>
    container.querySelector('[data-turn-setup-clock]');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  it('renders plain starting unchanged', () => {
    const html = renderToStaticMarkup(
      <TurnWorkHeader starting dataTestId="turn-starting-status" />,
    );
    expect(html).toContain('data-turn-header="starting"');
    expect(html).toContain(TURN_STARTING_LABEL);
    expect(html).not.toContain('Setting up');
    expect(html).not.toContain('data-turn-setup-clock');
  });

  it('names the project in a masked span, with a silent clock', () => {
    render(
      <TurnWorkHeader
        starting
        setup={{ projectName: 'canopy', startedAtMs: NOW - 8_000 }}
        dataTestId="turn-starting-status"
      />,
    );
    expect(header().getAttribute('data-turn-header')).toBe('setup');
    expect(header().getAttribute('role')).toBeNull();
    expect(status()?.getAttribute('aria-live')).toBe('polite');
    expect(status()?.textContent).toBe("Setting up this chat's copy of canopy");
    expect(status()?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'canopy',
    );
    expect(clock()?.getAttribute('aria-hidden')).toBe('true');
    expect(clock()?.textContent).toBe(' · 0:08');
    expect(status()?.contains(clock())).toBe(false);
    expect(
      container.querySelector('[data-testid="turn-starting-spinner"]'),
    ).not.toBeNull();
    expect(header().innerHTML).not.toContain('border-b');
  });

  it('falls back to "the project" without a name', () => {
    render(
      <TurnWorkHeader
        starting
        setup={{ startedAtMs: NOW }}
        dataTestId="turn-starting-status"
      />,
    );
    expect(status()?.textContent).toBe(
      "Setting up this chat's copy of the project",
    );
  });

  it('ticks the clock each second', () => {
    render(
      <TurnWorkHeader
        starting
        setup={{ startedAtMs: NOW - 8_000 }}
        dataTestId="turn-starting-status"
      />,
    );
    expect(clock()?.textContent).toBe(' · 0:08');
    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(clock()?.textContent).toBe(' · 0:11');
  });

  it('keeps one status node from setup to "Starting…"', () => {
    render(
      <TurnWorkHeader
        starting
        setup={{ projectName: 'canopy', startedAtMs: NOW - 8_000 }}
        dataTestId="turn-starting-status"
      />,
    );
    const before = status();
    render(<TurnWorkHeader starting dataTestId="turn-starting-status" />);
    expect(status()).toBe(before);
    expect(status()?.textContent).toBe(TURN_STARTING_LABEL);
    expect(header().getAttribute('data-turn-header')).toBe('starting');
    expect(clock()).toBeNull();
  });
});

describe('resolveTurnStartingStatus', () => {
  const base = { starting: true, nowMs: NOW } as const;

  it('is null for a turn that is not starting', () => {
    expect(
      resolveTurnStartingStatus({
        ...base,
        starting: false,
        worktreeSetupPhase: 'git-pending',
      }),
    ).toBeNull();
  });

  it.each([undefined, null, 'ready', 'scripts-pending', 'failed'])(
    'reads plain starting for setup phase %p',
    (phase) => {
      expect(
        resolveTurnStartingStatus({ ...base, worktreeSetupPhase: phase }),
      ).toEqual({ kind: 'starting' });
    },
  );

  it('clocks git-pending from an ISO createdAt', () => {
    expect(
      resolveTurnStartingStatus({
        ...base,
        worktreeSetupPhase: 'git-pending',
        worktreeCreatedAt: new Date(NOW - 8_000).toISOString(),
        fallbackStartedAtMs: NOW - 2_000,
        projectName: 'canopy',
      }),
    ).toEqual({
      kind: 'setup',
      projectName: 'canopy',
      startedAtMs: NOW - 8_000,
    });
  });

  it('clocks git-pending from an epoch createdAt', () => {
    expect(
      resolveTurnStartingStatus({
        ...base,
        worktreeSetupPhase: 'git-pending',
        worktreeCreatedAt: NOW - 5_000,
      }),
    ).toEqual({ kind: 'setup', startedAtMs: NOW - 5_000 });
  });

  it('falls back to the message time without a usable createdAt', () => {
    expect(
      resolveTurnStartingStatus({
        ...base,
        worktreeSetupPhase: 'git-pending',
        worktreeCreatedAt: 'not a date',
        fallbackStartedAtMs: NOW - 3_000,
        projectName: '  ',
      }),
    ).toEqual({ kind: 'setup', startedAtMs: NOW - 3_000 });
  });

  it('counts a long wait before the message from createdAt', () => {
    expect(
      resolveTurnStartingStatus({
        ...base,
        worktreeSetupPhase: 'git-pending',
        worktreeCreatedAt: NOW - 240_000,
        fallbackStartedAtMs: NOW - 1_000,
      }),
    ).toEqual({ kind: 'setup', startedAtMs: NOW - 240_000 });
  });

  it('clamps a future origin to now', () => {
    expect(
      resolveTurnStartingStatus({
        ...base,
        worktreeSetupPhase: 'git-pending',
        worktreeCreatedAt: NOW + 60_000,
      }),
    ).toEqual({ kind: 'setup', startedAtMs: NOW });
  });
});
