jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runParallelAgentsAction } from '../parallel-agents/runner';

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

describe('parallel-agents runner', () => {
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-parallel-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('hands each child the step Ledger route, as the one step agent', async () => {
    mockedClaudeQuery.mockImplementation(() =>
      makeMessages([
        { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
      ]),
    );

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_PIPELINE_LEDGER_TOOLS: LEDGER_TOOLS_ENV,
      INPUT_PROMPTS: JSON.stringify([{ prompt: 'one' }, { prompt: 'two' }]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
    for (const call of mockedClaudeQuery.mock.calls) {
      expect(call[0]?.options?.mcpServers).toHaveProperty('canopy');
    }
  });

  it('runs multiple prompts and aggregates outputs', async () => {
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          { type: 'assistant', message: { content: [] } },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'First result',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          { type: 'assistant', message: { content: [] } },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '{"summary":"done"}',
            structured_output: { summary: 'done' },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPTS: JSON.stringify([
        { prompt: 'first prompt' },
        { prompt: 'second prompt', system_prompt: 'be structured' },
      ]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.success_count).toBe('2');
    expect(outputs.failure_count).toBe('0');
    const results = JSON.parse(outputs.results) as Array<
      Record<string, string>
    >;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      index: 0,
      status: 'success',
      text_response: 'First result',
    });
    expect(results[1]).toMatchObject({
      index: 1,
      status: 'success',
      json_response: '{"summary":"done"}',
    });
    expect(fs.existsSync(outputs.results_file)).toBe(true);
  });

  it('redacts a configured secret value an agent echoes into its text or JSON response', async () => {
    // parallel-agents invokes the Claude SDK directly in this subprocess,
    // which inherits `secretEnv` alongside every other env var — an agent
    // CAN read a pipeline secret, and if it echoes one back, `results`,
    // `results_file`, and the per-agent transcript/text/json files all
    // write straight to disk, bypassing the parent process's stdout-level
    // `SecretValueRedactor` entirely.
    const secret = 'sekret-parallel-value-13579';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `The value is ${secret}`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPTS: JSON.stringify([{ prompt: 'first prompt' }]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.results).not.toContain(secret);
    const resultsFile = fs.readFileSync(outputs.results_file, 'utf8');
    expect(resultsFile).not.toContain(secret);
    const results = JSON.parse(outputs.results) as Array<{
      text_response_file?: string;
      transcript_file?: string;
    }>;
    const textResponseFile = results[0]?.text_response_file;
    expect(textResponseFile).toBeDefined();
    if (textResponseFile) {
      expect(fs.readFileSync(textResponseFile, 'utf8')).not.toContain(secret);
    }
  });

  it('redacts a multi-line configured secret from the per-agent transcript even though JSON-escaping the record would otherwise hide it', async () => {
    // Controller-followup5 regression: `serializeTranscript` redacting the
    // already-serialized transcript text cannot match a multi-line secret,
    // because JSON.stringify escapes the secret's own newlines into `\n`
    // two-character sequences before the string-based redaction pass ever
    // runs. Fixed by redacting each event's structured leaves BEFORE
    // serialization.
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

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPTS: JSON.stringify([{ prompt: 'first prompt' }]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    const results = JSON.parse(outputs.results) as Array<{
      transcript_file?: string;
    }>;
    const transcriptFile = results[0]?.transcript_file;
    expect(transcriptFile).toBeDefined();
    if (transcriptFile) {
      const records = fs
        .readFileSync(transcriptFile, 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
      expect(records.length).toBeGreaterThan(0);
      expect(JSON.stringify(records)).not.toContain('SYNTHETIC-ALPHA');
      expect(JSON.stringify(records)).not.toContain('SYNTHETIC-BRAVO');
    }
  });

  it('redacts a configured secret value that leaks into a per-agent failure message', async () => {
    // Independent-review regression: a per-agent SDK failure (e.g. the
    // agent's own error/tool-result text quoting a secret it read from its
    // env) landed in `error` unredacted, even though every SUCCESS-path
    // field was already covered — an inconsistency the original fix left
    // open, since `results`/`results_file` write straight to disk exactly
    // like the success-path fields do.
    const secret = 'sekret-parallel-failure-24680';
    mockedClaudeQuery.mockImplementation(() => {
      throw new Error(`SDK failed: upstream refused ${secret}`);
    });

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPTS: JSON.stringify([{ prompt: 'bad prompt' }]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.results).not.toContain(secret);
    const resultsFile = fs.readFileSync(outputs.results_file, 'utf8');
    expect(resultsFile).not.toContain(secret);
  });

  it('redacts a single-line configured secret from a per-agent failure message whose internal whitespace differs from the raw echo', async () => {
    // Independent-review regression: the per-agent failure `error` field
    // used plain `redactValues` instead of `redactNormalizedText`, so a
    // secret whose internal whitespace got reformatted into the thrown
    // error message (e.g. a newline where the secret has a plain space)
    // was never redacted, unlike every sibling free-text output field.
    const secret = 'correct horse battery staple';
    mockedClaudeQuery.mockImplementation(() => {
      throw new Error(
        'SDK failed: upstream refused correct horse\nbattery staple',
      );
    });

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPTS: JSON.stringify([{ prompt: 'bad prompt' }]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.results).not.toContain(secret);
    expect(outputs.results).not.toContain('correct horse');
    expect(outputs.results).not.toContain('battery staple');
  });

  it('redacts a multi-line configured secret from text_response even when echoed verbatim', async () => {
    // Independent-review regression: normalizing BEFORE redacting collapses
    // a multi-line secret's own internal newlines, so the subsequent exact
    // match against the (still multi-line) configured secret value fails and
    // the collapsed-but-still-complete secret leaks into `text_response`.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedClaudeQuery.mockReturnValueOnce(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `Here it is:\n${secret}\ndone.`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPTS: JSON.stringify([{ prompt: 'first prompt' }]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.results).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs.results).not.toContain('line2-abcdef');
    expect(outputs.results).not.toContain('END-FAKE-KEY');
  });

  it('captures per-agent failures without failing the whole action', async () => {
    mockedClaudeQuery.mockImplementation(({ prompt }) => {
      if (prompt === 'bad prompt') {
        throw new Error('SDK failed');
      }

      return makeMessages([
        { type: 'assistant', message: { content: [] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
        },
      ]) as ReturnType<typeof claudeQuery>;
    });

    await runParallelAgentsAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPTS: JSON.stringify([
        { prompt: 'good prompt' },
        { prompt: 'bad prompt' },
      ]),
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.success_count).toBe('1');
    expect(outputs.failure_count).toBe('1');
    const results = JSON.parse(outputs.results) as Array<
      Record<string, string>
    >;
    expect(results[1]).toMatchObject({
      index: 1,
      status: 'failure',
      error: 'SDK failed',
    });
  });
});
