import type {
  SplitTemporaryWorkspaceDestructiveApprovalRequest,
  SplitTemporaryWorkspacePreviewResponse,
} from '@canopy/desktop-shared/types';
import {
  consumeSplitTemporaryWorkspaceDestructiveApproval,
  createSplitTemporaryWorkspaceDestructiveApproval,
  SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE,
} from '../lib/split-temporary-workspace-approval';

const emptySummary = { count: 0, entries: [] };

function request(): SplitTemporaryWorkspaceDestructiveApprovalRequest {
  return {
    workspaceId: 'temporary-workspace',
    worktreeId: 'temporary-worktree',
    selections: { repo: 'remove' },
    rootAction: 'archive',
    previewRevision: 'preview-revision',
  };
}

function preview(
  removalMode: 'archive' | 'delete',
): SplitTemporaryWorkspacePreviewResponse {
  return {
    previewRevision: 'preview-revision',
    repos: [
      {
        repoId: 'repo',
        repoName: 'Repo',
        repoPath: '/repo',
        destinationWorkspaceName: 'Repo',
        removalMode,
        chats: emptySummary,
        pipelines: emptySummary,
        plans: emptySummary,
      },
    ],
    root: {
      present: false,
      canArchive: true,
      chats: emptySummary,
      pipelines: emptySummary,
      plans: emptySummary,
      attachments: emptySummary,
    },
  };
}

describe('split temporary project destructive approvals', () => {
  it('does not issue a token when the effective operation is non-destructive', () => {
    expect(
      createSplitTemporaryWorkspaceDestructiveApproval(
        request(),
        preview('archive'),
      ),
    ).toBeNull();
  });

  it('consumes an exact destructive approval only once', () => {
    const splitRequest = request();
    const destructivePreview = preview('delete');
    const approvalToken = createSplitTemporaryWorkspaceDestructiveApproval(
      splitRequest,
      destructivePreview,
      100,
    );
    expect(approvalToken).not.toBeNull();

    consumeSplitTemporaryWorkspaceDestructiveApproval(
      {
        ...splitRequest,
        destructiveApprovalToken: approvalToken ?? undefined,
      },
      destructivePreview,
      101,
    );

    expect(() =>
      consumeSplitTemporaryWorkspaceDestructiveApproval(
        {
          ...splitRequest,
          destructiveApprovalToken: approvalToken ?? undefined,
        },
        destructivePreview,
        102,
      ),
    ).toThrow(SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE);
  });

  it('rejects and consumes approval when the configuration fingerprint changes', () => {
    const splitRequest = request();
    const destructivePreview = preview('delete');
    const approvalToken = createSplitTemporaryWorkspaceDestructiveApproval(
      splitRequest,
      destructivePreview,
      200,
    );
    const changedPreview = {
      ...destructivePreview,
      previewRevision: 'changed-preview-revision',
      repos: destructivePreview.repos.map((repo) => ({
        ...repo,
        destinationWorkspaceId: 'changed-destination',
      })),
    };

    expect(() =>
      consumeSplitTemporaryWorkspaceDestructiveApproval(
        {
          ...splitRequest,
          destructiveApprovalToken: approvalToken ?? undefined,
        },
        changedPreview,
        201,
      ),
    ).toThrow(SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE);
    expect(() =>
      consumeSplitTemporaryWorkspaceDestructiveApproval(
        {
          ...splitRequest,
          destructiveApprovalToken: approvalToken ?? undefined,
        },
        destructivePreview,
        202,
      ),
    ).toThrow(SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE);
  });

  it('rejects approval when the displayed preview revision is stale', () => {
    expect(() =>
      createSplitTemporaryWorkspaceDestructiveApproval(
        { ...request(), previewRevision: 'stale-preview-revision' },
        preview('delete'),
      ),
    ).toThrow(SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE);
  });
});
