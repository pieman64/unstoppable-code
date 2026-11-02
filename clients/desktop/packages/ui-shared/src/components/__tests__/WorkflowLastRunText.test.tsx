import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowLastRunText } from '../WorkflowLastRunText';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('WorkflowLastRunText', () => {
  it.each([null, undefined])('reads Not run yet for %s', (lastRun) => {
    const html = renderToStaticMarkup(
      <WorkflowLastRunText lastRun={lastRun} now={NOW} />,
    );
    expect(html).toBe('<span class="fg-tertiary">Not run yet</span>');
  });

  it('shows the outcome with its glyph and how long ago it ran', () => {
    const html = renderToStaticMarkup(
      <WorkflowLastRunText
        lastRun={{ state: 'success', at: NOW - 2 * 3600e3 }}
        now={NOW}
      />,
    );
    expect(textOf(html)).toContain('Succeeded · 2h ago');
    expect(html).toContain('data-testid="workflows-last-run-status"');
  });

  it('reads Now for a running workflow instead of a relative time', () => {
    const html = renderToStaticMarkup(
      <WorkflowLastRunText lastRun={{ state: 'running' }} now={NOW} />,
    );
    expect(textOf(html)).toContain('Running · Now');
    expect(html).not.toContain('ago');
  });

  it('puts a custom test id on the glyph', () => {
    const html = renderToStaticMarkup(
      <WorkflowLastRunText
        lastRun={{ state: 'failure', at: NOW - 60e3 }}
        now={NOW}
        dataTestId="row-last-run"
      />,
    );
    expect(html).toContain('data-testid="row-last-run"');
    expect(textOf(html)).toContain('Failed · 1m ago');
  });

  it('renders the minimal Customize treatment with accessible labels', () => {
    const notRun = renderToStaticMarkup(
      <WorkflowLastRunText lastRun={null} variant="customize" />,
    );
    expect(notRun).toBe('');

    const succeeded = renderToStaticMarkup(
      <WorkflowLastRunText
        lastRun={{ state: 'success', at: NOW - 2 * 3600e3 }}
        now={NOW}
        variant="customize"
      />,
    );
    expect(textOf(succeeded)).toBe('2h ago');
    expect(succeeded).toContain('aria-label="Last run 2h ago"');
    expect(succeeded).toContain('fg-tertiary');
    expect(succeeded).not.toContain('data-status-glyph');

    const running = renderToStaticMarkup(
      <WorkflowLastRunText
        lastRun={{ state: 'running' }}
        variant="customize"
      />,
    );
    expect(textOf(running)).toBe('Running');
    expect(running).toContain('aria-label="Last run running"');
    expect(running).not.toContain('data-status-glyph');

    const failed = renderToStaticMarkup(
      <WorkflowLastRunText
        lastRun={{ state: 'failure', at: NOW - 3600e3 }}
        now={NOW}
        variant="customize"
      />,
    );
    expect(textOf(failed)).toBe('1h ago');
    expect(failed).toContain('aria-label="Last run failed 1h ago"');
    expect(failed).toContain('fg-destructive-strong');
    expect(failed).toContain('data-status-glyph="failed"');
  });
});
