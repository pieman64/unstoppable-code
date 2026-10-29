/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';
import { useRunningSubagentCount } from '../useRunningSubagentCount';

const PROJECT = 'project';
const WORKTREE = 'worktree';

function process(
  id: string,
  overrides: Partial<BackgroundProcess>,
): BackgroundProcess {
  return {
    id,
    chatId: 'chat-1',
    toolUseId: `tool-${id}`,
    toolName: 'Agent',
    kind: 'agent',
    description: id,
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    outputLines: [],
    canStop: true,
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
let seen: number | null = null;

function Probe(): null {
  seen = useRunningSubagentCount(PROJECT, WORKTREE);
  return null;
}

beforeEach(() => {
  seen = null;
  useDelegationActivityStore.getState().reset();
  useActivityStore.setState({ bgProcesses: {} });
  host = document.createElement('div');
  root = createRoot(host);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useRunningSubagentCount', () => {
  it('counts the worktree’s live and queued managed delegations', () => {
    act(() => {
      useDelegationActivityStore.getState().hydrate([
        {
          projectId: PROJECT,
          worktreeId: WORKTREE,
          chatId: 'a',
          live: 2,
          queued: 1,
        },
        {
          projectId: PROJECT,
          worktreeId: WORKTREE,
          chatId: 'b',
          live: 1,
          queued: 0,
        },
        // Another worktree's work never counts here.
        {
          projectId: PROJECT,
          worktreeId: 'other',
          chatId: 'c',
          live: 5,
          queued: 0,
        },
      ]);
    });
    expect(seen).toBe(4);
  });

  it('counts running background agents and workflows, not shells or finished work', () => {
    act(() => {
      useActivityStore.setState({
        bgProcesses: {
          [`${PROJECT}/${WORKTREE}`]: [
            process('agent', { kind: 'agent', status: 'running' }),
            process('queued', { kind: 'agent', status: 'queued' }),
            process('workflow', { kind: 'workflow', status: 'running' }),
            process('shell', { kind: 'bash', status: 'running' }),
            process('done', { kind: 'agent', status: 'completed' }),
          ],
          [`${PROJECT}/other`]: [process('elsewhere', { kind: 'agent' })],
        },
      });
    });
    expect(seen).toBe(3);
  });

  it('adds both sources together', () => {
    act(() => {
      useDelegationActivityStore.getState().hydrate([
        {
          projectId: PROJECT,
          worktreeId: WORKTREE,
          chatId: 'a',
          live: 3,
          queued: 0,
        },
      ]);
      useActivityStore.setState({
        bgProcesses: {
          [`${PROJECT}/${WORKTREE}`]: [
            process('a1', {}),
            process('a2', {}),
            process('a3', {}),
          ],
        },
      });
    });
    expect(seen).toBe(6);
  });

  it('is zero with nothing at work', () => {
    expect(seen).toBe(0);
  });
});
