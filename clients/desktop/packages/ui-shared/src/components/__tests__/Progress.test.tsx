/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProgressBar, ProgressRing, ProgressSteps } from '../Progress';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
  return container;
}

function progressbar(host: HTMLElement): HTMLElement {
  const bar = host.querySelector<HTMLElement>('[role="progressbar"]');
  if (bar === null) throw new Error('no progressbar');
  return bar;
}

/** The bar's fill: the only element inside the track. */
function fillOf(bar: HTMLElement): HTMLElement {
  const fill = bar.firstElementChild;
  if (!(fill instanceof HTMLElement)) throw new Error('no fill');
  return fill;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ProgressBar', () => {
  it('names the bar and reports a clamped value', () => {
    const host = render(<ProgressBar value={140} label="Importing" />);
    const bar = progressbar(host);
    expect(bar.getAttribute('aria-label')).toBe('Importing');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.hasAttribute('aria-valuetext')).toBe(false);
  });

  it('shows the label on the left and the rounded percent on the right', () => {
    const host = render(<ProgressBar value={41.6} label="Importing" />);
    const row = host.querySelector('[data-progress-label-row]');
    expect(row?.textContent).toBe('Importing42%');
    // The row repeats the bar's name and value, so readers hear them once.
    expect(row?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows and reads a caller-supplied value', () => {
    const host = render(
      <ProgressBar value={30} label="Resume" valueText="3 of 10 handled" />,
    );
    expect(
      host.querySelector('[data-progress-label-row]')?.textContent,
    ).toContain('3 of 10 handled');
    expect(progressbar(host).getAttribute('aria-valuetext')).toBe(
      '3 of 10 handled',
    );
  });

  it('keeps a hidden label as the accessible name only', () => {
    const host = render(<ProgressBar value={30} label="Upload" hideLabel />);
    expect(host.querySelector('[data-progress-label-row]')).toBeNull();
    expect(progressbar(host).getAttribute('aria-label')).toBe('Upload');
  });

  it('moves the fill by transform, never by width', () => {
    const host = render(<ProgressBar value={30} label="Upload" hideLabel />);
    const fill = fillOf(progressbar(host));
    expect(fill.style.width).toBe('');
    expect(fill.style.transform).toBe('translateX(-70%)');
    expect(fill.className).toContain('transition-transform');
    expect(fill.className).toContain('motion-reduce:transition-none');
  });

  it('exposes no value while indeterminate and stills the sweep under reduced motion', () => {
    const host = render(
      <ProgressBar
        value={20}
        label="Installing"
        valueText="Busy"
        indeterminate
      />,
    );
    const bar = progressbar(host);
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.hasAttribute('aria-valuetext')).toBe(false);
    expect(host.querySelector('[data-progress-label-row]')?.textContent).toBe(
      'Installing',
    );
    const fill = fillOf(bar);
    expect(fill.style.transform).toBe('');
    expect(fill.className).toContain('animate-progress-indeterminate');
    expect(fill.className).toContain('motion-reduce:animate-none');
    expect(fill.className).not.toContain('animate-pulse');
  });

  it('paints the fill by tone on the muted track', () => {
    const fills = (
      ['accent', 'warning', 'destructive', 'neutral'] as const
    ).map((tone) => {
      const bar = progressbar(
        render(<ProgressBar value={50} label={tone} tone={tone} hideLabel />),
      );
      expect(bar.className).toContain('bg-muted');
      return [bar.dataset.tone, fillOf(bar).className.split(' ')[0]];
    });
    expect(fills).toEqual([
      ['accent', 'bg-accent'],
      ['warning', 'bg-warning'],
      ['destructive', 'bg-destructive'],
      ['neutral', 'bg-fg-tertiary'],
    ]);
  });

  it('draws a 6px bar by default and a 4px bar when compact', () => {
    expect(
      progressbar(render(<ProgressBar value={5} label="a" />)).className,
    ).toContain('h-1.5');
    expect(
      progressbar(render(<ProgressBar value={5} label="b" size="compact" />))
        .className,
    ).toMatch(/(^|\s)h-1(\s|$)/);
  });
});

describe('ProgressRing', () => {
  function arc(host: HTMLElement): SVGCircleElement {
    const circle = host.querySelector<SVGCircleElement>('[data-part="arc"]');
    if (circle === null) throw new Error('no arc');
    return circle;
  }

  it('draws a 16px ring with a 2px stroke', () => {
    const host = render(<ProgressRing value={50} tone="accent" />);
    const svg = host.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
    expect(arc(host).getAttribute('stroke-width')).toBe('2');
  });

  it('is decorative without a label and a named progressbar with one', () => {
    const quiet = render(<ProgressRing value={50} tone="neutral" />);
    expect(quiet.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(quiet.querySelector('[role="progressbar"]')).toBeNull();

    const named = render(
      <ProgressRing value={120} tone="warning" label="Download" />,
    );
    const bar = progressbar(named);
    expect(bar.getAttribute('aria-label')).toBe('Download');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
  });

  it('keeps the arc and track in one role at two strengths', () => {
    const host = render(<ProgressRing value={50} tone="destructive" />);
    expect(arc(host).getAttribute('stroke')).toBe('var(--fg-destructive)');
    expect(
      host.querySelector('[data-part="track"]')?.getAttribute('stroke'),
    ).toBe('var(--bg-destructive-subtle)');
  });

  it('animates only the arc length, and not under reduced motion', () => {
    const host = render(<ProgressRing value={50} tone="accent" />);
    const className = arc(host).getAttribute('class') ?? '';
    expect(className).toContain('transition-[stroke-dashoffset]');
    expect(className).toContain('motion-reduce:transition-none');
  });
});

describe('ProgressSteps', () => {
  const STAGES = [
    [{ id: 'plan', state: 'done' }],
    [
      { id: 'build', state: 'done' },
      { id: 'test', state: 'running' },
    ],
    [{ id: 'ship', state: 'queued' }],
  ] as const;

  it('draws one 12px glyph per step with a rule between stages', () => {
    const host = render(<ProgressSteps stages={STAGES} />);
    const steps = [...host.querySelectorAll('[data-status-glyph-state]')].map(
      (step) => step.getAttribute('data-status-glyph-state'),
    );
    expect(steps).toEqual(['done', 'done', 'running', 'queued']);
    expect(
      host.querySelectorAll('[data-progress-stage-separator]'),
    ).toHaveLength(2);
  });

  it('is decorative without a label', () => {
    const host = render(<ProgressSteps stages={STAGES} />);
    expect(host.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('reports finished steps when named', () => {
    const host = render(<ProgressSteps stages={STAGES} label="Run steps" />);
    const bar = progressbar(host);
    expect(bar.getAttribute('aria-label')).toBe('Run steps');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('4');
    expect(bar.getAttribute('aria-valuetext')).toBe('2 of 4 done');
  });

  it('renders nothing without steps', () => {
    const host = render(<ProgressSteps stages={[]} />);
    expect(host.innerHTML).toBe('');
  });
});
