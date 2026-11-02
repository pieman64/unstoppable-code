import { renderToStaticMarkup } from 'react-dom/server';
import {
  CodeGraphSummaryView,
  type CodeGraphSummaryViewData,
  type CodeGraphSummaryViewProps,
} from '../code-graph/CodeGraphSummaryView';
import { SettingsDangerConfirmBlock } from '../SettingsDangerConfirmBlock';

const SUMMARY: CodeGraphSummaryViewData = {
  enabled: true,
  state: 'ready',
  snapshotState: 'readable',
  repositories: [
    {
      repoId: 'repo',
      name: 'repo',
      state: 'ready',
      lastBuildAt: 0,
      gitHead: 'abcdef1234',
    },
  ],
  totals: {
    fileCount: 9143,
    symbolCount: 50290,
    edgeCount: 624945,
    unresolvedEdgeCount: 425625,
    filesWithErrors: 9,
    communityCount: 1439,
    flowCount: 500,
  },
  lastBuildAt: 0,
};

function render(props: Partial<CodeGraphSummaryViewProps> = {}): string {
  return renderToStaticMarkup(
    <CodeGraphSummaryView
      phase="loaded"
      summary={SUMMARY}
      loadErrorMessage="Could not load"
      buildErrorMessage={null}
      building={false}
      onRetry={() => undefined}
      onBuild={() => undefined}
      onOpenSettings={() => undefined}
      {...props}
    />,
  );
}

describe('CodeGraphSummaryView rows layout', () => {
  it('shows the counts as plain rows with Update on the first row', () => {
    const html = render({ layout: 'rows' });
    expect(html).toContain('>Index<');
    expect(html).toContain('>Health<');
    expect(html).toContain('data-testid="code-graph-metric-files"');
    expect(html).toContain((9143).toLocaleString());
    expect(html).toContain('data-testid="code-graph-summary-build"');
    expect(html).toContain('>Update<');
    // No stat cards and no solid accent button.
    expect(html).not.toContain('text-lg font-semibold');
    expect(html).not.toContain('bg-accent px-3');
  });

  it('offers Generate on the index row when nothing is generated yet', () => {
    const html = render({
      layout: 'rows',
      summary: { ...SUMMARY, snapshotState: 'missing', state: 'missing' },
    });
    expect(html).toContain('data-testid="code-graph-summary-missing"');
    expect(html).toContain('No Code Graph has been generated yet.');
    expect(html).toContain('>Generate<');
  });

  it('keeps the stat cards by default', () => {
    const html = render();
    expect(html).toContain('Update Code Graph');
    expect(html).not.toContain('>Index<');
  });
});

describe('SettingsDangerConfirmBlock row surface', () => {
  const base = {
    title: 'Archive project',
    description: 'Archived projects are kept until you delete them.',
    triggerLabel: 'Archive project…',
    confirmLabel: 'Archive',
    confirmInProgressLabel: 'Archiving…',
    onConfirmStart: (): void => undefined,
    onConfirmCancel: (): void => undefined,
    onConfirm: (): void => undefined,
    isWorking: false,
    surface: 'row' as const,
  };

  it('shows the action on the trailing edge of the row', () => {
    const html = renderToStaticMarkup(
      <SettingsDangerConfirmBlock {...base} confirming={false} />,
    );
    expect(html).toContain('Archive project');
    expect(html).toContain('Archive project…');
    expect(html).not.toContain('border-line-destructive');
  });

  it('swaps the action for Cancel and confirm in place', () => {
    const html = renderToStaticMarkup(
      <SettingsDangerConfirmBlock {...base} confirming />,
    );
    expect(html).toContain('>Cancel<');
    expect(html).toContain('>Archive<');
    expect(html).not.toContain('Archive project…');
  });
});
