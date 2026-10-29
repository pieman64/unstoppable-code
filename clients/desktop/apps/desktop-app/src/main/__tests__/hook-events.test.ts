import type {
  HookDescriptor,
  HookRunResponse,
} from '@canopy/desktop-shared/types';
import { createHookCompleteEvent } from '../lib/hook-events';

const hook: HookDescriptor = {
  hookKey: 'project:pr:create',
  triggerName: 'pr:create',
  label: 'PR Created',
  actions: [],
  target: 'project',
};

function buildResult(overrides: Partial<HookRunResponse>): HookRunResponse {
  return {
    success: false,
    exitCode: 1,
    output: '',
    timedOut: false,
    durationMs: 100,
    ...overrides,
  };
}

describe('createHookCompleteEvent', () => {
  it('clears output for successful completions', () => {
    const event = createHookCompleteEvent(
      'project-a',
      'worktree-a',
      hook,
      buildResult({
        success: true,
        exitCode: 0,
        output: 'large output',
      }),
    );

    expect(event.result.output).toBe('');
  });

  it('includes a compact failure summary for failed completions', () => {
    const event = createHookCompleteEvent(
      'project-a',
      'worktree-a',
      hook,
      buildResult({
        output: [
          '$ [1/1] Pipeline action',
          'Pipeline input validation failed:',
          '- Pipeline input "enabled" must be "true" or "false"',
          '- Pipeline input "mode" must be one of: fast, thorough',
          '- extra line 1',
          '- extra line 2',
          '- extra line 3',
          '- extra line 4',
          '- extra line 5',
        ].join('\n'),
      }),
    );

    expect(event.result.output).toBe(
      [
        '$ [1/1] Pipeline action',
        'Pipeline input validation failed:',
        '- Pipeline input "enabled" must be "true" or "false"',
        '- Pipeline input "mode" must be one of: fast, thorough',
        '- extra line 1',
        '- extra line 2',
        '- extra line 3',
        '- extra line 4',
        '[output truncated]',
      ].join('\n'),
    );
  });
});
