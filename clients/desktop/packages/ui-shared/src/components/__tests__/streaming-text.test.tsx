/** @jest-environment jsdom */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Markdown,
  TRANSCRIPT_MARKDOWN_OPTIONS,
  withSoftLineBreaks,
} from '../Markdown';
import {
  preloadSmoothMarkdown,
  SmoothStreamingProvider,
} from '../streaming-text';
import {
  STREAMING_SOURCE_QUIET_MS,
  STREAMING_WORD_FADE_MS,
  useSmoothStreamingText,
} from '../streaming-text-pacing';

jest.mock('../markdown-mermaid-renderer', () => ({
  renderMermaid: jest.fn(() => new Promise<never>(() => undefined)),
}));

jest.mock('mdast-util-from-markdown', () => ({
  fromMarkdown: (): { children: never[] } => ({ children: [] }),
}));

const SENTENCE =
  'Another process is already listening on the port your dev server wants.';

let container: HTMLDivElement;
let root: Root;
let reducedMotion = false;

beforeAll(async () => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  await preloadSmoothMarkdown();
});

beforeEach(() => {
  jest.useFakeTimers();
  reducedMotion = false;
  window.matchMedia = (query: string): MediaQueryList => {
    const list = new EventTarget();
    return Object.assign(list, {
      matches: query.includes('reduce') && reducedMotion,
      media: query,
      onchange: null,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
    });
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function render(text: string, streaming: boolean, smooth = true): void {
  act(() => {
    root.render(
      <SmoothStreamingProvider value={smooth}>
        <Markdown streaming={streaming}>{text}</Markdown>
      </SmoothStreamingProvider>,
    );
  });
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** Steps the per-frame beat; jsdom runs animation frames on a 16ms timer. */
function frames(count: number): void {
  for (let index = 0; index < count; index += 1) advance(16);
}

const shownText = (): string => (container.textContent ?? '').trim();
const fadingSpans = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.stream-word-fade'));

describe('smooth streaming in Markdown', () => {
  it('shows each delta at once when the Labs choice is off', () => {
    render('Another process', true, false);
    expect(shownText()).toBe('Another process');
    expect(fadingSpans()).toHaveLength(0);
  });

  it('reveals a new reply in whole words on a steady beat', () => {
    render(SENTENCE, true);
    expect(shownText()).toBe('');
    const seen: string[] = [];
    for (let frame = 0; frame < 120 && shownText() !== SENTENCE; frame += 1) {
      frames(1);
      seen.push(shownText());
    }
    expect(shownText()).toBe(SENTENCE);
    // Several steps, each one ending on a whole word.
    const steps = Array.from(new Set(seen));
    expect(steps.length).toBeGreaterThan(4);
    for (const step of steps) {
      expect(SENTENCE.startsWith(step)).toBe(true);
      expect(SENTENCE[step.length] ?? ' ').toMatch(/\s/);
    }
  });

  it('holds back a half-arrived last word for a moment', () => {
    render('Another proc', true);
    frames(10);
    expect(shownText()).toBe('Another');
    frames(40);
    expect(shownText()).toBe('Another proc');
  });

  it('finishes revealing after the stream ends', () => {
    render(SENTENCE, true);
    frames(2);
    render(SENTENCE, false);
    frames(80);
    expect(shownText()).toBe(SENTENCE);
  });

  it('never paces or fades a reply that was already finished', () => {
    render(SENTENCE, false);
    expect(shownText()).toBe(SENTENCE);
    expect(fadingSpans()).toHaveLength(0);
  });

  it('fades each newly revealed stretch in one span, then shows plain text', () => {
    render(SENTENCE, true);
    let newest: HTMLElement | undefined;
    for (let frame = 0; frame < 120 && newest === undefined; frame += 1) {
      frames(1);
      newest = fadingSpans().at(-1);
    }
    expect(newest).toBeInstanceOf(HTMLElement);
    // Whole words, not single letters.
    expect(newest?.textContent).toMatch(/^\s*\S+/);
    // The next reveal keeps that span's element, so its fade runs only once.
    const before = shownText();
    for (let frame = 0; frame < 20 && shownText() === before; frame += 1) {
      frames(1);
    }
    expect(shownText().length).toBeGreaterThan(before.length);
    expect(fadingSpans()).toContain(newest);
    // Once the last stretch has faded, every span is plain text again.
    render(SENTENCE, false);
    frames(80);
    advance(STREAMING_WORD_FADE_MS + 40);
    expect(shownText()).toBe(SENTENCE);
    expect(fadingSpans()).toHaveLength(0);
    expect(container.querySelector('p')?.childNodes).toHaveLength(1);
  });

  it('hides half-typed markdown until it closes', () => {
    render('Use **port', true);
    frames(60);
    expect(shownText()).not.toContain('*');
    render('Use **port 5173** instead', true);
    frames(60);
    expect(container.querySelector('strong')?.textContent).toBe('port 5173');
  });

  it('leaves a block that was on screen before the switch turned on as it is', () => {
    render(SENTENCE, true, false);
    render(SENTENCE, true, true);
    expect(shownText()).toBe(SENTENCE);
    render(`${SENTENCE} More arrives.`, true, true);
    frames(30);
    expect(shownText()).toBe(`${SENTENCE} More arrives.`);
    expect(fadingSpans()).toHaveLength(0);
  });

  it('reveals under StrictMode, whose effect replay must not stall the beat', () => {
    act(() => {
      root.render(
        <StrictMode>
          <SmoothStreamingProvider value>
            <Markdown streaming>{SENTENCE}</Markdown>
          </SmoothStreamingProvider>
        </StrictMode>,
      );
    });
    frames(60);
    expect(shownText()).toBe(SENTENCE);
  });

  it('reveals text written without spaces while it streams', () => {
    const characters = '端口已经被另一个进程占用了请先停止旧的服务器再启动新的';
    for (let length = 1; length <= characters.length; length += 1) {
      render(characters.slice(0, length), true);
      advance(48);
    }
    // Still streaming, yet most of it is on screen.
    expect(shownText().length).toBeGreaterThan(characters.length / 2);
  });

  it('shows a large block whole within about 0.9 seconds', () => {
    const block = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' ');
    render(block, true);
    frames(60);
    expect(shownText()).toBe(block);
  });

  it('holds a half-arrived first word even late in the page’s life', () => {
    advance(1000);
    render('Another proc', true);
    advance(160);
    expect(shownText()).toBe('Another');
  });

  it('keeps half-typed markdown hidden until the reveal catches up', () => {
    const bold = `bold ${'text '.repeat(60)}end`;
    const text = `${'word '.repeat(300)}then **${bold}** ends`;
    render(text, true);
    frames(2);
    // The stream ends while the reveal is still behind.
    render(text, false);
    for (
      let frame = 0;
      frame < 80 && !shownText().endsWith('ends');
      frame += 1
    ) {
      frames(1);
      expect(shownText()).not.toContain('*');
    }
    frames(80);
    expect(container.querySelector('strong')?.textContent).toBe(bold);
  });

  it('shows a finished block whole while the rest of its turn runs', () => {
    // Desktop marks every block of a running turn as streaming; this one
    // arrived whole and leaves a mark open.
    render('It returns `Promise from the handler', true);
    frames(80);
    advance(STREAMING_SOURCE_QUIET_MS);
    expect(shownText()).toContain('Promise from the handler');
  });

  it('keeps the line breaks a host asks for', () => {
    const options = withSoftLineBreaks(TRANSCRIPT_MARKDOWN_OPTIONS);
    const draw = (streaming: boolean): void => {
      act(() => {
        root.render(
          <SmoothStreamingProvider value>
            <Markdown options={options} streaming={streaming}>
              {'First line of the message\nsecond line of it'}
            </Markdown>
          </SmoothStreamingProvider>,
        );
      });
    };
    draw(true);
    frames(40);
    expect(container.querySelectorAll('p br')).toHaveLength(1);
    draw(false);
    frames(40);
    advance(STREAMING_WORD_FADE_MS + 40);
    expect(container.querySelectorAll('p br')).toHaveLength(1);
    expect(shownText()).toBe('First line of the messagesecond line of it');
  });

  it('keeps every diagram after the fade settles', () => {
    const diagram = '```mermaid\ngraph TD; A-->B\n```';
    // Text after the diagrams fades in last, so the settle pass runs.
    const text = `${Array.from({ length: 20 }, () => diagram).join('\n\n')}\n\nThat is all.`;
    render(text, true);
    render(text, false);
    frames(80);
    advance(STREAMING_WORD_FADE_MS + 40);
    expect(
      container.querySelectorAll('[data-testid="markdown-mermaid"]'),
    ).toHaveLength(20);
  });

  it('keeps today’s path under reduced motion', () => {
    reducedMotion = true;
    render(SENTENCE, true);
    expect(shownText()).toBe(SENTENCE);
    expect(fadingSpans()).toHaveLength(0);
  });
});

function Paced({
  text,
  pacing,
}: {
  readonly text: string;
  readonly pacing: boolean;
}): JSX.Element {
  return <p>{useSmoothStreamingText(text, true, pacing)}</p>;
}

describe('useSmoothStreamingText', () => {
  it('keeps what was on screen when pacing turns on, and paces what follows', () => {
    act(() => root.render(<Paced text={SENTENCE} pacing={false} />));
    act(() => root.render(<Paced text={SENTENCE} pacing />));
    expect(shownText()).toBe(SENTENCE);
    act(() => root.render(<Paced text={`${SENTENCE} More arrives.`} pacing />));
    expect(shownText()).toBe(SENTENCE);
    frames(40);
    expect(shownText()).toBe(`${SENTENCE} More arrives.`);
  });
});
