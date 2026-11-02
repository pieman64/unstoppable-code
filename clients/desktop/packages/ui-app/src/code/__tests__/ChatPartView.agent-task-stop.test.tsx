/** @jest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BackgroundTaskStopOutcome,
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import type { PortalChatPart } from '@canopy/protocol/portal';
import { ChatPartView } from '../ChatPartView';
import {
  AgentCardHeaderActionContext,
  type AgentCardTaskStopHost,
} from '../agent-card-task-stop';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const capabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: false,
  backgroundTaskStop: true,
};

/** A client command that answers only task stops, recording each call. */
function stopCommand(
  respond: () => Promise<BackgroundTaskStopOutcome>,
  calls: unknown[][] = [],
): CanopyClient['command'] {
  function command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;
  function command(
    name: CommandName,
    args: CommandMap[CommandName]['args'],
  ): Promise<unknown> {
    calls.push([name, args]);
    return name === 'activity.stopBackgroundTask'
      ? respond()
      : Promise.reject(new Error(`Unexpected command: ${name}`));
  }
  return command;
}

function client(command: CanopyClient['command']): CanopyClient {
  return {
    capabilities,
    query: () => new Promise(() => undefined),
    command,
    subscribe: () => () => undefined,
  };
}

const TARGET = {
  projectId: 'cloud:ws:p1',
  worktreeId: 'cloud:wt:w1',
  chatId: 'cloud:chat-1',
};

function agentPart(data: Record<string, unknown> = {}): PortalChatPart {
  return {
    kind: 'agent',
    data: {
      toolUseId: 'toolu_1',
      subagentType: 'general-purpose',
      description: 'Review the notes folder',
      isRunning: true,
      taskId: 'task-1',
      taskStatus: 'running',
      taskStoppable: true,
      ...data,
    },
  };
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mount(
  part: PortalChatPart,
  host: AgentCardTaskStopHost | null,
  command: CanopyClient['command'] = stopCommand(() =>
    Promise.resolve('stopped'),
  ),
): HTMLDivElement {
  const container = document.createElement('div');
  root = createRoot(container);
  const content: ReactNode = (
    <CanopyClientProvider client={client(command)}>
      <AgentCardHeaderActionContext.Provider value={host}>
        <ChatPartView part={part} />
      </AgentCardHeaderActionContext.Provider>
    </CanopyClientProvider>
  );
  act(() => root?.render(content));
  return container;
}

function stopButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('[data-testid="agent-task-stop"]');
}

const HOST: AgentCardTaskStopHost = {
  stopTarget: (taskId) => ({ ...TARGET, taskId }),
};

describe('ChatPartView agent card Stop (CAN-5205)', () => {
  it("stops a live Claude agent's task from its card header", async () => {
    const calls: unknown[][] = [];
    const container = mount(
      agentPart(),
      HOST,
      stopCommand(() => Promise.resolve('stopped'), calls),
    );
    const button = stopButton(container);
    expect(button?.getAttribute('aria-label')).toBe('Stop agent');

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(calls).toEqual([
      ['activity.stopBackgroundTask', { ...TARGET, taskId: 'task-1' }],
    ]);
    expect(stopButton(container)?.textContent).toContain('Stopping');
  });

  it.each([
    ['without a host', agentPart(), null],
    ['for a task Core cannot stop', agentPart({ taskStoppable: false }), HOST],
    [
      'once the task has settled',
      agentPart({ taskStatus: 'completed', isRunning: false }),
      HOST,
    ],
    ['for a Codex child agent', agentPart({ provider: 'codex' }), HOST],
    [
      'when the host declines the task',
      agentPart(),
      { stopTarget: (): null => null },
    ],
  ])('offers no Stop %s', (_label, part, host) => {
    expect(stopButton(mount(part, host))).toBeNull();
  });
});
