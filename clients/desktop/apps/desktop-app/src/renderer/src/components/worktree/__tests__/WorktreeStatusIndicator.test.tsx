import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreeStatusIndicator } from '../WorktreeStatusIndicator';

function indicator(
  uiStatus: 'idle' | 'planning' | 'working' | 'unread' | 'done',
): string {
  return renderToStaticMarkup(
    <WorktreeStatusIndicator
      uiStatus={uiStatus}
      isRunningSetup={false}
      isTearingDown={false}
      isPendingGitSetup={false}
      isStreaming={false}
    />,
  );
}

describe('WorktreeStatusIndicator', () => {
  it('draws a done worktree with the shared green Done glyph', () => {
    const html = indicator('done');
    expect(html).toContain('data-status-glyph="done"');
    expect(html).toContain('fg-success-strong');
    expect(html).not.toContain('fg-special-strong');
  });

  it.each([
    ['planning', 'needs-you'],
    ['working', 'running'],
    ['unread', 'ready'],
  ] as const)('draws %s with the shared %s glyph', (uiStatus, glyph) => {
    const html = indicator(uiStatus);
    expect(html).toContain(`data-status-glyph="${glyph}"`);
    expect(html).not.toMatch(/fg-accent|border-fg-info/);
  });

  it('draws a done worktree whose pull request merged with the Merged glyph', () => {
    const html = renderToStaticMarkup(
      <WorktreeStatusIndicator
        uiStatus="done"
        isRunningSetup={false}
        isTearingDown={false}
        isPendingGitSetup={false}
        isStreaming={false}
        doneLabel="PR merged"
        merged
      />,
    );
    expect(html).toContain('data-status-glyph="merged"');
    expect(html).toContain('aria-label="PR merged"');
    expect(html).not.toContain('data-status-glyph="done"');
  });

  it('shows one spinner, not two, for a working worktree that is streaming', () => {
    const html = renderToStaticMarkup(
      <WorktreeStatusIndicator
        uiStatus="working"
        isRunningSetup={false}
        isTearingDown={false}
        isPendingGitSetup={false}
        isStreaming
      />,
    );
    expect(html).not.toContain('data-status-glyph="running"');
    expect(html.match(/aria-label="Thinking"/g) ?? []).toHaveLength(1);
  });

  it('keeps idle as empty space', () => {
    expect(indicator('idle')).not.toContain('data-status-glyph');
  });
});
