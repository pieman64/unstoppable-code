jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runCondenserAction } from '../condenser/runner';

type ClaudeQueryMock = (
  ...args: Parameters<typeof claudeQuery>
) => AsyncGenerator<unknown, void>;

const mockedClaudeQuery: jest.MockedFunction<ClaudeQueryMock> =
  jest.mocked(claudeQuery);

const LEDGER_TOOLS_ENV = JSON.stringify({
  mcpServers: {
    canopy: {
      type: 'http',
      url: 'http://127.0.0.1:1/canopy/mcp/worktree-session/pipeline',
      headers: { Authorization: 'Bearer route-token-123' },
    },
  },
  allowedTools: ['mcp__canopy__AddFeedEntry'],
  instructions: 'LEDGER BLOCK',
});

async function* makeMessages(
  messages: unknown[],
): AsyncGenerator<unknown, void> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}

describe('condenser runner', () => {
  let tempDir: string;
  let outputFile: string;
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-condenser-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('never gives the helper-like condenser the Ledger tools', async () => {
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'summary',
          structured_output: { summary: 'short' },
        },
      ]),
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_PIPELINE_LEDGER_TOOLS: LEDGER_TOOLS_ENV,
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'structured-summary',
    });

    expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      'mcpServers',
    );
  });

  it('controller structured normalization regression: masks eligible reflowed secret inside JSON summary', async () => {
    const secret = 'correct horse battery staple';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'summary',
          structured_output: {
            summary: 'leaked: correct horse\nbattery staple',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'structured-summary',
    });
    const outputs = fs.readFileSync(outputFile, 'utf8');
    const summary = outputs
      .split('\n')
      .find((line) => line.startsWith('summary='))
      ?.slice(8);
    const parsed: unknown = JSON.parse(summary ?? '{}');
    expect((parsed as { summary?: string }).summary).toBe('leaked: ***');
  });

  it('preserves an ordinary markdown thematic break in structured-summary when no secret actually matches', async () => {
    // Independent-review regression (followup7): the previous "did this
    // leaf actually match?" check looked for the literal `***` placeholder
    // IN THE OUTPUT, which false-positives whenever the original text
    // already contained `***` on its own (a markdown thematic break / bold-
    // italic delimiter, routine in agent-authored summaries) — collapsing
    // that leaf's whitespace even though no secret was configured to match
    // it there, violating no-secret fidelity.
    const secret = 'sekret-condenser-value-24680';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'summary',
          structured_output: {
            summary: 'Section one\n\n***\n\nSection two',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'structured-summary',
    });
    const outputs = fs.readFileSync(outputFile, 'utf8');
    const summary = outputs
      .split('\n')
      .find((line) => line.startsWith('summary='))
      ?.slice(8);
    const parsed: unknown = JSON.parse(summary ?? '{}');
    expect((parsed as { summary?: string }).summary).toBe(
      'Section one\n\n***\n\nSection two',
    );
  });

  it('preserves internal multi-space runs in structured-summary output when no secret matches', async () => {
    // Independent-review regression (followup7 round 2): the intermediate
    // fix for the `***`-sniffing false positive replaced it with an
    // unconditional `normalizeSingleLine` pass applied to the WHOLE
    // JSON.stringify'd structured summary — collapsing legitimate internal
    // multi-space runs inside an unrelated JSON string leaf even though no
    // secret was configured to match there. Only `clip`'s own truncation
    // marker (a literal newline) needs stripping for single-line output.
    const secret = 'sekret-condenser-value-24680';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'summary',
          structured_output: {
            summary: 'two  spaces   here',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'structured-summary',
    });
    const outputs = fs.readFileSync(outputFile, 'utf8');
    const summary = outputs
      .split('\n')
      .find((line) => line.startsWith('summary='))
      ?.slice(8);
    const parsed: unknown = JSON.parse(summary ?? '{}');
    expect((parsed as { summary?: string }).summary).toBe('two  spaces   here');
  });

  it('condenses key outputs from provided text without invoking Claude', async () => {
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_TEXT: 'key: value\nplain line\nanother: pair',
      INPUT_STRATEGY: 'key-outputs',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('summary=key: value another: pair');
  });

  it('redacts a multi-line configured secret from key-outputs even though line-filtering would otherwise break it apart', async () => {
    // Independent-review regression (followup7): `summarizeKeyOutputs`
    // drops any line without a `:`/`=`. If redaction ran AFTER filtering
    // (the previous order), a multi-line secret with a non-matching middle
    // line would have that middle line dropped, breaking the surviving
    // fragments' contiguity so the whole-value exact-match redaction pass
    // could never find them — both fragments would leak unredacted.
    const secret = 'auth: alpha123456\nbody-no-colon-segment\nend: beta987654';
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: `notes: ok\n${secret}\nmore: data`,
      INPUT_STRATEGY: 'key-outputs',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('alpha123456');
    expect(outputs).not.toContain('beta987654');
  });

  it('redacts a key-outputs secret that only becomes an exact match after per-line trimming reconstitutes it', async () => {
    // Independent-review regression (followup7 round 2): redacting the
    // WHOLE source text ONLY before `summarizeKeyOutputs` runs is not
    // enough on its own — `summarizeKeyOutputs` trims each line
    // (`.map((line) => line.trim())`) AFTER that single redaction pass. A
    // configured secret whose lines have leading/trailing whitespace in the
    // real input (so it never appears as an exact contiguous substring
    // BEFORE trimming) can be reconstituted into an exact match by that
    // trim step, with no further redaction pass ever running — leaking the
    // secret verbatim into `summary_file` and in normalized form into
    // `summary`.
    const secret = 'line-one-aaaa\nline-two-bbbb';
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'key: line-one-aaaa\n    line-two-bbbb: tail',
      INPUT_STRATEGY: 'key-outputs',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('line-one-aaaa');
    expect(outputs).not.toContain('line-two-bbbb');
    const summaryFile = fs.readFileSync(
      path.join(tempDir, '0', 'summary.txt'),
      'utf8',
    );
    expect(summaryFile).not.toContain('line-one-aaaa');
    expect(summaryFile).not.toContain('line-two-bbbb');
  });

  it('does not leak a key-outputs secret truncated by max_chars before the closing redaction pass could run', async () => {
    // Independent-review regression (followup7 round 3): `summarizeKeyOutputs`/
    // `summarizeRecentEvents` used to call `clip()` INTERNALLY as their own
    // last step, before ever returning to the caller — so a closing
    // redaction pass applied to their return value ran AFTER truncation,
    // not before it. A secret reconstituted by line-trimming that happens
    // to straddle the `max_chars` boundary would be cut in half by that
    // internal clip before the closing pass could ever match the whole
    // value — the exact clip-before-redact ordering hazard `llm-summary`
    // already guards against, reintroduced here via a different code path.
    // Fixed by moving `clip()` out of the filter helpers entirely, so
    // every redaction pass runs on the full, unclipped filtered text.
    const secret = 'line-one-aaaa\nline-two-bbbb';
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'key: line-one-aaaa\n    line-two-bbbb: tail',
      INPUT_STRATEGY: 'key-outputs',
      INPUT_MAX_CHARS: '25',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('line-one-aaaa');
    expect(outputs).not.toContain('line-two');
    const summaryFile = fs.readFileSync(
      path.join(tempDir, '0', 'summary.txt'),
      'utf8',
    );
    expect(summaryFile).not.toContain('line-one-aaaa');
    expect(summaryFile).not.toContain('line-two');
  });

  it('does not leak a truncated secret fragment when llm-summary clips before redacting', async () => {
    // Independent-review regression (followup7): `summary`/`normalizedSummary`
    // were clipped to `max_chars` BEFORE the exact-match redaction pass ran.
    // A secret straddling the clip boundary survives as a shorter fragment
    // that no longer matches the full configured value, leaking a prefix of
    // a real credential into a durable artifact.
    const secret = 'sk-live-abcdef0123456789XYZ';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `The key is ${secret} and that is everything.`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'llm-summary',
      INPUT_MAX_CHARS: '25',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('sk-live-abcdef');
    const summaryFile = fs.readFileSync(
      path.join(tempDir, '0', 'summary.txt'),
      'utf8',
    );
    expect(summaryFile).not.toContain('sk-live-abcdef');
  });

  it('redacts a configured secret value the agent echoes into its LLM summary', async () => {
    // condenser invokes the Claude SDK directly in this subprocess, which
    // inherits `secretEnv` alongside every other env var — the agent CAN
    // read a pipeline secret, and if it echoes one back into its summary,
    // `summary`/`summary_file` write straight to disk (`setOutput`/
    // `writeOutputFile`), bypassing the parent's stdout-level
    // `SecretValueRedactor` entirely.
    const secret = 'sekret-condenser-value-24680';

    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `Condensed summary containing ${secret}`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'llm-summary',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain(secret);
    const summaryFile = fs.readFileSync(
      path.join(tempDir, '0', 'summary.txt'),
      'utf8',
    );
    expect(summaryFile).not.toContain(secret);
  });

  it('redacts a multi-line configured secret from the structured-summary strategy', async () => {
    // Independent-review regression: the `structured-summary` strategy's
    // `summary` came from `JSON.stringify(result.structured)` with no
    // redaction of the structured value at all before stringifying — a
    // secret in a structured leaf reached any later string-based
    // redaction pass only as its JSON-escaped, unmatchable form. Fixed by
    // redacting the structured value (via `redactStructuredValue`) before
    // it's stringified.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `{"summary":"found the secret here"}`,
          structured_output: { summary: `found ${secret} here` },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'structured-summary',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs).not.toContain('line2-abcdef');
    expect(outputs).not.toContain('END-FAKE-KEY');
    const summaryFile = fs.readFileSync(
      path.join(tempDir, '0', 'summary.txt'),
      'utf8',
    );
    expect(summaryFile).not.toContain('BEGIN-FAKE-KEY');
    expect(summaryFile).not.toContain('line2-abcdef');
    expect(summaryFile).not.toContain('END-FAKE-KEY');
  });

  it('redacts a multi-line configured secret from the live stdout event stream even though JSON-escaping the event would otherwise hide it', async () => {
    // Controller-followup5 regression: condenser writes raw SDK events
    // straight to stdout as JSON — a multi-line secret echoed verbatim
    // survives serialization only as an escaped `\n` two-character
    // sequence, which the parent process's stdout-level SecretValueRedactor
    // (a string-based, byte-stream matcher) can never exact-match against
    // the still-multi-line raw secret value. Fixed by redacting each
    // event's structured leaves BEFORE `JSON.stringify`.
    const secret = 'SYNTHETIC-ALPHA\nSYNTHETIC-BRAVO';

    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: secret }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: secret,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'llm-summary',
    });

    const stdoutWritten = stdoutWriteSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('');
    expect(stdoutWritten).not.toContain('SYNTHETIC-ALPHA');
    expect(stdoutWritten).not.toContain('SYNTHETIC-BRAVO');
  });

  it('redacts a multi-line configured secret from summary even when echoed verbatim', async () => {
    // Independent-review regression: normalizing BEFORE redacting collapses
    // a multi-line secret's own internal newlines, so the subsequent exact
    // match against the (still multi-line) configured secret value fails and
    // the collapsed-but-still-complete secret leaks into `summary`.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';

    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `Condensed summary:\n${secret}\ndone.`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some long context to condense.',
      INPUT_STRATEGY: 'llm-summary',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs).not.toContain('line2-abcdef');
    expect(outputs).not.toContain('END-FAKE-KEY');
  });
});
