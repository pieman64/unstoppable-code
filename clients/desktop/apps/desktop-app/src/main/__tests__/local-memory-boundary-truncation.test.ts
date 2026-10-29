import {
  clipAtBoundaries,
  countMemoryLines,
  LOCAL_MEMORY_MORE_MARKER,
} from '../memory/local/boundary-truncation';
import { clipMemoryIndex } from '../memory/local/store';

const MARKER = LOCAL_MEMORY_MORE_MARKER;

describe('clipAtBoundaries', () => {
  it('returns text that fits unchanged', () => {
    expect(
      clipAtBoundaries('# A\n- one\n- two', { maxBytes: 100, maxLines: 3 }),
    ).toEqual({ text: '# A\n- one\n- two', truncated: false });
  });

  it('keeps whole sections and drops the first one that does not fit', () => {
    const text = [
      '# Index',
      '- intro',
      '## Small',
      '- small fact',
      '## Large',
      `- ${'large '.repeat(30)}`,
      '## After',
      '- after fact',
    ].join('\n');
    const clipped = clipAtBoundaries(
      text,
      { maxBytes: 120 },
      { marker: MARKER },
    );
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe(
      ['# Index', '- intro', '## Small', '- small fact', MARKER].join('\n'),
    );
    expect(Buffer.byteLength(clipped.text, 'utf8')).toBeLessThanOrEqual(120);
  });

  it('does not skip ahead to a later section that would fit', () => {
    const text = ['## A', `- ${'a'.repeat(50)}`, '## B', '- b'].join('\n');
    expect(clipAtBoundaries(`- first\n${text}`, { maxBytes: 20 }).text).toBe(
      '- first',
    );
  });

  it('cuts one oversized section at a line boundary', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `- fact ${index}`);
    const clipped = clipAtBoundaries(
      ['# Memory', ...lines].join('\n'),
      { maxLines: 10 },
      { marker: MARKER },
    );
    expect(clipped.text.split('\n')).toEqual([
      '# Memory',
      ...lines.slice(0, 8),
      MARKER,
    ]);
  });

  it('never cuts inside a line', () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `- line ${index} with several words in it.`,
    ).join('\n');
    for (const maxBytes of [50, 137, 401, 999]) {
      const clipped = clipAtBoundaries(text, { maxBytes });
      for (const line of clipped.text.split('\n').filter(Boolean)) {
        expect(text.split('\n')).toContain(line);
      }
      expect(Buffer.byteLength(clipped.text, 'utf8')).toBeLessThanOrEqual(
        maxBytes,
      );
    }
  });

  it('drops a line too long for the budget instead of splitting it', () => {
    expect(clipAtBoundaries(`- ${'x'.repeat(200)}`, { maxBytes: 100 })).toEqual(
      { text: '', truncated: true },
    );
  });

  it('keeps leading whole sentences of a long note when asked', () => {
    const note =
      'Use pnpm for installs. Run verify before release. Never push to main without review from the owner.';
    expect(
      clipAtBoundaries(note, { maxChars: 60 }, { sentences: true }).text,
    ).toBe('Use pnpm for installs. Run verify before release.');
    expect(clipAtBoundaries(note, { maxChars: 60 }).text).toBe('');
  });

  it('respects lines and bytes together and leaves no dangling heading or open fence', () => {
    const text = [
      '# Memory',
      '- one',
      '## Commands',
      '```sh',
      'npm run verify',
      'npm run build',
      '```',
    ].join('\n');
    const clipped = clipAtBoundaries(text, { maxLines: 5, maxBytes: 1_000 });
    expect(clipped.text).toBe('# Memory\n- one');
  });

  it('counts a trailing newline as the end of the last line, not a new one', () => {
    expect(countMemoryLines('')).toBe(0);
    expect(countMemoryLines('a\nb')).toBe(2);
    expect(countMemoryLines('a\nb\n')).toBe(2);
    expect(countMemoryLines('a\r\nb\r\n\n')).toBe(2);
  });

  it('leaves a full 200-line index ending in a newline unchanged', () => {
    const index = `${[
      '# Memory',
      ...Array.from({ length: 150 }, (_, index) => `- fact ${index}`),
      '## Last section',
      ...Array.from({ length: 48 }, (_, index) => `- last ${index}`),
    ].join('\n')}\n`;
    expect(countMemoryLines(index)).toBe(200);
    expect(clipMemoryIndex(index)).toBe(index);
    expect(clipAtBoundaries(index, { maxLines: 200 })).toEqual({
      text: index,
      truncated: false,
    });
  });

  it('omits a marker that would not fit on its own', () => {
    expect(
      clipAtBoundaries(
        `- ${'x'.repeat(40)}`,
        { maxBytes: 10 },
        { marker: MARKER },
      ),
    ).toEqual({ text: '', truncated: true });
  });
});
