import { isPlanFileWrite } from '../plan-tool-input';

describe('isPlanFileWrite', () => {
  it.each([
    '/Users/test/.claude/plans/draft.md',
    '.claude/plans/draft.md',
    'C:\\Users\\test\\.claude\\plans\\draft.md',
    'C:/Users/test/.claude/plans/draft.MD',
  ])(
    'recognizes %s in object and serialized input without plan-mode state',
    (file_path) => {
      const input = { file_path, content: '# Plan' };
      expect(isPlanFileWrite('Write', input)).toBe(true);
      expect(isPlanFileWrite('Write', JSON.stringify(input))).toBe(true);
    },
  );

  it.each([
    'docs/plans/draft.md',
    'plans/draft.md',
    '/Users/test/not.claude/plans/draft.md',
    '/Users/test/.claude/plans-backup/draft.md',
    '/Users/test/.claude/plans/nested/draft.md',
    '/Users/test/.claude/plans/draft.md.bak',
    '/Users/test/.claude/plans/.md',
    '/Users/test/.claude/plans/../draft.md',
    'src/index.ts',
    '',
  ])('keeps %s as an ordinary project path', (file_path) => {
    expect(isPlanFileWrite('Write', { file_path })).toBe(false);
  });

  it.each([
    'Read',
    'Edit',
    'NotebookEdit',
    'ExitPlanMode',
    'write',
    'mcp__server__Write',
  ])('requires the native Write tool rather than %s', (toolName) => {
    expect(
      isPlanFileWrite(toolName, {
        file_path: '/Users/test/.claude/plans/draft.md',
      }),
    ).toBe(false);
  });

  it.each([
    undefined,
    null,
    1,
    true,
    [],
    {},
    { file_path: null },
    { file_path: 42 },
    { file_path: ['/Users/test/.claude/plans/draft.md'] },
    '',
    '{',
    'null',
    '[]',
    'true',
    '42',
    '{"file_path":"/Users/test/.claude/plans/draft.md","content":"unfinished',
    '{"file_path":"/Users/test/.claude/plans/draft.md"}\n\n[truncated 20 chars]',
  ])('rejects invalid or truncated input %p without throwing', (input) => {
    expect(isPlanFileWrite('Write', input)).toBe(false);
  });
});
