import {
  pairSplitRows,
  parseUnifiedPatch,
  type PatchRow,
} from '../unified-patch';

const SINGLE = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 111..222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -10,4 +10,5 @@ function main() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const z = 0;',
  ' const c = 4;',
  ' const d = 5;',
].join('\n');

/** `kind:old:new:text` per row, for compact assertions. */
function describeRows(rows: readonly PatchRow[]): string[] {
  return rows.map(
    (row) =>
      `${row.kind}:${String(row.oldLine)}:${String(row.newLine)}:${row.text}`,
  );
}

describe('parseUnifiedPatch', () => {
  it('parses one file, dropping git headers and tracking line numbers', () => {
    const files = parseUnifiedPatch(SINGLE);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file?.path).toBe('src/x.ts');
    expect(file?.notes).toEqual([]);
    expect(file?.hunks).toHaveLength(1);
    const hunk = file?.hunks[0];
    expect(hunk?.header).toBe('@@ -10,4 +10,5 @@ function main() {');
    expect(hunk?.section).toBe('function main() {');
    expect(hunk?.oldStart).toBe(10);
    expect(hunk?.newStart).toBe(10);
    expect(describeRows(hunk?.rows ?? [])).toEqual([
      'context:10:10:const a = 1;',
      'del:11:null:const b = 2;',
      'add:null:11:const b = 3;',
      'add:null:12:const z = 0;',
      'context:12:13:const c = 4;',
      'context:13:14:const d = 5;',
    ]);
  });

  it('restarts numbering at each hunk and defaults an omitted count to 1', () => {
    const files = parseUnifiedPatch(
      [
        'diff --git a/a b/a',
        '--- a/a',
        '+++ b/a',
        '@@ -1 +1 @@',
        '-one',
        '+uno',
        '@@ -40,2 +40,2 @@',
        ' forty',
        '-old',
        '+new',
      ].join('\n'),
    );
    const hunks = files[0]?.hunks ?? [];
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.section).toBe('');
    expect(describeRows(hunks[0]?.rows ?? [])).toEqual([
      'del:1:null:one',
      'add:null:1:uno',
    ]);
    expect(describeRows(hunks[1]?.rows ?? [])).toEqual([
      'context:40:40:forty',
      'del:41:null:old',
      'add:null:41:new',
    ]);
  });

  it('splits a whole-worktree patch into one section per file', () => {
    const files = parseUnifiedPatch(
      [
        SINGLE,
        'diff --git a/docs/b.md b/docs/b.md',
        'new file mode 100644',
        'index 000..333',
        '--- /dev/null',
        '+++ b/docs/b.md',
        '@@ -0,0 +1,2 @@',
        '+# Title',
        '+body',
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        'index 444..000',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
      ].join('\n'),
    );
    expect(files.map((file) => file.path)).toEqual([
      'src/x.ts',
      'docs/b.md',
      'gone.txt',
    ]);
    expect(files[1]?.notes).toEqual(['new file mode 100644']);
    expect(describeRows(files[1]?.hunks[0]?.rows ?? [])).toEqual([
      'add:null:1:# Title',
      'add:null:2:body',
    ]);
    expect(files[2]?.notes).toEqual(['deleted file mode 100644']);
    expect(describeRows(files[2]?.hunks[0]?.rows ?? [])).toEqual([
      'del:1:null:bye',
    ]);
  });

  it('keeps rename, mode, and binary header lines as notes without hunks', () => {
    const files = parseUnifiedPatch(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 100%',
        'rename from old.ts',
        'rename to new.ts',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/logo.png b/logo.png',
        'index 555..666 100644',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n'),
    );
    expect(files).toEqual([
      {
        path: 'new.ts',
        notes: [
          'similarity index 100%',
          'rename from old.ts',
          'rename to new.ts',
        ],
        hunks: [],
      },
      {
        path: 'run.sh',
        notes: ['old mode 100644', 'new mode 100755'],
        hunks: [],
      },
      {
        path: 'logo.png',
        notes: ['Binary files a/logo.png and b/logo.png differ'],
        hunks: [],
      },
    ]);
  });

  it('flags the row before a no-newline marker instead of rendering it as content', () => {
    const files = parseUnifiedPatch(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -1 +1 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    const rows = files[0]?.hunks[0]?.rows ?? [];
    expect(describeRows(rows)).toEqual(['del:1:null:old', 'add:null:1:new']);
    expect(rows.map((row) => row.noNewline === true)).toEqual([true, true]);
  });

  it('classifies hunk-body lines by marker even when they look like headers', () => {
    const files = parseUnifiedPatch(
      [
        'diff --git a/x.md b/x.md',
        '--- a/x.md',
        '+++ b/x.md',
        '@@ -1,4 +1,4 @@',
        ' --- a divider in content',
        '--- removed rule',
        '+++ added banner',
        ' diff --git looking text',
        ' index looking text',
      ].join('\n'),
    );
    expect(files).toHaveLength(1);
    expect(describeRows(files[0]?.hunks[0]?.rows ?? [])).toEqual([
      'context:1:1:--- a divider in content',
      'del:2:null:-- removed rule',
      'add:null:2:++ added banner',
      'context:3:3:diff --git looking text',
      'context:4:4:index looking text',
    ]);
  });

  it('treats an empty line inside a hunk as blank context', () => {
    const files = parseUnifiedPatch(
      ['--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' a', '', ' c'].join('\n'),
    );
    expect(describeRows(files[0]?.hunks[0]?.rows ?? [])).toEqual([
      'context:1:1:a',
      'context:2:2:',
      'context:3:3:c',
    ]);
  });

  it('keeps every row of a patch cut off mid-hunk', () => {
    // Oversized responses are truncated mid-hunk; the counts promise more rows.
    const files = parseUnifiedPatch(
      [
        'diff --git a/big b/big',
        '--- a/big',
        '+++ b/big',
        '@@ -1,100 +1,100 @@',
        ' one',
        '-two',
        '+tw',
      ].join('\n'),
    );
    expect(describeRows(files[0]?.hunks[0]?.rows ?? [])).toEqual([
      'context:1:1:one',
      'del:2:null:two',
      'add:null:2:tw',
    ]);
  });

  it('ignores a preamble before the first file header', () => {
    const files = parseUnifiedPatch(
      ['commit abc', 'Author: someone', '', SINGLE].join('\n'),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.notes).toEqual([]);
    expect(files[0]?.hunks[0]?.rows).toHaveLength(6);
  });

  it('opens a new section for a plain diff -u patch without diff lines', () => {
    const files = parseUnifiedPatch(
      [
        '--- a/one\t2024-01-01',
        '+++ b/one\t2024-01-02',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '--- a/two',
        '+++ b/two',
        '@@ -1 +1 @@',
        '-c',
        '+d',
      ].join('\n'),
    );
    expect(files.map((file) => file.path)).toEqual(['one', 'two']);
  });

  it('tolerates CRLF line endings and a trailing newline', () => {
    const files = parseUnifiedPatch(`${SINGLE.replace(/\n/g, '\r\n')}\r\n`);
    expect(files[0]?.path).toBe('src/x.ts');
    expect(files[0]?.hunks[0]?.rows).toHaveLength(6);
    expect(files[0]?.hunks[0]?.rows[0]?.text).toBe('const a = 1;');
  });

  it('returns nothing for an empty patch', () => {
    expect(parseUnifiedPatch('')).toEqual([]);
  });
});

describe('pairSplitRows', () => {
  it('shows context on both sides and zips a deletion run with its additions', () => {
    const rows = parseUnifiedPatch(SINGLE)[0]?.hunks[0]?.rows ?? [];
    const pairs = pairSplitRows(rows).map(
      (pair) => `${pair.left?.text ?? '∅'} | ${pair.right?.text ?? '∅'}`,
    );
    expect(pairs).toEqual([
      'const a = 1; | const a = 1;',
      'const b = 2; | const b = 3;',
      '∅ | const z = 0;',
      'const c = 4; | const c = 4;',
      'const d = 5; | const d = 5;',
    ]);
  });

  it('leaves the new side empty for unmatched deletions', () => {
    const rows = parseUnifiedPatch(
      ['--- a/f', '+++ b/f', '@@ -1,3 +1,1 @@', '-a', '-b', '+c', '-d'].join(
        '\n',
      ),
    )[0]?.hunks[0]?.rows;
    const pairs = pairSplitRows(rows ?? []).map(
      (pair) => `${pair.left?.text ?? '∅'} | ${pair.right?.text ?? '∅'}`,
    );
    // `-d` after `+c` begins a new change run rather than joining the first.
    expect(pairs).toEqual(['a | c', 'b | ∅', 'd | ∅']);
  });
});
