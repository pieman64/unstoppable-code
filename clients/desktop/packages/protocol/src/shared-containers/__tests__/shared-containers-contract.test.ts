import {
  DEFAULT_SHARED_CONTAINER_LIST_LIMIT,
  MAX_SHARED_CONTAINER_CAPABILITIES,
  MAX_SHARED_CONTAINER_LIST_LIMIT,
  MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT,
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_COMMIT_REQUEST_BYTES,
  MAX_SHARED_CONTAINER_DOWNLOAD_URLS_REQUEST_BYTES,
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_DOWNLOAD_ARTIFACTS,
  MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
  MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES,
  MAX_SHARED_CONTAINER_RETAINED_REVISIONS,
  MAX_SHARED_CONTAINER_REPOSITORIES,
  SHARED_CONTAINER_CAPABILITIES,
  SHARED_CONTAINER_ERROR_CODES,
  SHARED_CONTAINERS_API_VERSION,
  SHARED_CONTAINER_TYPES,
  SHARED_CONTAINER_LINK_AUDIENCES,
  SHARED_CONTAINER_LINK_PATH_PREFIX,
  sharedContainerLinkPath,
  isSharedContainerCreateRequest,
  isSharedContainerCapabilitySet,
  isSharedContainerDetail,
  isSharedContainerRevisionPackage,
  summarizeSharedContainerCapabilityPackage,
  isSharedContainerManifest,
  isSharedContainerRef,
  isSharedContainerSummary,
  isDismissedSharedContainerSummary,
  isListDismissedSharedContainersResponse,
  isRestoreSharedContainerResponse,
  type CreateSharedContainerGrantResponse,
  type ListSharedContainerRecipientsResponse,
  type ListSharedContainersResponse,
  type SearchSharedContainerMembersResponse,
  type SharedContainerDetail,
  isSharedContainerStageRevisionRequest,
  isSharedContainerRevisionLayout,
  isSharedContainerRevisionLayoutV2,
  isSharedContainerRevisionLayoutV3,
  isSharedContainerRevisionLayoutV4,
  isSharedContainerRevisionLayoutV5,
  isSharedContainerPublishedLayout,
  sharedContainerPublishedLayoutHasWebPage,
  isSharedContainerPublishedChat,
  isSharedContainerPublishedPlan,
  isSharedContainerForkProvenance,
  type SharedContainerStageRevisionRequest,
  type SharedContainerManifest,
  type SharedContainerStageRevisionResponse,
  type SharedContainerDownloadUrlsResponse,
} from '../index';
import {
  CANOPY_SERVER_CAPABILITIES,
  REQUIRED_CANOPY_SERVER_CAPABILITIES,
} from '../../canopy-server';

describe('shared-container protocol contract', () => {
  it('builds only canonical unlisted capability-link paths', () => {
    const token = 'A'.repeat(43);
    expect(SHARED_CONTAINER_LINK_AUDIENCES).toEqual(['ANYONE', 'ORGANIZATION']);
    expect(sharedContainerLinkPath(token)).toBe(
      `${SHARED_CONTAINER_LINK_PATH_PREFIX}/${token}`,
    );
    expect(() => sharedContainerLinkPath(`${token}=`)).toThrow(
      'Invalid shared-container link token',
    );
  });

  it('accepts only sanitized schema-v3 publisher layouts', () => {
    const panelLayout = {
      orientation: 1,
      root: {
        type: 'leaf',
        size: 800,
        tabs: [
          { kind: 'chat', chatId: 'chat-1' },
          {
            kind: 'file',
            repoId: 'repo-1',
            relativePath: 'src/index.ts',
            viewMode: 'raw',
          },
          {
            kind: 'browser',
            repoId: 'repo-1',
            relativePath: 'site/index.html',
          },
        ],
        activeTabIndex: 1,
      },
    };
    expect(isSharedContainerPublishedLayout(panelLayout)).toBe(true);
    expect(
      isSharedContainerPublishedLayout({
        ...panelLayout,
        root: {
          ...panelLayout.root,
          tabs: [{ kind: 'browser', url: 'https://example.com' }],
        },
      }),
    ).toBe(false);
    expect(
      isSharedContainerPublishedLayout({
        ...panelLayout,
        root: {
          ...panelLayout.root,
          tabs: [{ kind: 'file', repoId: 'repo-1', relativePath: '../secret' }],
        },
      }),
    ).toBe(false);

    const revision = {
      schemaVersion: 3,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'canopy',
          remoteUrl: 'git@github.com:example/canopy.git',
          owner: 'example',
          repository: 'canopy',
          baseCommitSha: 'a'.repeat(40),
          files: [],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
      layout: panelLayout,
    };
    expect(isSharedContainerRevisionLayoutV3(revision)).toBe(true);
    expect(isSharedContainerRevisionLayout(revision)).toBe(false);
    expect(isSharedContainerRevisionLayoutV2(revision)).toBe(false);
  });

  it('accepts web page browser panels only in schema v5 layouts', () => {
    const webPageLayout = {
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'browser', url: 'https://example.com/docs?page=2' },
          { kind: 'browser', url: 'http://localhost:5173/' },
          { kind: 'browser', url: 'http://127.0.0.1:8080/app' },
        ],
        activeTabIndex: 1,
      },
    };
    expect(
      isSharedContainerPublishedLayout(webPageLayout, { allowWebPages: true }),
    ).toBe(true);
    expect(isSharedContainerPublishedLayout(webPageLayout)).toBe(false);
    for (const url of [
      'file:///tmp/index.html',
      'javascript:alert(1)',
      'about:blank',
      'not a url',
    ]) {
      expect(
        isSharedContainerPublishedLayout(
          {
            ...webPageLayout,
            root: {
              ...webPageLayout.root,
              tabs: [{ kind: 'browser', url }],
              activeTabIndex: 0,
            },
          },
          { allowWebPages: true },
        ),
      ).toBe(false);
    }

    const revision = {
      schemaVersion: 5,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'canopy',
          remoteUrl: 'git@github.com:example/canopy.git',
          owner: 'example',
          repository: 'canopy',
          baseCommitSha: 'a'.repeat(40),
          files: [],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
      layout: webPageLayout,
      startPage: { kind: 'url', url: 'https://example.com/start' },
    };
    expect(isSharedContainerRevisionLayoutV5(revision)).toBe(true);
    expect(
      isSharedContainerRevisionLayoutV4({ ...revision, schemaVersion: 4 }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV3({
        ...revision,
        schemaVersion: 3,
        startPage: undefined,
      }),
    ).toBe(false);
  });

  it('reports whether a published layout carries a web page', () => {
    expect(
      sharedContainerPublishedLayoutHasWebPage({
        orientation: 1,
        root: {
          type: 'branch',
          size: 1,
          children: [
            {
              type: 'leaf',
              size: 1,
              tabs: [{ kind: 'chat', chatId: 'chat-1' }],
              activeTabIndex: 0,
            },
            {
              type: 'leaf',
              size: 1,
              tabs: [{ kind: 'browser', url: 'http://localhost:3000/' }],
              activeTabIndex: 0,
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      sharedContainerPublishedLayoutHasWebPage({
        orientation: 0,
        root: {
          type: 'leaf',
          size: 1,
          tabs: [
            { kind: 'browser', repoId: 'repo-1', relativePath: 'index.html' },
          ],
          activeTabIndex: 0,
        },
      }),
    ).toBe(false);
    expect(sharedContainerPublishedLayoutHasWebPage(undefined)).toBe(false);
  });

  it('accepts schema v4 start pages only for published repositories', () => {
    const revision = {
      schemaVersion: 4,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'canopy',
          remoteUrl: 'git@github.com:example/canopy.git',
          owner: 'example',
          repository: 'canopy',
          baseCommitSha: 'a'.repeat(40),
          files: [],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
      startPage: {
        kind: 'file',
        repoId: 'repo-1',
        relativePath: 'README.md',
      },
    };

    expect(isSharedContainerRevisionLayoutV4(revision)).toBe(true);
    expect(
      isSharedContainerRevisionLayoutV4({
        ...revision,
        startPage: { ...revision.startPage, repoId: 'missing' },
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV4({
        ...revision,
        startPage: { kind: 'url', url: 'https://example.com/start' },
      }),
    ).toBe(true);
    expect(
      isSharedContainerRevisionLayoutV4({
        ...revision,
        startPage: { kind: 'url', url: 'file:///tmp/index.html' },
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV3({
        ...revision,
        schemaVersion: 3,
      }),
    ).toBe(false);

    expect(
      isSharedContainerRevisionLayoutV4({
        ...revision,
        containerType: 'COWORK_WORK_ENTRY',
        repositories: [],
        startPage: {
          kind: 'file',
          repoId: 'workspace',
          relativePath: 'README.md',
        },
      }),
    ).toBe(true);
  });

  it('pins the v1 vocabulary and limits', () => {
    expect(SHARED_CONTAINERS_API_VERSION).toBe(1);
    expect(SHARED_CONTAINER_TYPES).toEqual([
      'CODE_WORKTREE',
      'COWORK_WORK_ENTRY',
      'CLOUD_CHAT',
    ]);
    expect(SHARED_CONTAINER_CAPABILITIES).toEqual(['VIEW', 'PROMPT']);
    expect(SHARED_CONTAINER_ERROR_CODES).toEqual([
      'insufficient-role',
      'blocked-by-org-billing',
      'external-sharing-disabled',
      'shared-container-grant-not-found',
      'shared-container-dismissal-not-found',
      'shared-container-stage-already-committed',
      'shared-container-upload-target-refresh-exhausted',
      'shared-container-cleanup-in-progress',
      'shared_container_package_upload_expired',
      'shared_container_parent_package_unavailable',
      'cloud-chat-owner-organization-mismatch',
    ]);
    expect(MAX_SHARED_CONTAINER_CAPABILITIES).toBe(
      SHARED_CONTAINER_CAPABILITIES.length,
    );
    expect(DEFAULT_SHARED_CONTAINER_LIST_LIMIT).toBe(20);
    expect(MAX_SHARED_CONTAINER_LIST_LIMIT).toBe(50);
    expect(MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT).toBe(50);
    expect(MAX_SHARED_CONTAINER_ARTIFACT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_SHARED_CONTAINER_REVISION_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES).toBe(1024 * 1024);
    expect(MAX_SHARED_CONTAINER_COMMIT_REQUEST_BYTES).toBe(1024);
    expect(MAX_SHARED_CONTAINER_DOWNLOAD_URLS_REQUEST_BYTES).toBe(16 * 1024);
    expect(MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION).toBe(200);
    expect(MAX_SHARED_CONTAINER_DOWNLOAD_ARTIFACTS).toBe(200);
    expect(MAX_SHARED_CONTAINER_RETAINED_REVISIONS).toBe(20);
    expect(MAX_SHARED_CONTAINER_REPOSITORIES).toBe(20);
  });

  it('defines a serializable two-phase artifact publish request', () => {
    const request: SharedContainerStageRevisionRequest = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      title: 'Feature branch',
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      sourceDeviceId: 'device',
      schemaVersion: 1,
      artifacts: [
        {
          artifactId: '00000000-0000-4000-8000-000000000002',
          path: 'transcript.jsonl',
          representation: 'BLOB',
          hash: 'sha256:abc',
          objectSizeBytes: '42',
        },
      ],
    };

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(isSharedContainerStageRevisionRequest(request)).toBe(true);
  });

  it('binds immutable revision lineage into the artifact manifest', () => {
    const manifest: SharedContainerManifest = {
      revisionId: '00000000-0000-4000-8000-000000000010',
      parentRevisionId: '00000000-0000-4000-8000-000000000009',
      schemaVersion: 1,
      artifacts: [
        {
          artifactId: '00000000-0000-4000-8000-000000000002',
          path: 'transcript.jsonl',
          representation: 'BLOB',
          hash: 'sha256:abc',
          objectSizeBytes: '42',
        },
      ],
    };

    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(isSharedContainerManifest(manifest)).toBe(true);
    expect(
      isSharedContainerManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], representation: 'UNKNOWN' }],
      }),
    ).toBe(false);
    expect(
      isSharedContainerManifest({ ...manifest, undeclared: 'top-level' }),
    ).toBe(false);
    expect(
      isSharedContainerManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], undeclared: 'artifact' }],
      }),
    ).toBe(false);
  });

  it('validates the recipient revision layout and rejects undeclared fields', () => {
    const layout = {
      schemaVersion: 1,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'canopy',
          remoteUrl: 'git@github.com:example/canopy.git',
          owner: 'example',
          repository: 'canopy',
          baseCommitSha: 'a'.repeat(40),
          files: [
            {
              path: 'src/index.ts',
              status: 'modified',
              artifactId: 'artifact-1',
              mode: '100644',
            },
            { path: 'old.ts', status: 'deleted', mode: '100644' },
          ],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };

    expect(isSharedContainerRevisionLayout(layout)).toBe(true);
    expect(JSON.stringify(layout)).not.toContain('"run"');
    const withRun = {
      ...layout,
      run: {
        commands: [
          { name: 'setup', command: 'make setup', repoId: 'repo-1' },
          { name: 'launch', command: 'make dev', repoId: 'repo-1' },
        ],
        requiredEnv: ['API_URL', 'DATABASE_URL'],
      },
    };
    expect(isSharedContainerRevisionLayout(withRun)).toBe(true);
    expect(
      isSharedContainerRevisionLayout({
        ...withRun,
        run: {
          ...withRun.run,
          requiredEnv: [`A${'B'.repeat(256)}`],
        },
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...withRun,
        run: {
          ...withRun.run,
          commands: [{ name: 'setup', command: 'make setup' }],
        },
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...withRun,
        run: {
          ...withRun.run,
          commands: [
            { name: 'setup', command: 'make setup', repoId: 'missing' },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...withRun,
        run: { ...withRun.run, unexpected: true },
      }),
    ).toBe(false);
    // CAN-2551: committed work is optional, so a revision published before the
    // fields existed (the base object above) and one that carries them must
    // both validate.
    const withCommitted = {
      ...layout,
      repositories: [
        {
          ...layout.repositories[0],
          baseBranch: 'main',
          mergeBaseSha: 'b'.repeat(40),
          committedFiles: [
            {
              path: 'src/committed.ts',
              status: 'modified',
              insertions: 4,
              deletions: 1,
            },
            { path: 'src/new.ts', status: 'added' },
          ],
        },
      ],
    };
    expect(isSharedContainerRevisionLayout(withCommitted)).toBe(true);
    for (const invalidRepository of [
      { ...withCommitted.repositories[0], mergeBaseSha: 'not-a-sha' },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: 'src/a.ts', status: 'unknown-status' }],
      },
      {
        ...withCommitted.repositories[0],
        // A committed entry never names an artifact: its blobs already live in
        // the recipient's own clone.
        committedFiles: [
          { path: 'src/a.ts', status: 'added', artifactId: 'artifact-2' },
        ],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: '.git/config', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: 'src/a.ts', status: 'added', insertions: -1 }],
      },
      // Committed paths never reach the filesystem — git contains them inside
      // `<sha>:<path>` — but they stay publisher-controlled input, so the
      // validator keeps parity with the uncommitted half's materialize-time
      // check rather than relying on git's containment alone (CAN-2551).
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: '../escape.ts', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: 'src/./a.ts', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: '.', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: '/etc/passwd', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: 'C:\\Windows\\x.ts', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: 'src\\a.ts', status: 'added' }],
      },
      {
        ...withCommitted.repositories[0],
        committedFiles: [{ path: 'src//a.ts', status: 'added' }],
      },
    ]) {
      expect(
        isSharedContainerRevisionLayout({
          ...layout,
          repositories: [invalidRepository],
        }),
      ).toBe(false);
    }
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        repositories: [
          {
            ...layout.repositories[0],
            files: [
              {
                ...layout.repositories[0].files[0],
                representation: 'UNKNOWN',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        repositories: [
          {
            ...layout.repositories[0],
            files: [{ path: 'missing.ts', status: 'added', mode: '100644' }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        repositories: [
          {
            ...layout.repositories[0],
            files: [
              {
                ...layout.repositories[0].files[0],
                path: '.GIT/config',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        repositories: [
          {
            ...layout.repositories[0],
            files: Array.from({ length: 1001 }, (_, index) => ({
              path: `deleted/${index}.txt`,
              status: 'deleted',
              mode: '100644',
            })),
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        repositories: Array.from(
          { length: MAX_SHARED_CONTAINER_REPOSITORIES + 1 },
          (_, index) => ({
            ...layout.repositories[0],
            repoId: `repo-${index}`,
            repoName: `repo-${index}`,
            repository: `repo-${index}`,
            files: [],
          }),
        ),
      }),
    ).toBe(false);

    const coworkLayout = {
      ...layout,
      containerType: 'COWORK_WORK_ENTRY',
      repositories: [],
      files: [
        {
          path: 'reports/final.txt',
          status: 'added',
          artifactId: 'cowork-file-artifact',
          sizeBytes: '12',
        },
      ],
    };
    expect(isSharedContainerRevisionLayout(coworkLayout)).toBe(true);
    expect(
      isSharedContainerRevisionLayout({ ...coworkLayout, run: withRun.run }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        withheldFileCount: 2,
        withheldFileReasons: ['credential-shaped', 'oversized'],
      }),
    ).toBe(true);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        withheldFileCount: -1,
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...layout,
        withheldFileCount: 1,
        withheldFileReasons: ['private-path'],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...coworkLayout,
        repositories: layout.repositories,
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({ ...layout, files: coworkLayout.files }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayout({
        ...coworkLayout,
        files: [{ ...coworkLayout.files[0], status: 'deleted' }],
      }),
    ).toBe(false);
  });

  it('accepts schema v2 only for layouts containing a valid snapshot repository', () => {
    const snapshotRepository = {
      repoId: 'repo-1',
      repoName: 'local-only',
      source: 'snapshot',
      baseCommitSha: 'a'.repeat(40),
      snapshot: {
        bundleArtifactIds: ['00000000-0000-4000-8000-000000000001'],
        treeFileCount: 2,
        treeBytes: '128',
      },
      files: [],
    };
    const layout = {
      schemaVersion: 2,
      containerType: 'CODE_WORKTREE',
      title: 'Local project',
      repositories: [snapshotRepository],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    };

    expect(isSharedContainerRevisionLayoutV2(layout)).toBe(true);
    expect(isSharedContainerRevisionLayout(layout)).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({
        ...layout,
        repositories: [
          {
            ...snapshotRepository,
            snapshot: {
              ...snapshotRepository.snapshot,
              treeFileCount: MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
            },
            files: [
              {
                path: 'existing.txt',
                status: 'modified',
                mode: '100644',
                artifactId: '00000000-0000-4000-8000-000000000002',
              },
            ],
          },
        ],
      }),
    ).toBe(true);
    expect(
      isSharedContainerRevisionLayoutV2({
        ...layout,
        repositories: [
          {
            ...snapshotRepository,
            snapshot: {
              ...snapshotRepository.snapshot,
              treeFileCount: MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
            },
            files: [
              {
                path: 'new.txt',
                status: 'added',
                mode: '100644',
                artifactId: '00000000-0000-4000-8000-000000000002',
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({ ...layout, schemaVersion: 1 }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({
        ...layout,
        repositories: [
          {
            ...snapshotRepository,
            snapshot: {
              ...snapshotRepository.snapshot,
              bundleArtifactIds: [],
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({
        ...layout,
        repositories: [
          {
            ...snapshotRepository,
            snapshot: {
              ...snapshotRepository.snapshot,
              treeBytes: '-1',
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({
        ...layout,
        repositories: [
          {
            ...snapshotRepository,
            remoteUrl: 'git@github.com:example/local-only.git',
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({
        ...layout,
        repositories: [],
      }),
    ).toBe(false);
    expect(
      isSharedContainerRevisionLayoutV2({ ...layout, schemaVersion: 3 }),
    ).toBe(false);
  });

  it('validates the structurally safe published-chat envelope', () => {
    const chat = {
      schemaVersion: 1,
      chatId: 'chat-1',
      title: 'Published chat',
      createdAt: '2026-08-30T12:00:00.000Z',
      description: 'Safe display metadata',
      messages: [
        {
          messageId: 'message-1',
          chatId: 'chat-1',
          role: 'assistant',
          status: 'complete',
          text: 'hello',
          createdAtMs: 1,
        },
      ],
    };
    expect(isSharedContainerPublishedChat(chat)).toBe(true);
    expect(
      isSharedContainerPublishedChat({ ...chat, sdkSessionId: 'secret' }),
    ).toBe(false);
    expect(
      isSharedContainerPublishedChat({
        ...chat,
        messages: [{ ...chat.messages[0], role: 'operator' }],
      }),
    ).toBe(false);
  });

  it('keeps forward-compatible chat parts and mismatched message chat ids readable', () => {
    const chat = {
      schemaVersion: 1,
      chatId: 'chat-1',
      title: 'Published chat',
      createdAt: '2026-08-30T12:00:00.000Z',
      messages: [
        {
          messageId: 'message-1',
          chatId: 'stale-source-chat-id',
          role: 'assistant',
          status: 'complete',
          text: 'hello',
          createdAtMs: 1,
          parts: [{ kind: 'future-part', data: { safe: true } }],
        },
      ],
    };

    expect(isSharedContainerPublishedChat(chat)).toBe(true);
  });

  it('validates the structurally safe published-plan envelope', () => {
    const plan = {
      schemaVersion: 1,
      planId: 'plan-1',
      title: 'Published plan',
      content: '# Plan',
      source: 'agent',
      reviewStatus: 'pending',
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:00:00.000Z',
      latestRevisionNumber: 2,
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-08-30T12:00:00.000Z',
          anchor: {
            quote: 'Implement the publisher',
            renderedText: 'Implement the publisher',
            lineStart: 4,
            lineEnd: 4,
            planNodeId: 'task-1',
            headingPath: ['Phase 1'],
            unanchored: false,
            source: 'diagram',
            diagramKind: 'sequence',
          },
          anchorState: 'matched',
          comments: [
            {
              id: 'comment-1',
              author: 'remote',
              remoteAuthor: { userId: 'user-1', displayName: 'Ada' },
              body: 'Looks good',
              createdAt: '2026-08-30T12:01:00.000Z',
            },
          ],
        },
      ],
    };
    expect(isSharedContainerPublishedPlan(plan)).toBe(true);
    expect(
      isSharedContainerPublishedPlan({ ...plan, projectId: 'local-secret' }),
    ).toBe(false);
    expect(
      isSharedContainerPublishedPlan({ ...plan, commentThreads: [{}] }),
    ).toBe(false);
    expect(
      isSharedContainerPublishedPlan({
        ...plan,
        commentThreads: [
          {
            ...plan.commentThreads[0],
            anchor: { ...plan.commentThreads[0].anchor, localPath: '/secret' },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects a structurally malformed stage request', () => {
    const base = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      title: 'Feature branch',
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      sourceDeviceId: 'device',
      schemaVersion: 1,
    };
    const artifact = {
      artifactId: '00000000-0000-4000-8000-000000000002',
      path: 'transcript.jsonl',
      representation: 'BLOB',
      hash: 'sha256:abc',
      objectSizeBytes: '42',
    };

    expect(isSharedContainerStageRevisionRequest(null)).toBe(false);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        idempotencyKey: undefined,
        artifacts: [artifact],
      }),
    ).toBe(false);
    expect(isSharedContainerStageRevisionRequest({ ...base })).toBe(false);
    // A non-object artifact element must fail the shape gate, not the server.
    expect(
      isSharedContainerStageRevisionRequest({ ...base, artifacts: [null] }),
    ).toBe(false);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        artifacts: [{ ...artifact, representation: 'NOT_A_REPRESENTATION' }],
      }),
    ).toBe(false);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        artifacts: [{ ...artifact, objectSizeBytes: 42 }],
      }),
    ).toBe(false);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        parentRevisionId: 4,
        artifacts: [artifact],
      }),
    ).toBe(false);
    expect(
      isSharedContainerStageRevisionRequest({ ...base, artifacts: [artifact] }),
    ).toBe(true);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        parentRevisionId: '00000000-0000-4000-8000-000000000020',
        artifacts: [{ ...artifact, carriedFromParentRevision: true }],
      }),
    ).toBe(true);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        artifacts: [{ ...artifact, carriedFromParentRevision: false }],
      }),
    ).toBe(false);
  });

  it('rejects malformed package counts and unsafe executable paths', () => {
    const metadata = {
      digest: `pp:v1:${'A'.repeat(43)}`,
      counts: { skills: 1, pipelines: 0, agents: 0, automations: 0, hooks: 0 },
      executableFiles: ['skill/scripts/run.sh'],
    };
    expect(isSharedContainerRevisionPackage(metadata)).toBe(true);
    for (const skills of [-1, 0.5, '1', Infinity, undefined]) {
      expect(
        isSharedContainerRevisionPackage({
          ...metadata,
          counts: { ...metadata.counts, skills },
        }),
      ).toBe(false);
    }
    expect(
      isSharedContainerRevisionPackage({
        ...metadata,
        executableFiles: ['../run.sh'],
      }),
    ).toBe(false);
  });

  it('counts and discloses only what a copy installs, leaving plugin members out', () => {
    const kinds = [
      'standalone_skill',
      'plugin_skill',
      'plugin_command',
      'plugin_agent',
      'agent_definition',
      'child_pipeline',
      'pipeline_definition',
      'automation_definition',
      'hook_definition',
      'pipeline_action',
      'automation_pipeline',
      'file_asset',
    ] as const;
    const resources = kinds.map((kind) => ({
      id: kind,
      kind,
      displayName: kind,
      sourceLabel: 'source',
      sourceVisibility: 'private' as const,
      invocationKeys: [],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude' as const,
          runtimeKind: 'plugin_fragment' as const,
          rootName: kind,
          entries: [
            {
              path: 'file',
              mode: 'execute' as const,
              sha256: 'a'.repeat(64),
              size: 1,
            },
          ],
        },
      ],
    }));
    expect(
      summarizeSharedContainerCapabilityPackage(`pp:v1:${'A'.repeat(43)}`, {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources,
        bindings: [],
        environmentRequirements: [],
        totalFiles: resources.length,
        totalBytes: resources.length,
      }),
    ).toEqual({
      digest: `pp:v1:${'A'.repeat(43)}`,
      // A child pipeline installs inside its parent pipeline's package, not as
      // its own library item, so only the definition and automation pipeline
      // count. Plugin skills,
      // commands and agents are not installed on the recipient's computer.
      counts: { skills: 1, agents: 1, pipelines: 2, automations: 1, hooks: 1 },
      executableFiles: [
        'agent_definition/file',
        'automation_definition/file',
        'automation_pipeline/file',
        'child_pipeline/file',
        'file_asset/file',
        'hook_definition/file',
        'pipeline_action/file',
        'pipeline_definition/file',
        'standalone_skill/file',
      ],
    });
  });

  it("names a provider twin's script once by its readable root", () => {
    const resources = (['claude', 'codex'] as const).map((provider) => ({
      id: `opaque-${provider}`,
      kind: 'standalone_skill' as const,
      displayName: 'Helper',
      sourceLabel: 'source',
      sourceVisibility: 'private' as const,
      invocationKeys: [provider === 'claude' ? '/helper' : '$helper'],
      dependencyResourceIds: [],
      trees: [
        {
          provider,
          runtimeKind: 'standalone_skill' as const,
          rootName: 'customer-helper',
          entries: [
            {
              path: 'scripts/summarize.sh',
              mode: 'execute' as const,
              sha256: 'a'.repeat(64),
              size: 1,
            },
          ],
        },
      ],
    }));
    expect(
      summarizeSharedContainerCapabilityPackage(`pp:v1:${'A'.repeat(43)}`, {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources,
        bindings: [],
        environmentRequirements: [],
        totalFiles: 2,
        totalBytes: 2,
      }).executableFiles,
    ).toEqual(['customer-helper/scripts/summarize.sh']);
  });

  it('accepts the summary of a manifest at its path length limits', () => {
    const longPath = Array.from({ length: 4 }, () => 'p'.repeat(255)).join('/');
    const summary = summarizeSharedContainerCapabilityPackage(
      `pp:v1:${'A'.repeat(43)}`,
      {
        version: 1,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'r'.repeat(255),
            kind: 'standalone_skill',
            displayName: 'Skill',
            sourceLabel: 'source',
            sourceVisibility: 'private',
            invocationKeys: [],
            dependencyResourceIds: [],
            trees: [
              {
                provider: 'claude',
                runtimeKind: 'standalone_skill',
                rootName: 's'.repeat(255),
                entries: [
                  {
                    path: longPath,
                    mode: 'execute',
                    sha256: 'a'.repeat(64),
                    size: 1,
                  },
                ],
              },
            ],
          },
        ],
        bindings: [],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 1,
      },
    );
    expect(summary.executableFiles[0]?.length).toBeGreaterThan(1_024);
    expect(isSharedContainerRevisionPackage(summary)).toBe(true);
  });

  it('accepts exactly the three package attachment modes', () => {
    const base = {
      title: 'Share',
      idempotencyKey: 'stage',
      sourceDeviceId: 'device',
      schemaVersion: 1,
      artifacts: [],
    };
    const capabilityPackage = { version: 1, digest: `pp:v1:${'a'.repeat(43)}` };
    expect(isSharedContainerStageRevisionRequest(base)).toBe(true);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        capabilityPackage,
        committedPackageUploadId: 'upload',
      }),
    ).toBe(true);
    expect(
      isSharedContainerStageRevisionRequest({
        ...base,
        parentRevisionId: 'parent',
        carryParentPackage: true,
      }),
    ).toBe(true);
    for (const fields of [
      { capabilityPackage },
      { committedPackageUploadId: 'upload' },
      { carryParentPackage: true },
      { carryParentPackage: false },
      {
        parentRevisionId: 'parent',
        carryParentPackage: true,
        capabilityPackage,
        committedPackageUploadId: 'upload',
      },
      {
        capabilityPackage: { version: 1, digest: 'invalid' },
        committedPackageUploadId: 'upload',
      },
    ])
      expect(
        isSharedContainerStageRevisionRequest({ ...base, ...fields }),
      ).toBe(false);
  });

  it('returns the artifact key bundle from stage and download responses', () => {
    const key = {
      scheme: 'AES_256_GCM_CHUNKED_V1' as const,
      dataKey: Buffer.alloc(32, 1).toString('base64'),
      aad: 'shared-container-artifact\u001fidentity',
    };
    const staged: SharedContainerStageRevisionResponse = {
      stagingSessionId: 'stage',
      revisionId: 'revision',
      uploadTargets: [
        {
          artifactId: 'artifact',
          target: {
            url: 'https://upload',
            method: 'PUT',
            headers: {},
            expiresAt: '2026-08-28T00:00:00.000Z',
          },
          key,
        },
      ],
    };
    const downloads: SharedContainerDownloadUrlsResponse = {
      downloads: [
        {
          artifactId: 'artifact',
          target: {
            url: 'https://download',
            expiresAt: '2026-08-28T00:00:00.000Z',
          },
          key,
        },
      ],
    };

    expect(JSON.parse(JSON.stringify({ staged, downloads }))).toEqual({
      staged,
      downloads,
    });
  });

  it('accepts optional artifact detail while preserving revision invariants', () => {
    const detail: SharedContainerDetail = {
      id: 'container',
      organizationId: 'org',
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      organizationName: 'Organization',
      access: 'organization',
      worktreeId: 'worktree',
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      revision: 3,
      capabilities: ['VIEW'],
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      latestRevision: {
        id: 'revision',
        revision: 3,
        schemaVersion: 1,
        sourceDeviceId: 'device',
        artifactObjectKey: 'revisions/org/container/revision/manifest',
        artifactHash: 'sha256:manifest',
        artifactSizeBytes: '42',
        artifactCount: 1,
        totalSizeBytes: '42',
        artifacts: [
          {
            artifactId: 'artifact',
            path: 'transcript.jsonl',
            representation: 'BLOB',
            hash: 'sha256:abc',
            objectSizeBytes: '42',
          },
        ],
        createdAt: '2026-08-26T00:00:00.000Z',
      },
    };

    expect(isSharedContainerDetail(detail)).toBe(true);
    expect(
      isSharedContainerDetail({
        ...detail,
        latestRevision: { ...detail.latestRevision, totalSizeBytes: '-1' },
      }),
    ).toBe(false);
  });

  it('accepts only an explicit, non-empty MVP capability set', () => {
    expect(isSharedContainerCapabilitySet(['VIEW'])).toBe(true);
    expect(isSharedContainerCapabilitySet(['VIEW', 'PROMPT'])).toBe(true);
    expect(isSharedContainerCapabilitySet([])).toBe(false);
    expect(isSharedContainerCapabilitySet(['VIEW', 'VIEW'])).toBe(false);
    expect(isSharedContainerCapabilitySet(['EDIT'])).toBe(false);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        worktreeId: 'worktree',
        recipientUserId: 'recipient',
        capabilities: ['VIEW'],
      }),
    ).toBe(true);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        worktreeId: 'worktree',
        recipientUserId: 'recipient',
        capabilities: ['EDIT'],
      }),
    ).toBe(false);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        worktreeId: 'worktree',
        recipientUserId: 'recipient',
        capabilities: ['VIEW', 'VIEW'],
      }),
    ).toBe(false);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        cloudChatId: 'chat',
        recipientUserId: 'recipient',
        capabilities: ['VIEW', 'PROMPT'],
      }),
    ).toBe(true);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        worktreeId: 'worktree',
        cloudChatId: 'chat',
        recipientUserId: 'recipient',
        capabilities: ['VIEW', 'PROMPT'],
      }),
    ).toBe(false);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        recipientUserId: 'recipient',
        capabilities: ['VIEW', 'PROMPT'],
      }),
    ).toBe(false);
    expect(
      isSharedContainerCreateRequest({
        organizationId: 'org',
        worktreeId: 123,
        cloudChatId: 'chat',
        recipientUserId: 'recipient',
        capabilities: ['VIEW', 'PROMPT'],
      }),
    ).toBe(false);
  });

  it('validates exactly one shared-container anchor and its derived backend', () => {
    const common = {
      id: 'container',
      organizationId: 'org',
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      organizationName: 'Organization',
      access: 'organization',
    };

    expect(
      isSharedContainerRef({
        ...common,
        worktreeId: 'worktree',
        containerType: 'CODE_WORKTREE',
        backend: 'desktop',
      }),
    ).toBe(true);
    expect(
      isSharedContainerRef({
        ...common,
        cloudChatId: 'chat',
        containerType: 'CLOUD_CHAT',
        backend: 'cloud',
      }),
    ).toBe(true);
    expect(
      isSharedContainerRef({
        ...common,
        worktreeId: 'worktree',
        cloudChatId: 'chat',
        containerType: 'CLOUD_CHAT',
        backend: 'cloud',
      }),
    ).toBe(false);
    expect(
      isSharedContainerRef({
        ...common,
        containerType: 'CLOUD_CHAT',
        backend: 'cloud',
      }),
    ).toBe(false);
    expect(
      isSharedContainerRef({
        ...common,
        cloudChatId: 'chat',
        containerType: 'CLOUD_CHAT',
        backend: 'desktop',
      }),
    ).toBe(false);
    expect(
      isSharedContainerRef({
        ...common,
        worktreeId: 123,
        cloudChatId: 'chat',
        containerType: 'CLOUD_CHAT',
        backend: 'cloud',
      }),
    ).toBe(false);
  });

  it('keeps revision metadata serializable and artifact-only', () => {
    const detail: SharedContainerDetail = {
      id: 'container',
      organizationId: 'org',
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      organizationName: 'Organization',
      access: 'organization',
      worktreeId: 'worktree',
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      revision: 3,
      capabilities: ['VIEW'],
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      latestRevision: {
        id: 'revision',
        revision: 3,
        schemaVersion: 1,
        sourceDeviceId: 'device',
        artifactObjectKey: 'containers/container/3',
        artifactHash: 'sha256:abc',
        artifactSizeBytes: '42',
        createdAt: '2026-08-26T00:00:00.000Z',
      },
    };

    expect(isSharedContainerDetail(detail)).toBe(true);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  it('rejects an incomplete latest-revision wire record', () => {
    expect(
      isSharedContainerDetail({
        id: 'container',
        organizationId: 'org',
        ownerUserId: 'owner',
        worktreeId: 'worktree',
        containerType: 'CODE_WORKTREE',
        revision: 3,
        capabilities: ['VIEW'],
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        latestRevision: { id: 'revision', revision: 3 },
      }),
    ).toBe(false);
  });

  it('rejects response capability sets other than exactly VIEW', () => {
    const summary = {
      id: 'container',
      organizationId: 'org',
      ownerUserId: 'owner',
      worktreeId: 'worktree',
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      revision: 3,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };

    expect(isSharedContainerSummary({ ...summary, capabilities: [] })).toBe(
      false,
    );
    expect(
      isSharedContainerSummary({
        ...summary,
        capabilities: ['VIEW', 'VIEW'],
      }),
    ).toBe(false);
  });

  it('validates optional cloud workspace display metadata only on cloud summaries', () => {
    const cloudSummary = {
      id: 'container',
      organizationId: 'org',
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      organizationName: 'Organization',
      access: 'organization',
      cloudChatId: 'chat',
      backend: 'cloud',
      containerType: 'CLOUD_CHAT',
      title: 'Shared planning',
      revision: 0,
      capabilities: ['VIEW', 'PROMPT'],
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:00:00.000Z',
    };

    expect(
      isSharedContainerSummary({
        ...cloudSummary,
        cloudWorkspace: { id: 'workspace-1', name: 'Owner project' },
      }),
    ).toBe(true);
    expect(
      isSharedContainerSummary({
        ...cloudSummary,
        cloudWorkspace: { id: '', name: 'Owner project' },
      }),
    ).toBe(false);
    expect(
      isSharedContainerSummary({
        ...cloudSummary,
        cloudWorkspace: { id: 'workspace-1', name: '' },
      }),
    ).toBe(false);
    expect(
      isSharedContainerSummary({
        ...cloudSummary,
        containerType: 'CODE_WORKTREE',
        cloudWorkspace: { id: 'workspace-1', name: 'Owner project' },
      }),
    ).toBe(false);
  });

  it('rejects latest-revision metadata that disagrees with the container head', () => {
    expect(
      isSharedContainerDetail({
        id: 'container',
        organizationId: 'org',
        ownerUserId: 'owner',
        owner: { userId: 'owner', name: 'Owner' },
        organizationName: 'Organization',
        access: 'organization',
        worktreeId: 'worktree',
        containerType: 'CODE_WORKTREE',
        revision: 3,
        capabilities: ['VIEW'],
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        latestRevision: {
          id: 'revision',
          revision: 2,
          schemaVersion: 1,
          sourceDeviceId: 'device',
          artifactObjectKey: 'containers/container/2',
          artifactHash: 'sha256:abc',
          artifactSizeBytes: '42',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      }),
    ).toBe(false);
  });

  it('rejects negative artifact sizes in latest-revision wire records', () => {
    expect(
      isSharedContainerDetail({
        id: 'container',
        organizationId: 'org',
        ownerUserId: 'owner',
        worktreeId: 'worktree',
        containerType: 'CODE_WORKTREE',
        revision: 3,
        capabilities: ['VIEW'],
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
        latestRevision: {
          id: 'revision',
          revision: 3,
          schemaVersion: 1,
          sourceDeviceId: 'device',
          artifactObjectKey: 'containers/container/3',
          artifactHash: 'sha256:abc',
          artifactSizeBytes: '-1',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      }),
    ).toBe(false);
  });

  it('pins the envelope key every list route returns', () => {
    const containers: ListSharedContainersResponse = {
      containers: [],
      nextCursor: null,
    };
    const members: SearchSharedContainerMembersResponse = { members: [] };
    const recipients: ListSharedContainerRecipientsResponse = {
      recipients: [],
      nextCursor: null,
    };
    expect(Object.keys(containers)).toEqual(['containers', 'nextCursor']);
    expect(Object.keys(members)).toEqual(['members']);
    expect(Object.keys(recipients)).toEqual(['recipients', 'nextCursor']);
  });

  it('validates the dismissed listing and restore envelopes', () => {
    const container = {
      id: 'container',
      organizationId: 'org',
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      access: 'organization',
      worktreeId: 'worktree',
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      revision: 3,
      capabilities: ['VIEW'],
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const dismissed = { ...container, dismissedAt: '2026-10-01T00:00:00.000Z' };

    expect(isSharedContainerSummary(container)).toBe(true);
    expect(isDismissedSharedContainerSummary(dismissed)).toBe(true);
    // A live summary is not a dismissed one, and the timestamp must parse.
    expect(isDismissedSharedContainerSummary(container)).toBe(false);
    expect(
      isDismissedSharedContainerSummary({ ...container, dismissedAt: 'soon' }),
    ).toBe(false);

    expect(
      isListDismissedSharedContainersResponse({
        containers: [dismissed],
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      isListDismissedSharedContainersResponse({
        containers: [dismissed],
        nextCursor: 'cursor',
      }),
    ).toBe(true);
    expect(
      isListDismissedSharedContainersResponse({
        containers: [container],
        nextCursor: null,
      }),
    ).toBe(false);
    expect(
      isListDismissedSharedContainersResponse({ containers: [dismissed] }),
    ).toBe(false);

    expect(isRestoreSharedContainerResponse({ container })).toBe(true);
    expect(isRestoreSharedContainerResponse({ container: {} })).toBe(false);
    expect(isRestoreSharedContainerResponse(container)).toBe(false);
  });

  it('returns the container alongside the grant on create', () => {
    const created: CreateSharedContainerGrantResponse = {
      container: {
        id: 'container',
        organizationId: 'org',
        ownerUserId: 'owner',
        owner: { userId: 'owner', name: 'Owner' },
        organizationName: 'Organization',
        access: 'organization',
        worktreeId: 'worktree',
        containerType: 'COWORK_WORK_ENTRY',
        title: 'Work Entry',
        revision: 0,
        capabilities: ['VIEW'],
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
      grant: {
        id: 'grant',
        containerId: 'container',
        recipient: { kind: 'member', userId: 'recipient', name: 'Ada' },
        capabilities: ['VIEW'],
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
    };
    expect(Object.keys(created)).toEqual(['container', 'grant']);
    expect(isSharedContainerSummary(created.container)).toBe(true);
  });

  it('advertises shared-containers-v1 as optional', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('shared-containers-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain(
      'shared-containers-v1',
    );
  });

  it.each(['2026-09-08T12:00:00.000Z', '2026-09-08T08:00:00-04:00'])(
    'preserves the source publication time %s',
    (sourceRevisionCreatedAt) => {
      const provenance = {
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-2',
        sourceOwnerDisplayName: 'Ada',
        sourceRevisionCreatedAt,
        forkedAt: '2026-09-09T12:00:00.000Z',
      };
      expect(isSharedContainerForkProvenance(provenance)).toBe(true);
      expect(
        isSharedContainerForkProvenance(JSON.parse(JSON.stringify(provenance))),
      ).toBe(true);
      expect(
        isSharedContainerForkProvenance({ ...provenance, grantId: 'grant' }),
      ).toBe(false);
    },
  );

  it.each(['later', '', 42, null, {}, []])(
    'rejects invalid source publication time %j',
    (sourceRevisionCreatedAt) => {
      expect(
        isSharedContainerForkProvenance({
          sourceContainerId: 'container-1',
          sourceRevisionId: 'revision-2',
          sourceOwnerDisplayName: 'Ada',
          sourceRevisionCreatedAt,
          forkedAt: '2026-09-09T12:00:00.000Z',
        }),
      ).toBe(false);
    },
  );

  it('validates fork provenance without accepting undeclared fields', () => {
    const provenance = {
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      sourceOwnerDisplayName: 'Ada Lovelace',
      organizationId: 'organization-1',
      forkedAt: '2026-09-09T12:00:00.000Z',
    };

    expect(isSharedContainerForkProvenance(provenance)).toBe(true);
    expect(
      isSharedContainerForkProvenance({ ...provenance, grantId: 'grant-1' }),
    ).toBe(false);
    expect(
      isSharedContainerForkProvenance({ ...provenance, forkedAt: 'later' }),
    ).toBe(false);
    // A personal container shared directly has no owning organization.
    const personal: Record<string, unknown> = { ...provenance };
    delete personal.organizationId;
    expect(isSharedContainerForkProvenance(personal)).toBe(true);
    expect(
      isSharedContainerForkProvenance({ ...provenance, organizationId: '' }),
    ).toBe(false);
  });
});
