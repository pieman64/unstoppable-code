/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';
import {
  ChatTabPreviewCard,
  formatChatTabPreviewElapsed,
  type ChatTabPreviewCardProps,
} from '../ChatTabPreviewCard';
import {
  ChatTabPreviewReplyTicker,
  REPLY_TICKER_FADE_KEYFRAMES,
} from '../ChatTabPreviewReplyTicker';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

describe('ChatTabPreviewCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function render(overrides: Partial<ChatTabPreviewCardProps> = {}): void {
    act(() =>
      root.render(
        <ChatTabPreviewCard
          prompt="Tighten the Feed sidebar spacing"
          replies={['I moved the check.', 'Tests pass.']}
          status={{ kind: 'finished', endedAt: NOW - 20_000 }}
          toolCount={2}
          {...overrides}
        />,
      ),
    );
  }

  const q = (testId: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${testId}"]`);
  const statusText = (): string =>
    q('chat-tab-preview-status')?.textContent ?? '';
  const glyphSize = (): string | null | undefined =>
    q('chat-tab-preview-status')?.querySelector('svg')?.getAttribute('width');
  /** The status glyph's slot: the worktree hover card's 16×18 icon slot. */
  const glyphSlot = (): Element | null | undefined =>
    q('chat-tab-preview-status')?.firstElementChild;
  const classes = (element: Element | null | undefined): string[] =>
    element?.getAttribute('class')?.split(' ') ?? [];

  it('shows the prompt in a one-line bubble, blocked from session replay', () => {
    render();
    const bubble = q('chat-tab-preview-prompt');
    expect(bubble?.textContent).toBe('Tighten the Feed sidebar spacing');
    expect(bubble?.className.split(' ')).toEqual(
      expect.arrayContaining([
        'truncate',
        'rounded-md',
        'bg-muted',
        'px-2',
        'py-1',
        'fg-primary',
        REPLAY_BLOCK_CLASS,
      ]),
    );
  });

  it('omits the bubble while the prompt is not known', () => {
    render({ prompt: null });
    expect(q('chat-tab-preview-prompt')).toBeNull();
    expect(q('chat-tab-preview-reply')).not.toBeNull();
  });

  it('shows the reply in secondary ink, blocked from session replay', () => {
    render();
    const reply = q('chat-tab-preview-reply');
    expect(reply?.className).toContain('fg-secondary');
    expect(reply?.querySelectorAll('p')).toHaveLength(2);
    expect(reply?.firstElementChild?.className).toContain(REPLAY_BLOCK_CLASS);
  });

  it('reads Working with a live timer and a 12px spinner centered in the slot', () => {
    render({ status: { kind: 'working', startedAt: NOW - 28_000 } });
    expect(statusText()).toBe('Working… 0:282 tools');
    const spinner = q('chat-tab-preview-spinner');
    expect(spinner).toBeInstanceOf(HTMLElement);
    expect(spinner?.style.width).toBe('12px');
    expect(glyphSlot()?.contains(spinner ?? null)).toBe(true);
    expect(classes(glyphSlot())).toEqual(
      expect.arrayContaining(['w-4', 'h-4.5', 'justify-center']),
    );
    act(() => jest.advanceTimersByTime(3_000));
    expect(statusText()).toContain('Working… 0:31');
  });

  it('reads Question waiting with a 14px attention glyph', () => {
    render({ status: { kind: 'waiting', reason: 'question' } });
    expect(statusText()).toBe('Question waiting2 tools');
    expect(glyphSize()).toBe('14px');
    expect(classes(glyphSlot())).toEqual(
      expect.arrayContaining(['w-4', 'h-4.5']),
    );
    expect(classes(glyphSlot()?.firstElementChild)).toContain('fg-attention');
  });

  it('names approvals and plan reviews as waiting too', () => {
    render({ status: { kind: 'waiting', reason: 'approval' } });
    expect(statusText()).toContain('Approval needed');
    render({ status: { kind: 'waiting', reason: 'plan' } });
    expect(statusText()).toContain('Plan waiting for review');
  });

  it('reads Stopped as plain quiet text: stopping is not an error', () => {
    render({ status: { kind: 'stopped', endedAt: NOW - 4 * 60_000 } });
    expect(statusText()).toBe('Stopped 4m ago2 tools');
    expect(q('chat-tab-preview-status')?.querySelector('svg')).toBeNull();
    expect(
      q('chat-tab-preview-status')?.querySelector('[class*="destructive"]'),
    ).toBeNull();
  });

  it('reads Failed with its age and a 14px circled X in the failed ink', () => {
    render({ status: { kind: 'failed', endedAt: NOW - 4 * 60_000 } });
    expect(statusText()).toBe('Failed 4m ago2 tools');
    expect(glyphSize()).toBe('14px');
    expect(glyphSlot()?.querySelector('svg')).toBeInstanceOf(SVGElement);
    expect(glyphSlot()?.querySelector('circle')).toBeInstanceOf(SVGElement);
    expect(classes(glyphSlot())).toEqual(
      expect.arrayContaining(['w-4', 'h-4.5']),
    );
    expect(classes(glyphSlot()?.firstElementChild)).toContain(
      'fg-destructive-strong',
    );
  });

  it('spaces the glyph 8px from its label in an 18px row, like the worktree card', () => {
    render({ status: { kind: 'finished', endedAt: NOW } });
    expect(classes(q('chat-tab-preview-status'))).toEqual(
      expect.arrayContaining(['gap-2', 'min-h-4.5']),
    );
  });

  it('reads Finished just now with no glyph', () => {
    render();
    expect(statusText()).toBe('Finished just now2 tools');
    expect(q('chat-tab-preview-status')?.querySelector('svg')).toBeNull();
    expect(q('chat-tab-preview-spinner')).toBeNull();
  });

  it('colors only the glyph: the row reads in tertiary ink', () => {
    render({ status: { kind: 'failed', endedAt: NOW } });
    const row = q('chat-tab-preview-status');
    expect(row?.className.split(' ')).toEqual(
      expect.arrayContaining(['text-2xs', 'fg-tertiary']),
    );
    const colored = row?.querySelectorAll(
      '.fg-destructive-strong, .fg-attention',
    );
    expect(colored).toHaveLength(1);
  });

  it('counts one tool in the singular and hides an unknown count', () => {
    render({ toolCount: 1 });
    expect(statusText()).toMatch(/1 tool$/);
    render({ toolCount: null });
    expect(statusText()).toBe('Finished just now');
  });

  it('hides a zero tool count', () => {
    render({ toolCount: 0 });
    expect(statusText()).toBe('Finished just now');
  });

  it('reserves no reply space when there is no reply', () => {
    for (const status of [
      { kind: 'finished', endedAt: NOW } as const,
      { kind: 'stopped', endedAt: NOW } as const,
      { kind: 'working', startedAt: NOW } as const,
    ]) {
      render({ prompt: 'hey', replies: [], status, toolCount: 0 });
      expect(q('chat-tab-preview-prompt')?.textContent).toBe('hey');
      expect(q('chat-tab-preview-reply')).toBeNull();
      expect(statusText()).not.toContain('tool');
    }
  });

  it('keeps text 12px from the top edge when there is no prompt bubble', () => {
    render({ prompt: null });
    expect(classes(q('chat-tab-preview'))).toContain('pt-2');
    render();
    expect(classes(q('chat-tab-preview'))).not.toContain('pt-2');
  });

  it('says No messages yet for an empty chat, with no reply or count', () => {
    render({ prompt: null, replies: [], status: { kind: 'empty' } });
    expect(statusText()).toBe('No messages yet');
    expect(q('chat-tab-preview-reply')).toBeNull();
  });

  it('formats elapsed time as minutes or hours', () => {
    expect(formatChatTabPreviewElapsed(28_000)).toBe('0:28');
    expect(formatChatTabPreviewElapsed(12 * 60_000 + 5_000)).toBe('12:05');
    expect(formatChatTabPreviewElapsed(3_729_000)).toBe('1:02:09');
    expect(formatChatTabPreviewElapsed(-5)).toBe('0:00');
  });
});

describe('ChatTabPreviewReplyTicker', () => {
  let container: HTMLDivElement;
  let root: Root;
  let height = 32;
  /** The window's own height: it grows with the text up to two lines. */
  let frameHeight = 32;
  let animate: jest.Mock<
    { cancel: () => void },
    [Keyframe[], KeyframeAnimationOptions]
  >;
  let reduceMotion = false;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    height = 32;
    frameHeight = 32;
    reduceMotion = false;
    animate = jest.fn<
      { cancel: () => void },
      [Keyframe[], KeyframeAnimationOptions]
    >(() => ({ cancel: (): void => undefined }));
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });
    jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'chat-tab-preview-reply'
          ? frameHeight
          : height;
      });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: reduceMotion && query.includes('reduce'),
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  });

  function show(messages: string[]): void {
    act(() => root.render(<ChatTabPreviewReplyTicker messages={messages} />));
  }

  it('rests with hard 8px bands: two whole lines, nothing faded', () => {
    show(['First line']);
    const frame = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-preview-reply"]',
    );
    expect(frame?.style.getPropertyValue('--ticker-top-clear')).toBe('8px');
    expect(frame?.style.getPropertyValue('--ticker-top-solid')).toBe('8px');
    expect(frame?.style.getPropertyValue('--ticker-bottom-solid')).toBe('8px');
    expect(frame?.style.marginTop).toBe('-8px');
    expect(frame?.style.marginBottom).toBe('-8px');
    expect(animate).not.toHaveBeenCalled();
  });

  it('sizes to the text up to two lines, so one line leaves no blank line', () => {
    show(['First line']);
    const frame = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-preview-reply"]',
    );
    expect(frame?.style.height).toBe('');
    expect(frame?.style.maxHeight).toBe('calc(2lh + 16px)');
    expect(frame?.style.paddingTop).toBe('8px');
    expect(frame?.style.paddingBottom).toBe('8px');
  });

  it('grows without sliding while the window takes in the new line', () => {
    show(['First line']);
    height = 48;
    frameHeight = 48;
    show(['First line', 'A new line']);
    expect(animate).not.toHaveBeenCalled();
  });

  it('slides earlier text up and softens both edges when text arrives', () => {
    show(['First line']);
    height = 48;
    show(['First line', 'A new line']);
    expect(animate).toHaveBeenCalledTimes(2);
    const [slideFrames, slideOptions] = animate.mock.calls[0];
    expect(slideFrames).toEqual([
      { transform: 'translateY(16px)' },
      { transform: 'translateY(0)' },
    ]);
    expect(slideOptions).toEqual({
      duration: 280,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    });
    const [fadeFrames] = animate.mock.calls[1];
    expect(fadeFrames).toBe(REPLY_TICKER_FADE_KEYFRAMES);
    expect(REPLY_TICKER_FADE_KEYFRAMES[1]).toMatchObject({
      '--ticker-top-clear': '0px',
      '--ticker-bottom-solid': '18px',
    });
    expect(REPLY_TICKER_FADE_KEYFRAMES.at(-1)).toMatchObject({
      '--ticker-top-clear': '8px',
      '--ticker-bottom-solid': '8px',
    });
  });

  it('interrupts a running slide instead of queueing another', () => {
    const cancel = jest.fn();
    animate.mockImplementation(() => ({ cancel }));
    show(['One']);
    height = 48;
    show(['One', 'Two']);
    height = 64;
    show(['One', 'Two', 'Three']);
    // The first slide and fade are cancelled when the next chunk lands.
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('skips the slide with reduced motion', () => {
    reduceMotion = true;
    show(['First line']);
    height = 48;
    show(['First line', 'A new line']);
    expect(animate).not.toHaveBeenCalled();
  });

  it('stacks messages with no gap so lines stay on the grid', () => {
    show(['One', '', 'Two']);
    const content = container.querySelector(
      '[data-testid="chat-tab-preview-reply"] > div',
    );
    expect(content?.className).not.toMatch(/\bgap-/);
    expect(content?.querySelectorAll('p')).toHaveLength(2);
  });
});
