jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { resetRunDir } from '../_lib/output';
import { runCondenserAction } from '../condenser/runner';
import { runPlanPathValidationAction } from '../plan-path-validation/runner';
import { runQualityGateAction } from '../quality-gate/runner';
import { runRouterAction } from '../router/runner';

const mockedClaudeQuery = jest.mocked(claudeQuery);

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

describe('support actions', () => {
  let tempDir: string;
  let outputFile: string;
  let stdoutWriteSpy: jest.SpyInstance;
  let originalOutputDir: string | undefined;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-support-actions-'));
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

  it('condenses key outputs without Claude', async () => {
    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_TEXT: 'noise\nscore=91\nfeedback: looks good\n',
      INPUT_STRATEGY: 'key-outputs',
      INPUT_MAX_CHARS: '200',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('summary=score=91 feedback: looks good');
    expect(
      fs.readFileSync(path.join(tempDir, '0', 'summary.txt'), 'utf8'),
    ).toContain('score=91');
  });

  it('routes text into the requested labels', async () => {
    const logFile = path.join(tempDir, 'router-step.log');
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result:
            '{"route":"implement","confidence":0.9,"reasoning":"Code changes required."}',
          structured_output: {
            route: 'implement',
            confidence: 0.9,
            reasoning: 'Code changes required.',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runRouterAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LOG_FILE: logFile,
      INPUT_TEXT: 'Change the code and add a test.',
      INPUT_ROUTES: '["research","implement","verify"]',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.route).toBe('implement');
    expect(outputs.confidence).toBe('0.9');
    expect(outputs.transcript_file).toBe(logFile);
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text:
          'Route the following input into exactly one of these labels: research, implement, verify\nChange the code and add a test.',
        submitted_text:
          'Route the following input into exactly one of these labels: research, implement, verify\nChange the code and add a test.',
        plan_mode: false,
      })}\n`,
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result:
          '{"route":"implement","confidence":0.9,"reasoning":"Code changes required."}',
        structured_output: {
          route: 'implement',
          confidence: 0.9,
          reasoning: 'Code changes required.',
        },
      })}\n`,
    );
  });

  it('fails the quality gate below threshold while preserving outputs', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '{"score":72,"feedback":"Missing edge-case coverage."}',
          structured_output: {
            score: 72,
            feedback: 'Missing edge-case coverage.',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await expect(
      runQualityGateAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_TEXT: 'artifact text',
        INPUT_THRESHOLD: '80',
      }),
    ).rejects.toThrow(/did not meet threshold/);

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('score=72');
    expect(outputs).toContain('passed=false');
    expect(outputs).toContain('feedback=Missing edge-case coverage.');
    expect(outputs).toContain(
      `transcript_file=${path.join(tempDir, '0', 'quality-gate-transcript.jsonl')}`,
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'canopy_user_prompt',
        provider: 'claude',
        original_text:
          'Evaluate the following artifact against the provided criteria and return a score from 0 to 100.\nartifact text',
        submitted_text:
          'Evaluate the following artifact against the provided criteria and return a score from 0 to 100.\nartifact text',
        plan_mode: false,
      })}\n`,
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '{"score":72,"feedback":"Missing edge-case coverage."}',
        structured_output: {
          score: 72,
          feedback: 'Missing edge-case coverage.',
        },
      })}\n`,
    );
  });

  it('streams Claude-backed condenser summaries to stdout', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Short summary',
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    await runCondenserAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_TEXT: 'Very long context',
      INPUT_STRATEGY: 'llm-summary',
      INPUT_MAX_CHARS: '200',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('summary=Short summary');
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Short summary',
      })}\n`,
    );
  });

  it('validates and rejects unsafe plan paths', async () => {
    await expect(
      runPlanPathValidationAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PATHS: '["src/app.ts","../escape.ts","/tmp/abs.ts"]',
      }),
    ).rejects.toThrow(/rejected 2 path/);

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('valid=false');
    expect(outputs).toContain('invalid_count=2');
    expect(outputs).toContain('normalized_paths=["src/app.ts"]');
  });
});
