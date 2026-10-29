import {
  cloudWorkspaceFilesRootId,
  cloudWorkspaceFileRelativePath,
  parseCloudWorkspaceFileRelativePath,
} from '../index';
import {
  classifyCloudFileRootId,
  cloudChatAttachmentRelativePath,
  cloudChatAttachmentsFileRootId,
  cloudArtifactsFileRootId,
  cloudSandboxFileRootId,
  parseCloudChatAttachmentRelativePath,
} from '..';
import { CLOUD_DOCUMENT_PREVIEW_MAX_BYTES } from '../../document-preview';

describe('cloud session file root ids', () => {
  it('round-trips generated sandbox, artifact, and attachment roots without confusing prefixes in worktree ids', () => {
    const worktreeId = 'cloud:task:sandbox-artifacts-1';
    const chatId = 'chat|with/slashes';

    expect(
      classifyCloudFileRootId(cloudSandboxFileRootId(worktreeId, chatId)),
    ).toEqual({ kind: 'sandbox', worktreeLocalId: worktreeId, chatId });
    expect(
      classifyCloudFileRootId(cloudArtifactsFileRootId(worktreeId, chatId)),
    ).toEqual({ kind: 'artifacts', worktreeLocalId: worktreeId, chatId });
    expect(
      classifyCloudFileRootId(
        cloudChatAttachmentsFileRootId(worktreeId, chatId),
      ),
    ).toEqual({ kind: 'attachments', worktreeLocalId: worktreeId, chatId });
    expect(classifyCloudFileRootId('sandbox-legacy-worktree')).toEqual({
      kind: 'sandbox',
      worktreeLocalId: 'legacy-worktree',
      chatId: null,
    });
    expect(classifyCloudFileRootId('repository-a')).toBeNull();
  });

  it('round-trips attachment ids and filenames through one strict relative-path codec', () => {
    const relativePath = cloudChatAttachmentRelativePath(
      'attachment/%/一',
      'quarterly / 100%.pdf',
    );

    expect(relativePath).toBe(
      'attachment%2F%25%2F%E4%B8%80/quarterly%20%2F%20100%25.pdf',
    );
    expect(parseCloudChatAttachmentRelativePath(relativePath)).toEqual({
      attachmentId: 'attachment/%/一',
      filename: 'quarterly / 100%.pdf',
    });
  });

  it.each(['', '/', 'id/', '/file.pdf', 'id/file.pdf/extra', '%/file.pdf'])(
    'rejects malformed attachment relative path %p',
    (relativePath) => {
      expect(parseCloudChatAttachmentRelativePath(relativePath)).toBeNull();
    },
  );

  it('caps document preview bytes above attachment uploads and below sandbox downloads', () => {
    expect(CLOUD_DOCUMENT_PREVIEW_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('workspace file locators', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('round trips workspace identity and immutable versions', () => {
    expect(
      classifyCloudFileRootId(
        cloudWorkspaceFilesRootId('tree', 'cloud:ws:workspace'),
      ),
    ).toEqual({
      kind: 'workspace-files',
      worktreeLocalId: 'tree',
      workspaceLocalId: 'cloud:ws:workspace',
      chatId: null,
    });
    expect(
      parseCloudWorkspaceFileRelativePath(
        cloudWorkspaceFileRelativePath(id, id, 'finance Q1.csv'),
      ),
    ).toEqual({ fileId: id, versionId: id, filename: 'finance Q1.csv' });
  });
  it.each([
    `${id}/${id}/..`,
    `${id}/${id}/%2fetc`,
    `${id}/${id}/%zz`,
    `bad/${id}/name`,
    `${id}/${id}/a/b`,
  ])('rejects malformed and traversing paths %s', (path) => {
    expect(parseCloudWorkspaceFileRelativePath(path)).toBeNull();
  });
});

import {
  CLOUD_SESSION_TERMINAL_KEEPALIVE_INTERVAL_MS,
  CLOUD_SESSION_TERMINAL_KEEPALIVE_MAX_IDLE_MS,
  isCloudSandboxNotAwakeCode,
} from '../index';

describe('cloud session terminal contract', () => {
  it('recognises only the sandbox not-awake codes', () => {
    expect(isCloudSandboxNotAwakeCode('SANDBOX_SESSION_EXPIRED')).toBe(true);
    expect(isCloudSandboxNotAwakeCode('SANDBOX_NOT_READY')).toBe(true);
    expect(isCloudSandboxNotAwakeCode('FILE_NOT_FOUND')).toBe(false);
    expect(isCloudSandboxNotAwakeCode(undefined)).toBe(false);
  });
  it('pins the keepalive bounds to Core', () => {
    expect(CLOUD_SESSION_TERMINAL_KEEPALIVE_MAX_IDLE_MS).toBe(86_400_000);
    expect(CLOUD_SESSION_TERMINAL_KEEPALIVE_INTERVAL_MS).toBe(60_000);
  });
});
