import { renderToString } from 'react-dom/server';
import {
  DIFF_STATUS_DOT_COLORS,
  DiffFileTree,
  type DiffFileTreeGroup,
} from '../DiffFileTree';

const GROUPS: DiffFileTreeGroup[] = [
  {
    heading: 'Uncommitted',
    files: [
      {
        key: 'u:a.ts',
        filePath: 'a.ts',
        status: 'modified',
        insertions: 5,
        deletions: 2,
        selected: true,
      },
    ],
  },
  {
    heading: 'Committed',
    files: [
      {
        key: 'c:b.ts',
        filePath: 'b.ts',
        status: 'added',
        insertions: 12,
      },
    ],
  },
];

describe('DiffFileTree', () => {
  it('renders the file list with insertion/deletion counts and status dots', () => {
    const html = renderToString(
      <DiffFileTree
        groups={GROUPS}
        onSelect={(): void => {}}
        headerLabel="Files (2)"
      />,
    );
    expect(html).toContain('Files (2)');
    expect(html).toContain('Uncommitted');
    expect(html).toContain('Committed');
    expect(html).toContain('a.ts');
    expect(html).toContain('b.ts');
    expect(html).toContain('+<!-- -->5');
    expect(html).toContain('-<!-- -->2');
    expect(html).toContain('+<!-- -->12');
    // status dots
    expect(html).toContain('bg-warning');
    expect(html).not.toContain('bg-amber-400');
    expect(html).toContain('bg-success');
  });

  it('paints untracked files with the added green', () => {
    expect(DIFF_STATUS_DOT_COLORS.untracked).toBe(DIFF_STATUS_DOT_COLORS.added);
  });

  it('paints identity statuses with the hue-stable file roles', () => {
    // Renamed and copied share the renamed role; type-changed has its own.
    // Neither is a Tailwind palette color or a per-theme categorical slot,
    // so the legend reads the same in every theme.
    expect(DIFF_STATUS_DOT_COLORS.renamed).toBe('bg-fg-info');
    expect(DIFF_STATUS_DOT_COLORS.copied).toBe('bg-fg-info');
    expect(DIFF_STATUS_DOT_COLORS['type-changed']).toBe('bg-fg-special-strong');
  });

  it('marks the selected row distinctly', () => {
    const html = renderToString(
      <DiffFileTree groups={GROUPS} onSelect={(): void => {}} />,
    );
    expect(html).toMatch(/data-selected="true"[^>]*>[\s\S]*a\.ts/);
    expect(html).toMatch(/data-selected="false"[^>]*>[\s\S]*b\.ts/);
  });

  it('renders the collapse rail when collapsed', () => {
    const html = renderToString(
      <DiffFileTree
        groups={GROUPS}
        onSelect={(): void => {}}
        collapsed
        onToggleCollapsed={(): void => {}}
        dataTestId="my-tree"
      />,
    );
    expect(html).toContain('aria-label="Expand file tree"');
    expect(html).toContain('data-testid="my-tree-collapsed"');
    expect(html).not.toContain('a.ts');
  });

  it('renders the empty-state slot when no files are present', () => {
    const html = renderToString(
      <DiffFileTree
        groups={[
          { heading: 'Uncommitted', files: [] },
          { heading: 'Committed', files: [] },
        ]}
        onSelect={(): void => {}}
        emptyState={<p>No changes synced.</p>}
      />,
    );
    expect(html).toContain('No changes synced.');
  });

  it('renders a preamble slot above the groups', () => {
    const html = renderToString(
      <DiffFileTree
        groups={GROUPS}
        onSelect={(): void => {}}
        preamble={<button type="button">Combined diff</button>}
      />,
    );
    expect(html).toContain('Combined diff');
  });
});
