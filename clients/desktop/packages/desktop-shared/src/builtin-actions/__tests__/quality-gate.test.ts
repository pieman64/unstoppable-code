jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runQualityGateAction } from '../quality-gate/runner';

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

describe('quality-gate runner', () => {
  let tempDir: string;
  let outputFile: string;
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-quality-gate-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('never gives the helper-like gate the Ledger tools', async () => {
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":90,"feedback":"fine"}',
          structured_output: { score: 90, feedback: 'fine' },
        },
      ]),
    );

    await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_PIPELINE_LEDGER_TOOLS: LEDGER_TOOLS_ENV,
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
    });

    const options = mockedClaudeQuery.mock.calls[0]?.[0]?.options;
    expect(options).not.toHaveProperty('mcpServers');
    expect(JSON.stringify(options?.systemPrompt ?? '')).not.toContain(
      'LEDGER BLOCK',
    );
  });

  it('writes a finite score when the model answers with something that is not a number', async () => {
    // `Number('high')` is `NaN`, and `String(NaN)` is the literal `NaN`. Every
    // downstream `if:` comparison against it then reads false, silently — the
    // exact hazard the docs describe and `router` already guards against.
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":"high","feedback":"looks fine"}',
          structured_output: { score: 'high', feedback: 'looks fine' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    // A gate that could not score does not pass, which is the right outcome —
    // the point is that `score` is a number a pipeline can compare, not the
    // string `NaN`.
    await expect(
      runQualityGateAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_TEXT: 'Some artifact to review.',
        INPUT_THRESHOLD: '50',
      }),
    ).rejects.toThrow('did not meet threshold');

    const outputs = readOutputs(outputFile);
    expect(outputs.score).toBe('0');
    expect(outputs.passed).toBe('false');
  });

  it('never writes a configured numeric value as the score, and says so in its failure', async () => {
    // Coercion alone does not protect a configured value that already IS a
    // number: `Number(123456)` is `123456`, so `score` - and the threshold
    // error derived from it - carried the configured value verbatim.
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":123456,"feedback":"looks fine"}',
          structured_output: { score: 123456, feedback: 'looks fine' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    const failure = await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['123456']),
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
    }).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.score).not.toContain('123456');
    expect(outputs.score).toBe('0');
    // `passed` and the thrown threshold message are derived from the same
    // sanitized score, so neither can reintroduce the value.
    expect(outputs.passed).toBe('false');
    expect(failure).toContain('did not meet threshold');
    expect(failure).not.toContain('123456');
  });

  it.each([
    ['an array whose coercion is the value', [123456]],
    ['an exponent form of the value', '1.23456e5'],
    ['a hex form of the value', '0x1e240'],
  ])(
    'never writes a configured value the model returns as %s',
    async (_name, score) => {
      // Masking the SUPPLIED text is not enough: none of these shapes
      // contains the configured value until coercion canonicalizes them into
      // it, so the emitted text has to be checked too. `passed` and the
      // threshold message derive from the same sanitized score.
      const structured: Record<string, unknown> = {
        score,
        feedback: 'looks fine',
      };
      mockedClaudeQuery.mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: JSON.stringify(structured),
            structured_output: structured,
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

      const failure = await runQualityGateAction({
        CANOPY_OUTPUT: outputFile,
        CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['123456']),
        INPUT_TEXT: 'Some artifact to review.',
        INPUT_THRESHOLD: '50',
      }).then(
        () => undefined,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );

      const outputs = readOutputs(outputFile);
      expect(outputs.score).not.toContain('123456');
      expect(outputs.score).toBe('0');
      expect(outputs.passed).toBe('false');
      expect(failure).toContain('did not meet threshold');
      expect(failure).not.toContain('123456');
    },
  );

  it('keeps an unconfigured score that looks like a secret', async () => {
    // Control: with nothing configured the model's own number is written
    // exactly, and the gate passes on it.
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":123456,"feedback":"looks fine"}',
          structured_output: { score: 123456, feedback: 'looks fine' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([
        'unrelated-configured-value',
      ]),
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.score).toBe('123456');
    expect(outputs.passed).toBe('true');
  });

  it('redacts a configured secret value the agent echoes into its feedback', async () => {
    // quality-gate invokes the Claude SDK directly in this subprocess,
    // which inherits `secretEnv` alongside every other env var — the agent
    // CAN read a pipeline secret, and if it echoes one back into its
    // feedback, `feedback`/`transcript_file` write straight to disk,
    // bypassing the parent process's stdout-level `SecretValueRedactor`
    // entirely.
    const secret = 'sekret-quality-value-33445';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `{"score":90,"feedback":"Great, but watch out for ${secret}"}`,
          structured_output: {
            score: 90,
            feedback: `Great, but watch out for ${secret}`,
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.feedback).not.toContain(secret);
    const transcriptFile = fs.readFileSync(outputs.transcript_file, 'utf8');
    expect(transcriptFile).not.toContain(secret);
  });

  it('redacts a multi-line configured secret from the transcript even though JSON-escaping the record would otherwise hide it', async () => {
    // Controller-followup5 regression: redacting the already-serialized
    // transcript text (`redactValues(transcript.serialize(), secretValues)`)
    // cannot match a multi-line secret, because JSON.stringify escapes the
    // secret's own newlines into `\n` two-character sequences before the
    // string-based redaction pass ever runs. Fixed by redacting each
    // transcript record's structured leaves BEFORE serialization.
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
          structured_output: { score: 90, feedback: 'see result' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
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

  it('redacts a single-line configured secret from feedback whose internal whitespace differs from the raw echo', async () => {
    // Independent-review regression: `feedback` used plain `redactValues`
    // instead of `redactNormalizedText`, so a secret whose internal
    // whitespace the agent reformatted while echoing it (e.g. a newline
    // where the secret has a plain space) was never redacted, unlike every
    // sibling free-text output field in the other builtin actions.
    const secret = 'correct horse battery staple';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":90,"feedback":"see below"}',
          structured_output: {
            score: 90,
            feedback: 'The passphrase is correct horse\nbattery staple.',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.feedback).not.toContain(secret);
    expect(outputs.feedback).not.toContain('correct horse');
    expect(outputs.feedback).not.toContain('battery staple');
  });

  it('does not corrupt the transcript_file JSONL when a configured secret collides with real JSON structure', async () => {
    // Independent-review regression (followup7): `transcript.serialize()`
    // is ALREADY structurally redacted record-by-record via
    // `createTranscriptCapture` (each record's leaves are redacted before
    // `JSON.stringify`), so a SECOND raw `redactValues` pass over that
    // already-serialized text is not just redundant, it's unsafe — a
    // configured secret value can coincidentally match the transcript's OWN
    // JSON structure (e.g. `","subtype":` between two ordinary fields) and
    // get replaced with `***`, corrupting otherwise-valid JSON that never
    // contained the secret at all.
    const secret = '","subtype":';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":90,"feedback":"ordinary response"}',
          structured_output: { score: 90, feedback: 'ordinary response' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runQualityGateAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some artifact to review.',
      INPUT_THRESHOLD: '50',
    });

    const outputs = readOutputs(outputFile);
    const transcriptFile = fs.readFileSync(outputs.transcript_file, 'utf8');
    const records = transcriptFile
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(records.length).toBeGreaterThan(0);
  });
});
