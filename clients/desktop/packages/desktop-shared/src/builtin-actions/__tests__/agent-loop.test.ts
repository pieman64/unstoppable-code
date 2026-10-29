jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runAgentLoopAction } from '../agent-loop/runner';

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

function parseJsonLine(line: string): unknown {
  const parsed: unknown = JSON.parse(line);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('agent-loop runner', () => {
  let tempDir: string;
  let outputFile: string;
  let originalCwd: string;
  let stdoutWriteSpy: jest.SpyInstance;
  let originalOutputDir: string | undefined;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-loop-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    originalCwd = process.cwd();
    originalOutputDir = process.env.CANOPY_OUTPUT_DIR;
    delete process.env.CANOPY_OUTPUT_DIR;
    process.chdir(tempDir);
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    if (originalOutputDir === undefined) {
      delete process.env.CANOPY_OUTPUT_DIR;
    } else {
      process.env.CANOPY_OUTPUT_DIR = originalOutputDir;
    }
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hands every iteration the step Ledger route', async () => {
    mockedClaudeQuery.mockImplementation(() =>
      makeMessages([
        { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
      ]),
    );

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_PIPELINE_LEDGER_TOOLS: LEDGER_TOOLS_ENV,
      INPUT_PROMPT: 'Fix the issue.',
      INPUT_CHECK_COMMAND: 'true',
      INPUT_MAX_ITERATIONS: '1',
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const options = mockedClaudeQuery.mock.calls[0]?.[0]?.options;
    expect(options?.mcpServers).toHaveProperty('canopy');
    expect(options?.allowedTools).toContain('mcp__canopy__AddFeedEntry');
  });

  it('loops until the check command passes and records final outputs', async () => {
    const doneFile = path.join(tempDir, 'done.txt');
    let callCount = 0;

    mockedClaudeQuery.mockImplementation(() => {
      callCount += 1;
      if (callCount === 2) {
        fs.writeFileSync(doneFile, 'done\n', 'utf8');
      }

      return makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `iteration-${String(callCount)}`,
        },
      ]) as ReturnType<typeof claudeQuery>;
    });

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Fix the issue and rerun checks.',
      INPUT_CHECK_COMMAND: `test -f ${JSON.stringify(doneFile)}`,
      INPUT_MAX_ITERATIONS: '3',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_CONTEXT_STRATEGY: 'summary',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('iterations_run=2');
    expect(outputs).toContain('exit_reason=check_passed');
    expect(outputs).toContain('text_response=iteration-2');
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
    expect(mockedClaudeQuery.mock.calls[1]?.[0]?.prompt).toContain(
      'Previous iterations and check feedback:',
    );

    const transcriptLines = fs
      .readFileSync(
        path.join(tempDir, '0', 'agent-loop-transcript.jsonl'),
        'utf8',
      )
      .trim()
      .split('\n')
      .map((line) => parseJsonLine(line));
    expect(transcriptLines[0]).toMatchObject({
      type: 'canopy_user_prompt',
      original_text: 'Fix the issue and rerun checks.',
    });
    const firstIterationRecord = transcriptLines.find(
      (line): line is Record<string, unknown> =>
        isRecord(line) &&
        line.type === 'agent_loop_iteration' &&
        line.iteration === 1,
    );
    expect(firstIterationRecord).toBeDefined();
    expect(
      firstIterationRecord &&
        isRecord(firstIterationRecord.check) &&
        firstIterationRecord.check.passed === false,
    ).toBe(true);
    const firstEventRecord = transcriptLines.find(
      (line): line is Record<string, unknown> =>
        isRecord(line) &&
        line.type === 'agent_loop_event' &&
        line.iteration === 1,
    );
    expect(firstEventRecord).toBeDefined();
  });

  it.each([
    ['no configured values', [] as string[]],
    ['configured values that do not match', ['UNRELATED_VALUE_XYZ']],
  ])(
    'records the submitted prompt byte-for-byte with %s',
    async (_label, secretValues) => {
      // `redactNormalizedText` returns the NORMALIZED projection, so the
      // recorded "submitted prompt" lost its multiline indentation and blank
      // lines even when nothing was redacted, and no longer matched the prompt
      // actually submitted to the provider.
      const multiline = [
        'Fix the issue:',
        '',
        '    - indented bullet',
        '\t- tab bullet',
        '',
        'Then rerun checks.',
      ].join('\n');
      mockedClaudeQuery.mockImplementation(
        () =>
          makeMessages([
            {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'ok',
            },
          ]) as ReturnType<typeof claudeQuery>,
      );

      await runAgentLoopAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PROMPT: multiline,
        INPUT_CHECK_COMMAND: 'true',
        INPUT_MAX_ITERATIONS: '1',
        INPUT_PERMISSION_PRESET: 'read_only',
        INPUT_CONTEXT_STRATEGY: 'summary',
        ...(secretValues.length > 0
          ? { CANOPY_AGENT_SECRET_VALUES: JSON.stringify(secretValues) }
          : {}),
      });

      // The provider gets the real prompt, unchanged.
      expect(mockedClaudeQuery.mock.calls[0]?.[0]?.prompt).toBe(multiline);
      const promptRecord = fs
        .readFileSync(
          path.join(tempDir, '0', 'agent-loop-transcript.jsonl'),
          'utf8',
        )
        .trim()
        .split('\n')
        .map((line) => parseJsonLine(line))
        .find(
          (line): line is Record<string, unknown> =>
            isRecord(line) && line.type === 'canopy_user_prompt',
        );
      // The recorded copy is the submitted prompt, not its normalized form.
      expect(promptRecord?.original_text).toBe(multiline);
    },
  );

  it('masks a whitespace-reformatted configured value in the prompt record while keeping the rest of the formatting', async () => {
    // Normalized MATCHING is still required: a configured value whose internal
    // whitespace differs from the prompt's must still be masked. Only the
    // splice offsets change, so every unmatched byte survives.
    const configured = 'BEGIN-LOOP-KEY line-two END-LOOP-KEY';
    const asWritten = 'BEGIN-LOOP-KEY\n   line-two\nEND-LOOP-KEY';
    const multiline = [
      'Use this credential:',
      '',
      asWritten,
      '',
      '    - keep this indent',
    ].join('\n');
    mockedClaudeQuery.mockImplementation(
      () =>
        makeMessages([
          { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
        ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: multiline,
      INPUT_CHECK_COMMAND: 'true',
      INPUT_MAX_ITERATIONS: '1',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_CONTEXT_STRATEGY: 'summary',
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([configured]),
    });

    const promptRecord = fs
      .readFileSync(
        path.join(tempDir, '0', 'agent-loop-transcript.jsonl'),
        'utf8',
      )
      .trim()
      .split('\n')
      .map((line) => parseJsonLine(line))
      .find(
        (line): line is Record<string, unknown> =>
          isRecord(line) && line.type === 'canopy_user_prompt',
      );
    const recorded = promptRecord?.original_text;
    expect(typeof recorded).toBe('string');
    expect(recorded).not.toContain('BEGIN-LOOP-KEY');
    // Surrounding formatting is untouched: blank lines and the indent survive.
    expect(recorded).toContain('Use this credential:\n\n');
    expect(recorded).toContain('\n\n    - keep this indent');
  });

  it('redacts a configured secret value the agent echoes into its final response', async () => {
    // agent-loop invokes the Claude SDK directly with `secretEnv` merged
    // into its own process.env (so the agent CAN read a pipeline secret if
    // it needs to) — if the agent echoes that value back, `text_response`,
    // `text_response_file`, and `transcript_file` all bypass the parent's
    // stdout-level SecretValueRedactor entirely (they write straight to the
    // action output file / run-dir files via `setOutput`/`writeOutputFile`),
    // so this runner must redact them itself, the same way agent-prompt does.
    const secret = 'sekret-loop-value-98765';
    const doneFile = path.join(tempDir, 'done.txt');
    fs.writeFileSync(doneFile, 'done\n', 'utf8');

    mockedClaudeQuery.mockImplementation(
      () =>
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `the value is ${secret}`,
          },
        ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Fix the issue and rerun checks.',
      INPUT_CHECK_COMMAND: `test -f ${JSON.stringify(doneFile)}`,
      INPUT_MAX_ITERATIONS: '3',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_CONTEXT_STRATEGY: 'summary',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain(secret);
    const finalText = fs.readFileSync(
      path.join(tempDir, '0', 'agent-loop-final.txt'),
      'utf8',
    );
    expect(finalText).not.toContain(secret);
    const transcript = fs.readFileSync(
      path.join(tempDir, '0', 'agent-loop-transcript.jsonl'),
      'utf8',
    );
    expect(transcript).not.toContain(secret);
  });

  it('redacts a multi-line configured secret from text_response even when echoed verbatim', async () => {
    // Independent-review regression: normalizing BEFORE redacting collapses
    // a multi-line secret's own internal newlines, so the subsequent exact
    // match against the (still multi-line) configured secret value fails and
    // the collapsed-but-still-complete secret leaks into `text_response`.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const doneFile = path.join(tempDir, 'done.txt');
    fs.writeFileSync(doneFile, 'done\n', 'utf8');

    mockedClaudeQuery.mockImplementation(
      () =>
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `Here it is:\n${secret}\ndone.`,
          },
        ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Fix the issue and rerun checks.',
      INPUT_CHECK_COMMAND: `test -f ${JSON.stringify(doneFile)}`,
      INPUT_MAX_ITERATIONS: '3',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_CONTEXT_STRATEGY: 'summary',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs).not.toContain('line2-abcdef');
    expect(outputs).not.toContain('END-FAKE-KEY');
  });

  it('redacts a multi-line configured secret from a normalized summary embedded in a later iteration transcript record', async () => {
    // Controller-followup5 regression: the `summary` context strategy embeds
    // a `normalizeSingleLine`d copy of a prior iteration's raw output into
    // the NEXT iteration's prompt, which is also emitted as a
    // `canopy_user_prompt` transcript record. Normalizing collapses a
    // multi-line configured secret's own internal newlines before the
    // record-level redaction (an unnormalized, raw-value substring match)
    // ever sees it — the same hazard `redactNormalizedText` closes for
    // output fields, just reached via a transcript record instead.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const marker = path.join(tempDir, 'iteration-marker');
    const checkCommand = `test -f ${JSON.stringify(marker)} && exit 0 || (touch ${JSON.stringify(marker)} && exit 1)`;

    mockedClaudeQuery
      .mockImplementationOnce(
        () =>
          makeMessages([
            {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: `Here it is:\n${secret}\ndone.`,
            },
          ]) as ReturnType<typeof claudeQuery>,
      )
      .mockImplementationOnce(
        () =>
          makeMessages([
            {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'All fixed now.',
            },
          ]) as ReturnType<typeof claudeQuery>,
      );

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Fix the issue and rerun checks.',
      INPUT_CHECK_COMMAND: checkCommand,
      INPUT_MAX_ITERATIONS: '3',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_CONTEXT_STRATEGY: 'summary',
    });

    const transcriptFile = fs.readFileSync(
      path.join(tempDir, '0', 'agent-loop-transcript.jsonl'),
      'utf8',
    );
    expect(transcriptFile).not.toContain('BEGIN-FAKE-KEY');
    expect(transcriptFile).not.toContain('line2-abcdef');
    expect(transcriptFile).not.toContain('END-FAKE-KEY');
  });

  it('fails when the check never passes and reports max_iterations', async () => {
    mockedClaudeQuery.mockImplementation(
      () =>
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'still working',
          },
        ]) as ReturnType<typeof claudeQuery>,
    );

    await expect(
      runAgentLoopAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PROMPT: 'Keep trying.',
        INPUT_CHECK_COMMAND: 'exit 1',
        INPUT_MAX_ITERATIONS: '2',
      }),
    ).rejects.toThrow(/exhausted max_iterations/);

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('iterations_run=2');
    expect(outputs).toContain('exit_reason=max_iterations');
    expect(outputs).toContain('text_response=still working');
  });

  it('does not corrupt the transcript_file JSONL when a configured secret collides with real JSON structure', async () => {
    // Independent-review regression (followup7): `transcript.serialize()`
    // is ALREADY structurally redacted record-by-record via
    // `createTranscriptCapture` — a second raw `redactValues` pass over
    // that already-serialized text can corrupt otherwise-valid JSON when a
    // configured secret coincidentally matches the transcript's own
    // structure (e.g. `","subtype":` between two ordinary fields), even
    // though the secret was never actually present.
    const secret = '","subtype":';
    const doneFile = path.join(tempDir, 'done.txt');
    fs.writeFileSync(doneFile, 'done\n', 'utf8');

    mockedClaudeQuery.mockImplementation(
      () =>
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'ordinary response',
          },
        ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentLoopAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Fix the issue and rerun checks.',
      INPUT_CHECK_COMMAND: `test -f ${JSON.stringify(doneFile)}`,
      INPUT_MAX_ITERATIONS: '3',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_CONTEXT_STRATEGY: 'summary',
    });

    const transcript = fs.readFileSync(
      path.join(tempDir, '0', 'agent-loop-transcript.jsonl'),
      'utf8',
    );
    const records = transcript
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(records.length).toBeGreaterThan(0);
  });

  it('validates context_strategy values', async () => {
    await expect(
      runAgentLoopAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PROMPT: 'No-op',
        INPUT_CHECK_COMMAND: 'true',
        INPUT_CONTEXT_STRATEGY: 'invalid',
      }),
    ).rejects.toThrow(/context_strategy must be one of/);
  });
});
