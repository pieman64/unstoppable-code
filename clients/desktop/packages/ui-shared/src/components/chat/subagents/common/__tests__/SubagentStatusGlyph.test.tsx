/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubagentStatus } from '@canopy/agent-transcript';
import {
  SubagentStatusGlyph,
  subagentStatusGlyphState,
} from '../SubagentStatusGlyph';

describe('subagentStatusGlyphState', () => {
  it.each([
    ['running', 'running'],
    ['starting', 'running'],
    ['queued', 'queued'],
    ['approval', 'needs-you'],
    ['idle', 'paused'],
    ['completed', 'done'],
    ['failed', 'failed'],
    ['interrupted', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['stopped-by-parent', 'cancelled'],
  ] as const satisfies readonly (readonly [SubagentStatus, string])[])(
    '%s → %s',
    (status, state) => {
      expect(subagentStatusGlyphState(status)).toBe(state);
    },
  );
});

describe('SubagentStatusGlyph', () => {
  it('draws the shared glyph and keeps the raw status for automation', () => {
    const markup = renderToStaticMarkup(
      <SubagentStatusGlyph status="cancelled" />,
    );
    expect(markup).toContain('data-status="cancelled"');
    expect(markup).toContain('data-status-glyph="cancelled"');
    expect(markup).toContain('data-glyph="circle-stop"');
  });

  it('draws running as the neutral spinner, not the info one', () => {
    const markup = renderToStaticMarkup(
      <SubagentStatusGlyph status="running" spinnerSize={10} />,
    );
    expect(markup).toContain('data-status-glyph="running"');
    expect(markup).toContain('fg-secondary');
    expect(markup).not.toMatch(/fg-info|fg-accent/);
  });

  it('draws icons at the glyph box their size falls in', () => {
    expect(
      renderToStaticMarkup(<SubagentStatusGlyph status="failed" size={10} />),
    ).toContain('width:12px');
    expect(
      renderToStaticMarkup(<SubagentStatusGlyph status="failed" size={14} />),
    ).toContain('width:14px');
    expect(
      renderToStaticMarkup(<SubagentStatusGlyph status="failed" size={20} />),
    ).toContain('width:20px');
  });
});
