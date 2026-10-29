import type {
  SessionExportRecord,
  SessionExportUploadMetadata,
} from '@canopy/protocol/session-exports';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

jest.mock('../canopy-cloud/client', () => ({
  assertCanopyCloudCapability: jest.fn(),
  requestCanopyCloudBinary: jest.fn(),
  requestCanopyCloudJson: jest.fn(),
  requestCanopyCloudMultipartJson: jest.fn(),
  requestCanopyCloudNoContent: jest.fn(),
}));

import {
  assertCanopyCloudCapability,
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  requestCanopyCloudMultipartJson,
  requestCanopyCloudNoContent,
} from '../canopy-cloud/client';
import {
  deleteSessionExport,
  downloadSessionExportBundle,
  getSessionExport,
  listSessionExports,
  uploadSessionExport,
} from '../session-exports/canopy-server-client';

const metadata: SessionExportUploadMetadata = {
  title: 'Session export',
  workspaceName: 'Workspace',
  workspaceType: 'single-repo',
  manifestVersion: 1,
  appVersion: '0.26.8',
  sourceChatId: 'chat-1',
  claudeSessionId: 'claude-1',
  codexThreadId: 'codex-1',
  repos: [
    {
      name: 'canopy',
      branchName: 'feature/session-exports',
      remoteUrl: 'https://example.test/canopy.git',
    },
  ],
  contentHash: 'a'.repeat(64),
};

const record: SessionExportRecord = {
  ...metadata,
  id: '11111111-1111-4111-8111-111111111111',
  sizeBytes: 1234,
  createdAt: '2026-07-18T10:00:00.000Z',
  updatedAt: '2026-07-18T10:00:00.000Z',
};

const mockedAssert = jest.mocked(assertCanopyCloudCapability);
const mockedBinary = jest.mocked(requestCanopyCloudBinary);
const mockedJson = jest.mocked(requestCanopyCloudJson);
const mockedMultipart = jest.mocked(requestCanopyCloudMultipartJson);
const mockedNoContent = jest.mocked(requestCanopyCloudNoContent);
const credentialContext = {
  baseUrl: 'https://canopy.example.test',
  apiKey: 'initiating-account-key',
  capabilities: ['session-exports-v1'],
};

describe('session exports Canopy Server client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAssert.mockResolvedValue(undefined);
  });

  it('uploads metadata and gzip bytes as multipart with the transfer timeout', async () => {
    mockedMultipart.mockResolvedValue(record);
    const tempRoot = await mkdtemp(
      join(tmpdir(), 'session-export-client-test-'),
    );
    const bundlePath = join(tempRoot, 'session.tar.gz');
    const bundleBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]);
    await writeFile(bundlePath, bundleBytes);

    try {
      await expect(
        uploadSessionExport(
          metadata,
          { filePath: bundlePath },
          credentialContext,
        ),
      ).resolves.toEqual(record);

      expect(mockedAssert).toHaveBeenCalledWith(
        'session-exports-v1',
        credentialContext,
      );
      expect(mockedMultipart).toHaveBeenCalledTimes(1);
      const multipartCall = mockedMultipart.mock.calls[0];
      expect(multipartCall?.[0]).toBe('/api/v1/canopy/session-exports');
      expect(multipartCall?.[1].timeoutMs).toBe(120_000);
      expect(multipartCall?.[1].credentials).toEqual(credentialContext);
      expect(multipartCall?.[1].formData.get('metadata')).toBe(
        JSON.stringify(metadata),
      );
      const bundlePart = multipartCall?.[1].formData.get('bundle');
      expect(bundlePart).toBeInstanceOf(Blob);
      if (!(bundlePart instanceof Blob)) {
        throw new Error('Expected multipart bundle to be a Blob.');
      }
      expect(bundlePart.type).toBe('application/gzip');
      expect(Buffer.from(await bundlePart.arrayBuffer())).toEqual(bundleBytes);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('lists exports with the server query parameter shape', async () => {
    mockedJson.mockResolvedValue({ data: [record], nextCursor: 'next-page' });

    await expect(
      listSessionExports({
        limit: 25,
        cursor: 'cursor-value',
        q: 'review work',
      }),
    ).resolves.toEqual({ data: [record], nextCursor: 'next-page' });

    expect(mockedAssert).toHaveBeenCalledWith('session-exports-v1');
    expect(mockedJson).toHaveBeenCalledWith(
      '/api/v1/canopy/session-exports?limit=25&cursor=cursor-value&q=review+work',
    );
  });

  it('gets export metadata by encoded id', async () => {
    mockedJson.mockResolvedValue(record);

    await expect(
      getSessionExport('export/id', credentialContext),
    ).resolves.toEqual(record);

    expect(mockedAssert).toHaveBeenCalledWith(
      'session-exports-v1',
      credentialContext,
    );
    expect(mockedJson).toHaveBeenCalledWith(
      '/api/v1/canopy/session-exports/export%2Fid',
      { credentialContext },
    );
  });

  it('downloads raw bundle bytes with the transfer timeout', async () => {
    const bundleBytes = Buffer.from([0x1f, 0x8b, 0x08]);
    mockedBinary.mockResolvedValue(bundleBytes);

    await expect(
      downloadSessionExportBundle('export/id', credentialContext),
    ).resolves.toEqual(bundleBytes);

    expect(mockedAssert).toHaveBeenCalledWith(
      'session-exports-v1',
      credentialContext,
    );
    expect(mockedBinary).toHaveBeenCalledWith(
      '/api/v1/canopy/session-exports/export%2Fid/bundle',
      {
        method: 'GET',
        timeoutMs: 120_000,
        credentialContext,
      },
    );
  });

  it('deletes export metadata by encoded id', async () => {
    mockedNoContent.mockResolvedValue(undefined);

    await expect(deleteSessionExport('export/id')).resolves.toBeUndefined();

    expect(mockedAssert).toHaveBeenCalledWith('session-exports-v1');
    expect(mockedNoContent).toHaveBeenCalledWith(
      '/api/v1/canopy/session-exports/export%2Fid',
      { method: 'DELETE' },
    );
  });
});
