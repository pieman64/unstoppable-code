import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { backgroundProcessToTask } from '../background-tasks';

function backgroundProcess(
  overrides: Partial<BackgroundProcess> = {},
): BackgroundProcess {
  return {
    id: 'process-1',
    chatId: 'chat-1',
    toolUseId: 'tool-1',
    taskId: 'task-1',
    toolName: 'Bash',
    kind: 'bash',
    description: 'npm run dev',
    command: 'npm run dev',
    status: 'running',
    startedAt: 100,
    updatedAt: 200,
    lastDescription: 'Compiling',
    summary: 'Dev server',
    outputFile: '/tmp/output.log',
    outputLines: ['ready'],
    canStop: true,
    ...overrides,
  };
}

describe('backgroundProcessToTask', () => {
  it('projects the fields the cards render and drops host-local ones', () => {
    expect(backgroundProcessToTask(backgroundProcess())).toEqual({
      id: 'process-1',
      kind: 'bash',
      status: 'running',
      title: 'npm run dev',
      ownerToolUseId: 'tool-1',
      parentTaskId: null,
      startedAt: 100,
      settledAt: null,
      updatedAt: 200,
      lastDescription: 'Compiling',
      summary: 'Dev server',
      outputLines: ['ready'],
      canStop: true,
    });
  });

  it('settles terminal processes and offers Stop only with a task id', () => {
    const settled = backgroundProcessToTask(
      backgroundProcess({
        status: 'completed',
        lastDescription: undefined,
        summary: undefined,
      }),
    );
    expect(settled.settledAt).toBe(200);
    expect(settled.lastDescription).toBeNull();
    expect(settled.summary).toBeNull();
    expect(
      backgroundProcessToTask(backgroundProcess({ taskId: undefined })).canStop,
    ).toBe(false);
  });
});
