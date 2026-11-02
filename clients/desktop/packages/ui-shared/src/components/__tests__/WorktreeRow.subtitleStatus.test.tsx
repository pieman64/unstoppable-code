/**
 * Focused sidebar rows (early access) give their second line to a live status
 * instead of the branch: setup, teardown, git setup, and split progress.
 * In-progress statuses shimmer; a status that waits on the user stays still.
 * Classic rows keep the branch with the status after a dot.
 */
import { renderToString } from 'react-dom/server';
import { WorktreeRow, type WorktreeRowProps } from '../WorktreeRow';

function render(props: Partial<WorktreeRowProps> = {}): string {
  return renderToString(
    <WorktreeRow
      branchLabel="General test topic"
      branchName="dzzzgnr/unclear-task"
      worktreeId="dzzzgnr/unclear-task"
      uiStatus="idle"
      textScale="sidebar"
      statusModel="focused"
      {...props}
    />,
  );
}

/** The subtitle status element, or null. */
function subtitleStatus(html: string): string | null {
  return (
    /<span[^>]*data-testid="worktree-row-subtitle-status"[^>]*>[^<]*<\/span>/.exec(
      html,
    )?.[0] ?? null
  );
}

describe('WorktreeRow focused subtitle status', () => {
  it.each<[string, Partial<WorktreeRowProps>, string]>([
    ['setup', { setupPhase: 'running-setup' }, 'Running setup…'],
    ['teardown', { setupPhase: 'running-teardown' }, 'Running teardown…'],
    ['archive', { setupPhase: 'running-archive' }, 'Archiving…'],
    ['git setup', { setupPhase: 'git-pending' }, 'Setting up…'],
    [
      'split progress',
      {
        splitStatus: 'active',
        splitStatusMessage: 'Carving child branch (2/4)',
      },
      'Carving child branch (2/4)',
    ],
  ])(
    'shows a shimmering %s status instead of the branch',
    (_name, props, text) => {
      const html = render(props);
      const status = subtitleStatus(html);
      expect(status).toContain(text);
      expect(status).toContain('canopy-text-shimmer');
      expect(html).not.toContain('dzzzgnr/unclear-task<');
    },
  );

  it('keeps a split status that waits on the user still', () => {
    const status = subtitleStatus(
      render({
        splitStatus: 'review',
        splitStatusMessage: 'Waiting for your plan approval',
      }),
    );
    expect(status).toContain('Waiting for your plan approval');
    expect(status).not.toContain('canopy-text-shimmer');
  });

  it('keeps a row waiting in a bulk removal queue still', () => {
    for (const [queuedRemoval, text] of [
      ['delete', 'Queued for deletion'],
      ['archive', 'Queued for archiving'],
    ] as const) {
      const status = subtitleStatus(render({ queuedRemoval }));
      expect(status).toContain(text);
      expect(status).not.toContain('canopy-text-shimmer');
    }
  });

  it('starts a classic queued status without a separator when no identity precedes it', () => {
    const html = render({
      statusModel: 'classic',
      queuedRemoval: 'archive',
      worktreeIdSlot: null,
    });
    expect(html).toContain('Queued for archiving');
    expect(html).not.toContain('·');
    expect(
      render({ statusModel: 'classic', queuedRemoval: 'archive' }),
    ).toMatch(/dzzzgnr\/unclear-task<\/span>.*·.*Queued for archiving/s);
  });

  it('keeps the subtitle line on a compact row with nothing else to show', () => {
    const compactRow = (props: Partial<WorktreeRowProps>): string =>
      render({
        statusModel: 'classic',
        compact: true,
        worktreeIdSlot: null,
        ...props,
      });
    expect(compactRow({})).toContain('data-worktree-single-line="true"');
    const queued = compactRow({ queuedRemoval: 'delete' });
    expect(queued).not.toContain('data-worktree-single-line');
    expect(queued).toContain('Queued for deletion');
  });

  it('lets the host teardown replace the queued status', () => {
    const html = render({
      queuedRemoval: 'delete',
      setupPhase: 'running-teardown',
    });
    expect(subtitleStatus(html)).toContain('Running teardown…');
    expect(html).not.toContain('Queued');
  });

  it('shimmers the animal name only while scripts run on focused rows', () => {
    const running = render({ worktreeId: 'scorpion', scriptStatus: 'running' });
    expect(running).toMatch(
      /<span class="[^"]*canopy-text-shimmer[^"]*">scorpion<\/span>/,
    );
    expect(subtitleStatus(running)).toBeNull();
    expect(render({ worktreeId: 'scorpion' })).not.toContain(
      'canopy-text-shimmer',
    );
    expect(
      render({
        worktreeId: 'scorpion',
        statusModel: 'classic',
        scriptStatus: 'running',
      }),
    ).not.toContain('canopy-text-shimmer');
  });

  it('shows the branch when nothing is in progress', () => {
    const html = render();
    expect(subtitleStatus(html)).toBeNull();
    expect(html).toContain('dzzzgnr/unclear-task');
  });

  it('keeps the classic branch and dot when early access is off', () => {
    const html = render({
      statusModel: 'classic',
      setupPhase: 'running-setup',
    });
    expect(subtitleStatus(html)).toBeNull();
    expect(html).toContain('dzzzgnr/unclear-task');
    expect(html).toContain('Running setup…');
  });
});
