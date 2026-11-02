/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApprovalFileChangePreview } from '../ApprovalFileChangePreview';
import type { ApprovalFileChangeInput } from '../approval-file-change-rows';
import { REPLAY_BLOCK_CLASS } from '../../../lib/replay-privacy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join(
    '\n',
  );
}

describe('ApprovalFileChangePreview', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    change: ApprovalFileChangeInput,
    mode: 'compact' | 'expanded' = 'compact',
    onExpand?: () => void,
  ): void {
    act(() => {
      root.render(
        <ApprovalFileChangePreview
          change={change}
          mode={mode}
          onExpand={onExpand}
        />,
      );
    });
  }

  function query(testId: string): Element | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('renders deleted and added rows with text that does not rely on color', () => {
    render({ kind: 'edit', oldText: 'before', newText: 'after' });
    const rows = Array.from(
      container.querySelectorAll(
        '[data-testid="approval-file-change-rows"] li',
      ),
    );
    expect(rows.map((row) => row.getAttribute('data-row-kind'))).toEqual([
      'deleted',
      'added',
    ]);
    expect(rows[0]?.textContent).toBe('−Deleted line: before');
    expect(rows[1]?.textContent).toBe('+Added line: after');
    expect(container.textContent).toContain('Proposed edit');
  });

  it('renders supplied text as escaped text, never markup', () => {
    render({
      kind: 'write',
      content: '<img src=x onerror="alert(1)"> **bold**',
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain(
      '<img src=x onerror="alert(1)"> **bold**',
    );
    expect(container.textContent).toContain('Proposed content');
  });

  it('blocks the change from session replay', () => {
    render({ kind: 'write', content: 'secret' });
    expect(
      query('approval-file-change-preview')?.classList.contains(
        REPLAY_BLOCK_CLASS,
      ),
    ).toBe(true);
  });

  it('labels a replace-all edit without inventing occurrence counts', () => {
    render({ kind: 'edit', oldText: 'a', newText: 'b', replaceAll: true });
    expect(query('approval-file-change-replace-all')?.textContent).toBe(
      'Replaces every occurrence',
    );
  });

  it('shows empty, unchanged, and indeterminate states', () => {
    render({ kind: 'write', content: '' });
    expect(query('approval-file-change-state')?.textContent).toBe(
      'Empty content',
    );
    render({ kind: 'edit', oldText: 'same', newText: 'same' });
    expect(query('approval-file-change-state')?.textContent).toBe(
      'No text change',
    );
    render({ kind: 'edit', oldText: 'same', newText: 'same', truncated: true });
    expect(query('approval-file-change-state')?.textContent).toBe(
      'No difference in the available text',
    );
    expect(query('approval-file-change-source-truncated')).not.toBeNull();
  });

  it('offers the full change when only the compact display was shortened', () => {
    const onExpand = jest.fn();
    render({ kind: 'write', content: lines('line', 20) }, 'compact', onExpand);
    expect(container.textContent).toContain('12 more lines');
    expect(query('approval-file-change-source-truncated')).toBeNull();
    const expand = query('approval-file-change-expand');
    expect(expand?.textContent).toBe('View full change');
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('offers the available change and warns when the source was capped', () => {
    render(
      { kind: 'write', content: lines('line', 20), truncated: true },
      'compact',
      jest.fn(),
    );
    expect(query('approval-file-change-expand')?.textContent).toBe(
      'View available change',
    );
    expect(query('approval-file-change-source-truncated')).not.toBeNull();
  });

  it('does not offer expansion when nothing was hidden', () => {
    render(
      { kind: 'write', content: 'short', truncated: true },
      'compact',
      jest.fn(),
    );
    expect(query('approval-file-change-expand')).toBeNull();
    expect(query('approval-file-change-source-truncated')).not.toBeNull();
  });

  it('shows every line in the expanded view, keeps the warning, and offers no further expansion', () => {
    render(
      { kind: 'write', content: lines('line', 20), truncated: true },
      'expanded',
      jest.fn(),
    );
    expect(container.textContent).toContain('line20');
    expect(container.textContent).not.toContain('more lines');
    expect(query('approval-file-change-expand')).toBeNull();
    expect(query('approval-file-change-source-truncated')).not.toBeNull();
  });

  it('marks shortened lines and invisible ending changes', () => {
    render({ kind: 'edit', oldText: 'a\n', newText: `a${'z'.repeat(300)}` });
    expect(query('approval-file-change-shortened')?.textContent).toBe(
      '… (line shortened)',
    );
    render({ kind: 'edit', oldText: 'a\n', newText: 'a' });
    expect(query('approval-file-change-ending')?.textContent).toBe(
      'No newline at end',
    );
  });

  it('keeps a maximum-line Write fully reviewable without mounting a node per line', () => {
    const content = '\n'.repeat(19_996) + 'end\n';
    render({ kind: 'write', content }, 'expanded');
    const rows = query('approval-file-change-rows');
    expect(query('approval-file-change-block-text')?.textContent).toBe(
      '  \n'.repeat(19_996) + '  end',
    );
    expect(query('approval-file-change-annotations')?.textContent).toContain(
      'Blank lines in this block: 1–19996',
    );
    expect(rows?.querySelectorAll('*').length).toBeLessThan(50);
    expect(query('approval-file-change-expand')).toBeNull();
  });

  it('keeps both maximum Edit sides accessible with bounded expanded DOM', () => {
    render(
      {
        kind: 'edit',
        oldText: '\n'.repeat(20_000),
        newText: 'x\n'.repeat(10_000),
      },
      'expanded',
    );
    const rows = query('approval-file-change-rows');
    const blocks = container.querySelectorAll(
      '[data-testid="approval-file-change-block-text"]',
    );
    expect(blocks[0]?.textContent).toBe('− \n'.repeat(19_999) + '− ');
    expect(blocks[1]?.textContent).toBe('+ x\n'.repeat(9_999) + '+ x');
    expect(rows?.textContent).toContain('Deleted');
    expect(rows?.textContent).toContain('Added');
    expect(rows?.querySelectorAll('*').length).toBeLessThan(50);
  });

  it('preserves escaped text and invisible line differences in expanded blocks', () => {
    render(
      { kind: 'edit', oldText: '\r\n<img>\r\n', newText: '\n<script>' },
      'expanded',
    );
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain('<img>');
    expect(container.textContent).toContain('<script>');
    expect(container.textContent).toContain('Blank line');
    expect(container.textContent).toContain('CRLF');
    expect(container.textContent).toContain('No newline at end');
  });

  it('distinguishes a blank source line from literal Blank line text', () => {
    render({ kind: 'write', content: '\n' }, 'expanded');
    const blank = container.textContent;
    render({ kind: 'write', content: 'Blank line\n' }, 'expanded');
    expect(container.textContent).not.toBe(blank);

    render({ kind: 'write', content: '\nBlank line\n\n' }, 'expanded');
    expect(query('approval-file-change-block-text')?.textContent).toBe(
      '  \n  Blank line\n  ',
    );
    expect(query('approval-file-change-annotations')?.textContent).toBe(
      'Blank lines in this block: 1, 3',
    );
  });

  it('keeps newline annotations separate from identical literal suffixes', () => {
    render({ kind: 'write', content: 'x\r\n' }, 'expanded');
    const crlf = container.textContent;
    render({ kind: 'write', content: 'x  [CRLF]\n' }, 'expanded');
    expect(container.textContent).not.toBe(crlf);

    render(
      {
        kind: 'write',
        content: 'x\r\nx  [CRLF]\nx  [No newline at end]',
      },
      'expanded',
    );
    expect(query('approval-file-change-block-text')?.textContent).toBe(
      '  x\n  x  [CRLF]\n  x  [No newline at end]',
    );
    const annotations = query('approval-file-change-annotations');
    expect(annotations?.textContent).toContain('CRLF lines in this block: 1');
    expect(annotations?.textContent).toContain('No newline at end');

    render({ kind: 'write', content: 'x  [No newline at end]\n' }, 'expanded');
    expect(query('approval-file-change-block-text')?.textContent).toBe(
      '  x  [No newline at end]',
    );
    expect(query('approval-file-change-annotations')).toBeNull();
  });

  it('distinguishes an absent final newline from a literal ending marker', () => {
    render({ kind: 'write', content: 'x' }, 'expanded');
    const noFinalNewline = container.textContent;
    render({ kind: 'write', content: 'x  [No newline at end]\n' }, 'expanded');
    expect(container.textContent).not.toBe(noFinalNewline);
  });

  it('makes blank-only content visible and accessible', () => {
    render({ kind: 'write', content: '\n' });
    expect(query('approval-file-change-blank')?.textContent).toBe('Blank line');
    expect(query('approval-file-change-state')).toBeNull();
  });

  it('expands shortened context and restores its complete text', () => {
    const onExpand = jest.fn();
    const change: ApprovalFileChangeInput = {
      kind: 'edit',
      oldText: `${'c'.repeat(201)}\nold`,
      newText: `${'c'.repeat(201)}\nnew`,
    };
    render(change, 'compact', onExpand);
    expect(query('approval-file-change-expand')?.textContent).toBe(
      'View full change',
    );
    render(change, 'expanded');
    expect(container.textContent).toContain('c'.repeat(201));
    expect(query('approval-file-change-expand')).toBeNull();
  });
});
