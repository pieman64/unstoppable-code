/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatDetail } from '@canopy/protocol/chat-detail';
import {
  ChatDetailProvider,
  ChatLookProvider,
  StepTenseProvider,
  type ChatLook,
  type StepTense,
} from '../../chat-look';
import { StepRow } from '../StepRow';
import { ToolCallCard } from '../ToolCallCard';
import { TurnOutcomeTooltip } from '../TurnOutcomeTooltip';
import {
  STEP_BADGE_CLASS,
  StepBadge,
  dotSafeEllipsisPadding,
} from '../StepBadge';
import { getToolDisplayInfo } from '../tool-display';

/** Every character is 10px wide; the ellipsis too. */
const measure = (value: string): number => value.length * 10;

describe('dotSafeEllipsisPadding', () => {
  it('adds nothing when the text fits', () => {
    expect(dotSafeEllipsisPadding('file.ts', 70, measure)).toBe(0);
    expect(dotSafeEllipsisPadding('file.ts', 200, measure)).toBe(0);
  });

  it('adds nothing when the cut lands on a letter', () => {
    // 50px: four letters beside the ellipsis, "file…".
    expect(dotSafeEllipsisPadding('file-name.test.ts', 50, measure)).toBe(0);
  });

  it('moves a cut that lands right after a dot to before it', () => {
    // 60px: five characters fit beside the ellipsis, "file." + "…".
    const padding = dotSafeEllipsisPadding('file.test.ts', 60, measure);
    // The box shrinks by just under one character, so "file" + "…" is
    // what fits.
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThan(10);
    const shown = 60 - padding - measure('…');
    expect(Math.floor(shown / 10)).toBe(4);
  });

  it('skips a run of dots', () => {
    // 70px: six characters fit beside the ellipsis, "name.." + "…".
    const padding = dotSafeEllipsisPadding('name..rest', 70, measure);
    expect(Math.floor((70 - padding - 10) / 10)).toBe(4);
  });

  it('adds nothing when the box has no width', () => {
    expect(dotSafeEllipsisPadding('file.ts', 0, measure)).toBe(0);
  });
});

function render(look: ChatLook, detail: ChatDetail, node: ReactNode): string {
  return renderToStaticMarkup(
    <ChatLookProvider value={look}>
      <ChatDetailProvider value={detail}>{node}</ChatDetailProvider>
    </ChatLookProvider>,
  );
}

function ReadRow(): JSX.Element {
  const info = getToolDisplayInfo(
    'Read',
    JSON.stringify({ file_path: 'src/toolbar/toolbar.test.ts' }),
  );
  return (
    <ToolCallCard
      toolName="Read"
      toolFamily="read"
      label={info.label}
      status="success"
    />
  );
}

function BashRow(): JSX.Element {
  const info = getToolDisplayInfo(
    'Bash',
    JSON.stringify({ command: 'pnpm test toolbar --repeat 2' }),
  );
  return (
    <ToolCallCard
      toolName="Bash"
      toolFamily="bash"
      label={info.label}
      status="success"
    />
  );
}

function GrepRow(): JSX.Element {
  const info = getToolDisplayInfo(
    'Grep',
    JSON.stringify({ pattern: 'waitForIdle', path: 'src' }),
  );
  return (
    <ToolCallCard
      toolName="Grep"
      toolFamily="grep"
      label={info.label}
      status="success"
    />
  );
}

describe('step badges', () => {
  it('put the file, search target and command in a badge on Detailed', () => {
    const read = render('clean', 'detailed', <ReadRow />);
    expect(read).toContain(`class="${STEP_BADGE_CLASS}"`);
    // The verb, then its badge.
    expect(read).toMatch(/>Read(<\/span>)? ?<code/);
    expect(read).toContain('toolbar.test.ts');
    expect(read).not.toContain('src/toolbar');

    const grep = render('clean', 'detailed', <GrepRow />);
    expect(grep.match(/data-step-badge=""/g)).toHaveLength(2);
    expect(grep).toContain('Search for');

    const bash = render('clean', 'detailed', <BashRow />);
    expect(bash.match(/data-step-badge=""/g)).toHaveLength(1);
    expect(bash).toContain('Run');
    expect(bash).toContain('pnpm test toolbar --repeat 2');
  });

  it('keep plain words outside a step row, as in a tooltip or tray row', () => {
    const info = getToolDisplayInfo(
      'Bash',
      JSON.stringify({ command: 'pnpm test toolbar --repeat 2' }),
    );
    const html = render(
      'clean',
      'detailed',
      <span className="truncate">{info.label}</span>,
    );
    expect(html).not.toContain('data-step-badge');
    expect(html).toContain('pnpm test toolbar --repeat 2');
  });

  it('keep plain words in the turn-outcome tooltip on Detailed', () => {
    const html = render(
      'clean',
      'detailed',
      <TurnOutcomeTooltip
        outcomes={{ blocked: 0, failed: 1, interrupted: 0 }}
        steps={[
          {
            toolUseId: 'tool-1',
            outcome: 'failed',
            toolName: 'Bash',
            input: JSON.stringify({ command: 'pnpm test toolbar --repeat 2' }),
          },
        ]}
      />,
    );
    expect(html).not.toContain('data-step-badge');
    expect(html).toContain('pnpm test toolbar --repeat 2');
  });

  it('end labels wrapped in one element in an ellipsis on Detailed', () => {
    const row = (toolName: string, input: object): string =>
      render(
        'clean',
        'detailed',
        <StepRow
          step
          icon={<svg />}
          label={getToolDisplayInfo(toolName, JSON.stringify(input)).label}
        />,
      );
    const host = (html: string): HTMLElement => {
      const element = document.createElement('div');
      element.innerHTML = html;
      return element;
    };

    // A label in its own span: the span is a line, its words keep their
    // width and its target is a badge that shrinks first.
    const memory = host(
      row('canopy_search_memory', { query: 'package manager for this repo' }),
    );
    const wrapper = memory.querySelector(
      '[data-testid="chat-tool-call-search-memory-label"]',
    );
    expect(wrapper).toBeInstanceOf(HTMLElement);
    expect(wrapper?.className).toContain('min-w-0');
    expect(wrapper?.className).toContain('overflow-hidden');
    const words = wrapper?.querySelector('span.truncate');
    expect(words?.textContent).toBe('Search memory ');
    expect(words?.className).toContain('flex-shrink-0');
    expect(wrapper?.querySelector('[data-step-badge]')?.textContent).toBe(
      'package manager for this repo',
    );
    expect(memory.textContent).toBe(
      'Search memory package manager for this repo',
    );

    // A muted snippet shrinks and ends in an ellipsis, alone or after words.
    for (const html of [
      row('canopy_start_branched_agent', {
        followUpInstruction: 'Fix the flaky toolbar test in a new branch',
      }),
      row('canopy_add_ledger_entry', { title: 'Toolbar test fixed' }),
    ]) {
      const snippet = Array.from(host(html).querySelectorAll('span')).find(
        (span) =>
          span.textContent === 'Fix the flaky toolbar test in a new branch' ||
          span.textContent === 'Toolbar test fixed',
      );
      expect(snippet).toBeInstanceOf(HTMLElement);
      expect(snippet?.className).toContain('min-w-0');
      expect(snippet?.className).toContain('truncate');
    }

    // Recent uses the same badge line as Detailed.
    const recent = render(
      'clean',
      'recent',
      <StepRow
        step
        icon={<svg />}
        label={
          getToolDisplayInfo(
            'canopy_search_memory',
            JSON.stringify({ query: 'package manager' }),
          ).label
        }
      />,
    );
    expect(recent).toContain('data-step-badge');
  });

  it.each(['recent', 'compact'] as const)(
    'keep the same step presentation on %s',
    (detail) => {
      for (const row of [
        <ReadRow key="r" />,
        <GrepRow key="g" />,
        <BashRow key="b" />,
      ]) {
        const html = render('clean', detail, row);
        expect(html).toBe(render('clean', 'detailed', row));
      }
    },
  );

  it('uses the same row typography and icon geometry at every detail level', () => {
    for (const detail of ['detailed', 'recent', 'compact'] as const) {
      for (const step of [true, false]) {
        const html = render(
          'clean',
          detail,
          <StepRow step={step} icon={<svg />} label="Read file.ts" />,
        );
        expect(html).toContain('text-s fg-secondary');
        expect(html).not.toContain('canopy-small-icon-stroke');
        expect(html).toContain('h-3.5 w-3.5');
      }
    }

    // The words keep their spaces, so copied and spoken text reads right.
    const text = (html: string): string => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return host.textContent ?? '';
    };
    expect(text(render('clean', 'detailed', <ReadRow />))).toBe(
      'Read toolbar.test.ts',
    );
    expect(text(render('clean', 'detailed', <GrepRow />))).toBe(
      'Search for waitForIdle in src',
    );

    // Plain words keep their width beside a detail that shrinks first, and
    // still end in an ellipsis when they alone outgrow a narrow row.
    const plain = render(
      'clean',
      'detailed',
      <StepRow
        step
        icon={<svg />}
        label={
          <>
            {'Explore'}
            {' agent'}
          </>
        }
        detail="Find every caller of waitForIdle"
      />,
    );
    expect(plain).toContain(
      '<span class="max-w-full flex-shrink-0 truncate">Explore</span>',
    );
    expect(plain).toContain(
      '<span class="max-w-full flex-shrink-0 truncate"> agent</span>',
    );
    expect(plain).toMatch(
      /<span class="min-w-0 truncate fg-tertiary">Find every caller of waitForIdle<\/span>/,
    );
    const thought = render(
      'clean',
      'detailed',
      <StepRow step icon={<svg />} label="Thought for 3s" />,
    );
    expect(thought).toContain(
      '<span class="max-w-full flex-shrink-0 truncate">Thought for 3s</span>',
    );

    // A turn header or a run's line keeps the step row's own size.
    const header = render(
      'clean',
      'detailed',
      <StepRow icon={<svg />} label="Worked for 3m" />,
    );
    expect(header).toContain('text-s fg-secondary');
  });
});

describe('StepBadge on the page', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  /** Every character is 10px wide; the badge's text box is `width` px. */
  function layout(width: number): void {
    // jsdom has no canvas; measure text the way the badge's canvas would.
    const getContext = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'getContext',
    );
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: (): {
        font: string;
        measureText: (value: string) => { width: number };
      } => ({
        font: '',
        measureText: (value: string): { width: number } => ({
          width: value.length * 10,
        }),
      }),
    });
    restore.push(() => {
      if (getContext)
        Object.defineProperty(
          HTMLCanvasElement.prototype,
          'getContext',
          getContext,
        );
    });
    for (const [name, value] of [
      ['clientWidth', (): number => width],
      [
        'scrollWidth',
        function (this: HTMLElement): number {
          return (this.textContent ?? '').length * 10;
        },
      ],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        name,
      );
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get: value,
      });
      restore.push(() => {
        if (original)
          Object.defineProperty(HTMLElement.prototype, name, original);
      });
    }
  }

  /**
   * A stand-in ResizeObserver; `settle` fires each observer whose box
   * changed size, as the browser would, and returns the rounds it took.
   */
  function fakeResizeObserver(): () => number {
    const observed: Array<{ target: Element; fire: () => void; last: number }> =
      [];
    const original = globalThis.ResizeObserver;
    class FakeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        observed.push({
          target,
          last: target.clientWidth,
          fire: (): void => this.callback([], this),
        });
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = FakeResizeObserver;
    restore.push(() => {
      globalThis.ResizeObserver = original;
    });
    return (): number => {
      let rounds = 0;
      for (let changed = true; changed && rounds < 20; rounds += 1) {
        changed = false;
        for (const entry of observed) {
          const width = entry.target.clientWidth;
          if (width === entry.last) continue;
          entry.last = width;
          changed = true;
          act(() => entry.fire());
        }
      }
      return rounds;
    };
  }

  const paddingOf = (element: Element | undefined): number =>
    element instanceof HTMLElement
      ? Number.parseFloat(element.style.paddingRight || '0')
      : 0;

  it('settles even when its padding widens its own box', () => {
    // A flex line gives the badge more room as its padding grows: the worst
    // case, where the padding widens the badge by its whole amount.
    layout(60);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.parentElement?.matches('[data-step-badge]') === true
          ? 60 + paddingOf(this)
          : 200;
      },
    });
    const settle = fakeResizeObserver();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<StepBadge>file.test.ts</StepBadge>));
    expect(settle()).toBeLessThan(20);
    const text = host.querySelector('[data-step-badge] > span') ?? undefined;
    expect(paddingOf(text)).toBeGreaterThan(0);
    act(() => root.unmount());
    host.remove();
  });

  it("measures again when another badge's padding takes its room", () => {
    // Two badges share a line ("Searched for X in Y"): the first one's
    // padding comes out of the second one's room.
    layout(60);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.parentElement?.matches('[data-step-badge]') !== true) {
          return 200;
        }
        const [first] = Array.from(
          document.querySelectorAll('[data-step-badge] > span'),
        );
        return this === first ? 60 : 70 - paddingOf(first);
      },
    });
    const settle = fakeResizeObserver();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <span>
          <StepBadge>file.test.ts</StepBadge>
          <StepBadge>util.spec.ts</StepBadge>
        </span>,
      ),
    );
    expect(settle()).toBeLessThan(20);
    const [first, second] = Array.from(
      host.querySelectorAll('[data-step-badge] > span'),
    );
    // The first badge cuts at "file." in 60px and pads; that leaves the
    // second 60.5px, where it cuts at "util." and must pad too.
    expect(paddingOf(first)).toBeGreaterThan(0);
    expect(paddingOf(second)).toBeGreaterThan(0);
    act(() => root.unmount());
    host.remove();
  });

  it('measures again when status changes the room beside the badge', () => {
    // A new status detail reduces room from 70px to 60px, where the cut
    // lands after a dot. The line's own size doesn't change.
    let room = 70;
    layout(60);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: (): number => room,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const badge = (tense: StepTense): JSX.Element => (
      <StepTenseProvider value={tense}>
        <StepBadge>file.test.ts</StepBadge>
      </StepTenseProvider>
    );
    act(() => root.render(badge('running')));
    const text = (): HTMLElement | null =>
      host.querySelector<HTMLElement>('[data-step-badge] > span');
    // 70px: "file.t" + "…" fits, so no padding.
    expect(text()?.style.paddingRight ?? '').toBe('');
    room = 60;
    act(() => root.render(badge('done')));
    const padding = Number.parseFloat(text()?.style.paddingRight || '0');
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThan(10);
    act(() => root.unmount());
    host.remove();
  });

  it("watches the row's words when its label sits in its own span", () => {
    layout(60);
    const watched: Element[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(target: Element): void {
        watched.push(target);
      }
      unobserve(): void {}
      disconnect(): void {}
    };
    restore.push(() => {
      globalThis.ResizeObserver = original;
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const { label } = getToolDisplayInfo(
      'canopy_search_memory',
      JSON.stringify({ query: 'package manager' }),
    );
    act(() =>
      root.render(
        <ChatLookProvider value="clean">
          <ChatDetailProvider value="detailed">
            <StepRow step icon={<svg />} label={label} />
          </ChatDetailProvider>
        </ChatLookProvider>,
      ),
    );
    // The label's span sizes with its words; the row's words with the column.
    const words = host.querySelector('[data-step-row-words]');
    expect(words).toBeInstanceOf(HTMLElement);
    expect(watched).toContain(words);
    act(() => root.unmount());
    host.remove();
  });

  it('settles on one padding when the cut lands after a dot', () => {
    layout(60);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    restore.push(() => errors.mockRestore());
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<StepBadge>file.test.ts</StepBadge>));
    const text = host.querySelector<HTMLElement>('[data-step-badge] > span');
    const padding = Number.parseFloat(text?.style.paddingRight ?? '0');
    // "file" + "…" fits once the dot moves past the cut.
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThan(10);
    expect(errors).not.toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});
