/**
 * App Advisor cowork-classification coverage: entry-keyed
 * `app-advisor/<entryId>` targets get cowork panel/activity/archive
 * semantics while foreign `worktreeId === 'global'` targets stay untouched.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import {
  isAppAdvisorChatTarget,
  isLegacyAppAdvisorGlobalTarget,
  isSyntheticChatTarget,
  shouldArchiveChatTargetOnClose,
} from '../surface';

describe('App Advisor chat-target classification', () => {
  afterEach(() => {
    registerCoworkWorkspaceIds([]);
  });

  it('recognizes every App Advisor entry as an App Advisor target', () => {
    expect(isAppAdvisorChatTarget(APP_ADVISOR_PROJECT_ID, 'entry-1')).toBe(
      true,
    );
    expect(
      isAppAdvisorChatTarget(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).toBe(true);
  });

  it('never classifies a foreign project with worktreeId "global" as App Advisor', () => {
    expect(
      isAppAdvisorChatTarget('some-project', APP_ADVISOR_WORKTREE_ID),
    ).toBe(false);
    expect(
      isLegacyAppAdvisorGlobalTarget('some-project', APP_ADVISOR_WORKTREE_ID),
    ).toBe(false);
  });

  it('marks only the legacy global slot as the legacy target', () => {
    expect(
      isLegacyAppAdvisorGlobalTarget(
        APP_ADVISOR_PROJECT_ID,
        APP_ADVISOR_WORKTREE_ID,
      ),
    ).toBe(true);
    expect(
      isLegacyAppAdvisorGlobalTarget(APP_ADVISOR_PROJECT_ID, 'entry-1'),
    ).toBe(false);
  });

  it('treats App Advisor entries as synthetic (non-worktree) chat targets', () => {
    expect(isSyntheticChatTarget(APP_ADVISOR_PROJECT_ID, 'entry-1')).toBe(true);
  });

  it('archives App Advisor chats on close (cowork archive-on-close semantics)', () => {
    expect(
      shouldArchiveChatTargetOnClose(APP_ADVISOR_PROJECT_ID, 'entry-1'),
    ).toBe(true);
    // Ordinary worktree chats keep archiving; other synthetic scopes do not.
    expect(shouldArchiveChatTargetOnClose('project-1', 'worktree-1')).toBe(
      true,
    );
  });
});
