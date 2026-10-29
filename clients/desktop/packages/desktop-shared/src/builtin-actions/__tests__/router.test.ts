jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runRouterAction } from '../router/runner';

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

describe('router runner', () => {
  let tempDir: string;
  let outputFile: string;
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-router-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('never gives the helper-like router the Ledger tools', async () => {
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"route":"a","confidence":0.9,"reasoning":"fine"}',
          structured_output: { route: 'a', confidence: 0.9, reasoning: 'fine' },
        },
      ]),
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_PIPELINE_LEDGER_TOOLS: LEDGER_TOOLS_ENV,
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });

    expect(mockedClaudeQuery.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      'mcpServers',
    );
  });

  it('redacts a configured secret value the agent echoes into its reasoning', async () => {
    // router invokes the Claude SDK directly in this subprocess, which
    // inherits `secretEnv` alongside every other env var — the agent CAN
    // read a pipeline secret, and if it echoes one back into its
    // reasoning, `reasoning`/`transcript_file` write straight to disk,
    // bypassing the parent process's stdout-level `SecretValueRedactor`
    // entirely.
    const secret = 'sekret-router-value-55667';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `{"route":"a","confidence":0.9,"reasoning":"Matched because of ${secret}"}`,
          structured_output: {
            route: 'a',
            confidence: 0.9,
            reasoning: `Matched because of ${secret}`,
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.reasoning).not.toContain(secret);
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
          structured_output: {
            route: 'a',
            confidence: 0.9,
            reasoning: 'see result',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
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

  it('redacts a configured secret value the agent echoes into route/confidence, not just reasoning', async () => {
    // Independent-review regression: `result.structured`'s `route` and
    // `confidence` were trusted as constrained by the request schema's
    // `enum: routes`, but `extractFinalResult`'s fallback paths (pulling
    // structured output from the model's raw text or an unvalidated tool
    // call) don't actually enforce that constraint — nothing guarantees
    // `route` is ever one of the configured `routes`, so it needs the same
    // redaction as `reasoning`. `confidence` is coerced through
    // `Number(...)` so a smuggled string can't pass through verbatim.
    const secret = 'sekret-router-route-77123';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `{"route":"${secret}","confidence":"0.9 ${secret}","reasoning":"ok"}`,
          structured_output: {
            route: secret,
            confidence: `0.9 ${secret}`,
            reasoning: 'ok',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.route).not.toContain(secret);
    expect(outputs.confidence).not.toContain(secret);
  });

  it('redacts a single-line configured secret from reasoning whose internal whitespace differs from the raw echo', async () => {
    // Independent-review regression: `reasoning`/`route` used plain
    // `redactValues` instead of `redactNormalizedText`, so a secret whose
    // internal whitespace the agent reformatted while echoing it (e.g. a
    // newline where the secret has a plain space) was never redacted,
    // unlike every sibling free-text output field in the other builtin
    // actions.
    const secret = 'correct horse battery staple';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"route":"a","confidence":0.9,"reasoning":"see below"}',
          structured_output: {
            route: 'a',
            confidence: 0.9,
            reasoning: 'Matched because correct horse\nbattery staple.',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.reasoning).not.toContain(secret);
    expect(outputs.reasoning).not.toContain('correct horse');
    expect(outputs.reasoning).not.toContain('battery staple');
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
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"route":"a","confidence":0.9,"reasoning":"ordinary"}',
          structured_output: {
            route: 'a',
            confidence: 0.9,
            reasoning: 'ordinary',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
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

describe('confidence output contract', () => {
  // Through the real runner: the model's `confidence` must reach the step
  // output as a finite number, and model text must never reach it verbatim.
  // Before this work the router wrote `String(parsed.confidence ?? 0)`, so
  // `"high"` arrived as `high`; a bare `Number(...)` would write `NaN`.
  let tempDir = '';
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-router-conf-'));
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ['a number', 0.9, '0.9'],
    ['a numeric string', '0.9', '0.9'],
    ['a padded numeric string', ' 0.9 ', '0.9'],
    ['a word', 'high', '0'],
    ['a secret-looking string', 'SUPERSECRETVALUE', '0'],
    ['an empty string', '', '0'],
    ['true', true, '1'],
    ['missing', undefined, '0'],
    ['an exponent string', '1.5e-1', '0.15'],
    ['an array holding one number', [0.9], '0.9'],
  ])('writes %s (%p) as %p', async (_name, confidence, expected) => {
    const outputFile = path.join(tempDir, 'canopy-output.txt');
    const structured: Record<string, unknown> = { route: 'a', reasoning: 'r' };
    if (confidence !== undefined) structured.confidence = confidence;
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
    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['SUPERSECRETVALUE']),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });
    expect(readOutputs(outputFile).confidence).toBe(expected);
  });

  it.each([
    ['a number', 123456],
    ['a numeric string', '123456'],
    ['a padded numeric string', ' 123456 '],
    ['an array whose coercion is the value', [123456]],
    ['an exponent form of the value', '1.23456e5'],
    ['a hex form of the value', '0x1e240'],
  ])(
    'never writes a configured value the model returns as %s',
    async (_name, confidence) => {
      // Coercion alone does not protect a configured value that already IS a
      // number: `Number(123456)` is `123456`, so the step output carried the
      // configured value verbatim. Checking only the SUPPLIED text is not
      // enough either — `[123456]`, `'1.23456e5'` and `'0x1e240'` do not
      // contain the configured value until coercion canonicalizes them into
      // it. Both the supplied text and the emitted text are checked, and a
      // masked value falls back to the documented finite `0`.
      const outputFile = path.join(tempDir, 'canopy-output.txt');
      const structured: Record<string, unknown> = {
        route: 'a',
        confidence,
        reasoning: 'r',
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
      await runRouterAction({
        CANOPY_OUTPUT: outputFile,
        CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['123456']),
        INPUT_TEXT: 'Some text to route.',
        INPUT_ROUTES: JSON.stringify(['a', 'b']),
      });
      const outputs = readOutputs(outputFile);
      expect(outputs.confidence).not.toContain('123456');
      expect(outputs.confidence).toBe('0');
    },
  );

  it('keeps an unconfigured number that looks like a secret', async () => {
    // Control: the same digits with nothing configured stay exactly as the
    // model answered, so masking is driven by the configured values only.
    const outputFile = path.join(tempDir, 'canopy-output.txt');
    const structured = { route: 'a', confidence: 123456, reasoning: 'r' };
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
    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([
        'unrelated-configured-value',
      ]),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });
    expect(readOutputs(outputFile).confidence).toBe('123456');
  });

  it('keeps a configured value too short to be eligible', async () => {
    // Eligibility is unchanged: values under six characters are not matched,
    // on this path as everywhere else.
    const outputFile = path.join(tempDir, 'canopy-output.txt');
    const structured = { route: 'a', confidence: 12345, reasoning: 'r' };
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
    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['12345']),
      INPUT_TEXT: 'Some text to route.',
      INPUT_ROUTES: JSON.stringify(['a', 'b']),
    });
    expect(readOutputs(outputFile).confidence).toBe('12345');
  });
});
