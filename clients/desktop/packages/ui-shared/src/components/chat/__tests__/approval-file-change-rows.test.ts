import {
  APPROVAL_FILE_CHANGE_EXPANDED_LIMITS,
  approvalFileChangeExpansionCopy,
  buildApprovalFileChangeRows,
  type ApprovalFileChangeRow,
} from '../approval-file-change-rows';

/** Compact text form: sign, text, and markers per row. */
function describe_(rows: readonly ApprovalFileChangeRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'omitted') return `… ${row.block} ${row.count}`;
    const sign = { context: ' ', deleted: '-', added: '+', content: '=' }[
      row.kind
    ];
    return `${sign}${row.text}${row.shortened ? '…' : ''}${
      row.endingMarker ? ` [${row.endingMarker}]` : ''
    }`;
  });
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join(
    '\n',
  );
}

describe('buildApprovalFileChangeRows', () => {
  it('shows a one-line edit as a deleted and an added row', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'const a = 1;',
      newText: 'const a = 2;',
    });
    expect(result.state).toBe('changes');
    expect(describe_(result.rows)).toEqual(['-const a = 1;', '+const a = 2;']);
    expect(result.previewTruncated).toBe(false);
    expect(result.sourceTruncated).toBe(false);
  });

  it('drops shared lines and keeps one context line on each side', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'a\nb\nc\nold\nx\ny\nz',
      newText: 'a\nb\nc\nnew\nx\ny\nz',
    });
    expect(describe_(result.rows)).toEqual([' c', '-old', '+new', ' x']);
  });

  it('does not let the shared prefix and suffix overlap', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'a\na',
      newText: 'a\na\na',
    });
    expect(describe_(result.rows)).toEqual([' a', '+a', ' a']);
  });

  it('shows an insertion and a deletion', () => {
    expect(
      describe_(
        buildApprovalFileChangeRows({
          kind: 'edit',
          oldText: '',
          newText: 'added',
        }).rows,
      ),
    ).toEqual(['+added']);
    expect(
      describe_(
        buildApprovalFileChangeRows({
          kind: 'edit',
          oldText: 'gone',
          newText: '',
        }).rows,
      ),
    ).toEqual(['-gone']);
  });

  it('reports a complete unchanged edit', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'same',
      newText: 'same',
    });
    expect(result.state).toBe('unchanged');
    expect(result.rows).toEqual([]);
  });

  it('never claims capped equal prefixes are unchanged', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'same prefix',
      newText: 'same prefix',
      truncated: true,
    });
    expect(result.state).toBe('indeterminate');
    expect(result.sourceTruncated).toBe(true);
  });

  it('reports empty Write content and shows blank lines as rows', () => {
    expect(
      buildApprovalFileChangeRows({ kind: 'write', content: '' }).state,
    ).toBe('empty');
    expect(
      describe_(
        buildApprovalFileChangeRows({ kind: 'write', content: 'a\n\nb\n' })
          .rows,
      ),
    ).toEqual(['=a', '=', '=b']);
  });

  it('marks a CRLF-only change on the CRLF rows', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'a\r\nb\r\n',
      newText: 'a\nb\n',
    });
    expect(describe_(result.rows)).toEqual([
      '-a [crlf]',
      '-b [crlf]',
      '+a',
      '+b',
    ]);
  });

  it('does not mark endings when both sides use CRLF', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'a\r\nb\r\n',
      newText: 'a\r\nc\r\n',
    });
    expect(describe_(result.rows)).toEqual([' a', '-b', '+c']);
  });

  it('marks reordered mixed line endings even when both sides contain CRLF and LF', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: 'a\r\nb\n',
      newText: 'a\nb\r\n',
    });
    expect(describe_(result.rows)).toEqual([
      '-a [crlf]',
      '-b',
      '+a',
      '+b [crlf]',
    ]);
  });

  it('marks Write CRLF and missing final newline without changing supplied text', () => {
    expect(
      describe_(
        buildApprovalFileChangeRows({
          kind: 'write',
          content: 'a\r\nb',
        }).rows,
      ),
    ).toEqual(['=a [crlf]', '=b [no-final-newline]']);
  });

  it('offers expansion when only a context line was shortened', () => {
    const context = 'c'.repeat(201);
    const change = {
      kind: 'edit',
      oldText: `${context}\nold\nend`,
      newText: `${context}\nnew\nend`,
    } as const;
    const compact = buildApprovalFileChangeRows(change);
    expect(compact.previewTruncated).toBe(true);
    const expanded = buildApprovalFileChangeRows(
      change,
      APPROVAL_FILE_CHANGE_EXPANDED_LIMITS,
    );
    expect(expanded.rows[0]).toMatchObject({ text: context, shortened: false });
    expect(expanded.previewTruncated).toBe(false);
  });

  it('marks a final-newline change on the side without it', () => {
    expect(
      describe_(
        buildApprovalFileChangeRows({
          kind: 'edit',
          oldText: 'a\nb\n',
          newText: 'a\nb',
        }).rows,
      ),
    ).toEqual([' a', '-b', '+b [no-final-newline]']);
    expect(
      describe_(
        buildApprovalFileChangeRows({
          kind: 'edit',
          oldText: 'a',
          newText: 'a\n',
        }).rows,
      ),
    ).toEqual(['-a [no-final-newline]', '+a']);
  });

  it('limits rows and keeps both sides of a large replacement visible', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: lines('old', 100),
      newText: lines('new', 2),
    });
    const rows = describe_(result.rows);
    expect(rows).toEqual([
      '-old1',
      '-old2',
      '-old3',
      '-old4',
      '-old5',
      '-old6',
      '… deleted 94',
      '+new1',
      '+new2',
    ]);
    expect(result.previewTruncated).toBe(true);
    expect(result.sourceTruncated).toBe(false);
  });

  it('splits the row budget evenly when both sides are large', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: lines('old', 50),
      newText: lines('new', 50),
    });
    const kinds = result.rows.map((row) => row.kind);
    expect(kinds.filter((kind) => kind === 'deleted')).toHaveLength(4);
    expect(kinds.filter((kind) => kind === 'added')).toHaveLength(4);
    expect(kinds.filter((kind) => kind === 'omitted')).toHaveLength(2);
  });

  it('gives context only the rows left after the change', () => {
    const result = buildApprovalFileChangeRows({
      kind: 'edit',
      oldText: `ctx\n${lines('old', 4)}\nend`,
      newText: `ctx\n${lines('new', 4)}\nend`,
    });
    expect(result.rows.map((row) => row.kind)).toEqual([
      'deleted',
      'deleted',
      'deleted',
      'deleted',
      'added',
      'added',
      'added',
      'added',
    ]);
    expect(result.previewTruncated).toBe(false);
  });

  it('shortens long rows without splitting a surrogate pair', () => {
    const long = `${'x'.repeat(199)}😀tail`;
    const result = buildApprovalFileChangeRows({
      kind: 'write',
      content: long,
    });
    const row = result.rows[0];
    expect(row?.kind).toBe('content');
    if (row?.kind !== 'content') return;
    expect(row.shortened).toBe(true);
    expect(row.text).toBe('x'.repeat(199));
    expect(result.previewTruncated).toBe(true);
  });

  it('keeps compact and source truncation independent', () => {
    const capped = buildApprovalFileChangeRows({
      kind: 'write',
      content: 'short',
      truncated: true,
    });
    expect(capped.previewTruncated).toBe(false);
    expect(capped.sourceTruncated).toBe(true);

    const long = buildApprovalFileChangeRows({
      kind: 'write',
      content: lines('line', 20),
    });
    expect(long.previewTruncated).toBe(true);
    expect(long.sourceTruncated).toBe(false);
    expect(describe_(long.rows).at(-1)).toBe('… content 12');
  });

  it('removes every display limit in the expanded view', () => {
    const content = `${lines('line', 3000)}\n${'y'.repeat(5000)}`;
    const result = buildApprovalFileChangeRows(
      { kind: 'write', content },
      APPROVAL_FILE_CHANGE_EXPANDED_LIMITS,
    );
    expect(result.rows).toHaveLength(3001);
    expect(result.rows.some((row) => row.kind === 'omitted')).toBe(false);
    expect(result.previewTruncated).toBe(false);
    const last = result.rows.at(-1);
    expect(last?.kind === 'content' ? last.text.length : 0).toBe(5000);
  });
});

describe('approvalFileChangeExpansionCopy', () => {
  it('names a full change only when nothing was capped upstream', () => {
    expect(approvalFileChangeExpansionCopy(false)).toEqual({
      action: 'View full change',
      title: 'Full change',
    });
    expect(approvalFileChangeExpansionCopy(true)).toEqual({
      action: 'View available change',
      title: 'Available change',
    });
  });
});
