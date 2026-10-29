import {
  resolveFileLineRange,
  splitFileLineRange,
  type FileLineRange,
} from '../file-line-range';

function segmentsOf(
  content: string,
  line: number,
  lineEnd?: number,
): { range: FileLineRange; before: string; text: string; after: string } {
  const range = resolveFileLineRange(
    content,
    lineEnd === undefined ? { line } : { line, lineEnd },
  );
  const { before, range: text, after } = splitFileLineRange(content, range);
  return { range, before, text, after };
}

describe('resolveFileLineRange (CAN-4275)', () => {
  it('selects a single complete line including its terminator', () => {
    expect(resolveFileLineRange('a\nbb\nccc', { line: 2 })).toEqual({
      line: 2,
      lineEnd: 2,
      start: 2,
      end: 5,
    });
  });

  it('selects a multi-line range through the last terminator', () => {
    expect(
      resolveFileLineRange('a\nbb\nccc\nd', { line: 2, lineEnd: 3 }),
    ).toEqual({ line: 2, lineEnd: 3, start: 2, end: 9 });
  });

  it('ends the final line at end of content when it has no terminator', () => {
    expect(resolveFileLineRange('a\nbb', { line: 2 })).toEqual({
      line: 2,
      lineEnd: 2,
      start: 2,
      end: 4,
    });
  });

  it('treats a trailing newline as an empty final line', () => {
    expect(resolveFileLineRange('a\nb\n', { line: 3 })).toEqual({
      line: 3,
      lineEnd: 3,
      start: 4,
      end: 4,
    });
  });

  it('gives empty content one empty line', () => {
    expect(resolveFileLineRange('', { line: 1 })).toEqual({
      line: 1,
      lineEnd: 1,
      start: 0,
      end: 0,
    });
    expect(resolveFileLineRange('', { line: 9, lineEnd: 12 })).toEqual({
      line: 1,
      lineEnd: 1,
      start: 0,
      end: 0,
    });
  });

  it('clamps a start beyond the content to the last line', () => {
    expect(resolveFileLineRange('a\nb', { line: 40, lineEnd: 50 })).toEqual({
      line: 2,
      lineEnd: 2,
      start: 2,
      end: 3,
    });
  });

  it('clamps a range end beyond the content to the last line', () => {
    expect(resolveFileLineRange('a\nb\nc', { line: 2, lineEnd: 99 })).toEqual({
      line: 2,
      lineEnd: 3,
      start: 2,
      end: 5,
    });
  });

  it('clamps a start before the first line and a reversed end', () => {
    expect(resolveFileLineRange('a\nb', { line: 0 })).toMatchObject({
      line: 1,
      lineEnd: 1,
    });
    expect(resolveFileLineRange('a\nb', { line: -3 })).toMatchObject({
      line: 1,
    });
    expect(resolveFileLineRange('a\nb\nc', { line: 3, lineEnd: 1 })).toEqual({
      line: 3,
      lineEnd: 3,
      start: 4,
      end: 5,
    });
    expect(resolveFileLineRange('a\nb', { line: Number.NaN })).toMatchObject({
      line: 1,
    });
  });

  it('keeps CRLF terminators inside the selected lines', () => {
    expect(resolveFileLineRange('a\r\nb\r\nc', { line: 2 })).toEqual({
      line: 2,
      lineEnd: 2,
      start: 3,
      end: 6,
    });
  });

  it('counts UTF-16 offsets for non-ASCII text', () => {
    const content = 'π\n😀 x\nend';
    const range = resolveFileLineRange(content, { line: 2 });
    expect(range).toEqual({ line: 2, lineEnd: 2, start: 2, end: 7 });
    expect(content.slice(range.start, range.end)).toBe('😀 x\n');
  });
});

describe('splitFileLineRange (CAN-4275)', () => {
  it.each<[string, string, number, number | undefined]>([
    ['plain range', 'one\ntwo\nthree\nfour', 2, 3],
    ['CRLF', 'one\r\ntwo\r\nthree\r\n', 2, undefined],
    ['mixed endings', 'one\r\ntwo\nthree\r\nfour', 1, 4],
    ['lone CR stays content', 'one\rtwo\nthree', 1, undefined],
    ['unicode', 'π = 3\n😀 emoji\n中文\n', 2, 3],
    ['trailing newline final line', 'a\nb\n', 3, undefined],
    ['empty content', '', 1, undefined],
    ['blank lines', 'a\n\n\nb', 2, 3],
    ['single blank line', 'a\n\nb', 2, undefined],
    ['out of bounds', 'a\nb', 10, 20],
    ['whole file', 'a\nb\nc', 1, 3],
  ])('preserves %s byte-for-byte', (_label, content, line, lineEnd) => {
    const { before, text, after } = segmentsOf(content, line, lineEnd);
    expect(before + text + after).toBe(content);
  });

  it('splits around the requested lines', () => {
    expect(segmentsOf('one\ntwo\nthree\nfour', 2, 3)).toMatchObject({
      before: 'one\n',
      text: 'two\nthree\n',
      after: 'four',
    });
  });

  it('keeps a blank requested line as its terminator', () => {
    expect(segmentsOf('a\n\nb', 2)).toMatchObject({
      before: 'a\n',
      text: '\n',
      after: 'b',
    });
  });

  it('yields an empty range for an empty final line', () => {
    expect(segmentsOf('a\nb\n', 3)).toMatchObject({
      before: 'a\nb\n',
      text: '',
      after: '',
    });
  });

  it('does not treat a lone CR as a line break', () => {
    expect(segmentsOf('one\rtwo\nthree', 2)).toMatchObject({
      range: { line: 2, lineEnd: 2 },
      before: 'one\rtwo\n',
      text: 'three',
      after: '',
    });
  });
});
