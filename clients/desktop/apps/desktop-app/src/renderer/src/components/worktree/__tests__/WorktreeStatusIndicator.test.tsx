import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreeStatusIndicator } from '../WorktreeStatusIndicator';

describe('WorktreeStatusIndicator', () => {
  it('uses the merged status color for completed worktrees', () => {
    const html = renderToStaticMarkup(
      <WorktreeStatusIndicator
        uiStatus="done"
        isRunningSetup={false}
        isTearingDown={false}
        isPendingGitSetup={false}
        isStreaming={false}
      />,
    );

    expect(html).toContain('fg-special-strong');
    expect(html).not.toContain('fg-success-strong');
  });
});
