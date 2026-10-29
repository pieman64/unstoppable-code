import type {
  ListSessionExportsRequest,
  ListSessionExportsResponse,
  SessionExportRecord,
  SessionExportUploadMetadata,
} from '@canopy/protocol/session-exports';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  assertCanopyCloudCapability,
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  requestCanopyCloudMultipartJson,
  requestCanopyCloudNoContent,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';

// Session exports are served by the paired private server API, whose route
// namespace is distinct from the brand-specific desktop API namespace.
const API_PREFIX = '/api/v1/canopy';
const SESSION_EXPORTS_CAPABILITY = 'session-exports-v1';
const SESSION_EXPORT_TRANSFER_TIMEOUT_MS = 120_000;

/**
 * Upload an archive produced by `packSessionBundle`. Building the multipart
 * body reads the complete archive into memory because Node's FormData requires
 * a Blob for file parts.
 */
export async function uploadSessionExport(
  metadata: SessionExportUploadMetadata,
  bundle: { filePath: string },
  credentials: CanopyCloudCredentialContext,
): Promise<SessionExportRecord> {
  await assertCanopyCloudCapability(SESSION_EXPORTS_CAPABILITY, credentials);
  const archiveBytes = await readFile(bundle.filePath);
  const archiveBlob = new Blob([new Uint8Array(archiveBytes)], {
    type: 'application/gzip',
  });
  const formData = new FormData();
  formData.append('metadata', JSON.stringify(metadata));
  formData.append('bundle', archiveBlob, basename(bundle.filePath));

  return requestCanopyCloudMultipartJson<SessionExportRecord>(
    `${API_PREFIX}/session-exports`,
    {
      formData,
      timeoutMs: SESSION_EXPORT_TRANSFER_TIMEOUT_MS,
      credentials,
    },
  );
}

export async function listSessionExports(
  params: ListSessionExportsRequest,
): Promise<ListSessionExportsResponse> {
  await assertCanopyCloudCapability(SESSION_EXPORTS_CAPABILITY);
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.q) query.set('q', params.q);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestCanopyCloudJson<ListSessionExportsResponse>(
    `${API_PREFIX}/session-exports${suffix}`,
  );
}

export async function getSessionExport(
  id: string,
  credentials: CanopyCloudCredentialContext,
): Promise<SessionExportRecord> {
  await assertCanopyCloudCapability(SESSION_EXPORTS_CAPABILITY, credentials);
  return requestCanopyCloudJson<SessionExportRecord>(
    `${API_PREFIX}/session-exports/${encodeURIComponent(id)}`,
    { credentialContext: credentials },
  );
}

export async function downloadSessionExportBundle(
  id: string,
  credentials: CanopyCloudCredentialContext,
): Promise<Buffer> {
  await assertCanopyCloudCapability(SESSION_EXPORTS_CAPABILITY, credentials);
  return requestCanopyCloudBinary(
    `${API_PREFIX}/session-exports/${encodeURIComponent(id)}/bundle`,
    {
      method: 'GET',
      timeoutMs: SESSION_EXPORT_TRANSFER_TIMEOUT_MS,
      credentialContext: credentials,
    },
  );
}

export async function deleteSessionExport(id: string): Promise<void> {
  await assertCanopyCloudCapability(SESSION_EXPORTS_CAPABILITY);
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/session-exports/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}
