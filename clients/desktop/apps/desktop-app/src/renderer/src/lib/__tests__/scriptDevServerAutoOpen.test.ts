import type { ScriptOutputEvent } from '@canopy/desktop-shared/types';
import { createScriptDevServerAutoOpener } from '../scriptDevServerAutoOpen';
import type { DevServerHit } from '../scriptDevServerDetection';

function event(overrides: Partial<ScriptOutputEvent> = {}): ScriptOutputEvent {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    invocation: 'manual-run',
    script: {
      scriptKey: 'project:launch',
      scriptName: 'launch',
      label: 'Launch',
      command: 'npm run dev',
      lifecycle: 'launch',
      target: 'project',
      devServerPattern: { pattern: 'https?://\\S+', autoOpen: true },
    },
    lines: ['http://localhost:3000/'],
    ...overrides,
  };
}

describe('live script dev-server auto-open', () => {
  it('keeps overlapping runs of one script isolated when either completes', () => {
    const open = jest.fn();
    const tracker = createScriptDevServerAutoOpener(open);
    const first = event({ runId: 'run-1' });
    const second = event({ runId: 'run-2' });
    tracker.started(first);
    tracker.output(first);
    tracker.started(second);
    tracker.output(second);
    expect(open).toHaveBeenCalledTimes(2);
    tracker.completed(second);
    tracker.output(first);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens new URLs once per run, and opens again after a restart', () => {
    const open = jest.fn<
      void,
      [DevServerHit, { projectId: string; worktreeId: string }]
    >();
    const tracker = createScriptDevServerAutoOpener(open);
    const output = event();
    tracker.output(output);
    tracker.output(output);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:3000/',
        autoOpen: true,
      }),
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    tracker.started(output);
    tracker.output(output);
    expect(open).toHaveBeenCalledTimes(2);
    tracker.completed(output);
    tracker.started(output);
    tracker.output(output);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('respects mixed pattern priority and each browser destination', () => {
    const open = jest.fn<
      void,
      [DevServerHit, { projectId: string; worktreeId: string }]
    >();
    const tracker = createScriptDevServerAutoOpener(open);
    const output = event();
    output.script.devServerPattern = [
      { pattern: 'Manual: (https?://\\S+)' },
      {
        pattern: 'External: (https?://\\S+)',
        autoOpen: true,
        openTarget: 'external',
      },
      { pattern: 'https?://\\S+', autoOpen: true },
    ];
    tracker.output({
      ...output,
      lines: [
        'Manual: http://localhost:3000/',
        'External: http://localhost:3001/',
        'http://localhost:3002/',
      ],
    });
    expect(open.mock.calls.map(([hit]) => [hit.url, hit.openTarget])).toEqual([
      ['http://localhost:3001/', 'external'],
      ['http://localhost:3002/', 'in-app'],
    ]);
  });

  it('isolates projects, worktrees, and script keys', () => {
    const open = jest.fn();
    const tracker = createScriptDevServerAutoOpener(open);
    const output = event();
    tracker.output(output);
    tracker.output(event({ projectId: 'project-2' }));
    tracker.output(event({ worktreeId: 'worktree-2' }));
    tracker.output(
      event({ script: { ...output.script, scriptKey: 'project:docs' } }),
    );
    expect(open).toHaveBeenCalledTimes(4);
  });

  it('does not open legacy patterns or invalid URL schemes', () => {
    const open = jest.fn();
    const tracker = createScriptDevServerAutoOpener(open);
    const output = event();
    tracker.output({
      ...output,
      script: { ...output.script, devServerPattern: 'https?://\\S+' },
    });
    tracker.output({
      ...output,
      lines: ['javascript:alert(1)', 'file:///tmp/test'],
    });
    expect(open).not.toHaveBeenCalled();
  });
});
