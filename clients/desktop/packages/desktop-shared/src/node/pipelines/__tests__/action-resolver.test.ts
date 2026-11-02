import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveActionRuntime } from '../action-resolver';

function writeManifest(actionDir: string, lines: string[]): void {
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    lines.join('\n'),
    'utf-8',
  );
}

describe('resolveActionRuntime runs.using host', () => {
  let tempDir: string;
  let bundledActionsDir: string;

  function runtime(): {
    bundledActionsDir: string;
    getProjectActionsDir: (repoPath: string) => string;
  } {
    return {
      bundledActionsDir,
      getProjectActionsDir: (repoPath: string): string =>
        path.join(repoPath, '.canopy', 'actions'),
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-shared-action-'));
    bundledActionsDir = path.join(tempDir, 'bundled');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a bundled host action without a main path', () => {
    writeManifest(path.join(bundledActionsDir, 'move-to-group'), [
      'name: Move to Group',
      'runs:',
      '  using: host',
    ]);

    const action = resolveActionRuntime('builtin/move-to-group', runtime());

    expect(action?.definition.runs).toEqual({ using: 'host' });
    expect(action?.mainPath).toBeUndefined();
  });

  it('resolves the bundled send-agent-message manifest in every scope', () => {
    const action = resolveActionRuntime('builtin/send-agent-message', {
      bundledActionsDir: path.resolve(
        __dirname,
        '../../../../resources/actions',
      ),
      getProjectActionsDir: (repoPath: string): string =>
        path.join(repoPath, '.canopy', 'actions'),
    });

    expect(action?.definition.runs).toEqual({ using: 'host' });
    expect(action?.definition.scopes).toEqual([
      'global',
      'directory',
      'worktree',
    ]);
  });

  describe('the bundled wait-for-agent-reply manifest', () => {
    const manifest = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../resources/actions/wait-for-agent-reply/action.yml',
      ),
      'utf-8',
    );

    it('resolves as a host action without a fallback', () => {
      writeManifest(path.join(bundledActionsDir, 'wait-for-agent-reply'), [
        manifest,
      ]);

      const action = resolveActionRuntime(
        'builtin/wait-for-agent-reply',
        runtime(),
      );

      expect(action?.definition.runs).toEqual({ using: 'host' });
      expect(action?.mainPath).toBeUndefined();
    });

    it('is refused from a project actions folder', () => {
      writeManifest(
        path.join(tempDir, '.canopy', 'actions', 'wait-for-agent-reply'),
        [manifest],
      );

      expect(() =>
        resolveActionRuntime(
          'project/wait-for-agent-reply',
          runtime(),
          tempDir,
        ),
      ).toThrow(/only bundled actions may use/);
    });
  });

  it('ignores a stray main key on a host action, as pipeline actions do', () => {
    writeManifest(path.join(bundledActionsDir, 'host-thing'), [
      'name: Host Thing',
      'runs:',
      '  using: host',
      '  main: index.js',
    ]);
    writeManifest(path.join(bundledActionsDir, 'pipeline-thing'), [
      'name: Pipeline Thing',
      'runs:',
      '  using: pipeline',
      '  main: index.js',
    ]);

    const host = resolveActionRuntime('builtin/host-thing', runtime());
    const pipeline = resolveActionRuntime('builtin/pipeline-thing', runtime());

    expect(host?.definition.runs).toEqual({ using: 'host' });
    expect(host?.mainPath).toBeUndefined();
    expect(pipeline?.definition.runs).toEqual({ using: 'pipeline' });
    expect(pipeline?.mainPath).toBeUndefined();
  });

  it('refuses a project action that declares runs.using host', () => {
    writeManifest(path.join(tempDir, '.canopy', 'actions', 'host-thing'), [
      'name: Host Thing',
      'runs:',
      '  using: host',
    ]);

    expect(() =>
      resolveActionRuntime('project/host-thing', runtime(), tempDir),
    ).toThrow(/only bundled actions may use/);
  });

  it('refuses a package-overlay action that declares runs.using host', () => {
    const packageRoot = path.join(tempDir, 'package', 'host-thing');
    writeManifest(packageRoot, ['name: Host Thing', 'runs:', '  using: host']);

    expect(() =>
      resolveActionRuntime('project/host-thing', runtime(), tempDir, {
        packageDigest: 'digest',
        resources: [
          {
            virtualSourceId: 'source',
            resourceId: 'host-thing',
            provider: 'claude',
            rootPath: packageRoot,
            kind: 'pipeline_action',
            displayName: 'Host Thing',
            invocationKeys: ['project/host-thing'],
          },
        ],
      }),
    ).toThrow(/only bundled actions may use/);
  });

  describe('node fallback', () => {
    it('accepts a node fallback and resolves its main path', () => {
      const actionDir = path.join(bundledActionsDir, 'create-worktree');
      writeManifest(actionDir, [
        'name: Create Worktree',
        'runs:',
        '  using: host',
        '  fallback:',
        '    using: node',
        '    main: index.js',
      ]);

      const action = resolveActionRuntime('builtin/create-worktree', runtime());

      expect(action?.definition.runs).toEqual({
        using: 'host',
        fallback: { using: 'node', main: 'index.js' },
      });
      expect(action?.mainPath).toBe(path.resolve(actionDir, 'index.js'));
    });

    it('keeps a host action without a fallback mainless', () => {
      writeManifest(path.join(bundledActionsDir, 'move-to-group'), [
        'name: Move to Group',
        'runs:',
        '  using: host',
      ]);

      const action = resolveActionRuntime('builtin/move-to-group', runtime());

      expect(action?.definition.runs).toEqual({ using: 'host' });
      expect(action?.mainPath).toBeUndefined();
    });

    it.each([
      ['a python fallback', ['    using: python', '    main: index.py']],
      ['a host fallback', ['    using: host']],
      ['a fallback without main', ['    using: node']],
      ['a fallback with a blank main', ['    using: node', "    main: '  '"]],
    ])('refuses %s', (_label, fallbackLines) => {
      writeManifest(path.join(bundledActionsDir, 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
        '  fallback:',
        ...fallbackLines,
      ]);

      expect(() =>
        resolveActionRuntime('builtin/host-thing', runtime()),
      ).toThrow(/runs\.fallback/);
    });

    it('refuses a fallback that is not a mapping', () => {
      writeManifest(path.join(bundledActionsDir, 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
        '  fallback: index.js',
      ]);

      expect(() =>
        resolveActionRuntime('builtin/host-thing', runtime()),
      ).toThrow(/runs\.fallback/);
    });

    it('refuses a fallback main outside the action directory', () => {
      writeManifest(path.join(bundledActionsDir, 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
        '  fallback:',
        '    using: node',
        '    main: ../x.js',
      ]);

      expect(() =>
        resolveActionRuntime('builtin/host-thing', runtime()),
      ).toThrow(
        'Action "builtin/host-thing" has an unsafe runs.main "../x.js"',
      );
    });

    it('still refuses a project host action that declares a fallback', () => {
      writeManifest(path.join(tempDir, '.canopy', 'actions', 'host-thing'), [
        'name: Host Thing',
        'runs:',
        '  using: host',
        '  fallback:',
        '    using: node',
        '    main: index.js',
      ]);

      expect(() =>
        resolveActionRuntime('project/host-thing', runtime(), tempDir),
      ).toThrow(/only bundled actions may use/);
    });
  });

  it('still resolves pipeline actions and requires runs.main for node actions', () => {
    writeManifest(path.join(bundledActionsDir, 'pipeline-thing'), [
      'name: Pipeline Thing',
      'runs:',
      '  using: pipeline',
    ]);
    writeManifest(path.join(bundledActionsDir, 'node-thing'), [
      'name: Node Thing',
      'runs:',
      '  using: node',
    ]);

    expect(
      resolveActionRuntime('builtin/pipeline-thing', runtime())?.definition.runs
        .using,
    ).toBe('pipeline');
    expect(() => resolveActionRuntime('builtin/node-thing', runtime())).toThrow(
      /requires a non-empty runs.main/,
    );
  });
});
