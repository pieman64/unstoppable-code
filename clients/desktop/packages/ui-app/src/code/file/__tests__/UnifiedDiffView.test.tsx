/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { DiffViewMode } from '@canopy/ui-shared/components';
import { UnifiedDiffView } from '../UnifiedDiffView';

const PATCH = [
  'diff --git a/x.ts b/x.ts',
  'index 111..222 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '@@ -20,2 +20,2 @@ function tail() {',
  '-old tail',
  '+new tail',
  ' end',
].join('\n');

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function mount(patch: string, viewMode?: DiffViewMode): HTMLDivElement {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(<UnifiedDiffView patch={patch} viewMode={viewMode} />);
  });
  return container;
}

function rows(container: HTMLElement, kind: string): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[data-diff-row="${kind}"]`),
  );
}

describe('UnifiedDiffView', () => {
  it('renders the patch container', () => {
    const out = renderToString(<UnifiedDiffView patch={PATCH} />);
    expect(out).toContain('data-testid="file-unified-diff"');
  });

  it('does not render git header lines', () => {
    const text = mount(PATCH).textContent ?? '';
    expect(text).not.toContain('diff --git');
    expect(text).not.toContain('index 111..222');
    expect(text).not.toContain('--- a/x.ts');
    expect(text).not.toContain('+++ b/x.ts');
    // A first hunk at line 1 needs no separator.
    expect(text).not.toContain('@@ -1,3 +1,3 @@');
  });

  it('tints exactly one row per addition and deletion', () => {
    const out = renderToString(<UnifiedDiffView patch={PATCH} />);
    expect(out.split('bg-success-subtle').length - 1).toBe(2);
    expect(out.split('bg-destructive-subtle').length - 1).toBe(2);
    const container = mount(PATCH);
    expect(rows(container, 'add')).toHaveLength(2);
    expect(rows(container, 'del')).toHaveLength(2);
    expect(rows(container, 'context')).toHaveLength(3);
  });

  it('renders old and new line numbers in the gutters', () => {
    const container = mount(PATCH);
    const cells = (row: HTMLElement | undefined): string[] =>
      Array.from(row?.querySelectorAll('td') ?? []).map(
        (cell) => cell.textContent ?? '',
      );
    const [first, last] = [
      rows(container, 'context')[0],
      rows(container, 'context')[2],
    ];
    expect(cells(first).slice(0, 2)).toEqual(['1', '1']);
    expect(cells(last).slice(0, 2)).toEqual(['21', '21']);
    expect(cells(rows(container, 'del')[0]).slice(0, 2)).toEqual(['2', '']);
    expect(cells(rows(container, 'add')[0]).slice(0, 2)).toEqual(['', '2']);
  });

  it('separates hunks with the enclosing section text', () => {
    const container = mount(PATCH);
    const separators = rows(container, 'hunk');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.textContent).toBe('function tail() {');
  });

  it('renders header-looking hunk body text as content', () => {
    const patch = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1,2 +1,2 @@',
      ' --- a divider in content',
      '-old --- text',
      '+new +++ text',
    ].join('\n');
    const container = mount(patch);
    expect(rows(container, 'add')).toHaveLength(1);
    expect(rows(container, 'del')).toHaveLength(1);
    expect(rows(container, 'context')[0]?.textContent).toContain(
      '--- a divider in content',
    );
  });

  it('pairs deletions with additions side by side in split mode', () => {
    const container = mount(PATCH, 'split');
    expect(
      container
        .querySelector('[data-testid="file-unified-diff"]')
        ?.getAttribute('data-diff-view-mode'),
    ).toBe('split');
    const changes = rows(container, 'change');
    expect(changes).toHaveLength(2);
    const sides = changes[0]?.querySelectorAll('[data-diff-cell]');
    expect(sides?.[0]?.getAttribute('data-diff-cell')).toBe('del');
    expect(sides?.[0]?.textContent).toContain('const b = 2;');
    expect(sides?.[1]?.getAttribute('data-diff-cell')).toBe('add');
    expect(sides?.[1]?.textContent).toContain('const b = 3;');
    // Context shows on both sides of one row.
    expect(
      rows(container, 'context')[0]?.querySelectorAll(
        '[data-diff-cell="context"]',
      ),
    ).toHaveLength(2);
  });

  it('fills the missing side of an unmatched change', () => {
    const container = mount(
      ['--- a/f', '+++ b/f', '@@ -1,1 +1,2 @@', ' a', '+b'].join('\n'),
      'split',
    );
    const change = rows(container, 'change')[0];
    expect(change?.querySelectorAll('[data-diff-cell="empty"]')).toHaveLength(
      2,
    );
    expect(
      change?.querySelector('[data-diff-cell="add"]')?.textContent,
    ).toContain('b');
  });

  it('shows a file header per section for a multi-file patch', () => {
    const patch = [
      PATCH,
      'diff --git a/y.ts b/y.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/y.ts',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n');
    const headers = rows(mount(patch), 'file').map((row) => row.textContent);
    expect(headers).toEqual(['x.ts', 'y.tsnew file mode 100644']);
  });

  it('shows notes, without a path header, for a single hunk-less section', () => {
    const container = mount(
      [
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n'),
    );
    expect(rows(container, 'file')).toHaveLength(0);
    expect(rows(container, 'note')[0]?.textContent).toBe(
      'Binary files a/logo.png and b/logo.png differ',
    );
  });

  it('marks a missing final newline as a muted hint, not content', () => {
    const container = mount(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(rows(container, 'add')[0]?.textContent).toContain(
      'No newline at end of file',
    );
    expect(container.textContent).not.toContain('\\ No newline');
  });

  it('renders the empty-state element when the patch is blank', () => {
    const out = renderToString(
      <UnifiedDiffView patch="" emptyState={<div>nothing here</div>} />,
    );
    expect(out).toContain('nothing here');
    expect(out).not.toContain('data-testid="file-unified-diff"');
  });

  it('renders the empty-state for a patch with nothing to show', () => {
    const out = renderToString(
      <UnifiedDiffView
        patch={'diff --git a/x b/x\nindex 1..2 100644'}
        emptyState={<div>nothing here</div>}
      />,
    );
    expect(out).toContain('nothing here');
  });
});
