import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AgentAuditEntry,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { recordCodeReviewOrigin } from '@/stores/chat/code-review-registry';
import { auditEntryWorkspaceId } from '../auditTrailFilters';

type Scoped = Pick<
  AgentAuditEntry,
  'projectId' | 'worktreeId' | 'linkTarget'
> & {
  contextWorkspaceId?: string;
};

/** A loaded tracked plan: a legacy plan chat's owner comes from its plan. */
function trackedPlan(
  id: string,
  projectId: string,
  worktreeId: string,
): TrackedPlanData {
  return {
    id,
    projectId,
    worktreeId,
    source: 'claude',
    title: 'Plan',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [
      {
        revisionNumber: 1,
        content: '# Plan',
        source: 'claude',
        reviewStatus: 'pending',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    linkedExecutionIds: [],
  };
}

describe('auditEntryWorkspaceId (CAN-3461)', () => {
  afterEach(() => {
    useActivityStore.setState({ trackedPlans: {} });
  });

  it('prefers the link target workspace', () => {
    const entry: Scoped = {
      projectId: 'entry-project',
      linkTarget: {
        page: 'main',
        kind: 'worktree-chat',
        projectId: 'link-project',
        worktreeId: 'worktree-1',
      },
    };
    expect(auditEntryWorkspaceId(entry)).toBe('link-project');
  });

  it('falls back to the entry workspace, then a legacy Cowork id', () => {
    expect(auditEntryWorkspaceId({ projectId: 'entry-project' })).toBe(
      'entry-project',
    );
    expect(
      auditEntryWorkspaceId({
        linkTarget: {
          page: 'chat',
          kind: 'standalone-chat',
          worktreeId: 'legacy-chat-project',
        },
      }),
    ).toBe('legacy-chat-project');
    expect(auditEntryWorkspaceId({})).toBeUndefined();
  });

  it('uses authoritative synthetic origins and keeps global entries visible', () => {
    useActivityStore.setState({
      trackedPlans: {
        'plan-project/plan-worktree': [
          trackedPlan('plan-1', 'plan-project', 'plan-worktree'),
        ],
      },
    });
    recordCodeReviewOrigin('review-scope', {
      projectId: 'review-project',
      worktreeId: 'review-worktree',
    });

    expect(
      auditEntryWorkspaceId({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
      }),
    ).toBe('plan-project');
    expect(
      auditEntryWorkspaceId({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'review-scope',
      }),
    ).toBe('review-project');
    expect(
      auditEntryWorkspaceId({ projectId: PIPELINE_EDITOR_PROJECT_ID }),
    ).toBeUndefined();
  });

  it('uses persistent context ownership and resolves Cowork before its synthetic id', () => {
    expect(
      auditEntryWorkspaceId({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'restored-review',
        contextWorkspaceId: 'restored-project',
      }),
    ).toBe('restored-project');
    expect(
      auditEntryWorkspaceId({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        linkTarget: {
          page: 'chat',
          kind: 'standalone-chat',
          worktreeId: 'cowork-project',
        },
      }),
    ).toBe('cowork-project');
  });
});
