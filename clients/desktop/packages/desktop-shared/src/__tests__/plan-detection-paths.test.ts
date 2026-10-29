import { extractCandidatePaths } from '../plan-detection-paths';
import type { PersistedChatBlock } from '../types';

describe('extractCandidatePaths', () => {
  it('pulls paths from tool_use input arg keys', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'tool_use',
        toolUseId: 't1',
        toolName: 'Write',
        input: JSON.stringify({
          file_path: 'docs/superpowers/specs/a.md',
          content: 'x',
        }),
      },
      {
        type: 'tool_use',
        toolUseId: 't2',
        toolName: 'Read',
        input: JSON.stringify({ path: 'src/b.ts' }),
      },
      {
        type: 'tool_use',
        toolUseId: 't3',
        toolName: 'NotebookEdit',
        input: JSON.stringify({ notebook_path: 'nb/c.ipynb' }),
      },
    ];
    expect(extractCandidatePaths(blocks)).toEqual(
      expect.arrayContaining([
        'docs/superpowers/specs/a.md',
        'src/b.ts',
        'nb/c.ipynb',
      ]),
    );
  });

  it('pulls absolutePath from file_references', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'file_references',
        references: [{ displayPath: 'a.md', absolutePath: '/repo/docs/a.md' }],
      },
    ];
    expect(extractCandidatePaths(blocks)).toContain('/repo/docs/a.md');
  });

  it('extracts path-like tokens from text and strips wrapping punctuation/backticks', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'text',
        text: 'Saved the spec to `docs/superpowers/specs/plan.md`. Also see (docs/notes/x.md).',
      },
    ];
    const out = extractCandidatePaths(blocks);
    expect(out).toContain('docs/superpowers/specs/plan.md');
    expect(out).toContain('docs/notes/x.md');
  });

  it('ignores non-path text and malformed tool_use JSON', () => {
    const blocks: PersistedChatBlock[] = [
      { type: 'text', text: 'no paths here, just prose about 3/4 of things' },
      { type: 'tool_use', toolUseId: 't', toolName: 'Bash', input: 'not json' },
    ];
    // "3/4" has no filename tail; "not json" parses to nothing.
    expect(extractCandidatePaths(blocks)).toEqual([]);
  });

  it('dedupes repeated paths', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'tool_use',
        toolUseId: 't1',
        toolName: 'Write',
        input: JSON.stringify({ file_path: 'a.md' }),
      },
      { type: 'text', text: 'wrote `a.md`' },
    ];
    expect(extractCandidatePaths(blocks)).toEqual(['a.md']);
  });
});
