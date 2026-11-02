import {
  summarizeToolError,
  summarizeToolOutcome,
  TOOL_BLOCKED_FALLBACK_REASON,
  TOOL_ERROR_FALLBACK_REASON,
} from '../tool-outcome-summary';
import { USER_DENIED_MESSAGE } from '@canopy/protocol/approvals';

const ESC = String.fromCharCode(27);

describe('summarizeToolError', () => {
  it('takes the stderr line of a Bash exit-code result', () => {
    expect(
      summarizeToolError(
        'Exit code 1\nchecking mcp files\nzsh: no matches found: ~/.claude/mcp-*.json',
      ),
    ).toBe('zsh: no matches found: ~/.claude/mcp-*.json');
  });

  it('takes the first line of other errors', () => {
    expect(
      summarizeToolError(
        'MCP error -32602: Invalid arguments\n  at call (server.js:1)',
      ),
    ).toBe('MCP error -32602: Invalid arguments');
  });

  it('strips a hook prefix, ANSI sequences and extra whitespace', () => {
    expect(
      summarizeToolError(
        'PreToolUse:Bash hook error: Command   not\tallowed here',
      ),
    ).toBe('Command not allowed here');
    expect(summarizeToolError(`${ESC}[31merror:${ESC}[0m bad   input`)).toBe(
      'error: bad input',
    );
  });

  it('keeps the text after a hyperlink ended with ST', () => {
    const link = `${ESC}]8;;file:///repo/a.c${ESC}\\a.c${ESC}]8;;${ESC}\\`;
    expect(
      summarizeToolError(`Exit code 1\n${link}:3: error: missing semicolon`),
    ).toBe('a.c:3: error: missing semicolon');
  });

  it('never splits a character when truncating', () => {
    const reason = summarizeToolError(`${'a'.repeat(118)}😀 and more`);
    expect(reason).toBe(`${'a'.repeat(118)}😀…`);
  });

  it('truncates a long line with an ellipsis', () => {
    const reason = summarizeToolError(`File not found: ${'a'.repeat(300)}`);
    expect(reason.length).toBeLessThanOrEqual(120);
    expect(reason.endsWith('…')).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['empty output', ''],
    ['only whitespace', ' \n\t\n'],
    ['only an exit code', 'Exit code 1'],
    ['an exit code then blank lines', 'Exit code 2\n\n  \n'],
    ['a lone JSON brace', '{\n  "error": true\n}'],
    [
      'an exit code inside the chosen line',
      'Command exited with exit code 127',
    ],
  ])('falls back to plain words for %s', (_name, output) => {
    expect(summarizeToolError(output)).toBe(TOOL_ERROR_FALLBACK_REASON);
  });

  it('never says an exit code', () => {
    for (const output of [
      'Exit code 1',
      'Exit code 1\nExit code 1',
      'exit code 3\nfatal: not a git repository',
      'Error: exit code 1',
    ]) {
      expect(summarizeToolError(output)).not.toMatch(/exit code/i);
    }
  });
});

describe('summarizeToolOutcome', () => {
  it('names who stopped a blocked step', () => {
    expect(
      summarizeToolOutcome({ outcome: 'blocked', output: USER_DENIED_MESSAGE }),
    ).toBe('Denied by you');
  });

  it('says a safety check stopped a blocked step it cannot classify', () => {
    expect(summarizeToolOutcome({ outcome: 'blocked' })).toBe(
      TOOL_BLOCKED_FALLBACK_REASON,
    );
    expect(
      summarizeToolOutcome({ outcome: 'blocked', output: 'something else' }),
    ).toBe(TOOL_BLOCKED_FALLBACK_REASON);
  });

  it('summarizes an errored step from its output', () => {
    expect(
      summarizeToolOutcome({
        outcome: 'failed',
        output: 'Exit code 1\nzsh: no matches found: *.json',
      }),
    ).toBe('zsh: no matches found: *.json');
    expect(summarizeToolOutcome({ outcome: 'failed' })).toBe(
      TOOL_ERROR_FALLBACK_REASON,
    );
  });
});
