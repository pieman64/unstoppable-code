/**
 * @jest-environment jsdom
 */
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { IDLE_HOME_LINK_TARGET } from '@/components/home/homeLinkTarget';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  automationDraftName,
  automationSeedFromTask,
  isEligibleHomeTask,
  snapshotHomeTask,
} from '../draft';
import type { HomeTaskSnapshot } from '../types';

function makeSnapshot(
  overrides: Partial<HomeTaskSnapshot> = {},
): HomeTaskSnapshot {
  return {
    surface: 'page',
    mode: 'chat',
    text: 'Summarize billing failures for each service',
    workspaceId: 'workspace-1',
    fileReferenceCount: 0,
    attachmentCount: 0,
    scheduled: false,
    linkTargetStatus: 'idle',
    accountEpoch: 4,
    ...overrides,
  };
}

describe('repeat task drafts', () => {
  beforeEach(() => {
    useWorkspaceContextStore.setState({ accountEpoch: 4 });
    useHomeComposerStore.setState({
      mode: 'chat',
      text: 'Summarize billing failures for each service',
      workspaceId: 'workspace-1',
      fileReferences: [],
      attachments: [],
      scheduledSendDraft: null,
      linkTarget: IDLE_HOME_LINK_TARGET,
    });
  });

  it('snapshots the composer draft and account epoch synchronously', () => {
    useWorkspaceContextStore.setState({ accountEpoch: 9 });
    useHomeComposerStore.setState({
      mode: 'pipeline',
      text: 'Review deployment failures',
      workspaceId: 'workspace-2',
      scheduledSendDraft: { runAt: '2026-10-14T09:00:00.000Z' },
      linkTarget: { status: 'resolving', key: 'link', fingerprint: 'draft' },
    });

    expect(snapshotHomeTask('embedded')).toEqual({
      surface: 'embedded',
      mode: 'pipeline',
      text: 'Review deployment failures',
      workspaceId: 'workspace-2',
      fileReferenceCount: 0,
      attachmentCount: 0,
      scheduled: true,
      linkTargetStatus: 'resolving',
      accountEpoch: 9,
    });
  });

  it('allows a plain chat task in a workspace', () => {
    expect(isEligibleHomeTask(makeSnapshot())).toBe(true);
  });

  it.each([
    ['an empty-chat composer', { surface: 'embedded' as const }],
    ['pipeline mode', { mode: 'pipeline' as const }],
    ['empty prompt', { text: ' \n  ' }],
    ['missing workspace', { workspaceId: null }],
    ['App Advisor', { workspaceId: APP_ADVISOR_PROJECT_ID }],
    ['file references', { fileReferenceCount: 1 }],
    ['attachments', { attachmentCount: 1 }],
    ['scheduled send', { scheduled: true }],
    ['link-routed task', { linkTargetStatus: 'resolved' }],
  ])('excludes %s', (_name, overrides) => {
    expect(isEligibleHomeTask(makeSnapshot(overrides))).toBe(false);
  });

  it('uses the first non-empty line and collapses its whitespace for the name', () => {
    expect(
      automationDraftName('  \n  Review   billing\t failures  \nSecond line'),
    ).toBe('Review billing failures');
  });

  it('truncates names at the last word boundary and hard-cuts a long word', () => {
    expect(
      automationDraftName(
        'one two three four five six seven eight nine ten eleven twelve',
      ),
    ).toBe('one two three four five six seven eight nine ten eleven…');
    expect(automationDraftName('a'.repeat(70))).toBe(`${'a'.repeat(59)}…`);
    expect(automationDraftName('a'.repeat(60))).toBe('a'.repeat(60));
  });

  it('seeds a cowork automation and preserves the prompt verbatim', () => {
    const prompt = '  Review the weekly report\n  Keep its original spacing.  ';
    expect(automationSeedFromTask(prompt, STANDALONE_CHAT_PROJECT_ID)).toEqual({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      isCowork: true,
      name: 'Review the weekly report',
      prompt,
    });
  });

  it('seeds a code workspace automation', () => {
    expect(automationSeedFromTask('Review tests', 'workspace-1')).toEqual({
      projectId: 'workspace-1',
      isCowork: false,
      name: 'Review tests',
      prompt: 'Review tests',
    });
  });
});
