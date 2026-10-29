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
