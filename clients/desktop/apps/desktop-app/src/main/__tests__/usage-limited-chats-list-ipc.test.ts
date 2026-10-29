import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { isRealWorkspaceTarget } from '../ipc/usage-limited-chats';
import { isTransientRetryEligibleTarget } from '../lib/chat-targets';

describe('isRealWorkspaceTarget', () => {
  it('rejects app-managed sentinel projects', () => {
    for (const projectId of [
      'app-advisor',
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      PIPELINE_EDITOR_PROJECT_ID,
    ]) {
      expect(
        isRealWorkspaceTarget({ projectId, worktreeId: 'w', chatId: 'c' }),
      ).toBe(false);
    }
  });

  it('accepts real code, Code Review, and Cowork projects', () => {
    for (const projectId of [
      'ws-real',
      CODE_REVIEW_CHAT_PROJECT_ID,
      STANDALONE_CHAT_PROJECT_ID,
    ]) {
      expect(
        isRealWorkspaceTarget({ projectId, worktreeId: 'w', chatId: 'c' }),
      ).toBe(true);
    }
  });
});

describe('isTransientRetryEligibleTarget', () => {
  it('enables retries for every user-facing chat surface', () => {
    for (const projectId of [
      'ws-real',
      STANDALONE_CHAT_PROJECT_ID,
      PIPELINE_EDITOR_PROJECT_ID,
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      CODE_REVIEW_CHAT_PROJECT_ID,
    ]) {
      expect(
        isTransientRetryEligibleTarget({
          projectId,
          worktreeId: 'w',
          chatId: 'c',
        }),
      ).toBe(true);
    }
  });

  it('keeps App Advisor outside automatic retries', () => {
    expect(
      isTransientRetryEligibleTarget({
        projectId: 'app-advisor',
        worktreeId: 'w',
        chatId: 'c',
      }),
    ).toBe(false);
  });
});
