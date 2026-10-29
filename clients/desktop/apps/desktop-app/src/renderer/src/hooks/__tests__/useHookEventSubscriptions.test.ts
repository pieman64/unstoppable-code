import type { HookCompleteEvent } from '@canopy/desktop-shared/types';
import { buildHookCompletionToast } from '../useHookEventSubscriptions';

function createHookCompleteEvent(
  overrides: Partial<HookCompleteEvent['result']>,
): HookCompleteEvent {
  return {
    projectId: 'project-a',
    worktreeId: 'wt-1',
    hook: {
      hookKey: 'project:pr:create',
      triggerName: 'pr:create',
      label: 'PR Created',
      actions: [],
      target: 'project',
    },
    result: {
      success: false,
      exitCode: 1,
      output: '',
      timedOut: false,
      durationMs: 100,
      ...overrides,
    },
  };
}

describe('buildHookCompletionToast', () => {
  it('returns null for successful hook completions', () => {
    expect(
      buildHookCompletionToast(
        createHookCompleteEvent({
          success: true,
          exitCode: 0,
        }),
      ),
    ).toBeNull();
  });

  it('returns a warning toast when an if-command stops the hook', () => {
    expect(
      buildHookCompletionToast(
        createHookCompleteEvent({
          stopped: true,
          exitCode: 2,
        }),
      ),
    ).toEqual({
      message:
        'PR Created did not run because its if-command stopped the hook.',
      type: 'warning',
    });
  });

  it('returns an error toast for ordinary failures', () => {
    expect(buildHookCompletionToast(createHookCompleteEvent({}))).toEqual({
      message: 'PR Created failed — exit 1',
      type: 'error',
    });
  });

  it('includes failure output details when present', () => {
    expect(
      buildHookCompletionToast(
        createHookCompleteEvent({
          output: [
            'Pipeline input validation failed:',
            '- Pipeline input "enabled" must be "true" or "false"',
          ].join('\n'),
        }),
      ),
    ).toEqual({
      message:
        'PR Created failed — exit 1: Pipeline input validation failed: - Pipeline input "enabled" must be "true" or "false"',
      type: 'error',
    });
  });
});
