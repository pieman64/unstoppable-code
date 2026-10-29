jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

const originalCanopyEnv = process.env.CANOPY_ENV;
beforeAll(() => {
  process.env.CANOPY_ENV = 'development';
});
afterAll(() => {
  if (originalCanopyEnv === undefined) {
    delete process.env.CANOPY_ENV;
  } else {
    process.env.CANOPY_ENV = originalCanopyEnv;
  }
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pipelineConfigPaths from '@canopy/desktop-shared/node/pipelines/config-paths';
import {
  getBundledClaudeBinaryPath,
  getBundledCodexBinaryPath,
  getBundledRtkBinaryPath,
  getBundledRgBinaryPath,
} from '@canopy/desktop-shared/node/pipelines/config-paths';
import {
  initCodexModels,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import * as pipelineStore from '@canopy/desktop-shared/pipelines/store';
import { runStep } from '@canopy/desktop-shared/node/pipelines/executor';
import { readShutdownAgentMetadata } from '@canopy/desktop-shared/node/pipelines/executor/shutdown-recovery';
import {
  INPUT_REQUEST_OUTPUT_KEY,
  JOB_RESTART_OUTPUT_KEYS,
  JOB_RESTART_OUTPUT_KEY,
  NOTIFICATION_OUTPUT_KEY,
  PAUSE_OUTPUT_KEYS,
  PAUSE_OUTPUT_KEY,
  PIPELINE_OUTPUT_ENV_KEY,
  REPORT_JSON_OUTPUT_KEYS,
  REPORT_JSON_OUTPUT_KEY,
  REPORT_OUTPUT_KEYS,
  REPORT_OUTPUT_KEY,
  extractInputRequest,
  extractNotificationOutputs,
  extractReportOutputs,
  getPowerShellProcessSpec,
  getPythonProcessSpec,
  sanitizePauseControlOutputKeys,
  stepRequestedPause,
  stepRequestedRestart,
  sanitizeReportOutputKeys,
  sanitizeRestartOutputKeys,
} from '@canopy/desktop-shared/node/pipelines/executor/step-runner';
import type {
  AgentPromptWorkerRequest,
  AgentPromptWorkerResult,
  CodexPromptRunnerRequest,
  CodexPromptRunnerResult,
  ExecutionRuntime,
  NormalizedStep,
  StepResult,
  StepPostProcessContext,
  StepOutputEvent,
} from '@canopy/desktop-shared/node/pipelines/executor/types';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

function createStep(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    id: partial.id ?? 'step',
    shell: partial.shell ?? 'bash',
    continue_on_error: partial.continue_on_error ?? false,
    timeout_minutes: partial.timeout_minutes ?? 1,
    skip_on_missing_action: partial.skip_on_missing_action ?? false,
    ...partial,
  };
}

async function waitForPathExists(
  filePath: string,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

// A cold `tsx` start compiles before the step runs; on a loaded CI shard one
// spawn can take several seconds, so tsx-spawning tests need headroom.
const TSX_SPAWN_TIMEOUT_MS = 30_000;

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

describe('step-runner', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-step-runner-'));
    runtime = createRuntime(tempDir);
    fs.mkdirSync(runtime.bundledActionsDir, { recursive: true });
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs bash steps and captures outputs and dynamic env', async () => {
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        run: 'echo "artifact=dist" >> "$CANOPY_OUTPUT"\necho "VERSION=1.2.3" >> "$CANOPY_ENV"',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ artifact: 'dist' });
    expect(result.dynamic_env).toEqual({ VERSION: '1.2.3' });
    expect(result.log_file).toBeTruthy();
    expect(result.resolved_run).toBe(
      'echo "artifact=dist" >> "$CANOPY_OUTPUT"\necho "VERSION=1.2.3" >> "$CANOPY_ENV"',
    );
  });

  it('injects the neutral pipeline output path after user environment values', async () => {
    const userOutputPath = path.join(tempDir, 'user-output.txt');
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        shell: 'node',
        run: [
          "import fs from 'node:fs';",
          `fs.appendFileSync(process.env.${PIPELINE_OUTPUT_ENV_KEY}, 'neutral=yes\\n');`,
        ].join('\n'),
      }),
      cwd: tempDir,
      env: {
        [PIPELINE_OUTPUT_ENV_KEY]: userOutputPath,
      },
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ neutral: 'yes' });
    expect(fs.existsSync(userOutputPath)).toBe(false);
  });

  it('passes resolved pipeline runtime environment variables to run steps', async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalCanopyEnvEnhanced = process.env.CANOPY_ENV_ENHANCED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CANOPY_ENV_ENHANCED;

    try {
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          shell: 'node',
          run: [
            "import fs from 'node:fs';",
            'fs.appendFileSync(process.env.CANOPY_OUTPUT, `userEnv=${process.env.CANOPY_USER_TEST_FLAG}\\n`);',
            'fs.appendFileSync(process.env.CANOPY_OUTPUT, `apiKey=${process.env.OPENAI_API_KEY}\\n`);',
          ].join('\n'),
        }),
        cwd: tempDir,
        env: {
          CANOPY_USER_TEST_FLAG: 'from-user-env',
          OPENAI_API_KEY: 'from-user-key',
        },
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({
        userEnv: 'from-user-env',
        apiKey: 'from-user-key',
      });
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      if (originalCanopyEnvEnhanced === undefined) {
        delete process.env.CANOPY_ENV_ENHANCED;
      } else {
        process.env.CANOPY_ENV_ENHANCED = originalCanopyEnvEnhanced;
      }
    }
  });

  it('redacts secretEnv values from log files and streamed output', async () => {
    const outputEvents: StepOutputEvent[] = [];
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        shell: 'node',
        run: 'process.stdout.write(`token=${process.env.SECRET_TOKEN}\\nshort=${process.env.SHORT_SECRET}\\n`);',
      }),
      cwd: tempDir,
      env: {},
      secretEnv: {
        SECRET_TOKEN: 'super-secret-token',
        SHORT_SECRET: '12345',
      },
      runtime,
      signal: new AbortController().signal,
      onStepOutput: (event) => {
        outputEvents.push(event);
      },
    });

    expect(result.status).toBe('success');
    const log = fs.readFileSync(result.log_file ?? '', 'utf8');
    expect(log).toContain('token=***');
    expect(log).not.toContain('super-secret-token');
    expect(log).toContain('short=12345');
    expect(outputEvents.map((event) => event.data).join('')).toContain(
      'token=***',
    );
  });

  it('surfaces desktop notification outputs through post-process hook', async () => {
    const notifications: StepPostProcessContext[] = [];
    runtime.onStepPostProcess = (ctx): void => {
      notifications.push(ctx);
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        shell: 'node',
        run: [
          "import fs from 'node:fs';",
          "fs.appendFileSync(process.env.CANOPY_OUTPUT, `CANOPY_NOTIFICATION=${JSON.stringify({ title: 'Done', body: 'Pipeline finished' })}\\n`);",
          "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'visible=yes\\n');",
        ].join('\n'),
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      onStepPostProcess: runtime.onStepPostProcess,
    });

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ visible: 'yes' });
    expect(notifications[0]?.notifications).toEqual([
      { title: 'Done', body: 'Pipeline finished' },
    ]);
  });

  it('uses iteration-specific log files and emits iteration on streamed output events', async () => {
    const outputEvents: StepOutputEvent[] = [];

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'iter-step',
        run: 'echo "iteration output"',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      iteration: 1,
      onStepOutput: (event) => {
        outputEvents.push(event);
      },
    });

    expect(result.status).toBe('success');
    expect(path.basename(result.log_file ?? '')).toBe('job-1--iter-step.log');
    expect(outputEvents.length).toBeGreaterThan(0);
    expect(outputEvents.every((event) => event.iteration === 1)).toBe(true);
  });

  it('uses an iteration suffix for pass 2 logs', async () => {
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'iter-step',
        run: 'echo "iteration output"',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      iteration: 2,
    });

    expect(result.status).toBe('success');
    expect(path.basename(result.log_file ?? '')).toBe(
      'job-1--iter-step--iter2.log',
    );
  });

  it(
    'runs node and tsx inline steps',
    async () => {
      const nodeResult = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'node-step',
          shell: 'node',
          run: "import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, 'node=yes\\n');",
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      const tsxResult = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'tsx-step',
          shell: 'tsx',
          run: "import fs from 'node:fs'; const answer: string = 'yes'; fs.appendFileSync(process.env.CANOPY_OUTPUT!, `tsx=${answer}\\n`);",
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(nodeResult.outputs).toEqual({ node: 'yes' });
      expect(tsxResult.outputs).toEqual({ tsx: 'yes' });
    },
    TSX_SPAWN_TIMEOUT_MS,
  );

  it('selects py.exe -3 for Python actions on Windows when present', () => {
    const restorePlatform = setPlatform('win32');
    const originalPath = process.env.PATH;
    fs.writeFileSync(path.join(tempDir, 'py.exe'), '');
    process.env.PATH = tempDir;

    try {
      expect(getPythonProcessSpec('action.py')).toEqual({
        command: 'py.exe',
        args: ['-3', 'action.py'],
      });
    } finally {
      restorePlatform();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it('falls back to python.exe for Python actions on Windows', () => {
    const restorePlatform = setPlatform('win32');
    const originalPath = process.env.PATH;
    process.env.PATH = tempDir;

    try {
      expect(getPythonProcessSpec('action.py')).toEqual({
        command: 'python.exe',
        args: ['action.py'],
      });
    } finally {
      restorePlatform();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it('uses python3 for Python actions on macOS and Linux', () => {
    const restorePlatform = setPlatform('darwin');

    try {
      expect(getPythonProcessSpec('action.py')).toEqual({
        command: 'python3',
        args: ['action.py'],
      });
    } finally {
      restorePlatform();
    }
  });

  it('resolves PowerShell executable names per platform', () => {
    const originalPath = process.env.PATH;
    const pwshPath = path.join(tempDir, 'pwsh');
    const pwshExePath = path.join(tempDir, 'pwsh.exe');
    fs.writeFileSync(pwshPath, '');
    fs.writeFileSync(pwshExePath, '');
    fs.chmodSync(pwshPath, 0o755);
    fs.chmodSync(pwshExePath, 0o755);
    process.env.PATH = tempDir;

    const restoreDarwin = setPlatform('darwin');
    try {
      expect(getPowerShellProcessSpec('pwsh', 'step.ps1')).toEqual({
        command: fs.realpathSync(pwshPath),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'step.ps1',
        ],
        scriptPath: 'step.ps1',
      });
    } finally {
      restoreDarwin();
    }

    const restoreWin = setPlatform('win32');
    try {
      expect(getPowerShellProcessSpec('pwsh', 'step.ps1')).toEqual({
        command: fs.realpathSync(pwshExePath),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'step.ps1',
        ],
        scriptPath: 'step.ps1',
      });
    } finally {
      restoreWin();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it('requires pwsh.exe for explicit pwsh steps on Windows', () => {
    const restorePlatform = setPlatform('win32');
    const originalPath = process.env.PATH;
    process.env.PATH = tempDir;

    try {
      expect(() => getPowerShellProcessSpec('pwsh', 'step.ps1')).toThrow(
        'Step requested shell: pwsh but PowerShell 7+ (pwsh.exe) is not on PATH.',
      );
      expect(getPowerShellProcessSpec('powershell', 'step.ps1')).toEqual({
        command: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'step.ps1',
        ],
        scriptPath: 'step.ps1',
      });
    } finally {
      restorePlatform();
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });

  it(
    'runs tsx inline steps when cwd and PATH do not expose local binaries',
    async () => {
      const originalCwd = process.cwd();
      const originalPath = process.env.PATH;
      process.chdir(tempDir);
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
      pipelineConfigPaths.resetLoginShellPathCache();

      try {
        const result = await runStep({
          executionId: 'exec-1',
          jobId: 'job-1',
          step: createStep({
            id: 'tsx-step',
            shell: 'tsx',
            run: "import fs from 'node:fs'; const answer: string = 'yes'; fs.appendFileSync(process.env.CANOPY_OUTPUT!, `tsx=${answer}\\n`);",
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
        });

        expect(result.outputs).toEqual({ tsx: 'yes' });
      } finally {
        process.chdir(originalCwd);
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        pipelineConfigPaths.resetLoginShellPathCache();
      }
    },
    TSX_SPAWN_TIMEOUT_MS,
  );

  it('fails timed out steps and supports cancellation', async () => {
    const timeoutResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'timeout',
        run: 'sleep 1',
        timeout_minutes: 0.001,
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const controller = new AbortController();
    const pending = runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'cancelled',
        run: 'sleep 5',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const cancelledResult = await pending;

    expect(timeoutResult.status).toBe('failure');
    expect(timeoutResult.error).toMatch(/timed out/);
    expect(cancelledResult.status).toBe('cancelled');
  });

  it('cancels descendant processes that keep step stdio open', async () => {
    const controller = new AbortController();
    const pending = runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'cancelled-with-descendant',
        shell: 'node',
        run: [
          "import { spawn } from 'node:child_process';",
          "spawn('sleep', ['30'], { stdio: 'inherit' });",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    const cancelledResult = await pending;

    expect(cancelledResult.status).toBe('cancelled');
  }, 10_000);

  it('dispatches actions and supports composite outputs', async () => {
    const actionDir = path.join(runtime.bundledActionsDir, 'node-action');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Node Action',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'fromAction=yes\\n');",
      'utf8',
    );

    const compositeDir = path.join(
      runtime.bundledActionsDir,
      'composite-action',
    );
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Composite Action',
        'outputs:',
        '  value:',
        '    value: ${{ steps.inner.outputs.answer }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: inner',
        '      run: echo "answer=42" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );

    const actionResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'action',
        uses: 'builtin/node-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const compositeResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite',
        uses: 'builtin/composite-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(actionResult.outputs).toEqual({ fromAction: 'yes' });
    expect(compositeResult.outputs).toEqual({ value: '42' });
  });

  it('runs post-processing after git commit push action steps', async () => {
    const actionDir = path.join(runtime.bundledActionsDir, 'git-commit-push');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Git Commit Push',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        'const results = [{',
        "  status: 'failed',",
        "  failurePhase: 'commit',",
        '  repoPath: process.env.TEST_REPO_PATH,',
        "  repoId: 'repo-1',",
        "  repoName: 'Repo 1',",
        "  precommitFailureError: 'precommit failed',",
        '}];',
        'fs.appendFileSync(process.env.CANOPY_OUTPUT, `results_json=${JSON.stringify(results)}\\n`);',
      ].join('\n'),
      'utf8',
    );
    const onStepPostProcess = jest.fn<void, [StepPostProcessContext]>();

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'commit',
        uses: 'builtin/git-commit-push',
      }),
      cwd: tempDir,
      env: { TEST_REPO_PATH: tempDir },
      runtime,
      signal: new AbortController().signal,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      onStepPostProcess,
    });

    expect(result.status).toBe('success');
    const postProcessCall = onStepPostProcess.mock.calls[0]?.[0];
    expect(postProcessCall?.step).toMatchObject({
      id: 'commit',
      uses: 'builtin/git-commit-push',
    });
    expect(postProcessCall?.outputs.results_json).toEqual(expect.any(String));
    expect(postProcessCall).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });

  it('keeps step success when post-processing rejects', async () => {
    const actionDir = path.join(runtime.bundledActionsDir, 'git-commit-push');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Git Commit Push',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'pushed=true\\n');",
      'utf8',
    );

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'commit',
        uses: 'builtin/git-commit-push',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      onStepPostProcess: () => Promise.reject(new Error('hook failed')),
    });

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ pushed: 'true' });
  });

  it('preserves composite transcript outputs when a nested agent step fails or is cancelled', async () => {
    const agentChildDir = path.join(runtime.bundledActionsDir, 'agent-child');
    fs.mkdirSync(agentChildDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentChildDir, 'action.yml'),
      [
        'name: Agent Child',
        'log_format_hint: agent',
        'inputs:',
        '  behavior:',
        '    required: false',
        '  transcript_file:',
        '    required: true',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentChildDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        "const behavior = process.env.INPUT_BEHAVIOR || 'success';",
        'const transcriptFile = process.env.INPUT_TRANSCRIPT_FILE;',
        'const readyFile = `${transcriptFile}.ready`;',
        "fs.writeFileSync(transcriptFile, JSON.stringify({ behavior }), 'utf8');",
        'fs.appendFileSync(process.env.CANOPY_OUTPUT, `transcript_file=${transcriptFile}\\n`);',
        "fs.writeFileSync(readyFile, 'ready', 'utf8');",
        "if (behavior === 'cancel') {",
        '  setTimeout(() => process.exit(0), 5000);',
        "} else if (behavior === 'fail') {",
        '  process.exit(2);',
        '}',
      ].join('\n'),
      'utf8',
    );

    const compositeDir = path.join(
      runtime.bundledActionsDir,
      'composite-agent-wrapper',
    );
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Composite Agent Wrapper',
        'log_format_hint: agent',
        'inputs:',
        '  behavior:',
        '    required: false',
        '  transcript_file:',
        '    required: true',
        'outputs:',
        '  transcript_file:',
        '    value: ${{ steps.inner.outputs.transcript_file }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: inner',
        '      uses: builtin/agent-child',
        '      with:',
        '        behavior: ${{ inputs.behavior }}',
        '        transcript_file: ${{ inputs.transcript_file }}',
      ].join('\n'),
      'utf8',
    );

    const failureTranscript = path.join(tempDir, 'failure-transcript.jsonl');
    const failureResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite-agent-failure',
        uses: 'builtin/composite-agent-wrapper',
        with: {
          behavior: 'fail',
          transcript_file: failureTranscript,
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const cancelledTranscript = path.join(
      tempDir,
      'cancelled-transcript.jsonl',
    );
    const cancelledReadyFile = `${cancelledTranscript}.ready`;
    const controller = new AbortController();
    const cancelledPromise = runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite-agent-cancelled',
        uses: 'builtin/composite-agent-wrapper',
        with: {
          behavior: 'cancel',
          transcript_file: cancelledTranscript,
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: controller.signal,
    });
    const abortWhenReady = waitForPathExists(cancelledReadyFile).then(() => {
      controller.abort();
    });
    const cancelledResult = await cancelledPromise;
    await abortWhenReady;

    expect(failureResult.status).toBe('failure');
    expect(failureResult.log_format_hint).toBe('agent');
    expect(failureResult.outputs.transcript_file).toBe(failureTranscript);
    expect(fs.existsSync(failureTranscript)).toBe(true);

    expect(cancelledResult.status).toBe('cancelled');
    expect(cancelledResult.log_format_hint).toBe('agent');
    expect(cancelledResult.outputs.transcript_file).toBe(cancelledTranscript);
    expect(fs.existsSync(cancelledTranscript)).toBe(true);
  });

  it('injects the Claude, Codex, RTK, and ripgrep binary paths into run, action, and composite steps', async () => {
    const expectedClaudePath = getBundledClaudeBinaryPath();
    const expectedCodexPath = getBundledCodexBinaryPath();
    const expectedRtkPath = getBundledRtkBinaryPath();
    const expectedRgPath = getBundledRgBinaryPath();

    const runResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'run-env',
        run: [
          'echo "claude=$CANOPY_CLAUDE_BINARY_PATH" >> "$CANOPY_OUTPUT"',
          'echo "codex=$CANOPY_CODEX_BINARY_PATH" >> "$CANOPY_OUTPUT"',
          'echo "rtk=$CANOPY_RTK_BINARY_PATH" >> "$CANOPY_OUTPUT"',
          'echo "rg=$CANOPY_RG_BINARY_PATH" >> "$CANOPY_OUTPUT"',
        ].join('\n'),
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const actionDir = path.join(runtime.bundledActionsDir, 'env-action');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Env Action',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        'fs.appendFileSync(process.env.CANOPY_OUTPUT, `claude=${process.env.CANOPY_CLAUDE_BINARY_PATH}\\n`);',
        'fs.appendFileSync(process.env.CANOPY_OUTPUT, `codex=${process.env.CANOPY_CODEX_BINARY_PATH}\\n`);',
        'fs.appendFileSync(process.env.CANOPY_OUTPUT, `rtk=${process.env.CANOPY_RTK_BINARY_PATH}\\n`);',
        'fs.appendFileSync(process.env.CANOPY_OUTPUT, `rg=${process.env.CANOPY_RG_BINARY_PATH}\\n`);',
      ].join(' '),
      'utf8',
    );

    const actionResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'action-env',
        uses: 'builtin/env-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const compositeDir = path.join(runtime.bundledActionsDir, 'env-composite');
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Env Composite',
        'outputs:',
        '  claude:',
        '    value: ${{ steps.inner.outputs.claude }}',
        '  codex:',
        '    value: ${{ steps.inner.outputs.codex }}',
        '  rtk:',
        '    value: ${{ steps.inner.outputs.rtk }}',
        '  rg:',
        '    value: ${{ steps.inner.outputs.rg }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: inner',
        '      run: |',
        '        echo "claude=$CANOPY_CLAUDE_BINARY_PATH" >> "$CANOPY_OUTPUT"',
        '        echo "codex=$CANOPY_CODEX_BINARY_PATH" >> "$CANOPY_OUTPUT"',
        '        echo "rtk=$CANOPY_RTK_BINARY_PATH" >> "$CANOPY_OUTPUT"',
        '        echo "rg=$CANOPY_RG_BINARY_PATH" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );

    const compositeResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite-env',
        uses: 'builtin/env-composite',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(runResult.outputs.claude).toBe(expectedClaudePath);
    expect(runResult.outputs.codex).toBe(expectedCodexPath);
    expect(runResult.outputs.rtk).toBe(expectedRtkPath);
    expect(runResult.outputs.rg).toBe(expectedRgPath);
    expect(actionResult.outputs.claude).toBe(expectedClaudePath);
    expect(actionResult.outputs.codex).toBe(expectedCodexPath);
    expect(actionResult.outputs.rtk).toBe(expectedRtkPath);
    expect(actionResult.outputs.rg).toBe(expectedRgPath);
    expect(compositeResult.outputs.claude).toBe(expectedClaudePath);
    expect(compositeResult.outputs.codex).toBe(expectedCodexPath);
    expect(compositeResult.outputs.rtk).toBe(expectedRtkPath);
    expect(compositeResult.outputs.rg).toBe(expectedRgPath);
  });

  it('runs node steps and actions with ELECTRON_RUN_AS_NODE when hosted by Electron', async () => {
    const originalVersions = Object.getOwnPropertyDescriptor(
      process,
      'versions',
    );

    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: {
        ...process.versions,
        electron: '99.0.0',
      },
    });

    try {
      const nodeResult = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'node-electron-mode',
          shell: 'node',
          run: "import fs from 'node:fs'; fs.appendFileSync(process.env.CANOPY_OUTPUT, `electronRunAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'}\\n`);",
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      const actionDir = path.join(
        runtime.bundledActionsDir,
        'electron-node-action',
      );
      fs.mkdirSync(actionDir, { recursive: true });
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        [
          'name: Electron Node Action',
          'inputs: {}',
          'outputs: {}',
          'runs:',
          '  using: node',
          '  main: index.js',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(actionDir, 'index.js'),
        "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, `electronRunAsNode=${process.env.ELECTRON_RUN_AS_NODE || 'unset'}\\n`);",
        'utf8',
      );

      const actionResult = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'action-electron-mode',
          uses: 'builtin/electron-node-action',
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(nodeResult.outputs.electronRunAsNode).toBe('1');
      expect(actionResult.outputs.electronRunAsNode).toBe('1');
    } finally {
      if (originalVersions) {
        Object.defineProperty(process, 'versions', originalVersions);
      }
    }
  });

  it('injects the log file path into run and action steps', async () => {
    const runResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'run-log-env',
        run: 'echo "log=$CANOPY_LOG_FILE" >> "$CANOPY_OUTPUT"',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const actionDir = path.join(runtime.bundledActionsDir, 'log-env-action');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Log Env Action',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, `log=${process.env.CANOPY_LOG_FILE}\\n`);",
      'utf8',
    );

    const actionResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'action-log-env',
        uses: 'builtin/log-env-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(runResult.outputs.log).toBe(runResult.log_file);
    expect(actionResult.outputs.log).toBe(actionResult.log_file);
  });

  it('persists log_format_hint from the step override or action definition', async () => {
    const inheritedDir = path.join(runtime.bundledActionsDir, 'inherited-hint');
    fs.mkdirSync(inheritedDir, { recursive: true });
    fs.writeFileSync(
      path.join(inheritedDir, 'action.yml'),
      [
        'name: Inherited Hint',
        'log_format_hint: agent',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(inheritedDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'ok=yes\\n');",
      'utf8',
    );

    const overriddenDir = path.join(runtime.bundledActionsDir, 'step-hint');
    fs.mkdirSync(overriddenDir, { recursive: true });
    fs.writeFileSync(
      path.join(overriddenDir, 'action.yml'),
      [
        'name: Step Hint',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(overriddenDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'ok=yes\\n');",
      'utf8',
    );

    const inheritedResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'inherited',
        uses: 'builtin/inherited-hint',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const overriddenResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'overridden',
        uses: 'builtin/step-hint',
        log_format_hint: 'agent',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(inheritedResult.log_format_hint).toBe('agent');
    expect(overriddenResult.log_format_hint).toBe('agent');
  });

  it('uses runtime Claude-compatible resolver for Ollama action env', async () => {
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: 'ollama-qwen3-coder',
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'inputs:',
        '  prompt:',
        '    required: false',
        '  system_prompt:',
        '    required: false',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.CANOPY_OUTPUT, `base_url=${process.env.ANTHROPIC_BASE_URL || ''}\\n`);",
      ].join('\n'),
      'utf8',
    );
    const runtimeWithResolver: ExecutionRuntime = {
      ...runtime,
      resolveModelHarnessInvocation: (model) =>
        Promise.resolve({
          source: 'ollama',
          harness: 'claude',
          runtimeModel: model?.replace(/^ollama-/, '') ?? '',
          aiCreditsRouted: false,
          envOverride: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:11534',
          },
        }),
      resolveClaudeCompatibleInvocation: (model, options) =>
        Promise.resolve({
          providerType: 'ollama',
          sdkModel: model?.replace(/^ollama-/, ''),
          envOverride:
            options?.ensureRunningReason === 'pipeline' &&
            options.assertInstalled
              ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11534' }
              : {},
        }),
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent',
        uses: 'builtin/agent-prompt',
        with: {
          model: 'ollama-qwen3-coder',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: runtimeWithResolver,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs.base_url).toBe('http://127.0.0.1:11534');
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    initOllamaModels([]);
  });

  it('runs eligible Claude agent-prompt steps in terminal mode and emits projected transcript attachment', async () => {
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      "throw new Error('agentPromptWorker should intercept this step');",
      'utf8',
    );
    const onStepOutput = jest.fn<void, [StepOutputEvent]>();
    const onRunningStepPatch = jest.fn(() => Promise.resolve());
    const runtimeWithWorker: ExecutionRuntime = {
      ...runtime,
      agentPromptWorker: {
        runAgentPrompt: jest.fn(async (request) => {
          await request.onWorkerStarted?.('worker-1');
          return {
            status: 'success' as const,
            workerId: 'worker-1',
            sessionId: 'session-1',
            rawText: 'worker text',
            transcript: `${JSON.stringify({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'worker text' }],
              },
            })}\n`,
            projectedMessages: [
              {
                id: 'msg-1',
                role: 'assistant',
                timestamp: Date.now(),
                blocks: [{ type: 'text', text: 'worker text' }],
              },
            ],
          };
        }),
      },
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      childId: 'child-000000',
      step: createStep({
        id: 'agent',
        uses: 'builtin/agent-prompt',
        with: {
          prompt: 'hello',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: runtimeWithWorker,
      signal: new AbortController().signal,
      agentTerminalMode: true,
      onStepOutput,
      onRunningStepPatch,
    });

    const outputData = onStepOutput.mock.calls
      .map(([event]) => event.data)
      .join('');
    expect(result.status).toBe('success');
    expect(result.agentTerminalMode).toBe(true);
    expect(result.workerId).toBe('worker-1');
    expect(result.outputs.text_response).toBe('worker text');
    expect(onRunningStepPatch).toHaveBeenCalledWith('agent', {
      workerId: 'worker-1',
      agentTerminalMode: true,
      workerQueued: false,
    });
    expect(outputData).toContain('claude_terminal_projected_messages');
    expect(outputData).toContain('worker text');
    const projectedEvent = onStepOutput.mock.calls
      .map(([event]) => event)
      .find((event) =>
        event.data.includes('claude_terminal_projected_messages'),
      );
    expect(projectedEvent?.jobId).toBe('job-1');
    expect(projectedEvent).not.toHaveProperty('matrix_child_id');
  });

  it('applies Ollama-scoped global instructions in terminal worker mode', async () => {
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initModelHarnessAssignments({
      revision: 1,
      assignments: [
        {
          modelId: 'ollama-qwen3-coder',
          source: 'ollama',
          harness: 'claude',
          defaultHarness: 'codex',
          configurable: true,
          overridden: true,
        },
      ],
    });
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      "throw new Error('agentPromptWorker should intercept this step');",
      'utf8',
    );
    const runAgentPrompt = jest.fn(
      (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'success',
          workerId: 'worker-ollama',
          sessionId: 'session-ollama',
          rawText: 'done',
          transcript: '',
        }),
    );
    const runtimeWithWorker: ExecutionRuntime = {
      ...runtime,
      agentPromptWorker: { runAgentPrompt },
    };
    const globalInstructionsEnvName = brandEnvName(
      'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
    );

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent',
        uses: 'builtin/agent-prompt',
        with: { prompt: 'hello', model: 'ollama-qwen3-coder' },
      }),
      cwd: tempDir,
      env: {
        [globalInstructionsEnvName]: JSON.stringify({
          overall: '',
          scoped: [
            {
              id: 'ollama-only',
              text: 'Use the local Ollama workflow.',
              mode: 'append',
              harnesses: ['ollama'],
              models: [],
              workspaceTypes: [],
            },
          ],
        }),
      },
      runtime: runtimeWithWorker,
      signal: new AbortController().signal,
      agentTerminalMode: true,
    });

    expect(result.status).toBe('success');
    expect(runAgentPrompt.mock.calls[0]?.[0].systemPrompt).toContain(
      'Use the local Ollama workflow.',
    );
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    initOllamaModels([]);
  });

  it('does not launch an agent-prompt worker for a pre-aborted step', async () => {
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      "throw new Error('pre-aborted step should not spawn a process');",
      'utf8',
    );
    const runAgentPrompt = jest.fn<
      Promise<AgentPromptWorkerResult>,
      [AgentPromptWorkerRequest]
    >();
    const runtimeWithWorker: ExecutionRuntime = {
      ...runtime,
      agentPromptWorker: { runAgentPrompt },
    };
    const controller = new AbortController();
    controller.abort();

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent',
        uses: 'builtin/agent-prompt',
        with: { prompt: 'hello' },
      }),
      cwd: tempDir,
      env: {},
      runtime: runtimeWithWorker,
      signal: controller.signal,
      agentTerminalMode: true,
    });

    expect(result.status).toBe('cancelled');
    expect(result.conclusion).toBe('cancelled');
    expect(result.outcome).toBe('cancelled');
    expect(runAgentPrompt).not.toHaveBeenCalled();
  });

  it('marks an agent-prompt step as queued while its worker waits, then clears it on launch', async () => {
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      "throw new Error('agentPromptWorker should intercept this step');",
      'utf8',
    );
    const onRunningStepPatch = jest.fn(() => Promise.resolve());
    const runtimeWithWorker: ExecutionRuntime = {
      ...runtime,
      agentPromptWorker: {
        runAgentPrompt: jest.fn(async (request) => {
          await request.onWorkerQueued?.('worker-q');
          await request.onWorkerStarted?.('worker-q');
          return {
            status: 'success' as const,
            workerId: 'worker-q',
            sessionId: 'session-q',
            rawText: 'queued worker text',
            transcript: `${JSON.stringify({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'queued worker text' }],
              },
            })}\n`,
          };
        }),
      },
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent',
        uses: 'builtin/agent-prompt',
        with: {
          prompt: 'hello',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: runtimeWithWorker,
      signal: new AbortController().signal,
      agentTerminalMode: true,
      onRunningStepPatch,
    });

    expect(result.status).toBe('success');
    expect(onRunningStepPatch).toHaveBeenNthCalledWith(1, 'agent', {
      workerId: 'worker-q',
      agentTerminalMode: true,
      workerQueued: true,
    });
    expect(onRunningStepPatch).toHaveBeenNthCalledWith(2, 'agent', {
      workerId: 'worker-q',
      agentTerminalMode: true,
      workerQueued: false,
    });
  });

  it('runs an agent-resume step as a worker that resumes the prior session', async () => {
    const agentResumeDir = path.join(runtime.bundledActionsDir, 'agent-resume');
    fs.mkdirSync(agentResumeDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentResumeDir, 'action.yml'),
      [
        'name: Agent Resume',
        'log_format_hint: agent',
        'inputs:',
        '  session_id:',
        '    required: false',
        '  prompt:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentResumeDir, 'index.js'),
      "throw new Error('agentPromptWorker should intercept this step');",
      'utf8',
    );
    const runAgentPrompt = jest.fn(
      async (
        request: AgentPromptWorkerRequest,
      ): Promise<AgentPromptWorkerResult> => {
        await request.onWorkerStarted?.('worker-r');
        return {
          status: 'success',
          workerId: 'worker-r',
          sessionId: request.resumeSessionId ?? 'unknown',
          rawText: 'resumed text',
          transcript: `${JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'resumed text' }],
            },
          })}\n`,
        };
      },
    );
    const runtimeWithWorker: ExecutionRuntime = {
      ...runtime,
      agentPromptWorker: { runAgentPrompt },
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'resume',
        uses: 'builtin/agent-resume',
        with: {
          session_id: 'prior-session-id',
          prompt: 'continue the work',
          system_prompt: 'Do not append this on resume.',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: runtimeWithWorker,
      signal: new AbortController().signal,
      agentTerminalMode: true,
    });

    expect(result.status).toBe('success');
    expect(result.agentTerminalMode).toBe(true);
    expect(result.workerId).toBe('worker-r');
    expect(runAgentPrompt).toHaveBeenCalledTimes(1);
    expect(runAgentPrompt.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: 'prior-session-id',
    });
    expect(runAgentPrompt.mock.calls[0]?.[0].systemPrompt).toBe(
      'Do not append this on resume.',
    );
    expect(result.outputs.session_id).toBe('prior-session-id');
  });

  it('persists agent log metadata on successful, failed, and cancelled action steps', async () => {
    const codexRequests: CodexPromptRunnerRequest[] = [];
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        '  session_id:',
        '    required: false',
        '  model:',
        '    required: false',
        '  fast_mode:',
        '    required: false',
        '  behavior:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    const agentResumeDir = path.join(runtime.bundledActionsDir, 'agent-resume');
    fs.mkdirSync(agentResumeDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentResumeDir, 'action.yml'),
      [
        'name: Agent Resume',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        '  session_id:',
        '    required: false',
        '  model:',
        '    required: false',
        '  fast_mode:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentResumeDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'status=ok\\n');",
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        "const behavior = process.env.INPUT_BEHAVIOR || 'success';",
        "if (behavior === 'cancel') {",
        '  setTimeout(() => process.exit(0), 5000);',
        "} else if (behavior === 'fail') {",
        "  process.stderr.write('failed\\n');",
        '  process.exit(2);',
        '} else {',
        "  fs.appendFileSync(process.env.CANOPY_OUTPUT, 'status=ok\\n');",
        '}',
      ].join('\n'),
      'utf8',
    );
    runtime.codexPromptRunner = {
      runCodexPrompt: async (request): Promise<CodexPromptRunnerResult> => {
        codexRequests.push(request);
        if (request.stepId === 'agent-failure') {
          return {
            status: 'failure',
            transcript: 'failed\n',
            failure: {
              version: 1,
              provider: 'codex',
              had_agent_activity: true,
              message: 'failed',
            },
          };
        }
        if (request.stepId === 'agent-cancelled') {
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) {
              resolve();
              return;
            }
            request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            status: 'cancelled',
            transcript: '',
            failure: {
              version: 1,
              provider: 'codex',
              had_agent_activity: false,
              message: 'cancelled',
            },
          };
        }
        return {
          status: 'success',
          sessionId: request.resumeSessionId ?? `session-${request.stepId}`,
          rawText: 'done',
          transcript: 'done\n',
          usage: {},
        };
      },
    };

    const successResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent-success',
        uses: 'builtin/agent-prompt',
        with: {
          model: 'gpt-5.5',
          fast_mode: 'true',
          prompt: 'do the work',
        },
      }),
      cwd: tempDir,
      env: {
        PIPELINE_PUBLIC: 'public-value',
        HOME: '/must-not-override-canonical-home',
        CODEX_HOME: '/must-not-override-canonical-codex-home',
      },
      secretEnv: { PIPELINE_SECRET: 'secret-value' },
      runtime,
      signal: new AbortController().signal,
    });

    const failureResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent-failure',
        uses: 'builtin/agent-prompt',
        with: {
          model: 'gpt-5.5',
          behavior: 'fail',
          prompt: 'fail the work',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const controller = new AbortController();
    const cancelledPromise = runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent-cancelled',
        uses: 'builtin/agent-prompt',
        with: {
          model: 'gpt-5.5',
          behavior: 'cancel',
          prompt: 'cancel the work',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const cancelledResult = await cancelledPromise;

    const resumedResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent-resumed',
        uses: 'builtin/agent-resume',
        with: {
          model: 'gpt-5.5',
          fast_mode: 'false',
          session_id: 'session-agent-success',
          prompt: 'continue the work',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    for (const result of [
      successResult,
      failureResult,
      cancelledResult,
      resumedResult,
    ]) {
      expect(result.log_format_hint).toBe('agent');
      expect(result.agent_provider).toBe('codex');
      expect(result.agent_model).toBe('gpt-5.5');
    }
    expect(successResult.status).toBe('success');
    expect(successResult.agent_model_config).toEqual({ fastMode: true });
    expect(codexRequests[0]?.environment).toEqual({
      PIPELINE_PUBLIC: 'public-value',
      PIPELINE_SECRET: 'secret-value',
    });
    expect(codexRequests[0]).toMatchObject({
      fastMode: true,
      totalTimeoutMs: 60_000,
    });
    expect(failureResult.status).toBe('failure');
    expect(cancelledResult.status).toBe('cancelled');
    expect(resumedResult.status).toBe('success');
    expect(resumedResult.agent_model_config).toEqual({ fastMode: false });
  });

  it.each([true, false])(
    'checkpoints an interrupted Codex agent with activity=%s',
    async (hadActivity) => {
      const actionDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
      fs.mkdirSync(actionDir, { recursive: true });
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        'name: Agent\nlog_format_hint: agent\ninputs:\n  model: {}\n  prompt: {}\noutputs: {}\nruns:\n  using: node\n  main: index.js\n',
      );
      fs.writeFileSync(
        path.join(actionDir, 'index.js'),
        'throw new Error("unexpected subprocess")',
      );
      const controller = new AbortController();
      const transcript = `${JSON.stringify({ type: 'thread.started', thread_id: 'shutdown-thread' })}\n`;
      runtime.codexPromptRunner = {
        runCodexPrompt: (request): Promise<CodexPromptRunnerResult> => {
          request.onTranscriptLine?.(transcript.trim());
          controller.abort('app_shutdown');
          return Promise.resolve({
            status: 'cancelled',
            transcript,
            failure: {
              version: 1,
              provider: 'codex',
              agent_harness: 'codex',
              session_id: 'shutdown-thread',
              had_agent_activity: hadActivity,
              message: 'Stopped',
            },
          });
        },
      };
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent',
          uses: 'builtin/agent-prompt',
          with: { model: 'gpt-5.5', prompt: 'work' },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: controller.signal,
      });
      expect(result.status).toBe('paused');
      expect(result.pause_reason?.kind).toBe('app_shutdown');
      expect(result.agent_recovery).toMatchObject({
        session_id: 'shutdown-thread',
        strategy: hadActivity ? 'continue_session' : 'restart_step',
      });
      const transcriptFile = result.agent_recovery?.transcript_file;
      if (!transcriptFile) throw new Error('Missing durable transcript');
      expect(fs.readFileSync(transcriptFile, 'utf8')).toBe(transcript);
    },
  );

  it.each([
    [
      'ollama-shutdown-claude',
      'claude',
      {
        type: 'assistant',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Claude-compatible activity' }],
        },
      },
    ],
    [
      'ollama-shutdown-codex',
      'codex',
      {
        type: 'item.completed',
        item: {
          id: 'agent-1',
          type: 'agent_message',
          text: 'Codex-compatible activity',
        },
      },
    ],
  ] as const)(
    'detects Ollama shutdown activity through the %s harness',
    async (modelId, harness, event) => {
      initOllamaModels([
        {
          id: modelId,
          rawModelId: modelId.replace('ollama-', ''),
          label: modelId,
          show: { capabilities: ['completion', 'tools'] },
        },
      ]);
      initModelHarnessAssignments({
        revision: 1,
        assignments: [
          {
            modelId,
            source: 'ollama',
            harness,
            defaultHarness: harness,
            configurable: true,
            overridden: false,
          },
        ],
      });
      const logFile = path.join(tempDir, `${modelId}.jsonl`);
      fs.writeFileSync(logFile, `${JSON.stringify(event)}\n`, 'utf8');

      try {
        await expect(
          readShutdownAgentMetadata(
            logFile,
            createStep({ id: 'agent', uses: 'builtin/agent-prompt' }),
            modelId,
          ),
        ).resolves.toMatchObject({
          provider: 'ollama',
          agent_harness: harness,
          had_agent_activity: true,
        });
      } finally {
        initModelHarnessAssignments({ revision: 0, assignments: [] });
        initOllamaModels([]);
      }
    },
  );

  it('keeps interrupted Codex activity without a session ID under manual resume protection', async () => {
    const actionDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      'name: Agent\nlog_format_hint: agent\ninputs:\n  model: {}\n  prompt: {}\noutputs: {}\nruns:\n  using: node\n  main: index.js\n',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      'throw new Error("unexpected subprocess")',
    );
    const controller = new AbortController();
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> => {
        controller.abort('app_shutdown');
        return Promise.resolve({
          status: 'cancelled',
          transcript: '{"type":"item.completed"}\n',
          failure: {
            version: 1,
            provider: 'codex',
            agent_harness: 'codex',
            had_agent_activity: true,
            message: 'Stopped',
          },
        });
      },
    };

    const result = await runStep({
      executionId: 'exec-missing-session',
      jobId: 'job-1',
      step: createStep({
        id: 'agent',
        uses: 'builtin/agent-prompt',
        with: { model: 'gpt-5.5', prompt: 'work' },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: controller.signal,
    });

    expect(result.status).toBe('paused');
    expect(result.pause_reason?.kind).toBe('app_shutdown');
    expect(result.agent_recovery).toBeUndefined();
    expect(result.error).toContain('Automatic resume is unavailable');
  });

  it.each([
    ['a continuation of earlier work', true, 'continue_session'],
    ['a first resume of the step', false, 'restart_step'],
  ])(
    'keeps the recovery strategy of %s when resume setup fails',
    async (_label, continuing, expectedStrategy) => {
      const actionDir = path.join(runtime.bundledActionsDir, 'agent-resume');
      fs.mkdirSync(actionDir, { recursive: true });
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        'name: Agent Resume\nlog_format_hint: agent\ninputs:\n  model: {}\n  prompt: {}\n  session_id: {}\noutputs: {}\nruns:\n  using: node\n  main: index.js\n',
      );
      fs.writeFileSync(
        path.join(actionDir, 'index.js'),
        'throw new Error("unexpected subprocess")',
      );
      runtime.codexPromptRunner = {
        runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
          Promise.resolve({
            status: 'failure',
            transcript: '',
            failure: {
              version: 1,
              provider: 'codex',
              agent_harness: 'codex',
              // Resume setup failed: the saved session is known, but this
              // attempt produced no agent activity of its own.
              session_id: 'prior-thread',
              had_agent_activity: false,
              classification: {
                kind: 'provider_temporarily_unavailable',
                code: 'provider_timeout',
                provider: 'codex',
                account_scope: 'native',
                diagnostic_message: 'thread/resume timed out',
              },
              message:
                'Codex app-server did not respond to thread/resume within 120s',
            },
          }),
      };

      const result = await runStep({
        executionId: 'exec-resume-setup',
        jobId: 'job-1',
        step: createStep({
          id: 'agent',
          uses: 'builtin/agent-resume',
          with: {
            model: 'gpt-5.5',
            session_id: 'prior-thread',
            prompt: continuing ? 'Continue' : 'Review the change',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        ...(continuing
          ? {
              recoveryCheckpoint: {
                version: 2,
                reason_id: 'reason-1',
                action: 'agent-prompt',
                provider: 'codex',
                harness: 'codex',
                step_id: 'agent',
                session_id: 'prior-thread',
                had_agent_activity: true,
                strategy: 'continue_session',
                recovery_count: 1,
                paused_at: '2026-10-08T00:00:00.000Z',
                failure_message: 'earlier failure',
              },
            }
          : {}),
      });

      expect(result.status).toBe('paused');
      // A failed "Continue" must not fall back to rerunning the original task,
      // and a first resume must keep its own prompt instead of "Continue".
      expect(result.agent_recovery).toMatchObject({
        session_id: 'prior-thread',
        had_agent_activity: continuing,
        strategy: expectedStrategy,
      });
    },
  );

  it('streams Codex transcript lines through onStepOutput while the runner is active', async () => {
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      "throw new Error('codexPromptRunner should intercept this step');",
      'utf8',
    );
    const streamedLines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-live' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'the token is secret-value, do not repeat it',
        },
      }),
    ];
    const onStepOutput = jest.fn<void, [StepOutputEvent]>();
    let outputEventsDuringRun = -1;
    runtime.codexPromptRunner = {
      runCodexPrompt: (request): Promise<CodexPromptRunnerResult> => {
        for (const line of streamedLines) {
          request.onTranscriptLine?.(line);
        }
        outputEventsDuringRun = onStepOutput.mock.calls.length;
        return Promise.resolve({
          status: 'success',
          sessionId: 'thread-live',
          rawText: 'done',
          transcript: `${streamedLines.join('\n')}\n`,
          usage: {},
        });
      },
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent-live',
        uses: 'builtin/agent-prompt',
        with: {
          model: 'gpt-5.5',
          prompt: 'stream the work',
        },
      }),
      cwd: tempDir,
      env: {},
      secretEnv: { PIPELINE_SECRET: 'secret-value' },
      runtime,
      signal: new AbortController().signal,
      onStepOutput,
    });

    expect(result.status).toBe('success');
    // One redacted event per streamed line, emitted before the turn resolved.
    expect(outputEventsDuringRun).toBe(2);
    const expectedRedacted = `${streamedLines.join('\n')}\n`
      .split('secret-value')
      .join('***');
    const joinedOutput = onStepOutput.mock.calls
      .map(([event]) => event.data)
      .join('');
    expect(joinedOutput).toBe(expectedRedacted);
    expect(joinedOutput).not.toContain('secret-value');
    expect(onStepOutput.mock.calls[0]?.[0]).toMatchObject({
      executionId: 'exec-1',
      jobId: 'job-1',
      stepId: 'agent-live',
      stream: 'stdout',
    });
    expect(result.log_file).toBeDefined();
    expect(fs.readFileSync(result.log_file ?? '', 'utf8')).toBe(
      expectedRedacted,
    );
  });

  it('emits the full Codex transcript once when the runner does not stream', async () => {
    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  prompt:',
        '    required: false',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      "throw new Error('codexPromptRunner should intercept this step');",
      'utf8',
    );
    const transcript = `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-batch' })}\n`;
    const onStepOutput = jest.fn<void, [StepOutputEvent]>();
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'thread-batch',
          rawText: 'done',
          transcript,
          usage: {},
        }),
    };

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'agent-batch',
        uses: 'builtin/agent-prompt',
        with: {
          model: 'gpt-5.5',
          prompt: 'batch the work',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      onStepOutput,
    });

    expect(result.status).toBe('success');
    expect(onStepOutput).toHaveBeenCalledTimes(1);
    expect(onStepOutput.mock.calls[0]?.[0].data).toBe(transcript);
    expect(fs.readFileSync(result.log_file ?? '', 'utf8')).toBe(transcript);
  });

  it('finalizes an agent step when a terminal result is logged but the process stays alive', async () => {
    const previousGrace = process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS;
    process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS = '50';

    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        "process.stderr.write('non-json stderr prefix');",
        "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\\n');",
        "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'session_id=session-watchdog\\n');",
        "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'text_response=done\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-terminal-watchdog',
          uses: 'builtin/agent-prompt',
          with: {
            model: 'claude-terminal-test',
          },
          timeout_minutes: 1,
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.session_id).toBe('session-watchdog');
      expect(result.outputs.text_response).toBe('done');
      expect(result.error).toBeUndefined();
    } finally {
      if (previousGrace === undefined) {
        delete process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS;
      } else {
        process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS = previousGrace;
      }
    }
  });

  it('finalizes other agent-format actions after terminal results with custom outputs', async () => {
    const previousGrace = process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS;
    process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS = '50';

    const qualityGateDir = path.join(runtime.bundledActionsDir, 'quality-gate');
    fs.mkdirSync(qualityGateDir, { recursive: true });
    fs.writeFileSync(
      path.join(qualityGateDir, 'action.yml'),
      [
        'name: Quality Gate',
        'log_format_hint: agent',
        'inputs:',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(qualityGateDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'passed' }) + '\\n');",
        "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'score=1\\n');",
        "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'passed=true\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'quality-gate-terminal-watchdog',
          uses: 'builtin/quality-gate',
          with: {
            model: 'claude-terminal-test',
          },
          timeout_minutes: 1,
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs.score).toBe('1');
      expect(result.outputs.passed).toBe('true');
      expect(result.error).toBeUndefined();
    } finally {
      if (previousGrace === undefined) {
        delete process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS;
      } else {
        process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS = previousGrace;
      }
    }
  });

  it('treats terminal result error subtypes as failures', async () => {
    const previousGrace = process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS;
    process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS = '50';

    const agentPromptDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
    fs.mkdirSync(agentPromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentPromptDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  model:',
        '    required: false',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(agentPromptDir, 'index.js'),
      [
        "const fs = require('node:fs');",
        "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false }) + '\\n');",
        "fs.appendFileSync(process.env.CANOPY_OUTPUT, 'session_id=session-error\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'agent-terminal-error-watchdog',
          uses: 'builtin/agent-prompt',
          with: {
            model: 'claude-terminal-test',
          },
          timeout_minutes: 1,
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.outputs.session_id).toBe('session-error');
      expect(result.error).toContain('terminal error result');
    } finally {
      if (previousGrace === undefined) {
        delete process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS;
      } else {
        process.env.CANOPY_AGENT_TERMINAL_RESULT_GRACE_MS = previousGrace;
      }
    }
  });

  it('persists claude-only providers and omits unknown agent provider/model metadata', async () => {
    const qualityGateDir = path.join(runtime.bundledActionsDir, 'quality-gate');
    fs.mkdirSync(qualityGateDir, { recursive: true });
    fs.writeFileSync(
      path.join(qualityGateDir, 'action.yml'),
      [
        'name: Quality Gate',
        'log_format_hint: agent',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(qualityGateDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'status=ok\\n');",
      'utf8',
    );

    const customDir = path.join(runtime.bundledActionsDir, 'custom-agent');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDir, 'action.yml'),
      [
        'name: Custom Agent',
        'log_format_hint: agent',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(customDir, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'status=ok\\n');",
      'utf8',
    );

    const claudeOnlyResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'quality-gate',
        uses: 'builtin/quality-gate',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const unknownAgentResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'custom-agent',
        uses: 'builtin/custom-agent',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(claudeOnlyResult.log_format_hint).toBe('agent');
    expect(claudeOnlyResult.agent_provider).toBe('claude');
    expect(claudeOnlyResult.agent_model).toBeUndefined();
    expect(unknownAgentResult.log_format_hint).toBe('agent');
    expect(unknownAgentResult.agent_provider).toBeUndefined();
    expect(unknownAgentResult.agent_model).toBeUndefined();
  });

  it('parses pause output values consistently', () => {
    expect(stepRequestedPause({ [PAUSE_OUTPUT_KEY]: 'true' })).toBe(true);
    expect(stepRequestedPause({ [PAUSE_OUTPUT_KEY]: ' 1 ' })).toBe(true);
    expect(stepRequestedPause({ [PAUSE_OUTPUT_KEY]: 'TRUE' })).toBe(true);
    expect(stepRequestedPause({ [PAUSE_OUTPUT_KEY]: 'false' })).toBe(false);
    expect(stepRequestedPause({ [PAUSE_OUTPUT_KEY]: '0' })).toBe(false);
    expect(stepRequestedPause({ other: 'true' })).toBe(false);
  });

  it('accepts every branded pause output candidate', () => {
    for (const outputKey of PAUSE_OUTPUT_KEYS) {
      expect(stepRequestedPause({ [outputKey]: 'true' })).toBe(true);
    }
  });

  it('parses restart output values consistently', () => {
    expect(stepRequestedRestart({ [JOB_RESTART_OUTPUT_KEY]: 'true' })).toBe(
      true,
    );
    expect(stepRequestedRestart({ [JOB_RESTART_OUTPUT_KEY]: ' 1 ' })).toBe(
      true,
    );
    expect(stepRequestedRestart({ [JOB_RESTART_OUTPUT_KEY]: 'TRUE' })).toBe(
      true,
    );
    expect(stepRequestedRestart({ [JOB_RESTART_OUTPUT_KEY]: 'false' })).toBe(
      false,
    );
    expect(stepRequestedRestart({ [JOB_RESTART_OUTPUT_KEY]: '0' })).toBe(false);
    expect(stepRequestedRestart({ other: 'true' })).toBe(false);
  });

  it('accepts every neutral and branded restart output candidate', () => {
    for (const outputKey of JOB_RESTART_OUTPUT_KEYS) {
      expect(stepRequestedRestart({ [outputKey]: 'true' })).toBe(true);
    }
  });

  it('extracts report outputs from reserved keys', () => {
    expect(
      extractReportOutputs({
        [REPORT_OUTPUT_KEY]: '/tmp/report.md',
        [REPORT_JSON_OUTPUT_KEY]: '/tmp/report.json',
        other: 'value',
      }),
    ).toEqual({
      report_file: '/tmp/report.md',
      report_json_file: '/tmp/report.json',
    });
    expect(extractReportOutputs({ other: 'value' })).toBeUndefined();
  });

  it('extracts report outputs from every branded report output candidate', () => {
    for (const outputKey of REPORT_OUTPUT_KEYS) {
      expect(extractReportOutputs({ [outputKey]: '/tmp/report.md' })).toEqual({
        report_file: '/tmp/report.md',
      });
    }
    for (const outputKey of REPORT_JSON_OUTPUT_KEYS) {
      expect(extractReportOutputs({ [outputKey]: '/tmp/report.json' })).toEqual(
        {
          report_json_file: '/tmp/report.json',
        },
      );
    }
  });

  it('sanitizes reserved report output keys', () => {
    expect(
      sanitizeReportOutputKeys({
        [REPORT_OUTPUT_KEY]: '/tmp/report.md',
        [REPORT_JSON_OUTPUT_KEY]: '/tmp/report.json',
        other: 'value',
      }),
    ).toEqual({
      other: 'value',
    });
  });

  it('extracts notification metadata from reserved output', () => {
    expect(
      extractNotificationOutputs({
        [NOTIFICATION_OUTPUT_KEY]: JSON.stringify({
          title: 'Done',
          body: 'Pipeline finished',
        }),
      }),
    ).toEqual({
      notifications: [{ title: 'Done', body: 'Pipeline finished' }],
    });
    expect(extractNotificationOutputs({ other: 'value' })).toBeUndefined();
    expect(
      extractNotificationOutputs({ [NOTIFICATION_OUTPUT_KEY]: 'not json' }),
    ).toEqual({ error: 'notification metadata is not valid JSON' });
  });

  it('extracts valid pause input requests from reserved output', () => {
    const request = {
      title: 'Review',
      message: 'Confirm scope',
      fields: [{ key: 'scope', label: 'Scope', type: 'string' }],
    };

    expect(
      extractInputRequest({
        [INPUT_REQUEST_OUTPUT_KEY]: JSON.stringify(request),
      }),
    ).toEqual({ request });
  });

  it('reports malformed pause input requests', () => {
    expect(extractInputRequest({ other: 'value' })).toBeUndefined();
    expect(
      extractInputRequest({ [INPUT_REQUEST_OUTPUT_KEY]: 'not json' }),
    ).toEqual({ error: 'request-input metadata is not valid JSON' });
    expect(
      extractInputRequest({
        [INPUT_REQUEST_OUTPUT_KEY]: JSON.stringify({ fields: 'nope' }),
      }),
    ).toEqual({ error: 'request-input metadata failed validation' });
    expect(
      extractInputRequest({
        [INPUT_REQUEST_OUTPUT_KEY]: JSON.stringify({
          fields: [
            { key: 'scope', label: 'Scope', type: 'string' },
            { key: 'scope', label: 'Again', type: 'string' },
          ],
        }),
      }),
    ).toEqual({ error: 'request-input metadata failed validation' });
    expect(
      extractInputRequest({
        [INPUT_REQUEST_OUTPUT_KEY]: JSON.stringify({
          fields: [{ key: 'decision', label: 'Decision', type: 'choice' }],
        }),
      }),
    ).toEqual({ error: 'request-input metadata failed validation' });
  });

  it('sanitizes reserved pause control output keys', () => {
    expect(
      sanitizePauseControlOutputKeys({
        [PAUSE_OUTPUT_KEY]: 'true',
        [INPUT_REQUEST_OUTPUT_KEY]: '{"fields":[]}',
        other: 'value',
      }),
    ).toEqual({ other: 'value' });
  });

  it('sanitizes every branded reserved output key', () => {
    const outputs = {
      ...Object.fromEntries(PAUSE_OUTPUT_KEYS.map((key) => [key, 'true'])),
      ...Object.fromEntries(
        JOB_RESTART_OUTPUT_KEYS.map((key) => [key, 'true']),
      ),
      ...Object.fromEntries(
        REPORT_OUTPUT_KEYS.map((key) => [key, '/tmp/report.md']),
      ),
      ...Object.fromEntries(
        REPORT_JSON_OUTPUT_KEYS.map((key) => [key, '/tmp/report.json']),
      ),
      other: 'value',
    };

    expect(sanitizePauseControlOutputKeys(outputs)).not.toEqual(
      expect.objectContaining(
        Object.fromEntries(PAUSE_OUTPUT_KEYS.map((key) => [key, 'true'])),
      ),
    );
    expect(sanitizePauseControlOutputKeys(outputs)).not.toHaveProperty(
      INPUT_REQUEST_OUTPUT_KEY,
    );
    expect(sanitizeRestartOutputKeys(outputs)).not.toEqual(
      expect.objectContaining(
        Object.fromEntries(JOB_RESTART_OUTPUT_KEYS.map((key) => [key, 'true'])),
      ),
    );
    expect(sanitizeReportOutputKeys(outputs)).toEqual(
      expect.objectContaining({ other: 'value' }),
    );
    for (const outputKey of [
      ...REPORT_OUTPUT_KEYS,
      ...REPORT_JSON_OUTPUT_KEYS,
    ]) {
      expect(sanitizeReportOutputKeys(outputs)).not.toHaveProperty(outputKey);
    }
  });

  it('bubbles pause out of composite actions and skips later nested steps', async () => {
    const skippedFile = path.join(tempDir, 'should-not-exist.txt');
    const compositeDir = path.join(runtime.bundledActionsDir, 'pause-action');
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Pause Action',
        'outputs:',
        '  answer:',
        '    value: ${{ steps.pause.outputs.answer }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: pause',
        '      run: |',
        '        echo "answer=42" >> "$CANOPY_OUTPUT"',
        `        echo '${INPUT_REQUEST_OUTPUT_KEY}={"fields":[{"key":"scope","label":"Scope","type":"string"}]}' >> "$CANOPY_OUTPUT"`,
        `        echo "${PAUSE_OUTPUT_KEY}=true" >> "$CANOPY_OUTPUT"`,
        '    - id: after',
        `      run: echo "nope" > "${skippedFile}"`,
      ].join('\n'),
      'utf8',
    );

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite',
        uses: 'builtin/pause-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({
      answer: '42',
      [INPUT_REQUEST_OUTPUT_KEY]:
        '{"fields":[{"key":"scope","label":"Scope","type":"string"}]}',
      [PAUSE_OUTPUT_KEY]: 'true',
    });
    expect(fs.existsSync(skippedFile)).toBe(false);
  });

  it('bubbles restart out of composite actions and skips later nested steps', async () => {
    const skippedFile = path.join(tempDir, 'should-not-restart.txt');
    const compositeDir = path.join(runtime.bundledActionsDir, 'restart-action');
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Restart Action',
        'outputs:',
        '  answer:',
        '    value: ${{ steps.restart.outputs.answer }}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: restart',
        '      run: |',
        '        echo "answer=42" >> "$CANOPY_OUTPUT"',
        `        echo "${JOB_RESTART_OUTPUT_KEY}=true" >> "$CANOPY_OUTPUT"`,
        '    - id: after',
        `      run: echo "nope" > "${skippedFile}"`,
      ].join('\n'),
      'utf8',
    );

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite',
        uses: 'builtin/restart-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({
      answer: '42',
      [JOB_RESTART_OUTPUT_KEY]: 'true',
    });
    expect(fs.existsSync(skippedFile)).toBe(false);
  });

  it('runs the bundled request-input action and requests a pause', async () => {
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'confirm',
        uses: 'builtin/request-input',
        with: {
          title: 'Review',
          message: 'Confirm before proceeding',
          fields:
            '[{"key":"decision","label":"Decision","type":"choice","options":["continue","revise"],"required":true}]',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          '.cache',
          'brand',
          process.env.CANOPY_BRAND ?? 'canopy',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs[PAUSE_OUTPUT_KEY]).toBe('true');
    expect(extractInputRequest(result.outputs)).toEqual({
      request: {
        title: 'Review',
        message: 'Confirm before proceeding',
        fields: [
          {
            key: 'decision',
            label: 'Decision',
            type: 'choice',
            options: ['continue', 'revise'],
            required: true,
          },
        ],
      },
    });
  });

  it('carries the parent resource through inline descendants', async (): Promise<void> => {
    const parentResource = {
      owner: { type: 'organization', id: 'org-a', name: null },
    };
    const resolvePipelineContextResource: NonNullable<
      ExecutionRuntime['resolvePipelineContextResource']
    > = jest.fn((parent): Promise<typeof parentResource> => {
      if (parent.pipelineId !== 'org-parent')
        return Promise.reject(new Error('Lost parent provenance'));
      return Promise.resolve(parentResource);
    });
    const resolvePipelineResource = jest.fn(
      (): Promise<undefined> => Promise.resolve(undefined),
    );
    const result = await runStep({
      pipelineId: 'org-parent',
      executionId: 'exec-1',
      jobId: 'job-1',
      cwd: tempDir,
      env: {},
      step: createStep({
        id: 'inline',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline_yaml: [
            'name: Inline child',
            'on: dispatch',
            'jobs:',
            '  nested:',
            '    steps:',
            '      - uses: builtin/run-pipeline',
            '        with:',
            '          pipeline_yaml: "name: Grandchild\\non: dispatch\\njobs: {}"',
          ].join('\n'),
        },
      }),
      runtime: {
        ...runtime,
        resolvePipelineContextResource,
        resolvePipelineResource,
        bundledActionsDir: path.resolve(
          'packages/desktop-shared/resources/actions',
        ),
      },
      signal: new AbortController().signal,
    });
    expect(resolvePipelineContextResource).toHaveBeenCalledTimes(1);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('success');
    expect(resolvePipelineResource).toHaveBeenCalledWith(
      'inline-pipeline',
      parentResource,
      undefined,
      expect.anything(),
    );
  });

  it('runs nested pipelines from inline yaml and forwards child output events', async () => {
    const outputEvents: StepOutputEvent[] = [];

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline_yaml: [
            'name: Child Pipeline',
            'on:',
            '  dispatch:',
            '    inputs:',
            '      target:',
            '        required: true',
            'jobs:',
            '  child:',
            '    outputs:',
            '      greeting: ${{ steps.echo.outputs.greeting }}',
            '    steps:',
            '      - id: echo',
            '        run: |',
            '          echo "child stdout"',
            '          echo "greeting=hello ${{ inputs.target }}" >> "$CANOPY_OUTPUT"',
          ].join('\n'),
          inputs: '{"target":"world"}',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
      attempt: 2,
      iteration: 3,
      onStepOutput: (event) => {
        outputEvents.push(event);
      },
    });

    expect(result.status).toBe('success');
    expect(result.outputs.status).toBe('success');
    expect(JSON.parse(result.outputs.outputs)).toEqual({
      child: { greeting: 'hello world' },
    });
    expect(result.outputs['child.greeting']).toBe('hello world');
    expect(
      outputEvents.some(
        (event) =>
          event.executionId === 'exec-1' &&
          event.jobId === 'job-1' &&
          event.stepId === 'nested/child/echo' &&
          event.stepName === 'nested/child/echo' &&
          event.attempt === 2 &&
          event.iteration === 3 &&
          event.stream === 'stdout' &&
          event.data.includes('child stdout'),
      ),
    ).toBe(true);
    // Child byte positions index the child execution's log, not any log the
    // projected parent identity names, so projection drops them.
    const projected = outputEvents.filter((event) =>
      event.stepId.startsWith('nested/'),
    );
    expect(projected.length).toBeGreaterThan(0);
    for (const event of projected) {
      expect(event).not.toHaveProperty('logPosition');
    }
  });

  it('mints a fresh child execution id when no child reasons are selected', async () => {
    const onRunningStepPatch = jest.fn<
      Promise<void>,
      [string, Partial<StepResult>]
    >(() => Promise.resolve());
    const staleChildExecutionId = 'stale-child-execution';

    const result = await runStep({
      executionId: 'exec-fresh-child',
      jobId: 'job-1',
      step: createStep({
        id: 'nested',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline_yaml: [
            'name: Fresh Child Pipeline',
            'on: dispatch',
            'jobs:',
            '  child:',
            '    steps:',
            '      - id: echo',
            '        run: echo child',
          ].join('\n'),
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
      resumeChildExecutionId: staleChildExecutionId,
      resumeChildReasonIds: [],
      onRunningStepPatch,
    });

    const childExecutionId =
      onRunningStepPatch.mock.calls[0]?.[1].child_execution_id;
    expect(childExecutionId).toBeDefined();
    expect(childExecutionId).not.toBe(staleChildExecutionId);
    expect(result.status).toBe('success');
  });

  it('forwards nested matrix output with the physical child job identity confined to the nested step path', async () => {
    const outputEvents: StepOutputEvent[] = [];

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline_yaml: [
            'name: Child Matrix Pipeline',
            'on: dispatch',
            'jobs:',
            '  child:',
            '    strategy:',
            '      matrix:',
            '        item: [alpha]',
            '    steps:',
            '      - id: echo',
            '        run: echo "child ${{ matrix.item }}"',
          ].join('\n'),
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
      onStepOutput: (event) => {
        outputEvents.push(event);
      },
    });

    expect(result.status).toBe('success');
    const childOutput = outputEvents.find((event) =>
      event.data.includes('child alpha'),
    );
    expect(childOutput).toBeDefined();
    expect(childOutput).not.toHaveProperty('matrix_child_id');
  });

  it('passes boolean child pipeline inputs through run-pipeline', async () => {
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested-bool',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline_yaml: [
            'name: Child Boolean Pipeline',
            'on:',
            '  dispatch:',
            '    inputs:',
            '      enable_review:',
            '        type: boolean',
            '        required: false',
            '        default: false',
            'jobs:',
            '  child:',
            '    outputs:',
            '      enabled: ${{ steps.capture.outputs.enabled }}',
            '      mode: ${{ steps.capture.outputs.mode }}',
            '    steps:',
            '      - id: capture',
            '        run: |',
            '          echo "enabled=${{ inputs.enable_review }}" >> "$CANOPY_OUTPUT"',
            '          if [ "${{ inputs.enable_review }}" = "true" ]; then',
            '            echo "mode=enabled" >> "$CANOPY_OUTPUT"',
            '          else',
            '            echo "mode=disabled" >> "$CANOPY_OUTPUT"',
            '          fi',
          ].join('\n'),
          inputs: '{"enable_review":true}',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs['child.enabled']).toBe('true');
    expect(result.outputs['child.mode']).toBe('enabled');
  });

  it('propagates child pipeline report outputs through reserved keys', async () => {
    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested-report',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline_yaml: [
            'name: Child Report Pipeline',
            'on: dispatch',
            'jobs:',
            '  child:',
            '    steps:',
            '      - id: write_report',
            '        run: |',
            '          mkdir -p "$CANOPY_OUTPUT_DIR"',
            '          echo "# Child Report" > "$CANOPY_OUTPUT_DIR/report.md"',
            `          echo "${REPORT_OUTPUT_KEY}=$CANOPY_OUTPUT_DIR/report.md" >> "$CANOPY_OUTPUT"`,
          ].join('\n'),
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(result.outputs[REPORT_OUTPUT_KEY]).toBeTruthy();
    expect(result.outputs[REPORT_OUTPUT_KEY]).toContain(
      `${path.sep}executions${path.sep}`,
    );
  });

  it('runs nested pipelines from a relative file path and applies child cwd', async () => {
    const fixturesDir = path.join(tempDir, 'fixtures');
    const workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixturesDir, 'child.yaml'),
      [
        'name: File Child Pipeline',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    outputs:',
        '      cwd: ${{ steps.capture.outputs.cwd }}',
        '    steps:',
        '      - id: capture',
        '        run: |',
        '          touch child.txt',
        '          echo "cwd=$(pwd)" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested-file',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline: 'fixtures/child.yaml',
          cwd: 'workspace',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('success');
    expect(fs.realpathSync(result.outputs['child.cwd'])).toBe(
      fs.realpathSync(workspaceDir),
    );
    expect(fs.existsSync(path.join(workspaceDir, 'child.txt'))).toBe(true);
  });

  it('runs nested pipelines from a stored pipeline id and propagates pause', async () => {
    const storedPath = path.join(tempDir, 'stored-child.yaml');
    fs.writeFileSync(
      storedPath,
      [
        'name: Stored Child Pipeline',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    steps:',
        '      - id: pause',
        '        run: |',
        `          echo "${PAUSE_OUTPUT_KEY}=true" >> "$CANOPY_OUTPUT"`,
      ].join('\n'),
      'utf8',
    );
    jest
      .spyOn(pipelineStore, 'getStoredPipelinePathWithSource')
      .mockReturnValue({
        success: true,
        data: {
          source: 'user',
          filePath: storedPath,
        },
      });

    const parentResource = {
      owner: { type: 'user', id: 'account-a', name: null },
    };
    const resolvePipelineContextResource = jest.fn(() =>
      Promise.resolve(parentResource),
    );
    const resolvePipelineResource = jest.fn(
      (): Promise<undefined> => Promise.resolve(undefined),
    );
    const result = await runStep({
      pipelineId: 'parent-stored',
      executionId: 'exec-1',
      jobId: 'job-1',
      childId: 'child-000000',
      step: createStep({
        id: 'nested-stored',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline: 'stored-child',
        },
      }),
      cwd: tempDir,
      env: {},
      runtime: {
        ...runtime,
        resolvePipelineResource,
        resolvePipelineContextResource,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(resolvePipelineResource).toHaveBeenCalledWith(
      'stored-child',
      parentResource,
    );
    expect(resolvePipelineContextResource).toHaveBeenCalledWith({
      pipelineId: 'parent-stored',
      projectId: undefined,
      cwd: tempDir,
      pipelineFileDir: undefined,
    });
    expect(result.status).toBe('paused');
    expect(result.outputs.status).toBe('paused');
    expect(result.pause_reasons).toHaveLength(1);
    expect(result.pause_reasons?.[0]?.source).toMatchObject({
      job_id: 'job-1',
      step_id: 'nested-stored',
    });
    expect(result.pause_reasons?.[0]?.source).not.toHaveProperty(
      'matrix_child_id',
    );
  });

  it('rechecks packaged child pipelines against the parent instead of authorizing package files as project files', async () => {
    const packagedPipelines = path.join(tempDir, 'package-cache', 'pipelines');
    fs.mkdirSync(path.join(packagedPipelines, 'children'), { recursive: true });
    fs.writeFileSync(
      path.join(packagedPipelines, 'children', 'review.yaml'),
      [
        'name: Packaged Child Pipeline',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    steps:',
        '      - id: pause',
        '        run: |',
        `          echo "${PAUSE_OUTPUT_KEY}=true" >> "$CANOPY_OUTPUT"`,
      ].join('\n'),
      'utf8',
    );
    const parentResource = {
      owner: { type: 'user', id: 'account-a', name: null },
    };
    // The host rejects any file outside a known project root, exactly as
    // authorizeProjectPipelineRequest does for the package cache.
    const resolvePipelineResource = jest.fn(
      (
        _reference: string,
        _parent: unknown,
        file?: { cwd: string; filePath: string },
      ): Promise<undefined> =>
        file
          ? Promise.reject(
              new Error('Pipeline unavailable (unsupported-target)'),
            )
          : Promise.resolve(undefined),
    );
    const result = await runStep({
      pipelineId: 'parent-packaged',
      executionId: 'exec-1',
      jobId: 'job-1',
      childId: 'child-000000',
      step: createStep({
        id: 'nested-packaged',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline: 'children/review.yaml',
        },
      }),
      cwd: tempDir,
      env: {},
      pipelinePackageOverlay: {
        packageDigest: `pp:v1:${'C'.repeat(43)}`,
        resources: [
          {
            virtualSourceId: 'package/child',
            resourceId: 'child',
            provider: 'claude',
            rootPath: packagedPipelines,
            kind: 'child_pipeline',
            displayName: 'children/review.yaml',
            invocationKeys: ['children/review.yaml'],
          },
        ],
      },
      runtime: {
        ...runtime,
        resolvePipelineResource,
        resolvePipelineContextResource: () => Promise.resolve(parentResource),
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('paused');
    expect(resolvePipelineResource).toHaveBeenCalledWith(
      'review.yaml',
      parentResource,
      undefined,
      expect.objectContaining({ cwd: tempDir }),
    );
    for (const call of resolvePipelineResource.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
  });

  it('resolves nested pipelines relative to the parent pipeline file and project pipeline directory', async () => {
    const repoPath = path.join(tempDir, 'repo');
    const parentPipelineDir = path.join(
      repoPath,
      '.canopy',
      'pipelines',
      'workflows',
    );
    const projectPipelinesDir = path.join(repoPath, '.canopy', 'pipelines');
    fs.mkdirSync(parentPipelineDir, { recursive: true });
    fs.mkdirSync(path.join(projectPipelinesDir, 'shared'), { recursive: true });

    fs.writeFileSync(
      path.join(parentPipelineDir, 'child.yaml'),
      [
        'name: Relative Child',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    outputs:',
        '      source: ${{ steps.echo.outputs.source }}',
        '    steps:',
        '      - id: echo',
        '        run: echo "source=file-relative" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(projectPipelinesDir, 'shared', 'child.yaml'),
      [
        'name: Project Child',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    outputs:',
        '      source: ${{ steps.echo.outputs.source }}',
        '    steps:',
        '      - id: echo',
        '        run: echo "source=project-dir" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );

    const relativeResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested-relative',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline: 'child',
        },
      }),
      cwd: repoPath,
      env: {},
      pipelineFileDir: parentPipelineDir,
      repoPath,
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    const projectResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'nested-project',
        uses: 'builtin/run-pipeline',
        with: {
          pipeline: 'shared/child',
        },
      }),
      cwd: repoPath,
      env: {},
      repoPath,
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      signal: new AbortController().signal,
    });

    expect(relativeResult.status).toBe('success');
    expect(relativeResult.outputs['child.source']).toBe('file-relative');
    expect(projectResult.status).toBe('success');
    expect(projectResult.outputs['child.source']).toBe('project-dir');
  });

  it('resolves nested pipelines from the bundled pipelines directory', async () => {
    const originalCanopyEnvForTest = process.env.CANOPY_ENV;
    const originalBundledResourcesDir =
      process.env.CANOPY_BUNDLED_RESOURCES_DIR;
    const bundledResourcesDir = path.join(tempDir, 'bundled-resources');
    const bundledPipelinesDir = path.join(bundledResourcesDir, 'pipelines');
    fs.mkdirSync(bundledPipelinesDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundledPipelinesDir, 'bundled-child.yaml'),
      [
        'name: Bundled Child Pipeline',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    outputs:',
        '      source: ${{ steps.echo.outputs.source }}',
        '    steps:',
        '      - id: echo',
        '        run: echo "source=bundled" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );
    process.env.CANOPY_ENV = 'production';
    process.env.CANOPY_BUNDLED_RESOURCES_DIR = bundledResourcesDir;

    try {
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        step: createStep({
          id: 'nested-bundled',
          uses: 'builtin/run-pipeline',
          with: {
            pipeline: 'bundled-child.yaml',
          },
        }),
        cwd: tempDir,
        env: {},
        runtime: {
          ...runtime,
          bundledActionsDir: path.resolve(
            process.cwd(),
            'packages',
            'desktop-shared',
            'resources',
            'actions',
          ),
        },
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('success');
      expect(result.outputs['child.source']).toBe('bundled');
    } finally {
      if (originalCanopyEnvForTest === undefined) {
        delete process.env.CANOPY_ENV;
      } else {
        process.env.CANOPY_ENV = originalCanopyEnvForTest;
      }
      if (originalBundledResourcesDir === undefined) {
        delete process.env.CANOPY_BUNDLED_RESOURCES_DIR;
      } else {
        process.env.CANOPY_BUNDLED_RESOURCES_DIR = originalBundledResourcesDir;
      }
    }
  });

  it('forwards stdout and stderr through onStepOutput and keeps both in the log', async () => {
    const outputEvents: StepOutputEvent[] = [];

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'streamed',
        run: 'echo "hello stdout"\necho "hello stderr" >&2',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      onStepOutput: (event) => {
        outputEvents.push(event);
      },
    });

    expect(
      outputEvents.some(
        (event) =>
          event.executionId === 'exec-1' &&
          event.jobId === 'job-1' &&
          event.jobName === 'job-1' &&
          event.stepId === 'streamed' &&
          event.stepName === 'streamed' &&
          event.attempt === 0 &&
          event.stream === 'stdout' &&
          event.data.includes('hello stdout'),
      ),
    ).toBe(true);
    expect(
      outputEvents.some(
        (event) =>
          event.executionId === 'exec-1' &&
          event.jobId === 'job-1' &&
          event.jobName === 'job-1' &&
          event.stepId === 'streamed' &&
          event.stepName === 'streamed' &&
          event.attempt === 0 &&
          event.stream === 'stderr' &&
          event.data.includes('hello stderr'),
      ),
    ).toBe(true);
    expect(result.log_file).toBeTruthy();
    expect(fs.readFileSync(result.log_file ?? '', 'utf8')).toContain(
      'hello stdout',
    );
    expect(fs.readFileSync(result.log_file ?? '', 'utf8')).toContain(
      'hello stderr',
    );
  });

  it('uses nested composite step paths when streaming child output', async () => {
    const compositeDir = path.join(runtime.bundledActionsDir, 'stream-action');
    const outputEvents: StepOutputEvent[] = [];
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Stream Action',
        'outputs: {}',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: inner',
        '      run: |',
        '        echo "nested stdout"',
        '        echo "nested stderr" >&2',
      ].join('\n'),
      'utf8',
    );

    await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'composite',
        uses: 'builtin/stream-action',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      onStepOutput: (event) => {
        outputEvents.push(event);
      },
    });

    expect(
      outputEvents.some(
        (event) =>
          event.jobName === 'job-1' &&
          event.stepId === 'composite/inner' &&
          event.stepName === 'composite/inner' &&
          event.stream === 'stdout' &&
          event.data.includes('nested stdout'),
      ),
    ).toBe(true);
    expect(
      outputEvents.some(
        (event) =>
          event.jobName === 'job-1' &&
          event.stepId === 'composite/inner' &&
          event.stepName === 'composite/inner' &&
          event.stream === 'stderr' &&
          event.data.includes('nested stderr'),
      ),
    ).toBe(true);
  });

  it('uses attempt-specific log files and passes retry context into composite expressions', async () => {
    const compositeDir = path.join(runtime.bundledActionsDir, 'retry-action');
    fs.mkdirSync(compositeDir, { recursive: true });
    fs.writeFileSync(
      path.join(compositeDir, 'action.yml'),
      [
        'name: Retry Action',
        'outputs:',
        '  retry:',
        '    value: "${{ steps.only_retry.outputs.retry_seen }}-${{ job.retry_count }}"',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - id: only_retry',
        '      if: job.is_retry',
        '      run: echo "retry_seen=$CANOPY_JOB_RETRY_COUNT" >> "$CANOPY_OUTPUT"',
      ].join('\n'),
      'utf8',
    );

    const result = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'retry-composite',
        uses: 'builtin/retry-action',
      }),
      cwd: tempDir,
      env: {
        CANOPY_JOB_IS_RETRY: 'true',
        CANOPY_JOB_RETRY_COUNT: '1',
        CANOPY_JOB_MAX_RETRIES: '2',
      },
      runtime,
      signal: new AbortController().signal,
      attempt: 1,
      jobContext: {
        is_retry: true,
        retry_count: 1,
        max_retries: 2,
      },
    });

    expect(result.outputs).toEqual({ retry: '1-1' });
    expect(result.log_file).toContain('--attempt1.log');
  });

  it('handles missing actions, invalid working directories, and escaped mains', async () => {
    const skippedResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'missing',
        uses: 'builtin/does-not-exist',
        skip_on_missing_action: true,
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const invalidDirResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'bad-dir',
        run: 'echo hi',
        working_directory: '../escape',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    const escapedDir = path.join(runtime.bundledActionsDir, 'escaped');
    fs.mkdirSync(escapedDir, { recursive: true });
    fs.writeFileSync(
      path.join(escapedDir, 'action.yml'),
      [
        'name: Escaped',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: ../outside.js',
      ].join('\n'),
      'utf8',
    );
    const escapedResult = await runStep({
      executionId: 'exec-1',
      jobId: 'job-1',
      step: createStep({
        id: 'escaped',
        uses: 'builtin/escaped',
      }),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
    });

    expect(skippedResult.status).toBe('skipped');
    expect(invalidDirResult.status).toBe('failure');
    expect(escapedResult.status).toBe('failure');
    expect(escapedResult.error).toMatch(/unsafe runs.main/i);
  });
});
