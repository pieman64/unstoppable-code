import {
  buildCoworkRevisionArtifacts,
  publishCoworkSharedContainerRevision,
  validateCoworkRevisionForStage,
  type PublishCoworkRevisionDependencies,
} from '../shared-containers/publish/cowork';
import { buildCodeRevisionArtifacts } from '../shared-containers/publish/code';
import {
  buildCoworkPublishInventory,
  type CoworkPublishInventoryDependencies,
} from '../shared-containers/publish/inventory';
import {
  publishSharedContainerRevision,
  pruneSharedContainerPublishStaging,
  sanitizeSharedContainerTitle,
} from '../shared-containers/publish/pipeline';
import { getSharedContainerPublishStagingRootDir } from '../lib/paths';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { SharedContainerPublishRefusalError } from '../shared-containers/publish/errors';
import { ReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as publicationState from '../shared-containers/publication-state';
import type {
  SharedContainerPublicationRecord,
  SharedContainerPublicationStateStore,
} from '../shared-containers/publication-state';
import { SharedContainerReplicaManager } from '../shared-containers/replica/manager';
import {
  buildSharedContainerReplicaFixture,
  fetchForSharedContainerFixture,
  transportForSharedContainerFixture,
} from './fixtures/shared-container-replica-fixture';
import {
  MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES,
  MAX_SHARED_CONTAINER_TITLE_LENGTH,
  isAnySharedContainerRevisionLayout,
  isSharedContainerPublishedChat,
  isSharedContainerRevisionLayout,
  type SharedContainerStageRevisionRequest,
} from '@canopy/protocol/shared-containers';

describe('Cowork shared-container publisher pipeline', () => {
  afterEach(() => jest.restoreAllMocks());

  it('emits walked Cowork files by default and omits exactly the excluded path', async () => {
    const dependencies: CoworkPublishInventoryDependencies = {
      readChatTabs: () =>
        Promise.resolve({
          version: 1,
          activeTabId: null,
          tabs: [],
        }),
      listAttachments: () => Promise.resolve([]),
      listNotes: () => Promise.resolve([]),
      readNote: (_projectId, id) =>
        Promise.resolve({ meta: { id, title: id }, content: '' }),
      listPrompts: () => Promise.resolve([]),
      readPrompt: (_projectId, id) =>
        Promise.resolve({ meta: { id, title: id }, content: '' }),
      listCoworkCandidateFiles: () =>
        Promise.resolve({
          paths: ['hello.md', 'nested/second.txt'],
          withheldFileCount: 0,
        }),
      readWorkspaceFile: (_projectId, path) =>
        Promise.resolve({ path, bytes: Buffer.from(path) }),
      resolveStartPage: () =>
        Promise.resolve({
          startPage: { kind: 'file', path: 'hello.md' },
          source: 'cowork',
        }),
    };
    const buildLayout = async (
      excludedPaths?: string[],
    ): Promise<{
      schemaVersion: number;
      files: Array<{ path: string }>;
      startPage?: unknown;
    }> => {
      const inventory = await buildCoworkPublishInventory(
        {
          projectId: 'workspace-1',
          worktreeId: 'entry-1',
          scope: {
            includedPaths: [],
            ...(excludedPaths ? { excludedPaths } : {}),
          },
        },
        dependencies,
      );
      const layoutArtifact = buildCoworkRevisionArtifacts(inventory).find(
        (artifact) => artifact.path === 'container.json',
      );
      if (!layoutArtifact) throw new Error('Missing Cowork layout artifact');
      return JSON.parse(layoutArtifact.bytes.toString('utf8')) as {
        schemaVersion: number;
        files: Array<{ path: string }>;
        startPage?: unknown;
      };
    };

    await expect(buildLayout()).resolves.toMatchObject({
      schemaVersion: 4,
      files: [{ path: 'hello.md' }, { path: 'nested/second.txt' }],
      startPage: {
        kind: 'file',
        repoId: 'workspace',
        relativePath: 'hello.md',
      },
    });
    await expect(buildLayout(['nested/second.txt'])).resolves.toMatchObject({
      files: [{ path: 'hello.md' }],
    });

    // A web page in the layout needs schema v5, which older receivers report
    // as an update instead of rejecting the revision as invalid.
    const inventory = await buildCoworkPublishInventory(
      {
        projectId: 'workspace-1',
        worktreeId: 'entry-1',
        scope: { includedPaths: [] },
      },
      dependencies,
    );
    const webPageArtifact = buildCoworkRevisionArtifacts({
      ...inventory,
      layout: {
        orientation: 0,
        root: {
          type: 'leaf',
          size: 1,
          tabs: [{ kind: 'browser', url: 'http://localhost:5173/' }],
          activeTabIndex: 0,
        },
      },
    }).find((artifact) => artifact.path === 'container.json');
    if (!webPageArtifact) throw new Error('Missing Cowork layout artifact');
    const webPageLayout: unknown = JSON.parse(
      webPageArtifact.bytes.toString('utf8'),
    );
    expect(webPageLayout).toMatchObject({
      schemaVersion: 5,
      layout: {
        root: { tabs: [{ kind: 'browser', url: 'http://localhost:5173/' }] },
      },
    });
    expect(isAnySharedContainerRevisionLayout(webPageLayout)).toBe(true);
  });

  it('publishes a structural chat envelope and round-trips every Cowork artifact through the replica', async () => {
    const ownerAttachmentPath = '/Users/owner/private/image.png';
    const artifacts = buildCoworkRevisionArtifacts(
      {
        chats: [
          {
            id: 'chat-1',
            title: 'Chat at /Users/owner/workspace',
            description: 'Display only from C:\\Users\\owner\\project',
            createdAt: '2026-08-30T12:00:00.000Z',
            sdkSessionId: 'must-not-publish',
            messages: [
              {
                id: 'hidden-delivery',
                role: 'user',
                hidden: true,
                timestamp: 0,
                blocks: [
                  { type: 'text', text: 'private orchestration payload' },
                ],
              },
              {
                id: 'message-1',
                role: 'assistant',
                timestamp: 1,
                blocks: [
                  {
                    type: 'text',
                    text: `Open file:///Users/owner/workspace/file-url.txt\n${'x'.repeat(7_000)}`,
                  },
                  {
                    type: 'file_references',
                    references: [
                      {
                        displayPath: 'notes/private.md',
                        absolutePath: '/Users/owner/workspace/notes/private.md',
                      },
                    ],
                  },
                  {
                    type: 'tool_use',
                    toolUseId: 'tool-1',
                    toolName: 'Read',
                    input: {
                      path: '/Users/owner/workspace/secrets.txt',
                      '/Users/owner/workspace/keyed.txt': 'keyed path',
                      items: Array.from(
                        { length: 25 },
                        (_, index) => `item-${index}`,
                      ),
                      nested: {
                        command:
                          'cat /Users/owner/workspace/secrets.txt from C:\\Users\\owner\\project',
                        url: 'file:///Users/owner/workspace/nested-url.txt',
                        level1: { level2: { level3: 'preserved' } },
                      },
                    },
                  },
                  {
                    type: 'tool_result',
                    toolUseId: 'tool-1',
                    output:
                      'Read /Users/owner/workspace/secrets.txt from C:\\Users\\owner\\project',
                    isError: false,
                  },
                ],
                attachmentPaths: [ownerAttachmentPath],
              },
            ],
          },
        ],
        attachments: [
          {
            displayName: 'image.png',
            sourcePath: ownerAttachmentPath,
            bytes: Buffer.from('image'),
          },
        ],
        notes: [
          {
            meta: { id: 'note-1', title: 'Selected note' },
            content: '# Selected note\n',
          },
        ],
        prompts: [
          {
            meta: { id: 'prompt-1', title: 'Selected prompt' },
            content: '# Selected prompt\n',
          },
        ],
        files: [{ path: 'approved.txt', bytes: Buffer.from('approved') }],
        withheldFileCount: 2,
      },
      undefined,
      'Derived Work Entry title',
    );
    const layoutArtifact = artifacts.find(
      (artifact) => artifact.path === 'container.json',
    );
    expect(artifacts[artifacts.length - 1]?.path).toBe('container.json');
    const chatArtifact = artifacts.find(
      (artifact) => artifact.path === 'chats/chat-1.json',
    );
    expect(layoutArtifact).toBeDefined();
    expect(chatArtifact).toBeDefined();
    if (!layoutArtifact || !chatArtifact) throw new Error('Missing artifact');
    const layoutValue: unknown = JSON.parse(
      layoutArtifact.bytes.toString('utf8'),
    );
    const chatValue: unknown = JSON.parse(chatArtifact.bytes.toString('utf8'));
    expect(isSharedContainerRevisionLayout(layoutValue)).toBe(true);
    expect(isSharedContainerPublishedChat(chatValue)).toBe(true);
    if (
      !isSharedContainerRevisionLayout(layoutValue) ||
      !isSharedContainerPublishedChat(chatValue)
    ) {
      throw new Error('Publisher emitted an invalid artifact');
    }
    const layout = layoutValue;
    const chat = chatValue;
    expect(layout.repositories).toEqual([]);
    expect(layout.title).toBe('Derived Work Entry title');
    expect(layout.files).toHaveLength(1);
    expect(layout.withheldFileCount).toBe(2);
    expect(chat).not.toHaveProperty('sdkSessionId');
    expect(chat.messages).toHaveLength(1);
    expect(JSON.stringify(chat)).not.toContain('private orchestration');
    expect(chat.messages[0].text).toContain('x'.repeat(7_000));
    expect(chat.messages[0].parts).toContainEqual({
      kind: 'attachment',
      data: {
        references: [{ displayPath: 'notes/private.md' }],
      },
    });
    expect(chat.messages[0].parts).toContainEqual({
      kind: 'attachment',
      data: {
        attachmentPaths: [expect.stringMatching(/^attachments\/[a-f0-9]{64}$/)],
      },
    });
    const publishedToolPart = chat.messages[0].parts?.find(
      (part) => part.kind === 'tool_use',
    );
    expect(publishedToolPart?.data.input).toMatchObject({
      items: Array.from({ length: 25 }, (_, index) => `item-${index}`),
      nested: {
        level1: { level2: { level3: 'preserved' } },
      },
    });
    expect(() =>
      validateCoworkRevisionForStage(artifacts, 'org-1', 'device-1', 'key-1'),
    ).not.toThrow();

    const fixture = await buildSharedContainerReplicaFixture({
      layout,
      plaintextArtifacts: artifacts.filter(
        (artifact) => artifact.path !== 'container.json',
      ),
    });
    const root = await mkdtemp(join(tmpdir(), 'cowork-publish-roundtrip-'));
    const manager = new SharedContainerReplicaManager({
      rootDir: root,
      transport: transportForSharedContainerFixture(fixture),
      fetchImpl: fetchForSharedContainerFixture(fixture),
    });
    await manager.sync('container-1', 'org-1');
    await expect(manager.getState('container-1')).resolves.toMatchObject({
      withheldFileCount: 2,
    });
    const content = join(
      root,
      'container-1',
      'revisions',
      'revision-1',
      'content',
    );
    await expect(readFile(join(content, 'approved.txt'), 'utf8')).resolves.toBe(
      'approved',
    );
    await expect(
      readFile(join(content, 'notes', 'note-1.md'), 'utf8'),
    ).resolves.toBe('# Selected note\n');
    await expect(
      readFile(join(content, 'prompts', 'prompt-1.md'), 'utf8'),
    ).resolves.toBe('# Selected prompt\n');
    await expect(
      readFile(join(content, 'attachments', 'image.png'), 'utf8'),
    ).resolves.toBe('image');
    const allPlaintext = artifacts
      .map((artifact) => artifact.bytes.toString('utf8'))
      .join('\n');
    expect(allPlaintext).not.toContain('sdkSessionId');
    expect(allPlaintext).not.toContain('/Users/owner');
    expect(allPlaintext).not.toContain('C:\\Users\\owner');
  });

  it('redacts and clamps the Work Entry name it publishes as the list title', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    let stagedRequest: SharedContainerStageRevisionRequest | undefined;
    const derivedTitle = `token=super-secret-value /Users/owner/${'x'.repeat(
      MAX_SHARED_CONTAINER_TITLE_LENGTH,
    )}`;
    const stage = jest.fn(
      (_containerId: string, request: SharedContainerStageRevisionRequest) => {
        stagedRequest = request;
        return Promise.reject(new Error('stop after stage request'));
      },
    );

    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory: jest.fn().mockResolvedValue({
          chats: [],
          attachments: [],
          notes: [],
          prompts: [],
          files: [{ path: 'file.txt', bytes: Buffer.from('content') }],
        }),
        readScope: jest.fn().mockResolvedValue({
          includedPaths: ['file.txt'],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        // Both titles are the sidebar Work Entry name now, so the plaintext
        // one the recipient reads before accepting goes through the same
        // secret/path redaction and length clamp as the encrypted one.
        resolveTitles: jest.fn().mockResolvedValue({
          publishedTitle: derivedTitle,
          listTitle: derivedTitle,
        }),
        stage,
        upload: jest.fn(),
        commit: jest.fn(),
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).rejects.toThrow('stop after stage request');

    const sanitized = sanitizeSharedContainerTitle(derivedTitle);
    expect(stagedRequest?.title).toBe(sanitized);
    expect(stagedRequest?.title).not.toContain('super-secret-value');
    expect(stagedRequest?.title).not.toContain('/Users/owner');
    expect(stagedRequest?.title.length).toBeLessThanOrEqual(
      MAX_SHARED_CONTAINER_TITLE_LENGTH,
    );
    const containerArtifact = stagedRequest?.artifacts.find(
      (artifact) => artifact.path === 'container.json',
    );
    expect(containerArtifact).toBeDefined();
    expect(sanitized).not.toContain('super-secret-value');
    expect(sanitized).not.toContain('/Users/owner');
    expect(sanitized.length).toBeLessThanOrEqual(
      MAX_SHARED_CONTAINER_TITLE_LENGTH,
    );
    expect(
      sanitizeSharedContainerTitle(
        `${'a'.repeat(MAX_SHARED_CONTAINER_TITLE_LENGTH - 1)}😀`,
      ),
    ).toBe('a'.repeat(MAX_SHARED_CONTAINER_TITLE_LENGTH - 1));
  });

  it('rejects the complete stage request when adding its title exceeds the metadata limit', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY' as const,
    };
    const stateStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn((record: SharedContainerPublicationRecord) =>
        Promise.resolve(record),
      ),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stage = jest.fn().mockRejectedValue(new Error('stage was called'));

    await expect(
      publishSharedContainerRevision(target, {
        buildInventory: jest.fn().mockResolvedValue({}),
        buildArtifacts: jest.fn().mockReturnValue([]),
        validateArtifacts: jest.fn(
          (_artifacts, organizationId, sourceDeviceId, idempotencyKey) => {
            const baseRequest = {
              organizationId,
              idempotencyKey,
              sourceDeviceId: '',
              schemaVersion: 1 as const,
              artifacts: [],
            };
            const paddingLength =
              MAX_SHARED_CONTAINER_STAGE_REQUEST_BYTES -
              Buffer.byteLength(JSON.stringify(baseRequest)) -
              1;
            return {
              ...baseRequest,
              sourceDeviceId: sourceDeviceId.repeat(paddingLength),
            };
          },
        ),
        resolveTitles: jest.fn().mockResolvedValue({
          publishedTitle: 'Work Entry',
          listTitle: 'x'.repeat(MAX_SHARED_CONTAINER_TITLE_LENGTH),
        }),
        readScope: jest.fn().mockResolvedValue({
          includedPaths: [],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload: jest.fn(),
        commit: jest.fn(),
        readDeviceId: jest.fn().mockResolvedValue('x'),
      }),
    ).rejects.toThrow('Shared-container stage request byte limit exceeded');
    expect(stage).not.toHaveBeenCalled();
  });

  it('disposes a built inventory when title resolution fails', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'CODE_WORKTREE' as const,
    };
    const inventory = { snapshot: 'temporary' };
    const disposeInventory = jest
      .fn()
      .mockRejectedValue(new Error('inventory cleanup failed'));
    const stateStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn((record: SharedContainerPublicationRecord) =>
        Promise.resolve(record),
      ),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);

    await expect(
      publishSharedContainerRevision(target, {
        buildInventory: jest.fn().mockResolvedValue(inventory),
        buildArtifacts: jest.fn().mockReturnValue([]),
        disposeInventory,
        resolveTitles: jest
          .fn()
          .mockRejectedValue(new Error('title lookup failed')),
        readScope: jest.fn().mockResolvedValue({ includedPaths: [] }),
        stage: jest.fn(),
        upload: jest.fn(),
        commit: jest.fn(),
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).rejects.toThrow('title lookup failed');

    expect(disposeInventory).toHaveBeenCalledWith(inventory);
  });

  it('writes the code branch title into container.json', () => {
    const artifacts = buildCodeRevisionArtifacts(
      {
        chats: [],
        attachments: [],
        notes: [],
        prompts: [],
        plans: [],
        repositories: [],
        withheldFileCount: 0,
        withheldFileReasons: [],
      },
      undefined,
      'feature/can-2550',
    );
    const container = artifacts.find(
      (artifact) => artifact.path === 'container.json',
    );
    expect(container).toBeDefined();
    expect(
      JSON.parse(container?.bytes?.toString('utf8') ?? '{}'),
    ).toMatchObject({
      containerType: 'CODE_WORKTREE',
      title: 'feature/can-2550',
    });
  });

  it('publishes a code layout with a web page as schema v5', () => {
    const artifacts = buildCodeRevisionArtifacts(
      {
        chats: [],
        attachments: [],
        notes: [],
        prompts: [],
        plans: [],
        repositories: [],
        withheldFileCount: 0,
        withheldFileReasons: [],
        layout: {
          orientation: 0,
          root: {
            type: 'leaf',
            size: 1,
            tabs: [{ kind: 'browser', url: 'https://example.com/docs' }],
            activeTabIndex: 0,
          },
        },
      },
      undefined,
      'feature/web-page',
    );
    const container = artifacts.find(
      (artifact) => artifact.path === 'container.json',
    );
    const layout: unknown = JSON.parse(
      container?.bytes?.toString('utf8') ?? '{}',
    );
    expect(layout).toMatchObject({
      schemaVersion: 5,
      layout: {
        root: { tabs: [{ kind: 'browser', url: 'https://example.com/docs' }] },
      },
    });
    expect(isAnySharedContainerRevisionLayout(layout)).toBe(true);
  });

  it('uses content-addressed attachment remaps without owner-local paths', () => {
    const artifacts = buildCoworkRevisionArtifacts({
      chats: [
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: 'now',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              timestamp: 1,
              blocks: [],
              attachmentPaths: ['/Users/owner/private/image.png'],
            },
          ],
        },
      ],
      attachments: [
        {
          displayName: 'image.png',
          sourcePath: '/Users/owner/private/image.png',
          bytes: Buffer.from('image'),
        },
      ],
      notes: [],
      prompts: [],
      files: [],
    });
    const serialized = artifacts
      .map((artifact) => artifact.bytes.toString('utf8'))
      .join('\n');
    expect(serialized).not.toContain('/Users/owner/private');
    const layoutArtifact = artifacts.find(
      (artifact) => artifact.path === 'container.json',
    );
    if (!layoutArtifact) throw new Error('Missing container.json');
    const layoutValue: unknown = JSON.parse(
      layoutArtifact.bytes.toString('utf8'),
    );
    expect(isSharedContainerRevisionLayout(layoutValue)).toBe(true);
    if (!isSharedContainerRevisionLayout(layoutValue)) {
      throw new Error('Publisher emitted an invalid layout');
    }
    expect(Object.keys(layoutValue.attachmentPaths)).toEqual([
      expect.stringMatching(/^attachments\/[a-f0-9]{64}$/),
    ]);
  });

  it('redacts complete whitespace-bearing local paths from published chat text', () => {
    const artifacts = buildCoworkRevisionArtifacts({
      chats: [
        {
          id: 'chat-1',
          title: 'Open "/Users/owner/My Project/secrets.txt" and summarize it',
          description:
            'Inspect `C:\\Users\\owner\\My Project\\credentials.json` after launch',
          createdAt: 'now',
          messages: [
            {
              id: 'message-1',
              role: 'assistant',
              timestamp: 1,
              blocks: [
                {
                  type: 'text',
                  text: "Read 'file:///Users/owner/My Project/private.txt' and report\nKeep this line",
                },
              ],
            },
          ],
        },
      ],
      attachments: [],
      notes: [],
      prompts: [],
      files: [],
    });
    const chatArtifact = artifacts.find(
      (artifact) => artifact.path === 'chats/chat-1.json',
    );
    if (!chatArtifact) throw new Error('Missing chat artifact');
    const serialized = chatArtifact.bytes.toString('utf8');
    expect(serialized).not.toContain('My Project');
    expect(serialized).not.toContain('secrets.txt');
    expect(serialized).not.toContain('credentials.json');
    expect(serialized).not.toContain('private.txt');
    expect(serialized).toContain('and summarize it');
    expect(serialized).toContain('after launch');
    expect(serialized).toContain('and report');
    expect(serialized).toContain('Keep this line');
  });

  it('round-trips distinct attachment names that share identical bytes', async () => {
    const artifacts = buildCoworkRevisionArtifacts({
      chats: [
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: 'now',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              timestamp: 1,
              blocks: [],
              attachmentPaths: [
                '/Users/owner/first.txt',
                '/Users/owner/second.txt',
              ],
            },
          ],
        },
      ],
      attachments: [
        {
          displayName: 'first.txt',
          sourcePath: '/Users/owner/first.txt',
          bytes: Buffer.from('same bytes'),
        },
        {
          displayName: 'second.txt',
          sourcePath: '/Users/owner/second.txt',
          bytes: Buffer.from('same bytes'),
        },
      ],
      notes: [],
      prompts: [],
      files: [],
    });
    const layoutArtifact = artifacts.find(
      (artifact) => artifact.path === 'container.json',
    );
    if (!layoutArtifact) throw new Error('Missing container.json');
    const layoutValue: unknown = JSON.parse(
      layoutArtifact.bytes.toString('utf8'),
    );
    if (!isSharedContainerRevisionLayout(layoutValue)) {
      throw new Error('Publisher emitted an invalid layout');
    }
    expect(
      Object.values(layoutValue.attachmentPaths).map(
        (attachment) => attachment.displayName,
      ),
    ).toEqual(['first.txt', 'second.txt']);
    expect(
      new Set(
        Object.values(layoutValue.attachmentPaths).map(
          (attachment) => attachment.artifactId,
        ),
      ).size,
    ).toBe(1);

    const fixture = await buildSharedContainerReplicaFixture({
      layout: layoutValue,
      plaintextArtifacts: artifacts.filter(
        (artifact) => artifact.path !== 'container.json',
      ),
    });
    const root = await mkdtemp(join(tmpdir(), 'cowork-duplicate-attachment-'));
    const manager = new SharedContainerReplicaManager({
      rootDir: root,
      transport: transportForSharedContainerFixture(fixture),
      fetchImpl: fetchForSharedContainerFixture(fixture),
    });
    await manager.sync('container-1', 'org-1');
    const attachmentsDir = join(
      root,
      'container-1',
      'revisions',
      'revision-1',
      'content',
      'attachments',
    );
    await expect(
      readFile(join(attachmentsDir, 'first.txt'), 'utf8'),
    ).resolves.toBe('same bytes');
    await expect(
      readFile(join(attachmentsDir, 'second.txt'), 'utf8'),
    ).resolves.toBe('same bytes');
  });

  it('rejects oversized content before staging', () => {
    const artifacts = buildCoworkRevisionArtifacts({
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [
        {
          path: 'too-large.bin',
          bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
        },
      ],
    });
    expect(() =>
      validateCoworkRevisionForStage(artifacts, 'org-1', 'device-1', 'key-1'),
    ).toThrow(SharedContainerPublishRefusalError);
  });

  it('omits the organization from a personal container stage request', () => {
    const artifacts = buildCoworkRevisionArtifacts({
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [],
    });
    const organization = validateCoworkRevisionForStage(
      artifacts,
      'org-1',
      'device-1',
      'key-1',
    );
    const personal = validateCoworkRevisionForStage(
      artifacts,
      undefined,
      'device-1',
      'key-1',
    );

    expect(organization.organizationId).toBe('org-1');
    expect(personal).not.toHaveProperty('organizationId');
    const { organizationId: _organizationId, ...organizationRest } =
      organization;
    void _organizationId;
    expect(personal).toEqual(organizationRest);
  });

  it('stages source-backed Cowork content without materializing its plaintext', () => {
    const bytes = Buffer.from('approved');
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const createReadStream = jest.fn(() => Readable.from(bytes));
    const noteBytes = Buffer.from('# Note\n');
    const noteHash = `sha256:${createHash('sha256').update(noteBytes).digest('hex')}`;
    const noteReadStream = jest.fn(() => Readable.from(noteBytes));
    const promptBytes = Buffer.from('Prompt body\n');
    const promptHash = `sha256:${createHash('sha256').update(promptBytes).digest('hex')}`;
    const promptReadStream = jest.fn(() => Readable.from(promptBytes));
    const artifacts = buildCoworkRevisionArtifacts({
      chats: [],
      attachments: [],
      notes: [
        {
          meta: { id: 'note-1', title: 'Note' },
          source: {
            sizeBytes: noteBytes.byteLength,
            hash: noteHash,
            createReadStream: noteReadStream,
          },
        },
      ],
      prompts: [
        {
          meta: { id: 'prompt-1', title: 'Prompt' },
          source: {
            sizeBytes: promptBytes.byteLength,
            hash: promptHash,
            createReadStream: promptReadStream,
          },
        },
      ],
      files: [
        {
          path: 'approved.txt',
          source: { sizeBytes: bytes.byteLength, hash, createReadStream },
        },
      ],
    });

    const fileArtifact = artifacts.find(
      (artifact) => artifact.path === `files/${hash.slice('sha256:'.length)}`,
    );
    expect(fileArtifact?.hash).toBe(hash);
    expect(fileArtifact?.sizeBytes).toBe(bytes.byteLength);
    expect(fileArtifact?.source?.createReadStream).toBe(createReadStream);
    expect(fileArtifact).not.toHaveProperty('bytes');
    expect(
      artifacts.find((artifact) => artifact.path === 'notes/note-1.md')?.source
        ?.createReadStream,
    ).toBe(noteReadStream);
    expect(
      artifacts.find((artifact) => artifact.path === 'prompts/prompt-1.md')
        ?.source?.createReadStream,
    ).toBe(promptReadStream);
    const request = validateCoworkRevisionForStage(
      artifacts,
      'org-1',
      'device-1',
      'key-1',
    );
    expect(request.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: fileArtifact?.artifactId,
        hash,
        objectSizeBytes: String(bytes.byteLength),
      }),
    );
    expect(createReadStream).not.toHaveBeenCalled();
    expect(noteReadStream).not.toHaveBeenCalled();
    expect(promptReadStream).not.toHaveBeenCalled();
  });

  it.each([
    'notes/note-1.md',
    'NOTES/NOTE-1.MD',
    'notes',
    'attachments/image.png',
  ])(
    'rejects approved path %s when it collides with generated recipient output',
    (approvedPath) => {
      expect(() =>
        buildCoworkRevisionArtifacts({
          chats: [],
          attachments: [
            { displayName: 'image.png', bytes: Buffer.from('image') },
          ],
          notes: [
            {
              meta: { id: 'note-1', title: 'Selected note' },
              content: '# Selected note\n',
            },
          ],
          prompts: [],
          files: [{ path: approvedPath, bytes: Buffer.from('approved') }],
        }),
      ).toThrow('output path collision');
    },
  );

  it('rebuilds stable artifact ids when replaying one idempotency key', () => {
    const inventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [{ path: 'stable.txt', bytes: Buffer.from('stable') }],
    };
    const first = buildCoworkRevisionArtifacts(inventory, 'replay-key');
    const second = buildCoworkRevisionArtifacts(inventory, 'replay-key');
    expect(second).toEqual(first);
  });

  it('reuses and carries unchanged parent artifacts without uploading them', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY' as const,
    };
    const parentInventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [
        { path: 'stable.txt', bytes: Buffer.from('stable') },
        { path: 'changed.txt', bytes: Buffer.from('before') },
      ],
    };
    const inventory = {
      ...parentInventory,
      files: [
        parentInventory.files[0],
        { path: 'changed.txt', bytes: Buffer.from('after') },
      ],
    };
    const parentArtifacts = buildCoworkRevisionArtifacts(
      parentInventory,
      'parent-seed',
      'Entry',
    );
    const parentDetails = parentArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      path: artifact.path,
      representation: 'BLOB' as const,
      hash: artifact.hash,
      objectSizeBytes: String(artifact.sizeBytes),
    }));
    let state: SharedContainerPublicationRecord | null = {
      ...target,
      status: 'published',
      revision: 1,
      revisionId: 'revision-1',
      publishedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      publishedContentHash: 'sha256:stale',
    };
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue({
        get: jest.fn(() => Promise.resolve(state)),
        set: jest.fn((record: SharedContainerPublicationRecord) => {
          state = record;
          return Promise.resolve(record);
        }),
      } as unknown as SharedContainerPublicationStateStore);
    const stage = jest.fn(
      (_containerId: string, request: SharedContainerStageRevisionRequest) =>
        Promise.resolve({
          stagingSessionId: request.idempotencyKey,
          revisionId: 'revision-2',
          uploadTargets: request.artifacts
            .filter((artifact) => artifact.carriedFromParentRevision !== true)
            .map((artifact) => ({
              artifactId: artifact.artifactId,
              target: {
                url: 'https://uploads.example.test/artifact',
                method: 'PUT' as const,
                headers: {},
                expiresAt: '2026-09-01T02:00:00.000Z',
              },
              key: {
                scheme: 'AES_256_GCM_CHUNKED_V1' as const,
                dataKey: Buffer.alloc(32, 1).toString('base64'),
                aad: `artifact:${artifact.artifactId}`,
              },
            })),
        }),
    );
    const upload = jest.fn().mockResolvedValue(undefined);

    await publishSharedContainerRevision(target, {
      buildInventory: jest.fn().mockResolvedValue(inventory),
      buildArtifacts: (candidate, seed, title) =>
        buildCoworkRevisionArtifacts(candidate, seed, title),
      validateArtifacts: validateCoworkRevisionForStage,
      resolveTitles: jest.fn().mockResolvedValue({
        publishedTitle: 'Entry',
        listTitle: 'Entry',
      }),
      readScope: jest.fn().mockResolvedValue({ includedPaths: [] }),
      stage,
      upload,
      commit: jest.fn().mockResolvedValue({
        revision: {
          id: 'revision-2',
          revision: 2,
          createdAt: '2026-09-01T01:00:00.000Z',
        },
      }),
      fetchRevision: jest.fn().mockResolvedValue({
        revision: { id: 'revision-1', artifacts: parentDetails },
      }),
      readDeviceId: jest.fn().mockResolvedValue('device-1'),
    });

    const request = stage.mock.calls[0]?.[1];
    const stableParent = parentDetails.find(
      (artifact) =>
        artifact.path ===
        'files/' + createHash('sha256').update('stable').digest('hex'),
    );
    expect(stableParent).toBeDefined();
    expect(
      request?.artifacts.find(
        (artifact) => artifact.artifactId === stableParent?.artifactId,
      ),
    ).toMatchObject({ carriedFromParentRevision: true });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a carried idempotency key after a full-upload fallback', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
      containerType: 'COWORK_WORK_ENTRY' as const,
    };
    const parentInventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [
        { path: 'stable.txt', bytes: Buffer.from('stable') },
        { path: 'changed.txt', bytes: Buffer.from('before') },
      ],
    };
    const inventory = {
      ...parentInventory,
      files: [
        parentInventory.files[0],
        { path: 'changed.txt', bytes: Buffer.from('after') },
      ],
    };
    const parentDetails = buildCoworkRevisionArtifacts(
      parentInventory,
      'parent-seed',
      'Entry',
    ).map((artifact) => ({
      artifactId: artifact.artifactId,
      path: artifact.path,
      representation: 'BLOB' as const,
      hash: artifact.hash,
      objectSizeBytes: String(artifact.sizeBytes),
    }));
    let state: SharedContainerPublicationRecord | null = {
      ...target,
      status: 'published',
      revision: 1,
      revisionId: 'revision-1',
      publishedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      publishedContentHash: 'sha256:stale',
    };
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue({
        get: jest.fn(() => Promise.resolve(state)),
        set: jest.fn((record: SharedContainerPublicationRecord) => {
          state = record;
          return Promise.resolve(record);
        }),
      } as unknown as SharedContainerPublicationStateStore);
    // Server fake mirroring the real ordering: the idempotency lookup (same
    // key + different declaration => 409) runs before carried artifacts are
    // verified against the parent (mismatch => 422), and commit refuses a
    // session whose objects were never uploaded.
    const sessions = new Map<string, string>();
    const sessionArtifactIds = new Map<string, string[]>();
    const uploaded = new Set<string>();
    const stage = jest.fn(
      (_containerId: string, request: SharedContainerStageRevisionRequest) => {
        const declaration = JSON.stringify(request.artifacts);
        const existing = sessions.get(request.idempotencyKey);
        if (existing !== undefined && existing !== declaration) {
          return Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'Stage idempotency key is already in use',
              409,
            ),
          );
        }
        if (
          request.artifacts.some(
            (artifact) => artifact.carriedFromParentRevision === true,
          )
        ) {
          return Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'Carried artifact does not match parent revision',
              422,
            ),
          );
        }
        sessions.set(request.idempotencyKey, declaration);
        sessionArtifactIds.set(
          request.idempotencyKey,
          request.artifacts.map((artifact) => artifact.artifactId),
        );
        return Promise.resolve({
          stagingSessionId: request.idempotencyKey,
          revisionId: 'revision-2',
          uploadTargets: request.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            target: {
              url: 'https://uploads.example.test/artifact',
              method: 'PUT' as const,
              headers: {},
              expiresAt: '2026-09-01T02:00:00.000Z',
            },
            key: {
              scheme: 'AES_256_GCM_CHUNKED_V1' as const,
              dataKey: Buffer.alloc(32, 1).toString('base64'),
              aad: `artifact:${artifact.artifactId}`,
            },
          })),
        });
      },
    );
    let uploadAttempts = 0;
    const upload = jest.fn(
      (input: { target: { artifactId: string } }): Promise<void> => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return Promise.reject(new Error('network down'));
        }
        uploaded.add(input.target.artifactId);
        return Promise.resolve();
      },
    );
    const commit = jest.fn(
      (_containerId: string, _org: string, sessionId: string) => {
        const declared = sessionArtifactIds.get(sessionId) ?? [];
        if (!declared.every((artifactId) => uploaded.has(artifactId))) {
          return Promise.reject(
            new CanopyCloudClientError(
              'http-error',
              'Staged artifact upload is incomplete',
              409,
            ),
          );
        }
        return Promise.resolve({
          revision: {
            id: 'revision-2',
            revision: 2,
            createdAt: '2026-09-01T01:00:00.000Z',
          },
        });
      },
    );
    const deps = {
      buildInventory: jest.fn().mockResolvedValue(inventory),
      disposeInventory: jest
        .fn()
        .mockRejectedValue(new Error('inventory cleanup failed')),
      buildArtifacts: (
        candidate: typeof inventory,
        seed: string,
        title: string,
      ): ReturnType<typeof buildCoworkRevisionArtifacts> =>
        buildCoworkRevisionArtifacts(candidate, seed, title),
      validateArtifacts: validateCoworkRevisionForStage,
      resolveTitles: jest.fn().mockResolvedValue({
        publishedTitle: 'Entry',
        listTitle: 'Entry',
      }),
      readScope: jest.fn().mockResolvedValue({ includedPaths: [] }),
      stage,
      upload,
      commit,
      fetchRevision: jest.fn((_containerId: string, revisionId: string) =>
        revisionId === 'revision-1'
          ? Promise.resolve({
              revision: { id: 'revision-1', artifacts: parentDetails },
            })
          : Promise.reject(
              new CanopyCloudClientError(
                'http-error',
                'Revision not found',
                404,
              ),
            ),
      ),
      readDeviceId: jest.fn().mockResolvedValue('device-1'),
    };

    await expect(publishSharedContainerRevision(target, deps)).rejects.toThrow(
      'network down',
    );
    await expect(
      publishSharedContainerRevision(target, deps),
    ).resolves.toMatchObject({ status: 'published', revisionId: 'revision-2' });
    expect(commit).toHaveBeenCalled();
    expect(deps.disposeInventory).toHaveBeenCalledTimes(2);
  });

  it('does not stage another revision when scheduled content is unchanged', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const inventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [{ path: 'stable.txt', bytes: Buffer.from('stable') }],
    };
    let state: SharedContainerPublicationRecord | null = null;
    const stateStore = {
      get: jest.fn(() => Promise.resolve(state)),
      set: jest.fn((record: SharedContainerPublicationRecord) => {
        state = record;
        return Promise.resolve(record);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stage = jest.fn(
      (_containerId: string, request: SharedContainerStageRevisionRequest) =>
        Promise.resolve({
          stagingSessionId: request.idempotencyKey,
          revisionId: 'revision-1',
          uploadTargets: request.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            target: {
              url: 'https://uploads.example.test/artifact',
              method: 'PUT' as const,
              headers: {},
              expiresAt: '2026-09-01T02:00:00.000Z',
            },
            key: {
              scheme: 'AES_256_GCM_CHUNKED_V1' as const,
              dataKey: Buffer.alloc(32, 1).toString('base64'),
              aad: `artifact:${artifact.artifactId}`,
            },
          })),
        }),
    );
    const commit = jest.fn().mockResolvedValue({
      revision: {
        id: 'revision-1',
        revision: 1,
        createdAt: '2026-09-01T01:00:00.000Z',
      },
    });
    const dependencies = {
      buildInventory: jest.fn().mockResolvedValue(inventory),
      readScope: jest.fn().mockResolvedValue({
        includedPaths: ['stable.txt'],
        includedNoteIds: [],
        includedPromptIds: [],
      }),
      stage,
      upload: jest.fn().mockResolvedValue(undefined),
      commit,
      readDeviceId: jest.fn().mockResolvedValue('device-1'),
    };

    await publishCoworkSharedContainerRevision(target, dependencies);
    await expect(
      publishCoworkSharedContainerRevision(target, dependencies),
    ).resolves.toMatchObject({
      status: 'published',
      revision: 1,
      revisionId: 'revision-1',
    });

    expect(stage).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('publishes a new revision when only the plaintext list title changed', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const inventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [{ path: 'stable.txt', bytes: Buffer.from('stable') }],
    };
    let state: SharedContainerPublicationRecord | null = null;
    const stateStore = {
      get: jest.fn(() => Promise.resolve(state)),
      set: jest.fn((record: SharedContainerPublicationRecord) => {
        state = record;
        return Promise.resolve(record);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stagedTitles: string[] = [];
    const stage = jest.fn(
      (_containerId: string, request: SharedContainerStageRevisionRequest) => {
        stagedTitles.push(request.title);
        return Promise.resolve({
          stagingSessionId: request.idempotencyKey,
          revisionId: `revision-${stagedTitles.length}`,
          uploadTargets: request.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            target: {
              url: 'https://uploads.example.test/artifact',
              method: 'PUT' as const,
              headers: {},
              expiresAt: '2026-09-01T02:00:00.000Z',
            },
            key: {
              scheme: 'AES_256_GCM_CHUNKED_V1' as const,
              dataKey: Buffer.alloc(32, 1).toString('base64'),
              aad: `artifact:${artifact.artifactId}`,
            },
          })),
        });
      },
    );
    const commit = jest.fn(() =>
      Promise.resolve({
        revision: {
          id: `revision-${stagedTitles.length}`,
          revision: stagedTitles.length,
          createdAt: '2026-09-01T01:00:00.000Z',
        },
      }),
    );
    // The list title is server-visible state that no artifact hash covers: the
    // encrypted title rides in container.json, but the plaintext one the
    // recipient reads before accepting does not. Every Cowork container
    // published before that title became the real Work Entry name has the old
    // `Work Entry` on the server and unchanged content, so without the list
    // title in the fingerprint it is skipped as "content unchanged" and
    // recipients keep the stale name indefinitely.
    const resolveTitles = jest
      .fn()
      .mockResolvedValueOnce({
        publishedTitle: 'Customer follow-up',
        listTitle: 'Work Entry',
      })
      .mockResolvedValue({
        publishedTitle: 'Customer follow-up',
        listTitle: 'Customer follow-up',
      });
    const dependencies = {
      buildInventory: jest.fn().mockResolvedValue(inventory),
      readScope: jest.fn().mockResolvedValue({
        includedPaths: ['stable.txt'],
        includedNoteIds: [],
        includedPromptIds: [],
      }),
      resolveTitles,
      stage,
      upload: jest.fn().mockResolvedValue(undefined),
      commit,
      readDeviceId: jest.fn().mockResolvedValue('device-1'),
    };

    await publishCoworkSharedContainerRevision(target, dependencies);
    await publishCoworkSharedContainerRevision(target, dependencies);

    expect(stagedTitles).toEqual(['Work Entry', 'Customer follow-up']);

    // A third publish with the same title and the same content still skips.
    await publishCoworkSharedContainerRevision(target, dependencies);
    expect(stage).toHaveBeenCalledTimes(2);
  });

  it('stops before staging when inventory construction supersedes the target', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const replacement: SharedContainerPublicationRecord = {
      ...target,
      containerId: 'container-2',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'idle',
      updatedAt: '2026-09-01T04:00:00.000Z',
    };
    let state: SharedContainerPublicationRecord | null = null;
    const stateStore = {
      get: jest.fn(() => Promise.resolve(state)),
      set: jest.fn((record: SharedContainerPublicationRecord) => {
        if (state && state.containerId !== record.containerId) {
          return Promise.resolve(state);
        }
        state = record;
        return Promise.resolve(record);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stage = jest.fn();

    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory: jest.fn().mockImplementation(() => {
          state = replacement;
          return Promise.resolve({
            chats: [],
            attachments: [],
            notes: [],
            prompts: [],
            files: [{ path: 'changed.txt', bytes: Buffer.from('changed') }],
          });
        }),
        readScope: jest.fn().mockResolvedValue({
          includedPaths: ['changed.txt'],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload: jest.fn(),
        commit: jest.fn(),
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).rejects.toThrow(/publication target was superseded/i);
    expect(stage).not.toHaveBeenCalled();
  });

  it('stops before commit when an upload supersedes the target', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const replacement: SharedContainerPublicationRecord = {
      ...target,
      containerId: 'container-2',
      containerType: 'COWORK_WORK_ENTRY',
      status: 'idle',
      updatedAt: '2026-09-01T04:00:00.000Z',
    };
    let state: SharedContainerPublicationRecord | null = null;
    const stateStore = {
      get: jest.fn(() => Promise.resolve(state)),
      set: jest.fn((record: SharedContainerPublicationRecord) => {
        if (state && state.containerId !== record.containerId) {
          return Promise.resolve(state);
        }
        state = record;
        return Promise.resolve(record);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stage = jest.fn(
      (_containerId: string, request: SharedContainerStageRevisionRequest) =>
        Promise.resolve({
          stagingSessionId: request.idempotencyKey,
          revisionId: 'revision-1',
          uploadTargets: request.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            target: {
              url: 'https://uploads.example.test/artifact',
              method: 'PUT' as const,
              headers: {},
              expiresAt: '2026-09-01T05:00:00.000Z',
            },
            key: {
              scheme: 'AES_256_GCM_CHUNKED_V1' as const,
              dataKey: Buffer.alloc(32, 1).toString('base64'),
              aad: `artifact:${artifact.artifactId}`,
            },
          })),
        }),
    );
    const bodies: unknown[] = [];
    // Never reads the body, like an upload that fails before sending it.
    const upload = jest
      .fn()
      .mockImplementation(({ body }: { body: unknown }) => {
        bodies.push(body);
        state = replacement;
        return Promise.resolve();
      });
    const commit = jest.fn().mockResolvedValue({
      revision: {
        id: 'revision-1',
        revision: 1,
        createdAt: '2026-09-01T04:01:00.000Z',
      },
    });

    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory: jest.fn().mockResolvedValue({
          chats: [],
          attachments: [],
          notes: [],
          prompts: [],
          files: [{ path: 'changed.txt', bytes: Buffer.from('changed') }],
        }),
        readScope: jest.fn().mockResolvedValue({
          includedPaths: ['changed.txt'],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload,
        commit,
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).rejects.toThrow(/publication target was superseded/i);
    expect(upload).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    // The unread body must be closed before its staging directory goes away,
    // or its lazy open fails later with ENOENT and nothing handles the error.
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toBeInstanceOf(ReadStream);
      expect((body as ReadStream).closed).toBe(true);
    }
  });

  it('keeps its in-flight staging when startup recovery prunes earlier leftovers', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const stagingRoot = getSharedContainerPublishStagingRootDir();
    const leftover = join(stagingRoot, 'revision-leftover');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'artifact.bin'), 'stale');
    const stateStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn((record: SharedContainerPublicationRecord) =>
        Promise.resolve(record),
      ),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stage = jest.fn(
      async (
        _containerId: string,
        request: SharedContainerStageRevisionRequest,
      ) => {
        // Recovery can start after this publish has created its staging dir.
        await pruneSharedContainerPublishStaging();
        return {
          stagingSessionId: request.idempotencyKey,
          revisionId: 'revision-1',
          uploadTargets: request.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            target: {
              url: 'https://uploads.example.test/artifact',
              method: 'PUT' as const,
              headers: {},
              expiresAt: '2026-09-01T05:00:00.000Z',
            },
            key: {
              scheme: 'AES_256_GCM_CHUNKED_V1' as const,
              dataKey: Buffer.alloc(32, 1).toString('base64'),
              aad: `artifact:${artifact.artifactId}`,
            },
          })),
        };
      },
    );
    const upload = jest.fn(async ({ body }: { body: unknown }) => {
      for await (const chunk of body as AsyncIterable<Buffer>) void chunk;
    });

    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory: jest.fn().mockResolvedValue({
          chats: [],
          attachments: [],
          notes: [],
          prompts: [],
          files: [{ path: 'changed.txt', bytes: Buffer.from('changed') }],
        }),
        readScope: jest.fn().mockResolvedValue({
          includedPaths: ['changed.txt'],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload,
        commit: jest.fn().mockResolvedValue({
          revision: {
            id: 'revision-1',
            revision: 1,
            createdAt: '2026-09-01T04:01:00.000Z',
          },
        }),
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).resolves.toMatchObject({ status: 'published', revisionId: 'revision-1' });
    expect(upload).toHaveBeenCalled();
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
  });

  it('recovers a committed stage replay through the idempotent commit endpoint', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const inventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [],
    };
    const idempotencyKey = '00000000-0000-4000-8000-000000000010';
    const stageRequest = {
      ...validateCoworkRevisionForStage(
        buildCoworkRevisionArtifacts(inventory, idempotencyKey, 'entry-1'),
        target.organizationId,
        'device-1',
        idempotencyKey,
      ),
      title: 'entry-1',
    };
    const prior = {
      ...target,
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'error' as const,
      updatedAt: '2026-08-30T12:00:00.000Z',
      idempotencyKey,
      stagingSessionId: idempotencyKey,
      stageRequestHash: `sha256:${createHash('sha256')
        .update(JSON.stringify(stageRequest))
        .digest('hex')}`,
    };
    const stateStore = {
      get: jest.fn().mockResolvedValue(prior),
      set: jest.fn((record: SharedContainerPublicationRecord) =>
        Promise.resolve(record),
      ),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const stage = jest
      .fn()
      .mockRejectedValue(
        new CanopyCloudClientError(
          'http-error',
          'Staging session is already committed',
          409,
          'shared-container-stage-already-committed',
          undefined,
          true,
        ),
      );
    const upload = jest.fn();
    const buildInventory = jest.fn().mockResolvedValue(inventory);
    const commit = jest.fn().mockResolvedValue({
      revision: {
        id: 'revision-2',
        revision: 2,
        createdAt: '2026-08-30T12:01:00.000Z',
      },
    });

    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory,
        readScope: jest.fn().mockResolvedValue({
          includedPaths: [],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload,
        commit,
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).resolves.toMatchObject({
      status: 'published',
      revision: 2,
      revisionId: 'revision-2',
    });
    expect(stage).not.toHaveBeenCalled();
    expect(buildInventory).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(
      target.containerId,
      target.organizationId,
      prior.stagingSessionId,
    );

    stateStore.get = jest
      .fn()
      .mockResolvedValue({ ...prior, stagingSessionId: undefined });
    stage.mockClear();
    commit.mockClear();
    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory,
        readScope: jest.fn().mockResolvedValue({
          includedPaths: [],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload,
        commit,
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).resolves.toMatchObject({ status: 'published', revisionId: 'revision-2' });
    expect(stage).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      target.containerId,
      target.organizationId,
      expect.any(String),
    );
  });

  it('recovers a server-committed staged revision before reading unavailable live inventory', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const prior = {
      ...target,
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'publishing' as const,
      updatedAt: '2026-08-30T12:00:00.000Z',
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      stagingSessionId: '00000000-0000-4000-8000-000000000010',
      stagedRevisionId: 'revision-2',
      stageRequestHash: 'sha256:request',
    };
    const stateStore = {
      get: jest.fn().mockResolvedValue(prior),
      set: jest.fn((record: SharedContainerPublicationRecord) =>
        Promise.resolve(record),
      ),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    const buildInventory = jest
      .fn()
      .mockRejectedValue(new Error('approved file is temporarily unavailable'));
    const fetchRevision = jest.fn().mockResolvedValue({
      revision: {
        id: 'revision-2',
        revision: 2,
        createdAt: '2026-08-30T12:01:00.000Z',
      },
    });
    const commit = jest.fn();
    const dependencies = {
      buildInventory,
      readScope: jest.fn(),
      stage: jest.fn(),
      upload: jest.fn(),
      commit,
      fetchRevision,
      readDeviceId: jest.fn(),
    } as unknown as PublishCoworkRevisionDependencies;

    await expect(
      publishCoworkSharedContainerRevision(target, dependencies),
    ).resolves.toMatchObject({
      status: 'published',
      revision: 2,
      revisionId: 'revision-2',
    });
    expect(fetchRevision).toHaveBeenCalledWith(
      target.containerId,
      prior.stagedRevisionId,
      target.organizationId,
    );
    expect(buildInventory).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('starts a fresh stage when live inventory no longer matches the persisted request fingerprint', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const prior = {
      ...target,
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'error' as const,
      updatedAt: '2026-08-30T12:00:00.000Z',
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      stagingSessionId: '00000000-0000-4000-8000-000000000010',
      stageRequestHash: 'sha256:stale-request',
      revision: 4,
      revisionId: 'revision-4',
      publishedAt: '2026-08-30T11:00:00.000Z',
    };
    const persistedRecords: SharedContainerPublicationRecord[] = [];
    const stateStore = {
      get: jest.fn().mockResolvedValue(prior),
      set: jest.fn((record: SharedContainerPublicationRecord) => {
        persistedRecords.push(record);
        return Promise.resolve(record);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    let stagedRequest: SharedContainerStageRevisionRequest | undefined;
    const stage = jest.fn(
      (
        _containerId: string,
        request: SharedContainerStageRevisionRequest,
      ): Promise<never> => {
        stagedRequest = request;
        return Promise.reject(new Error('stop after request'));
      },
    );
    const commit = jest.fn().mockResolvedValue({
      revision: {
        id: 'stale-revision',
        revision: 5,
        createdAt: '2026-08-30T12:01:00.000Z',
      },
    });

    await expect(
      publishCoworkSharedContainerRevision(target, {
        buildInventory: jest.fn().mockResolvedValue({
          chats: [],
          attachments: [],
          notes: [],
          prompts: [],
          files: [{ path: 'changed.txt', bytes: Buffer.from('changed') }],
        }),
        readScope: jest.fn().mockResolvedValue({
          includedPaths: ['changed.txt'],
          includedNoteIds: [],
          includedPromptIds: [],
        }),
        stage,
        upload: jest.fn(),
        commit,
        readDeviceId: jest.fn().mockResolvedValue('device-1'),
      }),
    ).rejects.toThrow('stop after request');
    expect(commit).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledWith(target.containerId, expect.any(Object));
    expect(stagedRequest?.idempotencyKey).not.toBe(prior.idempotencyKey);
    const intermediateRecords = persistedRecords.filter(
      (record) => record.status !== 'published',
    );
    expect(intermediateRecords.length).toBeGreaterThan(0);
    for (const record of intermediateRecords) {
      expect(record).toMatchObject({
        revision: prior.revision,
        revisionId: prior.revisionId,
        publishedAt: prior.publishedAt,
      });
    }
  });

  it('abandons only a definitively exhausted upload-target replay', async () => {
    const target = {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      organizationId: 'org-1',
      containerId: 'container-1',
    };
    const inventory = {
      chats: [],
      attachments: [],
      notes: [],
      prompts: [],
      files: [],
    };
    const idempotencyKey = '00000000-0000-4000-8000-000000000010';
    const stageRequest = validateCoworkRevisionForStage(
      buildCoworkRevisionArtifacts(inventory, idempotencyKey),
      target.organizationId,
      'device-1',
      idempotencyKey,
      'revision-4',
    );
    let state: SharedContainerPublicationRecord = {
      ...target,
      containerType: 'COWORK_WORK_ENTRY',
      status: 'error',
      error: 'prior upload failed',
      updatedAt: '2026-08-30T12:00:00.000Z',
      idempotencyKey,
      stagingSessionId: idempotencyKey,
      stageRequestHash: `sha256:${createHash('sha256')
        .update(JSON.stringify(stageRequest))
        .digest('hex')}`,
      revision: 4,
      revisionId: 'revision-4',
      publishedAt: '2026-08-30T11:00:00.000Z',
    };
    const stateStore = {
      get: jest.fn(() => Promise.resolve(state)),
      set: jest.fn((record: SharedContainerPublicationRecord) => {
        state = record;
        return Promise.resolve(record);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    jest
      .spyOn(publicationState, 'getSharedContainerPublicationStateStore')
      .mockReturnValue(stateStore);
    let freshRequest: SharedContainerStageRevisionRequest | undefined;
    const refreshExhausted = new CanopyCloudClientError(
      'http-error',
      'Upload target refresh limit exceeded',
      429,
      'shared-container-upload-target-refresh-exhausted',
      undefined,
      true,
    );
    const stage = jest
      .fn()
      .mockRejectedValueOnce(refreshExhausted)
      .mockImplementationOnce(
        (
          _containerId: string,
          request: SharedContainerStageRevisionRequest,
        ): Promise<never> => {
          freshRequest = request;
          return Promise.reject(new Error('stop after fresh stage'));
        },
      );
    const dependencies = {
      buildInventory: jest.fn().mockResolvedValue(inventory),
      readScope: jest.fn().mockResolvedValue({
        includedPaths: [],
        includedNoteIds: [],
        includedPromptIds: [],
      }),
      stage,
      upload: jest.fn(),
      commit: jest
        .fn()
        .mockRejectedValue(
          new CanopyCloudClientError('http-error', 'not ready', 422),
        ),
      readDeviceId: jest.fn().mockResolvedValue('device-1'),
    };

    await expect(
      publishCoworkSharedContainerRevision(target, dependencies),
    ).rejects.toBe(refreshExhausted);
    expect(state).toMatchObject({
      status: 'error',
      restartWithFreshStage: true,
      revision: 4,
      revisionId: 'revision-4',
      publishedAt: '2026-08-30T11:00:00.000Z',
    });
    expect(state).not.toHaveProperty('idempotencyKey');
    expect(state).not.toHaveProperty('stagingSessionId');
    expect(state).not.toHaveProperty('stagedRevisionId');
    expect(state).not.toHaveProperty('stageRequestHash');

    await expect(
      publishCoworkSharedContainerRevision(target, dependencies),
    ).rejects.toThrow('stop after fresh stage');
    expect(freshRequest?.idempotencyKey).not.toBe(idempotencyKey);
  });
});
