import {
  buildScriptActionPins,
  scriptActionCommandPreview,
  scriptActionTargetLabel,
} from '../script-action-pins';
import { scriptAction } from './fixtures';

const runner = {
  enabled: true,
  isRunning: (action: { id: string }): boolean => action.id === 'running',
  isPending: (): boolean => false,
};

describe('buildScriptActionPins', () => {
  it('includes only approved, available, pinned actions', () => {
    const pins = buildScriptActionPins(
      [
        scriptAction({ id: 'ok' }),
        scriptAction({ id: 'unpinned', pinned: false }),
        scriptAction({ id: 'pending', status: 'pending' }),
        scriptAction({ id: 'dismissed', status: 'dismissed' }),
        scriptAction({ id: 'gone', unavailableReason: 'Missing' }),
        scriptAction({ id: 'running' }),
      ],
      runner,
      { platform: 'darwin', onRun: () => undefined },
    );
    expect(pins.map((pin) => [pin.id, pin.running])).toEqual([
      ['ok', false],
      ['running', true],
    ]);
  });

  it('supplies no executable pins when the runner is disabled', () => {
    expect(
      buildScriptActionPins(
        [scriptAction()],
        { ...runner, enabled: false },
        {
          platform: 'darwin',
          onRun: () => undefined,
        },
      ),
    ).toEqual([]);
  });

  it('describes the command, target and shortcut', () => {
    const onRun = jest.fn();
    const [pin] = buildScriptActionPins(
      [scriptAction({ shortcut: 'CommandOrControl+Shift+Y' })],
      runner,
      { platform: 'darwin', onRun },
    );
    expect(pin).toMatchObject({
      label: 'dev',
      command: 'pnpm run dev',
      target: 'canopy/apps/web',
      shortcut: '⌘⇧Y',
    });
    pin?.onRun();
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'dev' }));
    const [conflicted] = buildScriptActionPins(
      [
        scriptAction({
          shortcut: 'Alt+Y',
          shortcutConflict: 'Already used by lint',
        }),
      ],
      runner,
      { platform: 'linux', onRun },
    );
    expect(conflicted?.shortcut).toBeUndefined();
  });

  it('labels targets in user terms', () => {
    expect(
      scriptActionTargetLabel(
        scriptAction({ target: { kind: 'workspace-root' }, packagePath: null }),
      ),
    ).toBe('Workspace root');
    expect(
      scriptActionTargetLabel(
        scriptAction({
          target: { kind: 'selected-repository' },
          packagePath: null,
        }),
        'api',
      ),
    ).toBe('api');
    expect(
      scriptActionTargetLabel(
        scriptAction({
          target: { kind: 'selected-repository' },
          packagePath: null,
        }),
      ),
    ).toBe('Selected repository');
  });

  it('previews the first command line', () => {
    expect(scriptActionCommandPreview('make build\nmake test\n')).toBe(
      'make build …',
    );
    expect(scriptActionCommandPreview('echo hi\n')).toBe('echo hi');
    expect(scriptActionCommandPreview('x'.repeat(100))).toHaveLength(80);
  });
});
