/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPLAY_MASK_CLASS } from '../../../lib/replay-privacy';
import { QueuedMessageBubble } from '../QueuedMessageBubble';
import {
  QUEUED_MESSAGE_ANNOUNCEMENT_CLEAR_MS,
  QUEUED_MESSAGE_ANNOUNCEMENT_DELAY_MS,
  QueuedMessageAnnouncer,
} from '../QueuedMessageAnnouncer';
import {
  QUEUED_MESSAGE_SETUP_PROMISE,
  QueuedMessageReason,
  queuedMessageSendingAnnouncement,
  queuedMessageSetupAnnouncement,
  queuedMessageSetupSentence,
} from '../QueuedMessageReason';
import {
  QueuedMessageRow,
  QUEUED_MESSAGE_SETUP_TOOLTIP,
} from '../QueuedMessageRow';
import { setupTickerStateForTests } from '../QueuedMessageSetupClock';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('queued setup copy', () => {
  it('names the project, falling back when it is blank', () => {
    expect(queuedMessageSetupSentence('canopy')).toBe(
      "Setting up this chat's copy of canopy.",
    );
    expect(queuedMessageSetupSentence('  ')).toBe(
      "Setting up this chat's copy of the project.",
    );
    expect(queuedMessageSetupSentence(undefined)).toBe(
      "Setting up this chat's copy of the project.",
    );
    expect(QUEUED_MESSAGE_SETUP_PROMISE).toBe(
      "Your message will send automatically when it's ready.",
    );
    expect(QUEUED_MESSAGE_SETUP_TOOLTIP).toBe('Available when setup finishes');
  });

  it('announces the queued reason and sending', () => {
    expect(queuedMessageSetupAnnouncement('canopy')).toBe(
      "Queued. Setting up this chat's copy of canopy. Your message will send automatically when it's ready.",
    );
    expect(queuedMessageSendingAnnouncement(1)).toBe('Sending your message.');
    expect(queuedMessageSendingAnnouncement(3)).toBe('Sending your messages.');
  });
});

describe('QueuedMessageReason setup', () => {
  it('puts the sentence and promise first, then the spinner and clock', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageReason
        setup={{ projectName: 'canopy', startedAtMs: 0 }}
        nowMs={12_000}
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const reason = host.querySelector(
      '[data-testid="queued-message-setup-reason"]',
    );
    expect(reason?.getAttribute('data-layout')).toBe('stack');
    expect(reason?.className).toBe('mb-1 text-xs fg-secondary');
    const prose = reason?.children[0];
    expect(prose?.textContent).toBe(
      `${queuedMessageSetupSentence('canopy')} ${QUEUED_MESSAGE_SETUP_PROMISE}`,
    );
    // The name is masked from session replay.
    expect(prose?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'canopy',
    );
    // The spinner is text-free and decorative; the clock row holds no prose.
    const clockRow = reason?.children[1];
    const clock = clockRow?.querySelector(
      '[data-testid="queued-message-setup-clock"]',
    );
    expect(clockRow?.textContent).toBe(clock?.textContent);
    expect(clock?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      '0:12 elapsed',
    );
    expect(clock?.className).toContain('tabular-nums');
    expect(host.querySelector('[aria-label="Loading"]')).toBeNull();
  });

  it('shows an estimate on the clock row when one is given', () => {
    const html = renderToStaticMarkup(
      <QueuedMessageReason
        setup={{ startedAtMs: 0, estimateMs: 25_000 }}
        nowMs={10_000}
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const reason = host.querySelector(
      '[data-testid="queued-message-setup-reason"]',
    );
    expect(reason?.children[0]?.textContent).toBe(
      `Setting up this chat's copy of the project. ${QUEUED_MESSAGE_SETUP_PROMISE}`,
    );
    const clockRow = reason?.children[1];
    const clock = clockRow?.querySelector(
      '[data-testid="queued-message-setup-clock"]',
    );
    expect(clockRow?.textContent).toBe(clock?.textContent);
    expect(clock?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'about 0:15 left',
    );
  });

  it('keeps the bubble reason order: free text, setup, then waiting reason', () => {
    const setup = { startedAtMs: 0 };
    const withSetup = renderToStaticMarkup(
      <QueuedMessageBubble
        message={{
          id: 'q',
          text: 'queued',
          setup,
          waitingReason: 'steer_unavailable',
        }}
        clockNowMs={5_000}
      />,
    );
    expect(withSetup).toContain('data-testid="queued-message-setup-reason"');
    expect(withSetup).not.toContain('queued-message-waiting-reason');
    expect(withSetup).toContain(
      '<div class="mb-1 text-xs fg-secondary">Queued</div>',
    );

    const withText = renderToStaticMarkup(
      <QueuedMessageBubble
        message={{ id: 'q', text: 'queued', reason: 'Held.', setup }}
        clockNowMs={5_000}
      />,
    );
    expect(withText).not.toContain('queued-message-setup-reason');
    expect(withText).toContain('Held.');
  });
});

describe('QueuedMessageBubble setup quote', () => {
  const setup = { projectName: 'canopy', startedAtMs: 0 };

  function renderBubble(
    message: Parameters<typeof QueuedMessageBubble>[0]['message'],
  ): HTMLDivElement {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <QueuedMessageBubble message={message} clockNowMs={5_000} />,
    );
    return host;
  }

  function quoteOf(host: HTMLElement): Element | null {
    return host.querySelector('[data-testid="queued-message-setup-quote"]');
  }

  it('quotes the message right after the setup reason', () => {
    const host = renderBubble({ id: 'q', text: 'queued', setup });
    const reason = host.querySelector(
      '[data-testid="queued-message-setup-reason"]',
    );
    const quote = quoteOf(host);
    expect(quote).not.toBeNull();
    expect(reason?.nextElementSibling).toBe(quote);
    expect(quote?.querySelector('p')?.textContent).toBe('queued');
    expect(quote?.querySelector('.break-words')).not.toBeNull();
  });

  it('keeps every paragraph inside the quote', () => {
    const host = renderBubble({
      id: 'q',
      text: 'First paragraph.\n\nSecond paragraph.',
      setup,
    });
    const quote = quoteOf(host);
    const paragraphs = Array.from(host.querySelectorAll('p'));
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      'First paragraph.',
      'Second paragraph.',
    ]);
    expect(paragraphs.every((p) => quote?.contains(p))).toBe(true);
  });

  it('does not quote a free-text or host waiting reason', () => {
    expect(
      quoteOf(
        renderBubble({ id: 'q', text: 'queued', reason: 'Held.', setup }),
      ),
    ).toBeNull();
    expect(
      quoteOf(
        renderBubble({
          id: 'q',
          text: 'queued',
          waitingReason: 'steer_unavailable',
        }),
      ),
    ).toBeNull();
  });

  it('quotes exactly when the setup reason renders', () => {
    const host = renderBubble({
      id: 'q',
      text: 'queued',
      setup,
      waitingReason: 'steer_unavailable',
    });
    const hasReason =
      host.querySelector('[data-testid="queued-message-setup-reason"]') !==
      null;
    expect(quoteOf(host) !== null).toBe(hasReason);
  });

  it('leaves a plain queued body unwrapped', () => {
    const host = renderBubble({ id: 'q', text: 'queued' });
    expect(quoteOf(host)).toBeNull();
    const body = host.querySelector('.break-words');
    expect(body?.outerHTML).toBe(
      '<div class="break-words"><p class="whitespace-pre-wrap">queued</p></div>',
    );
    expect(body?.parentElement?.querySelector(':scope > .break-words')).toBe(
      body,
    );
  });
});

describe('QueuedMessageReason inline', () => {
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

  it('shortens the visible status and keeps the full text for assistive technology', () => {
    const longName = 'a-very-long-project-name-'.repeat(8);
    act(() =>
      root.render(
        <div style={{ width: 240 }}>
          <QueuedMessageRow
            text="queued"
            status={
              <QueuedMessageReason
                setup={{ projectName: longName, startedAtMs: 0 }}
                layout="inline"
                nowMs={65_000}
              />
            }
          />
        </div>,
      ),
    );
    const reason = container.querySelector(
      '[data-testid="queued-message-setup-reason"]',
    );
    expect(reason?.getAttribute('data-layout')).toBe('inline');
    expect(reason?.className).toContain('fg-secondary');
    expect(reason?.getAttribute('tabindex')).toBe('0');
    const visible = Array.from(
      reason?.querySelectorAll('[aria-hidden="true"]') ?? [],
    ).map((node) => node.textContent);
    expect(visible).toContain("Setting up this chat's copy");
    expect(visible).toContain('1:05 elapsed');
    // Only the descriptive words truncate; the spinner and clock keep their size.
    expect(reason?.querySelector('.truncate')?.textContent).toBe(
      "Setting up this chat's copy",
    );
    expect(
      reason?.querySelector('[data-testid="queued-message-setup-clock"]')
        ?.className,
    ).toContain('shrink-0');
    const hidden = reason?.querySelector(
      '[data-testid="queued-message-setup-full-text"]',
    );
    expect(hidden?.textContent).toBe(
      `Setting up this chat's copy of ${longName}. ${QUEUED_MESSAGE_SETUP_PROMISE}`,
    );
    expect(hidden?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      longName,
    );
    expect(setupTickerStateForTests().running).toBe(false);
  });
});

describe('QueuedMessageAnnouncer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function region(): HTMLElement | null {
    return container.querySelector('[data-testid="queued-message-announcer"]');
  }

  it('stays mounted and empty while idle', () => {
    act(() => root.render(<QueuedMessageAnnouncer announcement={null} />));
    expect(region()?.getAttribute('role')).toBe('status');
    expect(region()?.getAttribute('aria-live')).toBe('polite');
    expect(region()?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    expect(region()?.textContent).toBe('');
  });

  it('fills the region after it exists and clears it after four seconds', () => {
    act(() => root.render(<QueuedMessageAnnouncer announcement={null} />));
    act(() =>
      root.render(
        <QueuedMessageAnnouncer
          announcement={{ id: 1, text: 'Sending your message.' }}
        />,
      ),
    );
    expect(region()?.textContent).toBe('');
    act(() => jest.advanceTimersByTime(QUEUED_MESSAGE_ANNOUNCEMENT_DELAY_MS));
    expect(region()?.textContent).toBe('Sending your message.');
    act(() => jest.advanceTimersByTime(QUEUED_MESSAGE_ANNOUNCEMENT_CLEAR_MS));
    expect(region()?.textContent).toBe('');
    expect(region()).not.toBeNull();
  });

  it('repeats an identical announcement and cancels the stale clear', () => {
    const first = { id: 1, text: 'Sending your message.' };
    act(() => root.render(<QueuedMessageAnnouncer announcement={first} />));
    act(() => jest.advanceTimersByTime(3_000));
    act(() =>
      root.render(
        <QueuedMessageAnnouncer
          announcement={{ id: 2, text: 'Sending your message.' }}
        />,
      ),
    );
    act(() => jest.advanceTimersByTime(0));
    expect(region()?.textContent).toBe('');
    act(() => jest.advanceTimersByTime(QUEUED_MESSAGE_ANNOUNCEMENT_DELAY_MS));
    expect(region()?.textContent).toBe('Sending your message.');
    // The first announcement's clear would have fired here.
    act(() => jest.advanceTimersByTime(1_500));
    expect(region()?.textContent).toBe('Sending your message.');
  });

  it('clears when the announcement is withdrawn', () => {
    act(() =>
      root.render(
        <QueuedMessageAnnouncer announcement={{ id: 1, text: 'Hello.' }} />,
      ),
    );
    act(() => jest.advanceTimersByTime(QUEUED_MESSAGE_ANNOUNCEMENT_DELAY_MS));
    act(() => root.render(<QueuedMessageAnnouncer announcement={null} />));
    act(() => jest.advanceTimersByTime(0));
    expect(region()?.textContent).toBe('');
  });
});
