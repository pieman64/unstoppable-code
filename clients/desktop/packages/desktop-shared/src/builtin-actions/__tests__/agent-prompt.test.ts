jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { resetRunDir } from '../_lib/output';
import { brandEnvCandidates } from '@canopy/desktop-shared/brand/env';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import {
  applyPlanPromptRequirement,
  buildCodexThreadOptions,
  buildQueryOptions,
  extractClaudeProposedPlan,
  extractClaudeProposedPlanFromJsonl,
  extractCodexProposedPlan,
  extractCodexFinalResult,
  extractFinalResult,
  normalizeClaudeTerminalTranscriptToSdkJsonl,
  parseAgentSecretValuesEnv,
  parseBooleanInput,
  parseMaxTurns,
  parseModelConfigEnv,
  parsePermissionPreset,
  parsePipelineLedgerToolsEnv,
  parseSettingSources,
  parseThinkingEffort,
  parseStructuredSchema,
  redactNormalizedPreservingFormat,
  redactNormalizedText,
  resolveFastModeInput,
  resolvePrompt,
  validateStructuredOutputInputs,
} from '../agent-prompt/logic';
import { withAgentSessionStartupTimeout } from '../_lib/agent-session-startup';
import {
  runAgentPromptAction,
  runAgentResumeAction,
} from '../agent-prompt/runner';

interface ClaudeQueryTestDouble extends AsyncIterable<unknown> {
  close(): void;
}

type ClaudeQueryMock = (
  ...args: Parameters<typeof claudeQuery>
) => ClaudeQueryTestDouble;

const mockedClaudeQuery: jest.MockedFunction<ClaudeQueryMock> =
  jest.mocked(claudeQuery);
type CodexInput = string | unknown[];
type TurnOptions = { outputSchema?: unknown; signal?: AbortSignal };
type ThreadEvent = Record<string, unknown>;
interface Codex {
  startThread(options?: unknown): {
    id: string | null;
    runStreamed(
      input: CodexInput,
      options?: TurnOptions,
    ): Promise<{ events: AsyncGenerator<ThreadEvent, void> }>;
  };
  resumeThread(
    id: string,
    options?: unknown,
  ): {
    id: string | null;
    runStreamed(
      input: CodexInput,
      options?: TurnOptions,
    ): Promise<{ events: AsyncGenerator<ThreadEvent, void> }>;
  };
}
const mockedInitCodex = jest.fn();

initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
initCodexModels([
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    supportedThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
]);

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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function readTranscriptRecords(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsedRecord: unknown = JSON.parse(line);
      if (!isRecord(parsedRecord)) {
        throw new Error('Expected transcript record to be a JSON object');
      }
      return parsedRecord;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeMessages(messages: unknown[]): ClaudeQueryTestDouble {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
      for (const message of messages) {
        await Promise.resolve();
        yield message;
      }
    },
    close: () => undefined,
  };
}

describe('redactNormalizedText', () => {
  it('controller regression: keeps eligible configured secrets protected after whitespace normalization', () => {
    const secret = 'ab      cd';
    expect(redactNormalizedText(`value: ${secret}`, [secret])).toBe(
      'value: ***',
    );
  });

  it('redacts a multi-line secret echoed verbatim', () => {
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const result = redactNormalizedText(`Here it is:\n${secret}\ndone.`, [
      secret,
    ]);
    expect(result).not.toContain('BEGIN-FAKE-KEY');
    expect(result).not.toContain('line2-abcdef');
    expect(result).not.toContain('END-FAKE-KEY');
  });

  it('redacts a multi-line secret echoed with CRLF line endings', () => {
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    const result = redactNormalizedText(
      `Here it is:\r\n${secret.replace(/\n/g, '\r\n')}\r\ndone.`,
      [secret],
    );
    expect(result).not.toContain('BEGIN-FAKE-KEY');
    expect(result).not.toContain('line2-abcdef');
    expect(result).not.toContain('END-FAKE-KEY');
  });

  it('redacts a single-line secret whose internal whitespace the agent reformatted', () => {
    const secret = 'correct horse battery staple';
    const result = redactNormalizedText(
      'The passphrase is correct horse\nbattery staple, got it.',
      [secret],
    );
    expect(result).not.toContain(secret);
    expect(result).not.toContain('correct horse');
    expect(result).not.toContain('battery staple');
  });

  it('does not leak a shorter overlapping value when a longer value shares its prefix', () => {
    // Regression: a two-pass redact-normalize-redact sandwich can leak here
    // because the first pass's `***` for the longer value consumes
    // characters the shorter value's own (whitespace-reformatted) match
    // would have needed. A single pass over the normalized text against
    // the expanded value list does not have this problem.
    const secrets = ['AAAAAA BBBBBB', 'AAAAAA'];
    const result = redactNormalizedText('here:\nAAAAAA\nBBBBBB\ndone', secrets);
    expect(result).not.toContain('AAAAAA');
    expect(result).not.toContain('BBBBBB');
  });

  it('leaves text unchanged when no secret values are configured', () => {
    expect(redactNormalizedText('nothing\nsensitive here', [])).toBe(
      'nothing sensitive here',
    );
  });
});

describe('agent-prompt logic', () => {
  it('prefers prompt_file over prompt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-prompt-'));
    const promptFile = path.join(tempDir, 'prompt.txt');
    fs.writeFileSync(promptFile, 'from-file', 'utf8');

    await expect(resolvePrompt({ prompt: 'inline', promptFile })).resolves.toBe(
      'from-file',
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails on missing prompt', async () => {
    await expect(resolvePrompt({ prompt: '  ' })).rejects.toThrow(/non-empty/);
  });

  it('extracts the last terminal ExitPlanMode plan from JSONL', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'ExitPlanMode',
              input: { plan: 'first plan' },
            },
          ],
        },
      }),
      JSON.stringify({ type: 'user', message: { content: 'ignored' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'ExitPlanMode',
              input: { plan: 'final plan' },
            },
          ],
        },
      }),
    ].join('\n');

    expect(extractClaudeProposedPlanFromJsonl(jsonl)).toBe('final plan');
  });

  it('emits one complete JSON record per line, whatever the text holds', () => {
    // The step runner masks a worker transcript line by line with the
    // structural JSON masker, which is sound only because every line is one
    // whole record. A multi-line value, terminal control text or a raw final
    // answer must never become a physical line of its own.
    const multiLine = 'BEGIN-FAKE-KEY\nline2-abcdef\r\nEND-FAKE-KEY';
    const events = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `Here:\n${multiLine}\n\u001b[31mred\u001b[0m`,
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't',
              content: `out\n${multiLine}`,
            },
          ],
        },
      },
    ];
    const jsonl = normalizeClaudeTerminalTranscriptToSdkJsonl(
      events,
      {},
      `final\n${multiLine}`,
    );
    expect(jsonl.endsWith('\n')).toBe(true);
    const lines = jsonl.slice(0, -1).split('\n');
    for (const line of lines)
      expect((): unknown => JSON.parse(line)).not.toThrow();
    expect(lines.some((line) => line.includes('BEGIN-FAKE-KEY'))).toBe(true);
    expect(lines.filter((line) => line.startsWith('line2')).length).toBe(0);
  });

  it('normalizes terminal transcript events into SDK-message JSONL', () => {
    const jsonl = normalizeClaudeTerminalTranscriptToSdkJsonl(
      [
        { type: 'queue-operation', ignored: true },
        {
          type: 'assistant',
          uuid: 'raw-terminal-id',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
      ],
      {
        inputTokens: 3,
        outputTokens: 4,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 2,
      },
      'hello',
    );

    const lines = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toEqual([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
        session_id: '',
      },
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        result: 'hello',
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2,
          reasoning_output_tokens: 0,
        },
      }),
    ]);
    expect(lines[0]).not.toHaveProperty('uuid');
    expect(lines.some((line) => line.type === 'queue-operation')).toBe(false);
  });

  it('validates max_turns', () => {
    expect(parseMaxTurns(undefined)).toBe(100);
    expect(parseMaxTurns('2')).toBe(2);
    expect(() => parseMaxTurns('0')).toThrow(/positive integer/);
  });

  it('validates structured_output_schema', () => {
    expect(parseStructuredSchema(undefined)).toBeUndefined();
    expect(parseStructuredSchema('{"type":"object"}')).toEqual({
      type: 'object',
    });
    expect(() => parseStructuredSchema('[]')).toThrow(/JSON object/);
    expect(() => parseStructuredSchema('not json')).toThrow(
      /structured_output_schema must be valid JSON/,
    );
  });

  it('validates permission_preset', () => {
    expect(parsePermissionPreset(undefined)).toBe('none');
    expect(parsePermissionPreset('read_only')).toBe('read_only');
    expect(parsePermissionPreset('dangerous_all')).toBe('dangerous_all');
    expect(parsePermissionPreset('plan')).toBe('plan');
    expect(() => parsePermissionPreset('invalid')).toThrow(
      /permission_preset must be one of/,
    );
  });

  it('appends the planning requirement only for the plan preset', () => {
    expect(applyPlanPromptRequirement('Base prompt', 'none')).toBe(
      'Base prompt',
    );
    expect(applyPlanPromptRequirement('Base prompt', 'plan')).toContain(
      'If a blocker prevents an implementation-ready plan, use request_user_input to resolve it.',
    );
    expect(applyPlanPromptRequirement('Base prompt', 'plan')).toContain(
      'You must always end your turn by providing a proposed plan',
    );
  });

  it('rejects structured output for the plan preset', () => {
    expect(() =>
      validateStructuredOutputInputs('plan', { type: 'object' }),
    ).toThrow(/structured_output_schema cannot be combined/);
    expect(() =>
      validateStructuredOutputInputs('none', { type: 'object' }),
    ).not.toThrow();
  });

  it('validates thinking_effort', () => {
    expect(parseThinkingEffort(undefined)).toBeUndefined();
    expect(parseThinkingEffort('high')).toBe('high');
    expect(parseThinkingEffort('xhigh')).toBe('xhigh');
    expect(parseThinkingEffort('max')).toBe('max');
    expect(() => parseThinkingEffort('auto')).toThrow(
      /thinking_effort must be one of: off, low, medium, high, xhigh, max/,
    );
    expect(() => parseThinkingEffort('invalid')).toThrow(
      /thinking_effort must be one of: off, low, medium, high, xhigh, max/,
    );
  });

  it('validates setting_sources', () => {
    expect(parseSettingSources(undefined)).toBeUndefined();
    expect(parseSettingSources('[]')).toEqual([]);
    expect(parseSettingSources('project, local')).toEqual(['project', 'local']);
    expect(parseSettingSources('["user","project","user"]')).toEqual([
      'user',
      'project',
    ]);
    expect(() => parseSettingSources('["invalid"]')).toThrow(
      /setting_sources entries must be one of/,
    );
    expect(() => parseSettingSources('[1]')).toThrow(
      /setting_sources entries must be strings/,
    );
  });

  it('validates boolean inputs', () => {
    expect(parseBooleanInput(undefined, 'persist_session', false)).toBe(false);
    expect(parseBooleanInput('true', 'persist_session', false)).toBe(true);
    expect(parseBooleanInput('0', 'persist_session', true)).toBe(false);
    expect(() => parseBooleanInput('maybe', 'persist_session', false)).toThrow(
      /persist_session must be "true", "false", "1", or "0"/,
    );
  });

  describe('parseModelConfigEnv', () => {
    it('returns undefined for empty or whitespace input', () => {
      expect(parseModelConfigEnv(undefined)).toBeUndefined();
      expect(parseModelConfigEnv('')).toBeUndefined();
      expect(parseModelConfigEnv('   ')).toBeUndefined();
    });

    it('parses a valid fastMode JSON config', () => {
      expect(parseModelConfigEnv('{"fastMode":true}')).toEqual({
        fastMode: true,
      });
      expect(parseModelConfigEnv('{"fastMode":false}')).toEqual({
        fastMode: false,
      });
    });

    it('parses a valid thinkingLevel JSON config', () => {
      expect(parseModelConfigEnv('{"thinkingLevel":"high"}')).toEqual({
        thinkingLevel: 'high',
      });
    });

    it('returns undefined when JSON is malformed', () => {
      const writeSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        expect(parseModelConfigEnv('{not json')).toBeUndefined();
        expect(writeSpy).toHaveBeenCalledWith(
          expect.stringMatching(/must be valid JSON/),
        );
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('warns when fastMode is present but not a boolean', () => {
      const writeSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const result = parseModelConfigEnv('{"fastMode":"yes"}');
        expect(result).toBeUndefined();
        expect(writeSpy).toHaveBeenCalledWith(
          expect.stringMatching(/fastMode must be a boolean/),
        );
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('returns undefined for non-object JSON', () => {
      expect(parseModelConfigEnv('null')).toBeUndefined();
      expect(parseModelConfigEnv('"string"')).toBeUndefined();
      expect(parseModelConfigEnv('[1,2,3]')).toBeUndefined();
    });
  });

  describe('resolveFastModeInput', () => {
    it('returns false when no relevant env vars are set', () => {
      expect(resolveFastModeInput({})).toBe(false);
    });

    it('prefers INPUT_FAST_MODE over CANOPY_MODEL_CONFIG', () => {
      expect(
        resolveFastModeInput({
          INPUT_FAST_MODE: 'true',
          CANOPY_MODEL_CONFIG: '{"fastMode":false}',
          CANOPY_FAST_MODE_ENABLED: 'false',
        }),
      ).toBe(true);
    });

    it('uses CANOPY_MODEL_CONFIG when INPUT_FAST_MODE is absent', () => {
      expect(
        resolveFastModeInput({
          CANOPY_MODEL_CONFIG: '{"fastMode":true}',
          CANOPY_FAST_MODE_ENABLED: 'false',
        }),
      ).toBe(true);
    });

    it('falls back to CANOPY_FAST_MODE_ENABLED when model config is malformed', () => {
      const writeSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        expect(
          resolveFastModeInput({
            CANOPY_MODEL_CONFIG: 'not json',
            CANOPY_FAST_MODE_ENABLED: 'true',
          }),
        ).toBe(true);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('falls back to CANOPY_FAST_MODE_ENABLED when model config lacks fastMode', () => {
      expect(
        resolveFastModeInput({
          CANOPY_MODEL_CONFIG: '{"thinkingLevel":"high"}',
          CANOPY_FAST_MODE_ENABLED: 'true',
        }),
      ).toBe(true);
    });

    it('treats empty INPUT_FAST_MODE as absent and falls back', () => {
      expect(
        resolveFastModeInput({
          INPUT_FAST_MODE: '   ',
          CANOPY_MODEL_CONFIG: '{"fastMode":true}',
        }),
      ).toBe(true);
    });

    it('rejects an inherited Ultra fast model config instead of running Regular', () => {
      expect(() =>
        resolveFastModeInput({
          CANOPY_MODEL_CONFIG: '{"speed":"ultrafast","fastMode":false}',
          CANOPY_FAST_MODE_ENABLED: 'false',
        }),
      ).toThrow(
        'Pipelines do not support Ultra fast. Set fast_mode on this step, or run the pipeline with Regular or Fast.',
      );
    });

    it('lets an explicit INPUT_FAST_MODE win over an Ultra fast model config', () => {
      expect(
        resolveFastModeInput({
          INPUT_FAST_MODE: 'false',
          CANOPY_MODEL_CONFIG: '{"speed":"ultrafast","fastMode":false}',
        }),
      ).toBe(false);
      expect(
        resolveFastModeInput({
          INPUT_FAST_MODE: 'true',
          CANOPY_MODEL_CONFIG: '{"speed":"ultrafast","fastMode":false}',
        }),
      ).toBe(true);
    });
  });

  it('prefers structured_output from the final SDK result', () => {
    const result = extractFinalResult(
      [
        { type: 'assistant' },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"wrong":true}',
          structured_output: { right: true },
        },
      ] as never[],
      true,
    );

    expect(result.structured).toEqual({ right: true });
  });

  it('falls back to StructuredOutput tool input when result payload is sparse', () => {
    const result = extractFinalResult(
      [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'StructuredOutput',
                input: { summary: 'done' },
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: false,
        },
      ] as never[],
      true,
    );

    expect(result.structured).toEqual({ summary: 'done' });
  });

  it('fails when the SDK stream has no terminal result', () => {
    expect(() =>
      extractFinalResult([{ type: 'assistant' }] as never[], false),
    ).toThrow(/terminal result/);
  });

  it('keeps Codex reconnect warnings when a later turn completes', () => {
    const result = extractCodexFinalResult(
      [
        {
          type: 'thread.started',
          thread_id: 'thread-1',
        },
        {
          type: 'turn.started',
        },
        {
          type: 'error',
          message:
            'Reconnecting... 2/5 (stream disconnected before completion)',
        },
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '{"madeUpdates":true}',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      ],
      true,
    );

    expect(result.rawText).toBe('{"madeUpdates":true}');
    expect(result.structured).toEqual({ madeUpdates: true });
  });

  it('fails Codex streams that end after an error without turn completion', () => {
    expect(() =>
      extractCodexFinalResult(
        [
          {
            type: 'thread.started',
            thread_id: 'thread-1',
          },
          {
            type: 'turn.started',
          },
          {
            type: 'error',
            message: 'Reconnecting... 2/5 (stream disconnected)',
          },
        ],
        false,
      ),
    ).toThrow(/Codex query failed: Reconnecting/);
  });

  it('fails Codex streams with a generic error when the error message is blank', () => {
    expect(() =>
      extractCodexFinalResult(
        [
          {
            type: 'thread.started',
            thread_id: 'thread-1',
          },
          {
            type: 'turn.started',
          },
          {
            type: 'error',
          },
        ],
        false,
      ),
    ).toThrow(/^Codex query failed$/);
  });

  it('surfaces SDK result errors', () => {
    expect(() =>
      extractFinalResult(
        [
          {
            type: 'result',
            subtype: 'error_max_turns',
            is_error: true,
            errors: ['too many turns'],
          },
        ] as never[],
        false,
      ),
    ).toThrow(/too many turns/);
  });

  it('extracts Claude proposed plans from ExitPlanMode tool calls', () => {
    expect(
      extractClaudeProposedPlan([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'ExitPlanMode',
                input: { plan: 'Ship feature safely' },
              },
            ],
          },
        },
      ] as never[]),
    ).toBe('Ship feature safely');
  });

  it('extracts Codex proposed plans from agent messages and native plan items', () => {
    expect(
      extractCodexProposedPlan([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '<proposed_plan>Agent plan</proposed_plan>',
          },
        },
      ]),
    ).toBe('Agent plan');

    expect(
      extractCodexProposedPlan([
        {
          type: 'item.completed',
          item: {
            type: 'plan',
            text: '# Native plan',
          },
        },
      ]),
    ).toBe('# Native plan');
  });

  it('keeps the aggregate of configured values out of the provider process', () => {
    // The action reads the aggregate to mask its own output; the Claude CLI
    // and the tools it runs get every other variable, each configured value
    // under its own name included, but not the aggregate.
    const names = brandEnvCandidates('AGENT_SECRET_VALUES');
    const saved = names.map((name) => [name, process.env[name]] as const);
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedSecret = process.env.SYNTHETIC_CONFIGURED_VALUE;
    try {
      for (const name of names) process.env[name] = '["value-one","value-two"]';
      process.env.ANTHROPIC_API_KEY = 'synthetic-provider-key';
      process.env.SYNTHETIC_CONFIGURED_VALUE = 'value-one';
      const options = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'dangerous_all',
      });
      expect(options.env).toBeDefined();
      for (const name of names) expect(options.env?.[name]).toBeUndefined();
      expect(options.env?.ANTHROPIC_API_KEY).toBe('synthetic-provider-key');
      expect(options.env?.SYNTHETIC_CONFIGURED_VALUE).toBe('value-one');
      expect(options.env?.PATH).toBe(process.env.PATH);
      // The action itself still has it.
      for (const name of names)
        expect(process.env[name]).toBe('["value-one","value-two"]');
      const enhanced = getEnhancedEnv({ environment: false });
      for (const name of names) expect(enhanced[name]).toBeUndefined();
      expect(enhanced.SYNTHETIC_CONFIGURED_VALUE).toBe('value-one');
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedSecret === undefined)
        delete process.env.SYNTHETIC_CONFIGURED_VALUE;
      else process.env.SYNTHETIC_CONFIGURED_VALUE = savedSecret;
    }
  });

  it('builds query options for pipeline-safe automation', () => {
    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      model: 'claude-sonnet-4-6',
      permissionPreset: 'none',
      systemPrompt: 'Stay concise.',
      schema: { type: 'object' },
    });

    expect(options).toMatchObject({
      cwd: '/tmp/repo',
      maxTurns: 1,
      model: 'claude-sonnet-4-6',
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      tools: [],
      outputFormat: { type: 'json_schema' },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Stay concise.',
      },
    });
    expect(options.sandbox?.ripgrep?.command).toMatch(/(^rg$|\/rg$)/);
    expect(options.pathToClaudeCodeExecutable).toMatch(/(^claude$|\/claude$)/);
  });

  it('builds query options for persisted or resumed sessions when requested', () => {
    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      permissionPreset: 'none',
      persistSession: true,
      resumeSessionId: 'session-123',
    });

    expect(options.persistSession).toBe(true);
    expect(options.resume).toBe('session-123');
  });

  it('includes Claude RTK hooks by default when the preference env is unset', () => {
    delete process.env.CANOPY_PREF_RTK_ENABLED;

    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      permissionPreset: 'none',
    });

    expect(options.hooks?.PreToolUse).toEqual(
      expect.arrayContaining([expect.any(Object)]),
    );
  });

  it('omits Claude RTK hooks when CANOPY_PREF_RTK_ENABLED is false', () => {
    process.env.CANOPY_PREF_RTK_ENABLED = 'false';
    try {
      const options = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
      });

      expect(options.hooks).toBeUndefined();
    } finally {
      delete process.env.CANOPY_PREF_RTK_ENABLED;
    }
  });

  it('omits the native-memory suppression by default (local memory opt-in)', () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_PREF_LOCAL_MEMORY_ENABLED;

    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      permissionPreset: 'none',
    });

    expect(options.settings).toBeUndefined();
  });

  it('applies the native-memory suppression when the local memory preference env var is on', () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    process.env.CANOPY_PREF_LOCAL_MEMORY_ENABLED = 'true';
    try {
      const options = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
      });

      expect(options.settings).toEqual({ autoMemoryEnabled: false });
    } finally {
      delete process.env.CANOPY_PREF_LOCAL_MEMORY_ENABLED;
    }
  });

  it('omits the native-memory suppression when the branded env override allows it', () => {
    process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
    process.env.CANOPY_PREF_LOCAL_MEMORY_ENABLED = 'true';
    try {
      const options = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
      });

      expect(options.settings).toBeUndefined();
    } finally {
      delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
      delete process.env.CANOPY_PREF_LOCAL_MEMORY_ENABLED;
    }
  });

  it('omits RTK hooks for Ollama pipeline query options', () => {
    delete process.env.CANOPY_PREF_RTK_ENABLED;

    const options = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      provider: 'ollama',
      model: 'llama3.2',
      permissionPreset: 'none',
    });

    expect(options.hooks).toBeUndefined();
  });

  it('prefers CANOPY_RTK_BINARY_PATH over RTK_EXECUTABLE for Claude RTK hooks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-rtk-hook-'));
    const scriptPath = path.join(tempDir, 'rtk');
    fs.writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env node',
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    );
    fs.chmodSync(scriptPath, 0o755);

    process.env.CANOPY_PREF_RTK_ENABLED = 'true';
    process.env.CANOPY_RTK_BINARY_PATH = scriptPath;
    process.env.RTK_EXECUTABLE = path.join(tempDir, 'missing-rtk');
    try {
      const options = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
      });
      const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (!hook) {
        throw new Error('Expected PreToolUse hook');
      }

      const result = await hook(
        {
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          tool_input: { command: 'echo hello' },
        },
        undefined,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: 'echo rewritten' },
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Command rewritten by Canopy RTK integration',
        },
      });
    } finally {
      delete process.env.CANOPY_PREF_RTK_ENABLED;
      delete process.env.CANOPY_RTK_BINARY_PATH;
      delete process.env.RTK_EXECUTABLE;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows custom or empty Claude setting sources', () => {
    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
        settingSources: [],
      }).settingSources,
    ).toEqual([]);

    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
        settingSources: ['project'],
      }).settingSources,
    ).toEqual(['project']);
  });

  it('adds thinking options to Claude query options when requested', () => {
    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
        thinkingLevel: 'high',
      }).thinking,
    ).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
        thinkingLevel: 'high',
      }).effort,
    ).toBe('high');

    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
        thinkingLevel: 'off',
      }).thinking,
    ).toEqual({ type: 'disabled' });

    const xhighOptions = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      permissionPreset: 'none',
      thinkingLevel: 'xhigh',
    });
    expect(xhighOptions.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(xhighOptions.effort).toBe('xhigh');

    const maxOptions = buildQueryOptions({
      cwd: '/tmp/repo',
      maxTurns: 1,
      permissionPreset: 'none',
      thinkingLevel: 'max',
    });
    expect(maxOptions.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(maxOptions.effort).toBe('max');

    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
      }).thinking,
    ).toBeUndefined();
  });

  it('always skips the Codex git-repo trust check (directory-scoped runs are not git repos)', () => {
    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/app-advisor-home',
        model: 'gpt-5.5',
        permissionPreset: 'none',
      }).skipGitRepoCheck,
    ).toBe(true);
  });

  it('adds thinking options to Codex thread options when requested', () => {
    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.5',
        permissionPreset: 'none',
        thinkingLevel: 'high',
      }).modelReasoningEffort,
    ).toBe('high');

    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.5',
        permissionPreset: 'none',
        thinkingLevel: 'xhigh',
      }).modelReasoningEffort,
    ).toBe('xhigh');

    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.5',
        permissionPreset: 'none',
        thinkingLevel: 'max',
      }).modelReasoningEffort,
    ).toBe('xhigh');

    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.6-sol',
        permissionPreset: 'none',
        thinkingLevel: 'max',
      }).modelReasoningEffort,
    ).toBe('max');

    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.5',
        permissionPreset: 'none',
        thinkingLevel: 'off',
      }).modelReasoningEffort,
    ).toBe('low');

    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.5',
        permissionPreset: 'none',
      }).modelReasoningEffort,
    ).toBeUndefined();
  });

  it('uses read-only sandboxing for Codex plan mode', () => {
    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/repo',
        model: 'gpt-5.5',
        permissionPreset: 'plan',
      }).sandboxMode,
    ).toBe('read-only');
  });

  it('allows Codex pipeline agents to run in directory-scoped non-Git projects', () => {
    expect(
      buildCodexThreadOptions({
        cwd: '/tmp/cowork-home',
        model: 'gpt-5.5',
        permissionPreset: 'none',
      }),
    ).toMatchObject({
      workingDirectory: '/tmp/cowork-home',
      skipGitRepoCheck: true,
    });
  });

  it('builds query options for read_only permissions', () => {
    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'read_only',
      }),
    ).toMatchObject({
      cwd: '/tmp/repo',
      maxTurns: 1,
      persistSession: false,
      tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
      allowedTools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
    });
  });

  it('builds query options for dangerous_all permissions', () => {
    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'dangerous_all',
      }),
    ).toMatchObject({
      cwd: '/tmp/repo',
      maxTurns: 1,
      persistSession: false,
      tools: {
        type: 'preset',
        preset: 'claude_code',
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('builds query options for Claude plan mode', () => {
    expect(
      buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'plan',
      }),
    ).toMatchObject({
      cwd: '/tmp/repo',
      maxTurns: 1,
      persistSession: false,
      permissionMode: 'plan',
    });
  });

  it('prefers CANOPY_CLAUDE_BINARY_PATH over CLAUDE_CODE_EXECUTABLE', () => {
    const originalBundledPath = process.env.CANOPY_CLAUDE_BINARY_PATH;
    const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;

    process.env.CANOPY_CLAUDE_BINARY_PATH = '/tmp/canopy/claude';
    process.env.CLAUDE_CODE_EXECUTABLE = '/usr/local/bin/claude';

    try {
      expect(
        buildQueryOptions({
          cwd: '/tmp/repo',
          maxTurns: 1,
          permissionPreset: 'none',
        }).pathToClaudeCodeExecutable,
      ).toBe('/tmp/canopy/claude');
    } finally {
      if (originalBundledPath === undefined) {
        delete process.env.CANOPY_CLAUDE_BINARY_PATH;
      } else {
        process.env.CANOPY_CLAUDE_BINARY_PATH = originalBundledPath;
      }

      if (originalExecutable === undefined) {
        delete process.env.CLAUDE_CODE_EXECUTABLE;
      } else {
        process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
      }
    }
  });

  it('prefers CANOPY_RG_BINARY_PATH over RG_EXECUTABLE', () => {
    const originalBundledPath = process.env.CANOPY_RG_BINARY_PATH;
    const originalExecutable = process.env.RG_EXECUTABLE;

    process.env.CANOPY_RG_BINARY_PATH = '/tmp/canopy/rg';
    process.env.RG_EXECUTABLE = '/usr/local/bin/rg';

    try {
      expect(
        buildQueryOptions({
          cwd: '/tmp/repo',
          maxTurns: 1,
          permissionPreset: 'none',
        }).sandbox?.ripgrep?.command,
      ).toBe('/tmp/canopy/rg');
    } finally {
      if (originalBundledPath === undefined) {
        delete process.env.CANOPY_RG_BINARY_PATH;
      } else {
        process.env.CANOPY_RG_BINARY_PATH = originalBundledPath;
      }

      if (originalExecutable === undefined) {
        delete process.env.RG_EXECUTABLE;
      } else {
        process.env.RG_EXECUTABLE = originalExecutable;
      }
    }
  });

  describe('parseAgentSecretValuesEnv', () => {
    it('returns an empty array when the channel is absent', () => {
      expect(parseAgentSecretValuesEnv(undefined)).toEqual([]);
    });

    it('returns an empty array when the channel is blank', () => {
      expect(parseAgentSecretValuesEnv('   ')).toEqual([]);
    });

    it('returns the configured values when the channel is a valid JSON string array', () => {
      expect(
        parseAgentSecretValuesEnv(JSON.stringify(['sekret-one', 'sekret-two'])),
      ).toEqual(['sekret-one', 'sekret-two']);
    });

    it('throws without leaking the raw value when the channel is present but not valid JSON', () => {
      const raw = `not-json-but-contains-sekret-token-12345`;
      let caught: unknown;
      try {
        parseAgentSecretValuesEnv(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = caught instanceof Error ? caught.message : '';
      expect(message).not.toContain('sekret-token-12345');
      expect(message).not.toContain(raw);
    });

    it('throws when the channel is valid JSON but not an array', () => {
      expect(() =>
        parseAgentSecretValuesEnv(JSON.stringify({ a: 1 })),
      ).toThrow();
    });

    it('throws rather than silently dropping a non-string entry from a partially-valid array', () => {
      // A prior implementation filtered out non-string entries and continued
      // with whatever strings remained — silently narrowing protection to
      // fewer secrets than the executor actually configured. A malformed
      // entry here means the channel itself is corrupt, so this must fail
      // closed rather than run the step with partial redaction.
      expect(() =>
        parseAgentSecretValuesEnv(JSON.stringify(['sekret-one', 42])),
      ).toThrow();
    });
  });

  describe('pipeline Ledger tools', () => {
    const ledgerTools = {
      mcpServers: {
        canopy: {
          type: 'http' as const,
          url: 'http://127.0.0.1:1/canopy/mcp/worktree-session/pipeline',
          headers: { Authorization: 'Bearer route-token-123' },
          alwaysLoad: true,
        },
      },
      allowedTools: [
        'mcp__canopy__AddFeedEntry',
        'mcp__canopy__SearchFeedEntries',
      ],
      instructions: 'LEDGER BLOCK',
    };

    it('parses the route the executor hands the action', () => {
      expect(parsePipelineLedgerToolsEnv(JSON.stringify(ledgerTools))).toEqual(
        ledgerTools,
      );
      expect(parsePipelineLedgerToolsEnv(undefined)).toBeUndefined();
      expect(parsePipelineLedgerToolsEnv('  ')).toBeUndefined();
    });

    it('treats a malformed route as no tools without repeating it', () => {
      const writes: string[] = [];
      const spy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(String(chunk));
          return true;
        });
      try {
        for (const raw of [
          'not-json route-token-123',
          JSON.stringify({ ...ledgerTools, allowedTools: 'all' }),
          JSON.stringify({ ...ledgerTools, mcpServers: {} }),
          JSON.stringify({
            ...ledgerTools,
            mcpServers: { canopy: { type: 'stdio', command: 'sh' } },
          }),
          JSON.stringify({ ...ledgerTools, instructions: 42 }),
        ]) {
          expect(parsePipelineLedgerToolsEnv(raw)).toBeUndefined();
        }
      } finally {
        spy.mockRestore();
      }
      expect(writes).toHaveLength(5);
      expect(writes.join('')).not.toContain('route-token-123');
    });

    it('adds the route, allowed tools and Ledger block to the query', () => {
      const readOnly = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'read_only',
        systemPrompt: 'Stay concise.',
        ledgerTools,
      });
      expect(readOnly.mcpServers).toEqual(ledgerTools.mcpServers);
      expect(readOnly.allowedTools).toEqual([
        'Read',
        'Glob',
        'Grep',
        'NotebookRead',
        ...ledgerTools.allowedTools,
      ]);
      expect(readOnly.tools).toEqual(['Read', 'Glob', 'Grep', 'NotebookRead']);
      expect(readOnly.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'Stay concise.\n\nLEDGER BLOCK',
      });

      const noTools = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'none',
        ledgerTools,
      });
      expect(noTools.tools).toEqual([]);
      expect(noTools.allowedTools).toEqual(ledgerTools.allowedTools);
      expect(noTools.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'LEDGER BLOCK',
      });

      const fullAccess = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'dangerous_all',
        ledgerTools,
      });
      expect(fullAccess.mcpServers).toEqual(ledgerTools.mcpServers);
      expect(fullAccess).not.toHaveProperty('allowedTools');
    });

    it('ignores the tools under plan, where Claude runs none', () => {
      const plan = buildQueryOptions({
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'plan',
        systemPrompt: 'Plan it.',
        ledgerTools,
      });
      expect(plan).not.toHaveProperty('mcpServers');
      expect(plan).not.toHaveProperty('allowedTools');
      expect(plan.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'Plan it.',
      });
    });

    it('leaves the query exactly as it was without the tools', () => {
      const input = {
        cwd: '/tmp/repo',
        maxTurns: 1,
        permissionPreset: 'read_only' as const,
        systemPrompt: 'Stay concise.',
      };
      const without = buildQueryOptions({ ...input, ledgerTools: undefined });
      const baseline = buildQueryOptions(input);
      // Hook closures differ per call; everything else is identical.
      expect(Object.keys(without)).toEqual(Object.keys(baseline));
      expect(JSON.stringify(without)).toBe(JSON.stringify(baseline));
      expect(baseline).not.toHaveProperty('mcpServers');
    });

    it('withholds the route from the provider environment', () => {
      const names = brandEnvCandidates('PIPELINE_LEDGER_TOOLS');
      const saved = names.map((name) => [name, process.env[name]] as const);
      try {
        for (const name of names)
          process.env[name] = JSON.stringify(ledgerTools);
        const options = buildQueryOptions({
          cwd: '/tmp/repo',
          maxTurns: 1,
          permissionPreset: 'dangerous_all',
        });
        for (const name of names) expect(options.env?.[name]).toBeUndefined();
        const enhanced = getEnhancedEnv({ environment: false });
        for (const name of names) expect(enhanced[name]).toBeUndefined();
        // The action itself still reads it.
        for (const name of names)
          expect(process.env[name]).toBe(JSON.stringify(ledgerTools));
      } finally {
        for (const [name, value] of saved)
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    });
  });
});

describe('agent-prompt runner', () => {
  let tempDir: string;
  let outputFile: string;
  let stdoutWriteSpy: jest.SpyInstance;
  let stderrWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    mockedClaudeQuery.mockReset();
    mockedInitCodex.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-agent-prompt-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrWriteSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ['nABCDE', '\nABCDE'],
    ['","subtype":', 'ordinary response'],
  ])(
    'controller JSON regression: secret %p cannot corrupt transcript syntax',
    async (secret, text) => {
      mockedClaudeQuery.mockReturnValue(
        makeMessages([
          {
            type: 'system',
            subtype: 'init',
            session_id: 'controller-json-integrity',
          },
          { type: 'result', subtype: 'success', is_error: false, result: text },
        ]) as ReturnType<typeof claudeQuery>,
      );
      await runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
        INPUT_PROMPT: 'Summarize this task.',
      });
      const outputs = readOutputs(outputFile);
      const content = fs.readFileSync(outputs.transcript_file ?? '', 'utf8');
      expect(() =>
        content
          .trim()
          .split('\n')
          .map((line): unknown => JSON.parse(line)),
      ).not.toThrow();
    },
  );

  it('hands the Claude query the step Ledger route when the executor supplies one', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        { type: 'system', subtype: 'init', session_id: 'ledger-session' },
        { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
      ]),
    );
    const route = {
      canopy: {
        type: 'http',
        url: 'http://127.0.0.1:1/canopy/mcp/worktree-session/pipeline',
        headers: { Authorization: 'Bearer route-token-123' },
      },
    };

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Record your work.',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_SYSTEM_PROMPT: 'Be brief.',
      CANOPY_PIPELINE_LEDGER_TOOLS: JSON.stringify({
        mcpServers: route,
        allowedTools: ['mcp__canopy__AddFeedEntry'],
        instructions: 'LEDGER BLOCK',
      }),
    });

    const options = mockedClaudeQuery.mock.calls[0]?.[0]?.options;
    expect(options?.mcpServers).toEqual(route);
    expect(options?.allowedTools).toContain('mcp__canopy__AddFeedEntry');
    const ledgerAppend: unknown = expect.stringMatching(
      /Be brief\.[\s\S]*LEDGER BLOCK$/,
    );
    expect(options?.systemPrompt).toMatchObject({ append: ledgerAppend });
    expect(options?.env?.CANOPY_PIPELINE_LEDGER_TOOLS).toBeUndefined();
  });

  it('calls the SDK and writes text and structured outputs', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-1',
        },
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

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_STRUCTURED_OUTPUT_SCHEMA:
        '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}',
      INPUT_SYSTEM_PROMPT: 'Return structured output only.',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('session-1');
    expect(fs.existsSync(outputs.transcript_file ?? '')).toBe(true);
    expect(outputs.text_response_file).toBeTruthy();
    expect(outputs.text_response).toBe('{"summary":"done"}');
    expect(outputs.json_response).toBe('{"summary":"done"}');

    const firstCall = mockedClaudeQuery.mock.calls[0]?.[0];
    expect(firstCall?.prompt).toBe('Summarize this task.');
    expect(firstCall?.options).toMatchObject({
      cwd: process.cwd(),
      maxTurns: 100,
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
      allowedTools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
      outputFormat: { type: 'json_schema' },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Return structured output only.',
      },
    });
    expect(firstCall?.options).toBeDefined();
    if (!firstCall?.options) {
      throw new Error('Expected Claude query options to be defined');
    }
    expect(firstCall.options.pathToClaudeCodeExecutable).toMatch(
      /(^claude$|\/claude$)/,
    );

    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`,
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '{"summary":"done"}',
        structured_output: { summary: 'done' },
      })}\n`,
    );
  });

  it('redacts a configured pipeline secret value from text/structured/plan outputs', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-secret',
        },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'ExitPlanMode',
                input: { plan: 'Use sekret-token-12345 to call the API.' },
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'The API key is sekret-token-12345.',
          structured_output: { note: 'sekret-token-12345 embedded' },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['sekret-token-12345']),
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_PERMISSION_PRESET: 'read_only',
      INPUT_STRUCTURED_OUTPUT_SCHEMA:
        '{"type":"object","properties":{"note":{"type":"string"}},"required":["note"]}',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).not.toContain('sekret-token-12345');
    expect(outputs.json_response).not.toContain('sekret-token-12345');
    expect(
      fs.readFileSync(outputs.text_response_file ?? '', 'utf8'),
    ).not.toContain('sekret-token-12345');
    expect(
      fs.readFileSync(outputs.json_response_file ?? '', 'utf8'),
    ).not.toContain('sekret-token-12345');
    // The ExitPlanMode plan is extracted whatever the preset.
    expect(fs.readFileSync(outputs.proposed_plan_file ?? '', 'utf8')).toBe(
      'Use *** to call the API.\n',
    );
  });

  it('redacts a configured secret from text_response even when whitespace-normalization would otherwise reconstitute it', async () => {
    // Independent-review regression: `text_response` is
    // `normalizeSingleLine(rawText)`, applied AFTER `rawText` was already
    // redacted. A configured secret containing only single spaces does not
    // exact-match a whitespace VARIANT of itself in the agent's raw output
    // (e.g. a newline where the secret has a space), so redaction misses it
    // — then whitespace normalization collapses the newline back to a
    // space, reconstituting the exact configured secret string in
    // `text_response`, which is interpolated into downstream step
    // expressions.
    const secret = 'correct horse battery staple';
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-whitespace-secret',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `The passphrase is correct horse\nbattery staple, got it.`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).not.toContain(secret);
  });

  it('redacts a multi-line configured secret from text_response even when echoed verbatim', async () => {
    // Independent-review regression: normalizing BEFORE redacting collapses
    // a multi-line secret's own internal newlines, so the subsequent exact
    // match against the (still multi-line) configured secret value fails and
    // the collapsed-but-still-complete secret leaks into `text_response`.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-multiline-secret',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `Here it is:\n${secret}\ndone.`,
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_PERMISSION_PRESET: 'read_only',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).not.toContain('BEGIN-FAKE-KEY');
    expect(outputs.text_response).not.toContain('line2-abcdef');
    expect(outputs.text_response).not.toContain('END-FAKE-KEY');
  });

  it('controller regression: masks multiline secrets in decoded durable transcript records', async () => {
    const secret = 'SYNTHETIC-ALPHA\nSYNTHETIC-BRAVO';
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'controller-transcript-red',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: secret }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: secret },
      ]) as ReturnType<typeof claudeQuery>,
    );
    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
      INPUT_PROMPT: 'Summarize this task.',
    });
    const outputs = readOutputs(outputFile);
    const records = fs
      .readFileSync(outputs.transcript_file ?? '', 'utf8')
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(
      JSON.stringify(secret).slice(1, -1),
    );
  });

  it('redacts a configured secret from the fallback transcript.jsonl when CANOPY_LOG_FILE is unset', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-fallback-transcript',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'The API key is sekret-token-12345.',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['sekret-token-12345']),
      INPUT_PROMPT: 'Summarize this task.',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.transcript_file).toBeTruthy();
    expect(
      fs.readFileSync(outputs.transcript_file ?? '', 'utf8'),
    ).not.toContain('sekret-token-12345');
  });

  it('leaves outputs unchanged when no secret values are configured', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-plain',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'No secrets here.',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Summarize this task.',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).toBe('No secrets here.');
  });

  it('reuses CANOPY_LOG_FILE for transcript output when provided', async () => {
    const logFile = path.join(tempDir, 'step.log');
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-2',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LOG_FILE: logFile,
      INPUT_PROMPT: 'Summarize this task.',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('session-2');
    expect(outputs.transcript_file).toBe(logFile);
    expect(fs.existsSync(path.join(tempDir, 'transcript.jsonl'))).toBe(false);
  });

  it('returns after a terminal Claude result even if the SDK iterator stays open', async () => {
    async function* terminalThenHungStream(): AsyncGenerator<unknown, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'hung-session',
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
      };
      await new Promise(() => {});
    }

    mockedClaudeQuery.mockReturnValue(
      terminalThenHungStream() as ReturnType<typeof claudeQuery>,
    );

    await expect(
      withTimeout(
        runAgentPromptAction({
          CANOPY_OUTPUT: outputFile,
          INPUT_PROMPT: 'Summarize this task.',
        }),
        1000,
        'agent prompt hung',
      ),
    ).resolves.toBeUndefined();

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('hung-session');
    expect(outputs.text_response).toBe('done');
  });

  it('disables the agent session startup timer when configured to zero', async () => {
    jest.useFakeTimers();
    const onTimeout = jest.fn();
    async function* delayedStartup(): AsyncGenerator<string, void> {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      yield 'started';
    }
    const stream = withAgentSessionStartupTimeout(delayedStartup(), {
      actionLabel: 'agent-prompt',
      env: { CANOPY_AGENT_SESSION_START_TIMEOUT_MS: '0' },
      mode: 'start',
      onTimeout,
    });
    const first = stream.next();

    await jest.advanceTimersByTimeAsync(25);

    await expect(first).resolves.toEqual({ done: false, value: 'started' });
    expect(onTimeout).not.toHaveBeenCalled();
    await stream.return();
  });

  it('closes and fails a Claude session that emits no startup event', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    const query = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return this;
      },
      next: jest.fn(() => new Promise<IteratorResult<unknown>>(() => {})),
      return: jest.fn(() => Promise.resolve({ done: true, value: undefined })),
      close,
    };
    mockedClaudeQuery.mockReturnValue(query);

    const pending = runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SESSION_START_TIMEOUT_MS: '25',
      INPUT_PROMPT: 'Summarize this task.',
    });
    const assertion = expect(pending).rejects.toThrow(
      'agent-prompt: agent session did not start within 25 ms',
    );

    await jest.advanceTimersByTimeAsync(25);
    await assertion;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails a model-less resume after one startup timeout without trying another provider', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    const query = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return this;
      },
      next: jest.fn(() => new Promise<IteratorResult<unknown>>(() => {})),
      return: jest.fn(() => Promise.resolve({ done: true, value: undefined })),
      close,
    };
    mockedClaudeQuery.mockReturnValue(query);

    const pending = runAgentResumeAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SESSION_START_TIMEOUT_MS: '25',
      INPUT_SESSION_ID: 'session-timeout',
      INPUT_PROMPT: 'Continue the task.',
    });
    const assertion = expect(pending).rejects.toThrow(
      'agent-resume: agent session did not resume within 25 ms',
    );

    await jest.advanceTimersByTimeAsync(25);
    await assertion;
    expect(close).toHaveBeenCalledTimes(1);
    expect(mockedInitCodex).not.toHaveBeenCalled();
  });

  it('aborts and fails a Codex session that emits no startup event', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    jest.useFakeTimers();
    let startupSignal: AbortSignal | undefined;
    const runStreamed = jest.fn<
      Promise<{ events: AsyncGenerator<ThreadEvent, void> }>,
      [CodexInput, TurnOptions?]
    >(
      (
        _prompt: string,
        options?: { signal?: AbortSignal },
      ): Promise<{ events: AsyncGenerator<never, void> }> => {
        startupSignal = options?.signal;
        return Promise.resolve({
          events: (async function* (): AsyncGenerator<never, void> {
            const event = await new Promise<never>(() => {});
            yield event;
          })(),
        });
      },
    );
    const codex: Codex = {
      startThread: jest.fn(() => ({ id: null, runStreamed })),
      resumeThread: jest.fn(() => ({ id: null, runStreamed })),
    };
    mockedInitCodex.mockResolvedValue(codex);

    const pending = runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SESSION_START_TIMEOUT_MS: '25',
      INPUT_MODEL: 'gpt-5.5',
      INPUT_PROMPT: 'Summarize this task.',
    });
    const assertion = expect(pending).rejects.toThrow(
      'agent-prompt: agent session did not start within 25 ms',
    );

    await jest.advanceTimersByTimeAsync(25);
    await assertion;
    expect(startupSignal?.aborted).toBe(true);
  });

  it('clamps Claude xhigh thinking_effort to the SDK-supported effort field', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-3',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_THINKING_EFFORT: 'xhigh',
    });

    const firstCall = mockedClaudeQuery.mock.calls[0]?.[0];
    expect(firstCall?.options?.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(firstCall?.options?.effort).toBe('xhigh');
    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('rejects legacy auto thinking_effort values', async () => {
    const runStreamed = jest.fn().mockResolvedValue({
      events: makeMessages([
        {
          type: 'thread.started',
          thread_id: 'thread-1',
        },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'done' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      ]),
    });
    const startThread = jest.fn().mockReturnValue({ runStreamed });
    mockedInitCodex.mockResolvedValue({
      startThread,
    } as never);

    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'Summarize this task.',
        INPUT_THINKING_EFFORT: 'auto',
      }),
    ).rejects.toThrow(
      /thinking_effort must be one of: off, low, medium, high, xhigh, max/,
    );
    expect(startThread).not.toHaveBeenCalled();
  });

  it('warns that setting_sources are ignored for Codex models', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const runStreamed = jest.fn().mockResolvedValue({
      events: makeMessages([
        {
          type: 'thread.started',
          thread_id: 'thread-setting-sources',
        },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'done' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      ]),
    });
    const startThread = jest.fn().mockReturnValue({ runStreamed });
    mockedInitCodex.mockResolvedValue({
      startThread,
    } as never);

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_MODEL: 'gpt-5.5',
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_SETTING_SOURCES: '[]',
    });

    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'agent-prompt: setting_sources is not supported for Codex models and will be ignored\n',
    );
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
      }),
    );
  });

  it('retries Codex structured output after schema validation failures', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
    };
    const runStreamed = jest
      .fn<
        Promise<{ events: AsyncGenerator<unknown, void> }>,
        [CodexInput, TurnOptions?]
      >()
      .mockResolvedValueOnce({
        events: makeMessages([
          {
            type: 'thread.started',
            thread_id: 'thread-structured-retry',
          },
          {
            type: 'turn.failed',
            error: {
              message: 'Response does not match output schema',
            },
          },
        ]),
      })
      .mockResolvedValueOnce({
        events: makeMessages([
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: '{"summary":"done"}',
            },
          },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          },
        ]),
      });
    const startThread = jest.fn().mockReturnValue({
      id: 'thread-structured-retry',
      runStreamed,
    });
    mockedInitCodex.mockResolvedValue({
      startThread,
    } as never);

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_MODEL: 'gpt-5.5',
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_SYSTEM_PROMPT: 'Return structured output only.',
      INPUT_STRUCTURED_OUTPUT_SCHEMA: JSON.stringify(schema),
    });

    expect(runStreamed).toHaveBeenCalledTimes(2);
    const firstCodexCall = runStreamed.mock.calls[0];
    expect(firstCodexCall?.[0]).toEqual(
      expect.stringContaining('You MUST respond with ONLY a JSON object'),
    );
    expect(firstCodexCall?.[1]?.outputSchema).toEqual(schema);
    expect(firstCodexCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(runStreamed).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'Your previous response failed JSON Schema validation.',
      ),
      { outputSchema: schema },
    );
    expect(runStreamed).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(JSON.stringify(schema, null, 2)),
      { outputSchema: schema },
    );
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'agent-prompt: Codex structured output validation failed; retrying (1/2): Codex query failed: Response does not match output schema\n',
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('thread-structured-retry');
    expect(outputs.text_response).toBe('{"summary":"done"}');
    expect(outputs.json_response).toBe('{"summary":"done"}');

    const transcriptRecords = readTranscriptRecords(
      outputs.transcript_file ?? '',
    );
    expect(transcriptRecords[0]?.type).toBe('canopy_user_prompt');
    expect(transcriptRecords[1]).toMatchObject({
      type: 'canopy_injected_prompt',
      text: 'Return structured output only.',
    });
    expect(transcriptRecords[2]?.type).toBe('thread.started');
    expect(transcriptRecords[4]?.type).toBe('canopy_user_prompt');
    expect(
      transcriptRecords.filter(
        (record) => record.type === 'canopy_injected_prompt',
      ),
    ).toHaveLength(1);
  });

  it('stops Codex structured output retries after two attempts', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
    };
    const makeFailure = (
      attempt: number,
    ): { events: AsyncGenerator<unknown> } => ({
      events: makeMessages([
        ...(attempt === 1
          ? [
              {
                type: 'thread.started',
                thread_id: 'thread-structured-failure',
              },
            ]
          : []),
        {
          type: 'turn.failed',
          error: {
            message: `Response does not match output schema on attempt ${attempt}`,
          },
        },
      ]),
    });
    const runStreamed = jest
      .fn()
      .mockResolvedValueOnce(makeFailure(1))
      .mockResolvedValueOnce(makeFailure(2))
      .mockResolvedValueOnce(makeFailure(3));
    const startThread = jest.fn().mockReturnValue({
      id: 'thread-structured-failure',
      runStreamed,
    });
    mockedInitCodex.mockResolvedValue({
      startThread,
    } as never);

    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'Summarize this task.',
        INPUT_STRUCTURED_OUTPUT_SCHEMA: JSON.stringify(schema),
      }),
    ).rejects.toThrow(
      /Codex query failed: Response does not match output schema on attempt 3/,
    );

    expect(runStreamed).toHaveBeenCalledTimes(3);
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'agent-prompt: Codex structured output validation failed; retrying (1/2): Codex query failed: Response does not match output schema on attempt 1\n',
    );
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      'agent-prompt: Codex structured output validation failed; retrying (2/2): Codex query failed: Response does not match output schema on attempt 2\n',
    );
  });

  it('emits proposed_plan_file for Claude planning runs', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-plan',
        },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'ExitPlanMode',
                input: { plan: '## Plan\n1. Inspect the repo' },
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Plan shared',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Plan this task.',
      INPUT_PERMISSION_PRESET: 'plan',
    });

    const firstCall = mockedClaudeQuery.mock.calls[0]?.[0];
    expect(firstCall?.prompt).toContain(
      'If a blocker prevents an implementation-ready plan, use request_user_input to resolve it.',
    );
    expect(firstCall?.prompt).toContain(
      'You must always end your turn by providing a proposed plan',
    );
    expect(firstCall?.options?.permissionMode).toBe('plan');

    const outputs = readOutputs(outputFile);
    expect(outputs.proposed_plan_file).toBeTruthy();
    expect(fs.readFileSync(outputs.proposed_plan_file ?? '', 'utf8')).toBe(
      '## Plan\n1. Inspect the repo\n',
    );
  });

  it('simulates Codex plan mode and emits proposed_plan_file', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const runStreamed = jest
      .fn<
        Promise<{ events: AsyncGenerator<unknown, void> }>,
        [CodexInput, TurnOptions?]
      >()
      .mockResolvedValue({
        events: makeMessages([
          {
            type: 'thread.started',
            thread_id: 'thread-plan',
          },
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: '<proposed_plan>Ship it</proposed_plan>',
            },
          },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
            },
          },
        ]),
      });
    const startThread = jest.fn().mockReturnValue({ runStreamed });
    mockedInitCodex.mockResolvedValue({
      startThread,
    } as never);

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_MODEL: 'gpt-5.5',
      INPUT_PROMPT: 'Plan this task.',
      INPUT_PERMISSION_PRESET: 'plan',
    });

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
        sandboxMode: 'read-only',
      }),
    );
    const planCall = runStreamed.mock.calls[0];
    expect(planCall?.[0]).toEqual(
      expect.stringContaining('You are operating in Canopy Plan mode.'),
    );
    expect(planCall?.[0]).toEqual(
      expect.stringContaining(
        'If a blocker prevents an implementation-ready plan, use request_user_input to resolve it.',
      ),
    );
    expect(planCall?.[0]).toEqual(
      expect.stringContaining(
        'You must always end your turn by providing a proposed plan',
      ),
    );
    expect(planCall?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const outputs = readOutputs(outputFile);
    expect(fs.readFileSync(outputs.proposed_plan_file ?? '', 'utf8')).toBe(
      'Ship it\n',
    );
  });

  it('fails fast when plan mode and structured output are combined', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'Plan this task.',
        INPUT_PERMISSION_PRESET: 'plan',
        INPUT_STRUCTURED_OUTPUT_SCHEMA: '{"type":"object"}',
      }),
    ).rejects.toThrow(
      /structured_output_schema cannot be combined with permission_preset: plan/,
    );
  });

  it('emits proposed_plan_file for Codex native plan items outside the plan preset', async () => {
    await expect(
      runAgentPromptAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const runStreamed = jest.fn().mockResolvedValue({
      events: makeMessages([
        {
          type: 'thread.started',
          thread_id: 'thread-native-plan',
        },
        {
          type: 'item.completed',
          item: {
            type: 'plan',
            text: '# Native plan',
          },
        },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'done' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      ]),
    });
    const startThread = jest.fn().mockReturnValue({ runStreamed });
    mockedInitCodex.mockResolvedValue({
      startThread,
    } as never);

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_MODEL: 'gpt-5.5',
      INPUT_PROMPT: 'Summarize this task.',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.text_response).toBe('done');
    expect(fs.readFileSync(outputs.proposed_plan_file ?? '', 'utf8')).toBe(
      '# Native plan\n',
    );
  });

  it('enables persisted Claude sessions when requested', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-persisted',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentPromptAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PROMPT: 'Summarize this task.',
      INPUT_PERSIST_SESSION: 'true',
    });

    const firstCall = mockedClaudeQuery.mock.calls[0]?.[0];
    expect(firstCall?.options?.persistSession).toBe(true);

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('session-persisted');
  });

  it('resumes Claude sessions and outputs the resumed session id', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-resume',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'continued',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runAgentResumeAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_SESSION_ID: 'session-resume',
      INPUT_PROMPT: 'Continue the session.',
      INPUT_SYSTEM_PROMPT: 'Do not append this on resume.',
      CANOPY_PREF_GLOBAL_INSTRUCTIONS_PIPELINES: JSON.stringify({
        overall: 'New global instruction.',
        scoped: [],
      }),
    });

    const firstCall = mockedClaudeQuery.mock.calls[0]?.[0];
    expect(firstCall?.options?.resume).toBe('session-resume');
    expect(firstCall?.options?.persistSession).toBe(true);
    expect(firstCall?.options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Do not append this on resume.',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('session-resume');
    expect(outputs.text_response).toBe('continued');
  });

  it('resumes Codex sessions without requiring a thread.started event', async () => {
    await expect(
      runAgentResumeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_SESSION_ID: 'thread-1',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const runStreamed = jest.fn().mockResolvedValue({
      events: makeMessages([
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'continued' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      ]),
    });
    const resumeThread = jest.fn().mockReturnValue({
      id: 'thread-resume',
      runStreamed,
    });
    mockedInitCodex.mockResolvedValue({
      resumeThread,
      startThread: jest.fn(),
    } as never);

    await runAgentResumeAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_MODEL: 'gpt-5.5',
      INPUT_SESSION_ID: 'thread-resume',
      INPUT_PROMPT: 'Continue the session.',
    });

    expect(resumeThread).toHaveBeenCalledWith(
      'thread-resume',
      expect.objectContaining({
        model: 'gpt-5.5',
      }),
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('thread-resume');
    expect(outputs.text_response).toBe('continued');
  });

  it('auto-detects Codex resume sessions when no model is supplied', async () => {
    await expect(
      runAgentResumeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_SESSION_ID: 'thread-autodetect',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    mockedClaudeQuery.mockReturnValue(makeMessages([]));

    const runStreamed = jest.fn().mockResolvedValue({
      events: makeMessages([
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'continued' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
        },
      ]),
    });
    const resumeThread = jest.fn().mockReturnValue({
      id: 'thread-autodetect',
      runStreamed,
    });
    mockedInitCodex.mockResolvedValue({
      resumeThread,
      startThread: jest.fn(),
    } as never);

    await runAgentResumeAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_SESSION_ID: 'thread-autodetect',
      INPUT_PROMPT: 'Continue the session.',
    });

    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
    expect(resumeThread).toHaveBeenCalledTimes(1);

    const outputs = readOutputs(outputFile);
    expect(outputs.session_id).toBe('thread-autodetect');
    expect(outputs.text_response).toBe('continued');
  });

  it('preserves a classified failure when both model-less resume paths fail', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          error: 'rate_limit',
          message: 'Authorization: Bearer raw-provider-token',
        },
      ]),
    );
    mockedInitCodex.mockRejectedValue(new Error('Codex session not found'));

    await expect(
      runAgentResumeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_SESSION_ID: 'unknown-provider-session',
        INPUT_PROMPT: 'Continue the session.',
      }),
    ).rejects.toThrow();

    const outputs = readOutputs(outputFile);
    const metadata: unknown = JSON.parse(
      fs.readFileSync(outputs.agent_failure_metadata_file ?? '', 'utf8'),
    );
    expect(metadata).toMatchObject({
      provider: 'claude',
      classification: {
        kind: 'provider_usage_limit',
        code: 'rate_limit',
      },
    });
  });

  it('redacts a configured pipeline secret value from the failure classification diagnostic_message', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'assistant',
          error: 'rate_limit',
          message: 'rejected credential sekret-token-12345',
        },
      ]),
    );
    mockedInitCodex.mockRejectedValue(new Error('Codex session not found'));

    await expect(
      runAgentResumeAction({
        CANOPY_OUTPUT: outputFile,
        CANOPY_AGENT_SECRET_VALUES: JSON.stringify(['sekret-token-12345']),
        INPUT_SESSION_ID: 'unknown-provider-session',
        INPUT_PROMPT: 'Continue the session.',
      }),
    ).rejects.toThrow();

    const outputs = readOutputs(outputFile);
    const metadata: unknown = JSON.parse(
      fs.readFileSync(outputs.agent_failure_metadata_file ?? '', 'utf8'),
    );
    expect(metadata).toMatchObject({
      classification: { kind: 'provider_usage_limit', code: 'rate_limit' },
    });
    expect(JSON.stringify(metadata)).not.toContain('sekret-token-12345');
  });

  it.each([
    ['nABCDE', '\nABCDE'],
    ['","subtype":', 'ordinary response'],
  ])(
    'controller JSON regression: secret %p cannot corrupt the failure-path agent_failure_transcript_file',
    async (secret, text) => {
      // Independent-review regression: a second raw `redactValues` pass
      // over the already-structurally-redacted (and therefore already
      // clean) failure transcript can corrupt otherwise-valid JSON — a
      // configured secret value can coincidentally match part of the JSON's
      // own escape sequences (e.g. the raw text containing a real newline
      // followed by "ABCDE" is escaped to `\nABCDE`, which a raw pass
      // searching for the literal substring "nABCDE" matches starting
      // mid-escape) or structural delimiters (a secret shaped like
      // `","subtype":` collides with the transcript's own JSON syntax
      // between two ordinary fields), even though the secret was never
      // actually present in the original text. Fixed by writing
      // `failure.transcript` as-is (already redacted structurally by
      // `buildTranscriptCapture` before serialization) instead of
      // re-redacting it with a second raw pass.
      mockedClaudeQuery.mockReturnValue(
        makeMessages([
          {
            type: 'assistant',
            error: 'rate_limit',
            message: text,
          },
        ]),
      );
      mockedInitCodex.mockRejectedValue(new Error('Codex session not found'));

      await expect(
        runAgentResumeAction({
          CANOPY_OUTPUT: outputFile,
          CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
          INPUT_SESSION_ID: 'unknown-provider-session',
          INPUT_PROMPT: 'Continue the session.',
        }),
      ).rejects.toThrow();

      const outputs = readOutputs(outputFile);
      const content = fs.readFileSync(
        outputs.agent_failure_transcript_file ?? '',
        'utf8',
      );
      expect(() =>
        content
          .trim()
          .split('\n')
          .map((line): unknown => JSON.parse(line)),
      ).not.toThrow();
    },
  );

  it('fails resumed Codex sessions that return no events', async () => {
    await expect(
      runAgentResumeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_SESSION_ID: 'expired-thread',
        INPUT_PROMPT: 'test',
      }),
    ).rejects.toThrow('require a host CodexPromptRunner');
    return;
    const runStreamed = jest.fn().mockResolvedValue({
      events: makeMessages([]),
    });
    const resumeThread = jest.fn().mockReturnValue({
      id: 'expired-thread',
      runStreamed,
    });
    mockedInitCodex.mockResolvedValue({
      resumeThread,
      startThread: jest.fn(),
    } as never);

    await expect(
      runAgentResumeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_MODEL: 'gpt-5.5',
        INPUT_SESSION_ID: 'expired-thread',
        INPUT_PROMPT: 'Continue the session.',
      }),
    ).rejects.toThrow(/Failed to resume session "expired-thread"/);
  });
});

describe('redactNormalizedPreservingFormat', () => {
  const secret = 'MY SECRET KEY 123456';

  it('masks a value the agent reflowed across a newline', () => {
    // Independent review reproduced this leak: the durable file copy used
    // plain `redactValues`, so a reflowed value stayed in cleartext there
    // while the inline field it copies was masked.
    const echoed = 'Found this:\n  MY SECRET  KEY 123456\nin the config.\n';
    const output = redactNormalizedPreservingFormat(echoed, [secret]);
    expect(output).not.toContain('SECRET');
    expect(output).toBe('Found this:\n  ***\nin the config.\n');
  });

  it('masks a multi-line value echoed verbatim', () => {
    const output = redactNormalizedPreservingFormat(`head\n${secret}\ntail\n`, [
      secret,
    ]);
    expect(output).toBe('head\n***\ntail\n');
  });

  it('returns text byte-for-byte when nothing matches', () => {
    const plan = '# Plan\n\n1. first\n2. second   step\n\n   indented\n';
    expect(redactNormalizedPreservingFormat(plan, [secret])).toBe(plan);
  });

  it('preserves formatting outside the masked span, unlike the collapsing matcher', () => {
    const echoed = `line one\n\n  ${secret}  \n\nline two`;
    const preserved = redactNormalizedPreservingFormat(echoed, [secret]);
    expect(preserved).toBe('line one\n\n  ***  \n\nline two');
    // The single-line projection is still the right answer for an inline
    // field, and still collapses — these are deliberately different outputs.
    expect(redactNormalizedText(echoed, [secret])).toBe(
      'line one *** line two',
    );
  });

  it('applies the six-character floor to the original value', () => {
    expect(redactNormalizedPreservingFormat('a ab cd z', ['ab cd'])).toBe(
      'a ab cd z',
    );
  });
});
