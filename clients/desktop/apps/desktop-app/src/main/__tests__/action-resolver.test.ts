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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listBuiltinActions,
  resolveAction,
  resolveActionRuntime,
} from '../pipelines/action-resolver';
import { getBundledActionsDir } from '../pipelines/config-paths';

function writeManifest(actionDir: string, lines: string[]): void {
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    lines.join('\n'),
    'utf-8',
  );
}

describe('action-resolver', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('resolves bundled actions from resources/actions', () => {
    const action = resolveAction('builtin/discovery');

    expect(action).toMatchObject({
      name: 'Discovery',
      description: 'Scan the project and produce discovery artifacts.',
      log_format_hint: 'agent',
      runs: {
        using: 'composite',
      },
    });
    expect(action?.inputs).toMatchObject({
      model: {
        required: false,
      },
      permission_preset: {
        default: 'read_only',
      },
    });
    expect(action?.outputs).toMatchObject({
      text_response: {
        value: '${{ steps.discovery.outputs.text_response }}',
      },
      transcript_file: {
        value: '${{ steps.discovery.outputs.transcript_file }}',
      },
    });
    expect(action?.runs.using).toBe('composite');
    if (action?.runs.using === 'composite') {
      expect(action.runs.steps[0]).toMatchObject({
        id: 'discovery',
        uses: 'builtin/agent-prompt',
      });
    }
  });

  it('resolves the builtin run-pipeline action', () => {
    const action = resolveAction('builtin/run-pipeline');

    expect(action).toEqual({
      name: 'Run Pipeline',
      description:
        'Execute a child pipeline dynamically. Use the step-level target property, not an input, to choose inherit, directory, global, or an existing worktree; create worktrees first with builtin/create-worktree.',
      scopes: ['global', 'directory', 'worktree'],
      inputs: {
        pipeline: {
          description:
            'Stored pipeline ID, bundled filename, or path to a pipeline YAML file',
          required: false,
        },
        pipeline_yaml: {
          description:
            'Inline pipeline YAML string; ignored when pipeline is provided',
          required: false,
        },
        inputs: {
          description: 'JSON object of child pipeline inputs',
          required: false,
          default: '{}',
        },
        cwd: {
          description:
            'Optional child working directory relative to the parent step working directory',
          required: false,
        },
      },
      outputs: {
        status: {
          description: 'Child pipeline terminal status',
        },
        outputs: {
          description: 'JSON object of child job outputs',
        },
      },
      runs: {
        using: 'pipeline',
      },
    });
  });

  it('resolves the builtin agent-resume action', () => {
    const action = resolveAction('builtin/agent-resume');

    expect(action).toMatchObject({
      name: 'Agent Resume',
      description:
        'Resume an existing Claude- or Codex-harness session and expose the result to downstream steps.',
      log_format_hint: 'agent',
      inputs: {
        session_id: {
          required: true,
        },
        model: {
          required: false,
        },
        prompt: {
          required: false,
          default: '',
        },
        permission_preset: {
          required: false,
          default: 'none',
        },
        max_turns: {
          required: false,
        },
      },
      outputs: {
        session_id: {
          description: 'Provider session/thread ID for the resumed run.',
        },
      },
      runs: {
        using: 'node',
        main: 'index.js',
      },
    });
    expect(action?.inputs?.session_id?.description).toMatch(
      /session\/thread ID/,
    );
    expect(action?.inputs?.model?.description).toMatch(
      /pipeline model_aliases id/,
    );
    expect(action?.inputs?.model?.description).toMatch(/alias base model/);
    expect(action?.outputs?.transcript_file?.description).toMatch(
      /transcript capture/,
    );
  });

  it('resolves project actions from .canopy/actions', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
    const actionDir = path.join(tempDir, '.canopy', 'actions', 'custom-action');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Custom Action',
        'description: Resolve a project-scoped action.',
        'log_format_hint: agent',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: python',
        '  main: main.py',
      ].join('\n'),
      'utf-8',
    );

    const action = resolveAction('project/custom-action', tempDir);

    expect(action).toEqual({
      name: 'Custom Action',
      description: 'Resolve a project-scoped action.',
      scopes: ['global', 'directory', 'worktree'],
      log_format_hint: 'agent',
      inputs: {},
      outputs: {},
      runs: {
        using: 'python',
        main: 'main.py',
      },
    });
  });

  it('resolves project actions from fallback project action candidates', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
    const actionDir = path.join(tempDir, '.canopy', 'actions', 'legacy-action');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Legacy Action',
        'description: Resolve a fallback project-scoped action.',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf-8',
    );

    const action = resolveActionRuntime(
      'project/legacy-action',
      {
        bundledActionsDir: path.join(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
        getProjectActionsDir: (repoPath) =>
          path.join(repoPath, '.testbrand', 'actions'),
        getProjectActionsDirCandidates: (repoPath) => [
          path.join(repoPath, '.testbrand', 'actions'),
          path.join(repoPath, '.canopy', 'actions'),
        ],
      },
      tempDir,
    );

    expect(action?.definition.name).toBe('Legacy Action');
    expect(action?.manifestPath).toBe(path.join(actionDir, 'action.yml'));
  });

  it('returns null when an action is missing', () => {
    expect(resolveAction('builtin/does-not-exist')).toBeNull();
  });

  it('rejects unsafe project action paths', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));

    expect(() =>
      resolveAction('project/../escape', tempDir ?? undefined),
    ).toThrow(/Unsafe project action reference/);
  });

  it('rejects unsafe builtin action paths for runtime execution', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));

    expect(() =>
      resolveActionRuntime('builtin/../evil', {
        bundledActionsDir: path.join(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
        getProjectActionsDir: (repoPath) =>
          path.join(repoPath, '.canopy', 'actions'),
      }),
    ).toThrow(/Unsafe builtin action reference/);
  });

  it('rejects escaped runs.main values', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
    const actionDir = path.join(
      tempDir,
      '.canopy',
      'actions',
      'escaped-action',
    );
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Escaped Action',
        'description: Invalid runtime path.',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: ../outside.js',
      ].join('\n'),
      'utf-8',
    );

    expect(() =>
      resolveActionRuntime(
        'project/escaped-action',
        {
          bundledActionsDir: path.join(
            process.cwd(),
            'packages',
            'desktop-shared',
            'resources',
            'actions',
          ),
          getProjectActionsDir: (repoPath) =>
            path.join(repoPath, '.canopy', 'actions'),
        },
        tempDir ?? undefined,
      ),
    ).toThrow(/unsafe runs.main/i);
  });

  it('rejects unsupported log_format_hint values in action manifests', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
    const actionDir = path.join(tempDir, '.canopy', 'actions', 'invalid-hint');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Invalid Hint',
        'log_format_hint: custom',
        'inputs: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf-8',
    );

    expect(() =>
      resolveAction('project/invalid-hint', tempDir ?? undefined),
    ).toThrow(/log_format_hint "custom" is not supported/);
  });

  describe('runs.using host', () => {
    function hostRuntime(bundledActionsDir: string): {
      bundledActionsDir: string;
      getProjectActionsDir: (repoPath: string) => string;
    } {
      return {
        bundledActionsDir,
        getProjectActionsDir: (repoPath: string): string =>
          path.join(repoPath, '.canopy', 'actions'),
      };
    }

    it('resolves a bundled host action without a main path', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
      const bundledDir = path.join(tempDir, 'bundled');
      writeManifest(path.join(bundledDir, 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
      ]);

      const action = resolveActionRuntime(
        'builtin/host-thing',
        hostRuntime(bundledDir),
      );

      expect(action?.definition.runs).toEqual({ using: 'host' });
      expect(action?.mainPath).toBeUndefined();
    });

    it('ignores a stray main key on a host action, as pipeline actions do', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
      const bundledDir = path.join(tempDir, 'bundled');
      writeManifest(path.join(bundledDir, 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
        '  main: index.js',
      ]);
      writeManifest(path.join(bundledDir, 'pipeline-thing'), [
        'name: Pipeline Thing',
        'runs:',
        '  using: pipeline',
        '  main: index.js',
      ]);

      const host = resolveActionRuntime(
        'builtin/host-thing',
        hostRuntime(bundledDir),
      );
      const pipeline = resolveActionRuntime(
        'builtin/pipeline-thing',
        hostRuntime(bundledDir),
      );

      expect(host?.definition.runs).toEqual({ using: 'host' });
      expect(host?.mainPath).toBeUndefined();
      expect(pipeline?.definition.runs).toEqual({ using: 'pipeline' });
      expect(pipeline?.mainPath).toBeUndefined();
    });

    it('refuses a project action that declares runs.using host', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
      writeManifest(path.join(tempDir, '.canopy', 'actions', 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
      ]);

      expect(() =>
        resolveAction('project/host-thing', tempDir ?? undefined),
      ).toThrow(/only bundled actions may use/);
      expect(() =>
        resolveActionRuntime(
          'project/host-thing',
          hostRuntime(path.join(tempDir ?? '', 'bundled')),
          tempDir ?? undefined,
        ),
      ).toThrow(/only bundled actions may use/);
    });

    it('still requires runs.main for node actions', () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-action-'));
      const bundledDir = path.join(tempDir, 'bundled');
      writeManifest(path.join(bundledDir, 'node-thing'), [
        'name: Node Thing',
        'runs:',
        '  using: node',
      ]);

      expect(() =>
        resolveActionRuntime('builtin/node-thing', hostRuntime(bundledDir)),
      ).toThrow(/requires a non-empty runs.main/);
    });
  });

  it('resolves the builtin move-to-group host action', () => {
    const action = resolveAction('builtin/move-to-group');

    expect(action).toMatchObject({
      name: 'Move to Group',
      scopes: ['global', 'directory', 'worktree'],
      runs: { using: 'host' },
    });
    expect(Object.keys(action?.inputs ?? {})).toEqual([
      'project_id',
      'bot_id',
      'task_id',
      'group',
      'group_id',
      'color',
    ]);
    for (const input of Object.values(action?.inputs ?? {})) {
      expect(input.required).toBe(false);
    }
    expect(Object.keys(action?.outputs ?? {})).toEqual([
      'group_id',
      'group_name',
      'group_created',
      'grouped',
      'not_grouped_reason',
      'failure_reason',
    ]);

    const runtime = resolveActionRuntime('builtin/move-to-group', {
      bundledActionsDir: getBundledActionsDir(),
      getProjectActionsDir: (repoPath) =>
        path.join(repoPath, '.canopy', 'actions'),
    });
    expect(runtime?.definition.runs.using).toBe('host');
    expect(runtime?.mainPath).toBeUndefined();
  });

  it('lists builtin actions in sorted order', () => {
    const actions = listBuiltinActions();

    expect(actions).toEqual(
      [...actions].sort((left, right) => left.localeCompare(right)),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'coder',
        'complexity-assessor',
        'discovery',
        'move-to-group',
        'planner',
        'qa-reviewer',
        'request-input',
        'run-pipeline',
        'spec-writer',
      ]),
    );
  });
});
