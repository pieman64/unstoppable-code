/**
 * Server-rendered tests for the shared {@link TurnDiffSummary}. Validates the
 * file-count header, per-status icon color treatment, and rename "A → B"
 * tooltip behavior.
 */
import { renderToString } from 'react-dom/server';
import { TurnDiffSummary } from '../TurnDiffSummary';

describe('TurnDiffSummary', () => {
  it('renders the file-count header for a single file', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          {
            path: 'src/foo.ts',
            status: 'modified',
            insertions: 1,
            deletions: 0,
          },
        ]}
      />,
    );
    // SSR splits adjacent text/number nodes with `<!-- -->` comments.
    expect(html).toContain('1<!-- --> <!-- -->file changed');
    expect(html).toContain('+<!-- -->1');
    expect(html).toContain('-<!-- -->0');
  });

  it('pluralizes for multiple files', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          { path: 'a.ts', status: 'modified', insertions: 1, deletions: 0 },
          { path: 'b.ts', status: 'modified', insertions: 0, deletions: 1 },
        ]}
      />,
    );
    expect(html).toContain('2<!-- --> <!-- -->files changed');
  });

  it('renders the rename status with the "previous → current" tooltip', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          {
            path: 'b.ts',
            previousPath: 'a.ts',
            status: 'renamed',
            insertions: 0,
            deletions: 0,
          },
        ]}
      />,
    );
    expect(html).toContain('data-file-status="renamed"');
    // CAN-2799: the "A → B" text is a rich hover tooltip (see
    // TurnDiffSummary.tooltip.test.tsx), never a native title.
    expect(html).not.toContain('title=');
  });

  it('uses the success tint for added files', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          { path: 'a.ts', status: 'added', insertions: 10, deletions: 0 },
        ]}
      />,
    );
    expect(html).toContain('data-file-status="added"');
    expect(html).toContain('bg-success');
  });

  it('uses the destructive tint for deleted files', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          { path: 'a.ts', status: 'deleted', insertions: 0, deletions: 10 },
        ]}
      />,
    );
    expect(html).toContain('data-file-status="deleted"');
    expect(html).toContain('fg-destructive');
  });

  it('renders the repo caption when supplied', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          {
            path: 'a.ts',
            status: 'modified',
            insertions: 1,
            deletions: 1,
            repoName: 'service-a',
          },
        ]}
      />,
    );
    expect(html).toContain('service-a');
  });

  it('renders only the filename for Windows paths', () => {
    const html = renderToString(
      <TurnDiffSummary
        files={[
          {
            path: 'C:\\Users\\Tommy\\project\\src\\WorkspaceSettingsModal.tsx',
            status: 'modified',
            insertions: 1,
            deletions: 1,
          },
        ]}
      />,
    );
    expect(html).toContain('>WorkspaceSettingsModal.tsx</span>');
    expect(html).not.toContain('title=');
  });

  it('starts collapsed when the file count exceeds the default threshold', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      insertions: 1,
      deletions: 0,
    }));
    const html = renderToString(<TurnDiffSummary files={files} />);
    // Header rendered, individual rows not.
    expect(html).toContain('12<!-- --> <!-- -->files changed');
    expect(html).not.toContain('data-file-path="f0.ts"');
  });

  it('honors defaultExpanded=true for large file sets', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      insertions: 1,
      deletions: 0,
    }));
    const html = renderToString(
      <TurnDiffSummary files={files} defaultExpanded />,
    );
    expect(html).toContain('data-file-path="f0.ts"');
  });

  it('honors the dataTestId hook', () => {
    const html = renderToString(
      <TurnDiffSummary files={[]} dataTestId="diff-sum" />,
    );
    expect(html).toContain('data-testid="diff-sum"');
  });
});
