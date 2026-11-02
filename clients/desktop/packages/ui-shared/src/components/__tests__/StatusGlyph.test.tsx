/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusGlyph } from '../StatusGlyph';
import { SpinnerStyleProvider } from '../spinner-style';
import {
  STATUS_GLYPHS,
  STATUS_GLYPH_STATES,
  runStatusGlyphState,
  type StatusGlyphState,
} from '../../lib/status-glyph';

function glyphMarkup(state: StatusGlyphState): string {
  return renderToStaticMarkup(<StatusGlyph state={state} />);
}

/** The drawn artwork alone: the SVG children, without the ink wrapper. */
function artwork(state: StatusGlyphState): string {
  const markup = glyphMarkup(state);
  return markup.slice(markup.indexOf('<svg'), markup.lastIndexOf('</svg>'));
}

describe('STATUS_GLYPHS', () => {
  it('names nine states, each with its own glyph', () => {
    expect(STATUS_GLYPH_STATES).toHaveLength(9);
    const shapes = STATUS_GLYPH_STATES.map(
      (state) => STATUS_GLYPHS[state].shape,
    );
    expect(new Set(shapes).size).toBe(STATUS_GLYPH_STATES.length);
  });

  it('keeps the run-state colour roles', () => {
    expect(STATUS_GLYPHS.failed.ink).toBe('fg-destructive-strong');
    expect(STATUS_GLYPHS.done.ink).toBe('fg-success-strong');
    expect(STATUS_GLYPHS.merged.ink).toBe('fg-special-strong');
    expect(STATUS_GLYPHS.ready.ink).toBe('fg-info');
    expect(STATUS_GLYPHS['needs-you'].ink).toBe('fg-warning');
    expect(STATUS_GLYPHS.paused.ink).toBe('fg-secondary');
  });

  it('gives Cancelled a stop glyph apart from Failed, Done and Merged', () => {
    expect(STATUS_GLYPHS.cancelled.shape).toBe('circle-stop');
    const cancelled = artwork('cancelled');
    expect(cancelled).not.toBe(artwork('failed'));
    expect(cancelled).not.toBe(artwork('done'));
    expect(cancelled).not.toBe(artwork('merged'));
    expect(STATUS_GLYPHS.cancelled.ink).not.toBe(STATUS_GLYPHS.failed.ink);
  });

  it('never paints a state with the accent', () => {
    for (const state of STATUS_GLYPH_STATES) {
      expect(STATUS_GLYPHS[state].ink).not.toMatch(/accent/);
    }
  });
});

describe('StatusGlyph', () => {
  it('marks its state for automation and hides from readers by default', () => {
    const markup = glyphMarkup('failed');
    expect(markup).toContain('data-status-glyph="failed"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
  });

  it('names itself when given a label', () => {
    const markup = renderToStaticMarkup(
      <StatusGlyph state="cancelled" label="Cancelled" />,
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Cancelled"');
  });

  it('draws Running as the shared neutral spinner', () => {
    const dots = glyphMarkup('running');
    expect(dots).toContain('aria-label="Thinking"');
    expect(dots).toContain('fg-secondary');
    expect(dots).not.toMatch(/fg-info|fg-accent/);
    const comet = renderToStaticMarkup(
      <SpinnerStyleProvider value="comet">
        <StatusGlyph state="running" />
      </SpinnerStyleProvider>,
    );
    expect(comet).toContain('data-spinner="comet"');
    expect(comet).toContain('fg-secondary');
  });

  it('sizes the spinner to its own box when asked', () => {
    const markup = renderToStaticMarkup(
      <SpinnerStyleProvider value="comet">
        <StatusGlyph state="running" spinnerSize={10} />
      </SpinnerStyleProvider>,
    );
    expect(markup).toContain('width:10px');
  });

  it('draws Ready as a dot in the unread ink', () => {
    const markup = glyphMarkup('ready');
    expect(markup).toContain('rounded-full bg-current');
    expect(markup).toContain('fg-info');
    expect(markup).not.toContain('<svg');
  });

  it('draws icons at the compact tier with a 1.5px line', () => {
    const markup = glyphMarkup('paused');
    expect(markup).toContain('width:14px');
    // 1.5px drawn at 14px on the 24-unit grid.
    expect(markup).toMatch(/stroke-width:2\.57/);
  });

  it('draws the regular tier at 20px', () => {
    const markup = renderToStaticMarkup(<StatusGlyph state="done" size={20} />);
    expect(markup).toContain('h-5 w-5');
    expect(markup).toContain('width:20px');
  });

  it('draws the dense 12px box for strips and tables', () => {
    const markup = renderToStaticMarkup(
      <StatusGlyph state="failed" size={12} />,
    );
    expect(markup).toContain('h-3 w-3');
    expect(markup).toContain('width:12px');
    // Still a 1.5px line: 1.5 drawn at 12px on the 24-unit grid.
    expect(markup).toMatch(/stroke-width:3(;|")/);
  });

  it('keeps placement classes', () => {
    expect(
      renderToStaticMarkup(<StatusGlyph state="queued" className="mr-1" />),
    ).toContain('mr-1');
  });
});

describe('runStatusGlyphState', () => {
  it.each([
    ['queued', 'queued'],
    ['pending', 'queued'],
    ['running', 'running'],
    ['restarting', 'running'],
    ['paused', 'paused'],
    ['success', 'done'],
    ['completed', 'done'],
    ['succeeded', 'done'],
    ['failed', 'failed'],
    ['failure', 'failed'],
    ['timed_out', 'failed'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['skipped', 'cancelled'],
    ['stopping', 'running'],
  ] as const)('%s → %s', (status, state) => {
    expect(runStatusGlyphState(status)).toBe(state);
  });

  it('draws nothing for a status it does not know', () => {
    expect(runStatusGlyphState(undefined)).toBeNull();
    expect(runStatusGlyphState('mystery')).toBeNull();
  });
});
