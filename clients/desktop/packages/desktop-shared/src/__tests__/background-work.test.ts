import {
  backgroundProcessKindForTaskType,
  backgroundProcessKindForTool,
  blocksClose,
  isAsyncAgentLaunchText,
  hasBackgroundWork,
  isCloseBlockingTaskType,
} from '../lib/background-work';

describe('background work selectors', () => {
  it.each([
    ['local_agent', true],
    ['local_workflow', true],
    ['remote_agent', true],
    ['in_process_teammate', true],
    ['local_bash', false],
    ['mcp_task', false],
    ['future_task_type', true],
    [undefined, false],
  ])('treats task type %s as close-blocking: %s', (taskType, expected) => {
    expect(isCloseBlockingTaskType(taskType)).toBe(expected);
  });

  it('counts every provider task as background work and only agents and workflows as close-blocking', () => {
    const shellOnly = [{ taskType: 'local_bash' }];
    expect(hasBackgroundWork(undefined, shellOnly)).toBe(true);
    expect(blocksClose(undefined, shellOnly)).toBe(false);

    const withAgent = [...shellOnly, { taskType: 'local_agent' }];
    expect(blocksClose(undefined, withAgent)).toBe(true);

    expect(hasBackgroundWork(undefined, [])).toBe(false);
    expect(blocksClose({ live: 0, queued: 0 }, [])).toBe(false);
  });

  it.each([
    ['local_agent', 'agent'],
    ['remote_agent', 'agent'],
    ['in_process_teammate', 'agent'],
    ['local_workflow', 'workflow'],
    ['local_bash', 'bash'],
    ['monitor_ws', 'bash'],
    ['monitor_mcp', 'bash'],
    ['mcp_task', 'task'],
    ['future_task_type', undefined],
    ['toString', undefined],
    [undefined, undefined],
  ])('maps task type %s to card kind %s', (taskType, expected) => {
    expect(backgroundProcessKindForTaskType(taskType)).toBe(expected);
  });

  it.each([
    ['Bash', 'bash'],
    ['PowerShell', 'bash'],
    ['Monitor', 'bash'],
    ['Task', 'task'],
    ['Workflow', 'workflow'],
    ['Agent', 'agent'],
    ['toString', 'agent'],
  ])('maps the launching tool %s to card kind %s', (toolName, expected) => {
    expect(backgroundProcessKindForTool(toolName)).toBe(expected);
  });

  it('recognizes the background Agent launch acknowledgement only', () => {
    expect(
      isAsyncAgentLaunchText(
        'Async agent launched successfully.\nagentId: a1b2c3 (internal ID)',
      ),
    ).toBe(true);
    expect(isAsyncAgentLaunchText('Done. agentId: a1b2c3')).toBe(false);
    expect(isAsyncAgentLaunchText('')).toBe(false);
  });

  it('treats live or queued delegations as both background and close-blocking work', () => {
    expect(hasBackgroundWork({ live: 0, queued: 1 }, [])).toBe(true);
    expect(blocksClose({ live: 1, queued: 0 }, [])).toBe(true);
  });
});
