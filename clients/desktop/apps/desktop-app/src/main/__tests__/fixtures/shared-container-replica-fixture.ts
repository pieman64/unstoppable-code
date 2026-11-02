import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createArtifactEncryptStream } from '@canopy/artifact-crypto';
import type {
  SharedContainerArtifactDetail,
  SharedContainerArtifactKey,
  SharedContainerDetail,
  SharedContainerDownloadUrlsResponse,
  SharedContainerFetchRevisionResponse,
  SharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import type { SharedContainerReplicaTransport } from '../../shared-containers/transport';

export interface SharedContainerReplicaFixture {
  detail: SharedContainerDetail;
  revision: SharedContainerFetchRevisionResponse;
  downloads: SharedContainerDownloadUrlsResponse;
  responses: Map<string, Buffer>;
}

export interface SharedContainerPlaintextArtifact {
  artifactId: string;
  path: string;
  bytes: Buffer;
}

/**
 * Complete Cowork projection fixture shared by publisher and recipient tests.
 * It intentionally exercises every Cowork artifact table in one revision.
 */
export function buildSharedContainerCoworkFixture(): {
  layout: SharedContainerRevisionLayout;
  blobs: SharedContainerPlaintextArtifact[];
} {
  const chat = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      chatId: 'chat-1',
      title: 'Published chat',
      createdAt: '2026-08-30T12:00:00.000Z',
      messages: [
        {
          messageId: 'message-1',
          chatId: 'chat-1',
          role: 'user',
          status: 'complete',
          text: 'Review the approved evidence.',
          createdAtMs: 1,
        },
      ],
    }),
  );
  const note = Buffer.from('# Selected note\n');
  const prompt = Buffer.from('# Selected prompt\n');
  const attachment = Buffer.from('attachment bytes');
  const file = Buffer.from('approved file bytes');
  const attachmentHash = createHash('sha256').update(attachment).digest('hex');
  const fileHash = createHash('sha256').update(file).digest('hex');
  return {
    layout: {
      schemaVersion: 1,
      containerType: 'COWORK_WORK_ENTRY',
      title: 'Work Entry',
      repositories: [],
      files: [
        {
          path: 'evidence/approved.txt',
          status: 'added',
          artifactId: 'file-artifact',
          sizeBytes: String(file.byteLength),
        },
      ],
      notes: [{ itemId: 'note-1', title: 'Selected note' }],
      prompts: [{ itemId: 'prompt-1', title: 'Selected prompt' }],
      attachmentPaths: {
        [`attachments/${attachmentHash}`]: {
          artifactId: 'attachment-artifact',
          displayName: 'evidence.txt',
        },
      },
    },
    blobs: [
      { artifactId: 'chat-artifact', path: 'chats/chat-1.json', bytes: chat },
      { artifactId: 'note-artifact', path: 'notes/note-1.md', bytes: note },
      {
        artifactId: 'prompt-artifact',
        path: 'prompts/prompt-1.md',
        bytes: prompt,
      },
      {
        artifactId: 'attachment-artifact',
        path: `attachments/${attachmentHash}`,
        bytes: attachment,
      },
      {
        artifactId: 'file-artifact',
        path: `files/${fileHash}`,
        bytes: file,
      },
    ],
  };
}

export function buildSharedContainerDirtyFileFixture(): {
  layout: SharedContainerRevisionLayout;
  blobs: Array<{ artifactId: string; path: string; bytes: Buffer }>;
} {
  const modified = Buffer.from('export const changed = true;\n');
  const added = Buffer.from('export const added = true;\n');
  const blob = (
    artifactId: string,
    bytes: Buffer,
  ): { artifactId: string; path: string; bytes: Buffer } => ({
    artifactId,
    path: `repos/repo-1/files/${createHash('sha256').update(bytes).digest('hex')}`,
    bytes,
  });
  const blobs = [
    blob('modified-artifact', modified),
    blob('added-artifact', added),
  ];
  return {
    layout: {
      schemaVersion: 1,
      containerType: 'CODE_WORKTREE',
      title: 'Feature branch',
      repositories: [
        {
          repoId: 'repo-1',
          repoName: 'repo',
          remoteUrl: 'https://github.com/acme/repo.git',
          owner: 'acme',
          repository: 'repo',
          baseCommitSha: 'a'.repeat(40),
          files: [
            {
              path: 'src/modified.ts',
              status: 'modified',
              artifactId: 'modified-artifact',
              mode: '100755',
            },
            {
              path: 'src/added.ts',
              status: 'added',
              artifactId: 'added-artifact',
              mode: '100755',
            },
            { path: 'src/deleted.ts', status: 'deleted', mode: '100644' },
          ],
        },
      ],
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
    },
    blobs,
  };
}

function sha256(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function encrypt(
  value: Buffer,
  key: Buffer,
  aad: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(value).pipe(
    createArtifactEncryptStream(key, aad, value.byteLength),
  )) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Reusable publisher/recipient contract fixture. Callers can derive tampered,
 * truncated, reordered, and wrong-hash variants without embedding encryption
 * details into an individual test.
 */
export async function buildSharedContainerReplicaFixture(
  options: {
    revisionId?: string;
    revision?: number;
    parentRevisionId?: string;
    chatHash?: string;
    chatContents?: string;
    containerType?: 'CODE_WORKTREE' | 'COWORK_WORK_ENTRY';
    layout?: SharedContainerRevisionLayout;
    /**
     * Repository ids the default `CODE_WORKTREE` layout declares.
     *
     * Seeding only borrows checkouts for repositories the new revision still
     * declares, so a test exercising checkout reuse has to say which ones the
     * manifest names (CAN-2551).
     */
    repoIds?: readonly string[];
    plaintextArtifacts?: SharedContainerPlaintextArtifact[];
  } = {},
): Promise<SharedContainerReplicaFixture> {
  const revisionId = options.revisionId ?? 'revision-1';
  const revisionNumber = options.revision ?? 1;
  const containerType =
    options.layout?.containerType ??
    options.containerType ??
    'COWORK_WORK_ENTRY';
  const layout = Buffer.from(
    JSON.stringify(
      options.layout ?? {
        schemaVersion: 1,
        containerType,
        title:
          containerType === 'CODE_WORKTREE' ? 'Feature branch' : 'Work Entry',
        repositories: (options.repoIds ?? []).map((repoId) => ({
          repoId,
          repoName: repoId,
          remoteUrl: `https://github.com/acme/${repoId}.git`,
          owner: 'acme',
          repository: repoId,
          baseCommitSha: 'a'.repeat(40),
          files: [],
        })),
        files: [],
        notes: [],
        prompts: [],
        attachmentPaths: {},
      },
    ),
  );
  const chat = Buffer.from(
    options.chatContents ?? '{"id":"chat-1","messages":[]}',
  );
  const plaintextArtifacts = [
    ...(options.plaintextArtifacts ?? [
      {
        artifactId: 'chat-artifact',
        path: 'chats/chat-1.json',
        bytes: chat,
      },
    ]),
    { artifactId: 'layout-artifact', path: 'container.json', bytes: layout },
  ];
  const artifacts: SharedContainerArtifactDetail[] = plaintextArtifacts.map(
    (artifact) => ({
      artifactId: artifact.artifactId,
      path: artifact.path,
      representation: 'BLOB',
      hash:
        artifact.artifactId === 'chat-artifact' && options.chatHash
          ? options.chatHash
          : sha256(artifact.bytes),
      objectSizeBytes: String(artifact.bytes.byteLength),
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      revisionId,
      ...(options.parentRevisionId
        ? { parentRevisionId: options.parentRevisionId }
        : {}),
      schemaVersion: 1,
      artifacts,
    }),
  );
  const manifestKey = randomBytes(32);
  const manifestCiphertext = await encrypt(
    manifest,
    manifestKey,
    'manifest-aad',
  );
  const encryptedArtifacts = await Promise.all(
    plaintextArtifacts.map(async (artifact) => {
      const dataKey = randomBytes(32);
      const aad = `${artifact.artifactId}-aad`;
      return {
        ...artifact,
        dataKey,
        aad,
        ciphertext: await encrypt(artifact.bytes, dataKey, aad),
      };
    }),
  );
  const key = (dataKey: Buffer, aad: string): SharedContainerArtifactKey => ({
    scheme: 'AES_256_GCM_CHUNKED_V1',
    dataKey: dataKey.toString('base64'),
    aad,
  });
  const createdAt = '2026-08-28T12:00:00.000Z';
  const revisionDetail = {
    id: revisionId,
    revision: revisionNumber,
    schemaVersion: 1,
    ...(options.parentRevisionId
      ? { parentRevisionId: options.parentRevisionId }
      : {}),
    sourceDeviceId: 'device-1',
    artifactObjectKey: 'private/manifest',
    artifactHash: sha256(manifestCiphertext),
    artifactSizeBytes: String(manifestCiphertext.byteLength),
    artifacts,
    artifactCount: artifacts.length,
    totalSizeBytes: String(
      plaintextArtifacts.reduce(
        (total, artifact) => total + artifact.bytes.byteLength,
        0,
      ),
    ),
    createdAt,
  };
  return {
    detail: {
      id: 'container-1',
      organizationId: 'org-1',
      ownerUserId: 'owner-1',
      owner: { userId: 'owner-1', name: 'Owner' },
      access: 'organization',
      worktreeId: 'worktree-1',
      containerType,
      title: 'Shared worktree',
      revision: revisionNumber,
      capabilities: ['VIEW'],
      createdAt,
      updatedAt: createdAt,
      latestRevision: revisionDetail,
    },
    revision: { revision: revisionDetail },
    downloads: {
      downloads: [
        {
          artifactId: revisionId,
          target: {
            url: `https://fixture/${revisionId}/manifest`,
            expiresAt: createdAt,
          },
          key: key(manifestKey, 'manifest-aad'),
        },
        ...encryptedArtifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          target: {
            url: `https://fixture/${revisionId}/${
              artifact.artifactId === 'layout-artifact'
                ? 'layout'
                : artifact.artifactId === 'chat-artifact'
                  ? 'chat'
                  : artifact.artifactId
            }`,
            expiresAt: createdAt,
          },
          key: key(artifact.dataKey, artifact.aad),
        })),
      ],
    },
    responses: new Map([
      [`https://fixture/${revisionId}/manifest`, manifestCiphertext],
      ...encryptedArtifacts.map((artifact): [string, Buffer] => [
        `https://fixture/${revisionId}/${
          artifact.artifactId === 'layout-artifact'
            ? 'layout'
            : artifact.artifactId === 'chat-artifact'
              ? 'chat'
              : artifact.artifactId
        }`,
        artifact.ciphertext,
      ]),
    ]),
  };
}

export function transportForSharedContainerFixture(
  fixture: SharedContainerReplicaFixture,
): SharedContainerReplicaTransport {
  return {
    resolveLatest: () => Promise.resolve(fixture.detail),
    fetchRevision: () => Promise.resolve(fixture.revision),
    requestDownloadUrls: (_containerId, _revisionId, _orgId, artifactIds) =>
      Promise.resolve({
        downloads: fixture.downloads.downloads.filter((download) =>
          artifactIds.includes(download.artifactId),
        ),
      }),
  };
}

export function fetchForSharedContainerFixture(
  fixture: SharedContainerReplicaFixture,
): typeof fetch {
  return (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body = fixture.responses.get(url);
    return Promise.resolve(
      new Response(body ? new Uint8Array(body) : undefined),
    );
  };
}
