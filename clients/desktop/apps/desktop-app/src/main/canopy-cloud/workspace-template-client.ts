import { BRAND } from '@canopy/brand/current';
import type {
  PipelinePackageRef,
  PublicWorkspaceTemplateShareSnapshot,
  SharedWorkspaceTemplateDocument,
  WorkspaceTemplateShareAudience,
  ListWorkspaceTemplateSharesResponse,
  ListWorkspaceTemplateSharesRequest,
} from '@canopy/protocol';
import type { ChatProjectTemplateShareInfo } from '@canopy/desktop-shared/types';
import {
  requestCanopyCloudJson,
  requestCanopyCloudBinary,
  requestCanopyCloudNoContent,
  requestCanopyCloudPublicBinary,
  requestCanopyCloudPublicJson,
} from './client';
import { CanopyCloudClientError } from './client';
import { getPublicWorkspaceTemplateSnapshot } from './public-share-client';
import {
  withPackageVersionNegotiation,
  type PipelinePackageDownload,
} from '../pipelines/canopy-server-client';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}/workspace-template-shares`;
const PUBLIC_PACKAGE_PREFIX = '/api/v1/public-shares/blueprints';
const SCOPED_PACKAGE_PREFIX = '/api/v1/workspace-template-shares';

function isNotFound(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    error.code === 'http-error' &&
    error.status === 404
  );
}

export async function createWorkspaceTemplateShare(
  document: SharedWorkspaceTemplateDocument,
  clientPublicationKey: string,
  packageInput: {
    audience?: WorkspaceTemplateShareAudience;
    teamId?: string;
    organizationId?: string;
    capabilityPackage?: PipelinePackageRef | null;
    committedPackageUploadId?: string;
  } = {},
): Promise<Omit<ChatProjectTemplateShareInfo, 'upToDate'>> {
  return requestCanopyCloudJson(`${API_PREFIX}`, {
    method: 'POST',
    body: JSON.stringify({ document, clientPublicationKey, ...packageInput }),
  });
}

export async function republishWorkspaceTemplateShare(
  externalId: string,
  document: SharedWorkspaceTemplateDocument,
  packageInput: {
    audience?: WorkspaceTemplateShareAudience;
    teamId?: string;
    organizationId?: string;
    capabilityPackage?: PipelinePackageRef | null;
    committedPackageUploadId?: string;
  } = {},
): Promise<{ pinnedContentHash: string }> {
  return requestCanopyCloudJson(
    `${API_PREFIX}/${encodeURIComponent(externalId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ document, ...packageInput }),
    },
  );
}

export async function listWorkspaceTemplateShares(
  request: ListWorkspaceTemplateSharesRequest = {},
): Promise<ListWorkspaceTemplateSharesResponse> {
  const query = new URLSearchParams();
  if (request.createdBy) query.set('createdBy', request.createdBy);
  if (request.query) query.set('q', request.query);
  return requestCanopyCloudJson<ListWorkspaceTemplateSharesResponse>(
    `${API_PREFIX}${query.size > 0 ? `?${query}` : ''}`,
  );
}

export async function revokeWorkspaceTemplateShare(
  externalId: string,
): Promise<void> {
  await requestCanopyCloudNoContent(
    `${API_PREFIX}/${encodeURIComponent(externalId)}`,
    { method: 'DELETE' },
  );
}

export async function getWorkspaceTemplateShareSnapshot(
  externalId: string,
  expectedContentHash?: string,
): Promise<PublicWorkspaceTemplateShareSnapshot> {
  return getPublicWorkspaceTemplateSnapshot(externalId, expectedContentHash);
}

function publicBlueprintPackagePath(
  externalId: string,
  clientKey?: string,
): string {
  const base = `${PUBLIC_PACKAGE_PREFIX}/${encodeURIComponent(externalId)}`;
  return clientKey === undefined
    ? `${base}/package`
    : `${base}/skills/${encodeURIComponent(clientKey)}/package`;
}

export async function getPublicBlueprintPackage(
  externalId: string,
  expectedPackageDigest: string,
  clientKey?: string,
): Promise<PipelinePackageDownload> {
  const query = new URLSearchParams({ expectedPackageDigest });
  try {
    return await withPackageVersionNegotiation((headers) =>
      requestCanopyCloudPublicJson<PipelinePackageDownload>(
        `${publicBlueprintPackagePath(externalId, clientKey)}?${query.toString()}`,
        { headers },
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const base = `${SCOPED_PACKAGE_PREFIX}/${encodeURIComponent(externalId)}`;
    const path =
      clientKey === undefined
        ? `${base}/package`
        : `${base}/skills/${encodeURIComponent(clientKey)}/package`;
    return withPackageVersionNegotiation((headers) =>
      requestCanopyCloudJson<PipelinePackageDownload>(
        `${path}?${query.toString()}`,
        { headers },
      ),
    );
  }
}

export async function getPublicBlueprintPackageBlob(
  externalId: string,
  expectedPackageDigest: string,
  sha256: string,
  clientKey?: string,
): Promise<Uint8Array> {
  const query = new URLSearchParams({ expectedPackageDigest });
  try {
    return new Uint8Array(
      await withPackageVersionNegotiation((headers) =>
        requestCanopyCloudPublicBinary(
          `${publicBlueprintPackagePath(externalId, clientKey)}/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
          { headers },
        ),
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const base = `${SCOPED_PACKAGE_PREFIX}/${encodeURIComponent(externalId)}`;
    const path =
      clientKey === undefined
        ? `${base}/package`
        : `${base}/skills/${encodeURIComponent(clientKey)}/package`;
    return new Uint8Array(
      await withPackageVersionNegotiation((headers) =>
        requestCanopyCloudBinary(
          `${path}/blobs/${encodeURIComponent(sha256)}?${query.toString()}`,
          { headers },
        ),
      ),
    );
  }
}
