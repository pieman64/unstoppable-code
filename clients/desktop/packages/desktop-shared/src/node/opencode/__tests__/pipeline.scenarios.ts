import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  runOpenCodePipelinePrompt,
  type OpenCodePromptHost,
} from '../../pipelines/opencode-prompt-runner';

for (const permissionPreset of ['none', 'read_only', 'dangerous_all'] as const)
  void test(`pipeline native write enforces ${permissionPreset}`, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'opencode-pipeline-'));
    let closed = 0;
    try {
      const request = {
        cwd,
        environment: {},
        prompt: 'WRITE',
        model: 'opencode:fixture%2Fmodel',
        executionsDir: path.join(cwd, 'executions'),
        executionId: 'test-execution',
        jobId: 'test-job',
        stepId: 'test-step',
        attempt: 1,
        totalTimeoutMs: 20_000,
        permissionPreset,
      };
      const host: OpenCodePromptHost = {
        open: (signal: AbortSignal) =>
          Promise.resolve({
            executable: process.execPath,
            prefix: [
              fileURLToPath(new URL('./fake-agent.mjs', import.meta.url)),
            ],
            env: process.env,
            signal,
            close: (): Promise<void> => {
              closed++;
              return Promise.resolve();
            },
          }),
        authorize: () => Promise.resolve({ decision: 'allow' }),
      };
      const result = await runOpenCodePipelinePrompt(request, host);
      assert.equal(result.status, 'success');
      if (result.status === 'success') {
        assert.equal(result.usage.inputTokens, undefined);
        assert.equal(result.usage.outputTokens, undefined);
      }
      assert.equal(closed, 1);
      if (permissionPreset === 'dangerous_all')
        assert.equal(
          await readFile(path.join(cwd, 'sentinel.txt'), 'utf8'),
          'approved',
        );
      else await assert.rejects(readFile(path.join(cwd, 'sentinel.txt')));
      const missing = await runOpenCodePipelinePrompt(
        { ...request, resumeSessionId: 'not-owned' },
        host,
      );
      assert.equal(missing.status, 'failure');
      assert.equal(closed, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
