jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runPlanWithReviewAction } from '../plan-with-review/runner';

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

function readOutputs(filePath: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function* makeMessages(
  messages: unknown[],
): AsyncGenerator<unknown, void> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}

describe('plan-with-review runner', () => {
  let tempDir: string;
  let outputFile: string;
  let stdoutWriteSpy: jest.SpyInstance;
  let originalOutputDir: string | undefined;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-plan-review-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    originalOutputDir = process.env.CANOPY_OUTPUT_DIR;
    delete process.env.CANOPY_OUTPUT_DIR;
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hands the planner and reviewer the step Ledger route', async () => {
    mockedClaudeQuery.mockImplementation(() =>
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"passed":true,"feedback":"ok"}',
          structured_output: { passed: true, feedback: 'ok' },
        },
      ]),
    );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_PIPELINE_LEDGER_TOOLS: LEDGER_TOOLS_ENV,
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '0',
    });

    expect(mockedClaudeQuery).toHaveBeenCalled();
    for (const call of mockedClaudeQuery.mock.calls) {
      expect(call[0]?.options?.mcpServers).toHaveProperty('canopy');
    }
  });

  it('redacts a configured secret value the agent echoes into its plan and feedback', async () => {
    // plan-with-review invokes the Claude SDK directly in this subprocess,
    // which inherits `secretEnv` alongside every other env var — the agent
    // CAN read a pipeline secret, and if it echoes one back into the plan,
    // research, or feedback text, every one of these outputs writes
    // straight to disk, bypassing the parent process's stdout-level
    // `SecretValueRedactor` entirely.
    const secret = 'sekret-plan-value-11223';
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `Research notes with ${secret}`,
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `Plan draft containing ${secret}`,
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `{"passed":true,"feedback":"Looks good, ${secret}"}`,
            structured_output: {
              passed: true,
              feedback: `Looks good, ${secret}`,
            },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '0',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).not.toContain(secret);
    expect(outputs.feedback).not.toContain(secret);
    const plansFile = fs.readFileSync(
      path.join(tempDir, '0', 'plan-with-review.md'),
      'utf8',
    );
    expect(plansFile).not.toContain(secret);
    const researchFile = fs.readFileSync(
      path.join(tempDir, '0', 'plan-research.md'),
      'utf8',
    );
    expect(researchFile).not.toContain(secret);
    const transcriptFile = fs.readFileSync(outputs.transcript_file, 'utf8');
    expect(transcriptFile).not.toContain(secret);
  });

  it('redacts a multi-line configured secret from the transcript even though JSON-escaping the record would otherwise hide it', async () => {
    // Controller-followup5 regression: redacting the already-serialized
    // transcript text cannot match a multi-line secret, because
    // JSON.stringify escapes the secret's own newlines into `\n`
    // two-character sequences before the string-based redaction pass ever
    // runs. Fixed by redacting each transcript record's structured leaves
    // BEFORE serialization.
    const secret = 'SYNTHETIC-ALPHA\nSYNTHETIC-BRAVO';
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: secret,
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
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
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '{"passed":true,"feedback":"Looks good"}',
            structured_output: { passed: true, feedback: 'Looks good' },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '0',
    });

    const outputs = readOutputs(outputFile);
    const transcriptFile = fs.readFileSync(outputs.transcript_file, 'utf8');
    const records = transcriptFile
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain('SYNTHETIC-ALPHA');
    expect(JSON.stringify(records)).not.toContain('SYNTHETIC-BRAVO');
  });

  it('does not corrupt the transcript_file JSONL when a configured secret collides with real JSON structure', async () => {
    // Independent-review regression (followup7): the transcript passed to
    // `writeReviewOutputs` is ALREADY structurally redacted record-by-record
    // via `createTranscriptCapture` — a second raw `redactValues` pass over
    // that already-serialized text can corrupt otherwise-valid JSON when a
    // configured secret coincidentally matches the transcript's own
    // structure (e.g. `","subtype":` between two ordinary fields), even
    // though the secret was never actually present.
    const secret = '","subtype":';
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Research notes',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Plan draft',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '{"passed":true,"feedback":"Looks good"}',
            structured_output: { passed: true, feedback: 'Looks good' },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '0',
    });

    const outputs = readOutputs(outputFile);
    const transcriptFile = fs.readFileSync(outputs.transcript_file, 'utf8');
    const records = transcriptFile
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(records.length).toBeGreaterThan(0);
  });

  it('redacts a multi-line configured secret from text_response and feedback even when echoed verbatim', async () => {
    // Independent-review regression: normalizing BEFORE redacting collapses
    // a multi-line secret's own internal newlines, so the subsequent exact
    // match against the (still multi-line) configured secret value fails and
    // the collapsed-but-still-complete secret leaks into `text_response`/
    // `feedback`.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Research notes, nothing sensitive.',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `Plan draft:\n${secret}\ndone.`,
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: `{"passed":true,"feedback":"Looks good:\\n${secret}\\ndone."}`,
            structured_output: {
              passed: true,
              feedback: `Looks good:\n${secret}\ndone.`,
            },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '0',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs.text_response).not.toContain('line2-abcdef');
    expect(outputs.feedback).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs.feedback).not.toContain('line2-abcdef');
  });

  it('revises plans until validation passes and reuses CANOPY_LOG_FILE', async () => {
    const logFile = path.join(tempDir, 'step.log');
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Research summary',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Draft plan v1',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '{"passed":false,"feedback":"Add verification steps."}',
            structured_output: {
              passed: false,
              feedback: 'Add verification steps.',
            },
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Draft plan v2',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '{"passed":true,"feedback":"Looks good."}',
            structured_output: {
              passed: true,
              feedback: 'Looks good.',
            },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LOG_FILE: logFile,
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '2',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.revision_count).toBe('1');
    expect(outputs.text_response).toBe('Draft plan v2');
    expect(outputs.feedback).toBe('Looks good.');
    expect(outputs.transcript_file).toBe(logFile);
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(5);
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Research summary',
      })}\n`,
    );
    expect(
      fs.existsSync(
        path.join(tempDir, '0', 'plan-with-review-transcript.jsonl'),
      ),
    ).toBe(false);
  });

  it('writes a fallback transcript artifact when no log file env is present', async () => {
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Research summary',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Draft plan v1',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '{"passed":true,"feedback":"Looks good."}',
            structured_output: {
              passed: true,
              feedback: 'Looks good.',
            },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runPlanWithReviewAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Plan the current task.',
      INPUT_MAX_REVISIONS: '0',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.transcript_file).toBe(
      path.join(tempDir, '0', 'plan-with-review-transcript.jsonl'),
    );
    expect(fs.existsSync(outputs.transcript_file)).toBe(true);
  });
});
