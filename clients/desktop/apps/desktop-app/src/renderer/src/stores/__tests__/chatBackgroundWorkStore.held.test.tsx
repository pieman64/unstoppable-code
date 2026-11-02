/** @jest-environment jsdom */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildGitHubWorkflowRunArtifactReceipt } from '@canopy/desktop-shared/lib/agent-artifacts';
import type { GitHubWorkflowRunArtifactReceiptV1 } from '@canopy/desktop-shared/types';
import {
  chatBackgroundWorkKey,
  dismissChatBackgroundRun,
  markChatBackgroundRunsSeenLive,
  publishChatBackgroundRuns,
  resetChatBackgroundWorkStoreForTests,
  useChatBackgroundWorkStore,
  useChatHeldRunKeys,
} from '../chatBackgroundWorkStore';

const CHAT = chatBackgroundWorkKey('proj', 'wt', 'chat-1');

function githubRun(
  state: GitHubWorkflowRunArtifactReceiptV1['state'],
): GitHubWorkflowRunArtifactReceiptV1 {
  return buildGitHubWorkflowRunArtifactReceipt({
    operation: 'github.watch',
    createdAt: '2026-07-20T00:00:00.000Z',
    watcherId: 'watcher-ci',
    repository: 'acme/api',
    runId: '101',
    runAttempt: 1,
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    navigationTarget: {
      kind: 'github_workflow_run',
      repository: 'acme/api',
      runId: '101',
      htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    },
    state,
    observedAt: '2026-07-20T00:01:00.000Z',
  });
}

let held: ReadonlySet<string> = new Set();
function Harness(): null {
  held = useChatHeldRunKeys(CHAT);
  return null;
}

let root: Root;
beforeEach(() => {
  resetChatBackgroundWorkStoreForTests();
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
});
afterEach(() => act(() => root.unmount()));

describe('useChatHeldRunKeys', () => {
  it('holds a watched GitHub run only once its snapshot is final, until dismissed', () => {
    const running = githubRun({ kind: 'intermediate', status: 'in_progress' });
    act(() => {
      publishChatBackgroundRuns(CHAT, [running]);
      markChatBackgroundRunsSeenLive(CHAT, [running.dedupeKey]);
    });
    // Still running: its watcher makes it live, or, with no watcher, it
    // goes back to its turn as the drawer drops it. Holding it would list
    // it nowhere.
    expect(held.has(running.dedupeKey)).toBe(false);

    act(() =>
      publishChatBackgroundRuns(CHAT, [
        githubRun({ kind: 'terminal', conclusion: 'success' }),
      ]),
    );
    expect(held.has(running.dedupeKey)).toBe(true);

    act(() => dismissChatBackgroundRun(CHAT, running.dedupeKey));
    expect(held.has(running.dedupeKey)).toBe(false);
  });

  it('keeps the final snapshot when the transcript republishes an older one', () => {
    const running = githubRun({ kind: 'intermediate', status: 'in_progress' });
    const finished = {
      ...githubRun({ kind: 'terminal', conclusion: 'success' }),
      observedAt: '2026-07-20T00:05:00.000Z',
    };
    act(() => {
      publishChatBackgroundRuns(CHAT, [running]);
      markChatBackgroundRunsSeenLive(CHAT, [running.dedupeKey]);
      // The drawer publishes what the watcher last saw.
      publishChatBackgroundRuns(CHAT, [finished]);
    });
    expect(held.has(running.dedupeKey)).toBe(true);
    // The transcript's carry still holds the in-progress snapshot; it must
    // not bring the run back as live, or the two writers flip it forever.
    act(() => publishChatBackgroundRuns(CHAT, [running]));
    expect(held.has(running.dedupeKey)).toBe(true);
    expect(
      useChatBackgroundWorkStore.getState().byChat[CHAT]?.[running.dedupeKey],
    ).toBe(finished);
  });
});
