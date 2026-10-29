import { BRAND } from '@canopy/brand/current';
import {
  assertResourceContext,
  assertResourceContextSnapshot,
  resourceContextEnabled,
  resourceContextSnapshot,
} from '../lib/resource-context';
import { createResourceLaneInventory } from '../lib/resource-inventory';
import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import type {
  ListSharedPluginsRequest,
  SharedPluginCreateRequest,
  SharedPluginDetail,
  SharedPluginPublicShareInfo,
  SharedPluginSummary,
  SharedPluginUpdateRequest,
} from '@canopy/desktop-shared/types/plugins';
import {
  requestCanopyCloudJson as requestJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudNoContent as requestNoContent,
} from '../canopy-cloud/client';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

const PLUGINS_CAPABILITY = 'plugins-crud-v1';
const listPluginLanes = createResourceLaneInventory<{
  id: string;
  owner: SharedPluginSummary['owner'];
  plugin: SharedPluginSummary;
}>();

/**
 * Capability negotiation for every shared-plugin Cloud call: a Cloud that does
 * not advertise `plugins-crud-v1` fails here with the negotiated error rather
 * than at an unsupported endpoint. Shared by the IPC handlers and the portal's
 * `share_plugin` service path.
 */
export async function assertSharedPluginsSupported(): Promise<void> {
  await assertCanopyCloudCapability(PLUGINS_CAPABILITY);
}

export async function listSharedPlugins(
  request: Pick<ListSharedPluginsRequest, 'createdBy' | 'query'> = {},
): Promise<SharedPluginSummary[]> {
  if (resourceContextEnabled()) {
    const page = await listPluginLanes(request, async (lane, _cursor, etag) => {
      const query = new URLSearchParams({
        shareScope: lane.kind === 'personal' ? 'private' : 'organization',
      });
      if (request.createdBy) query.set('createdBy', request.createdBy);
      if (request.query) query.set('q', request.query);
      if (lane.kind === 'organization')
        query.set('organizationId', lane.organizationId);
      const result = await requestCanopyCloudJsonConditional<{
        data: SharedPluginSummary[];
      }>(`${API_PREFIX}/plugins?${query}`, { etag });
      if (result.status === 'not-modified') return result;
      return {
        ...result,
        body: {
          data: result.body.data.map((row) => ({
            id: row.externalId,
            owner: row.owner,
            plugin: row,
          })),
          nextCursor: null,
        },
      };
    });
    return page.data.map((row) => row.plugin);
  }
  const query = new URLSearchParams();
  if (request.createdBy) query.set('createdBy', request.createdBy);
  if (request.query) query.set('q', request.query);
  const response = await requestJson<{ data: SharedPluginSummary[] }>(
    `${API_PREFIX}/plugins${query.size > 0 ? `?${query}` : ''}`,
  );
  return response.data;
}

export async function getSharedPlugin(
  remoteId: string,
): Promise<SharedPluginDetail> {
  const snapshot = resourceContextEnabled()
    ? await resourceContextSnapshot()
    : undefined;
  const detail = await requestJson<SharedPluginDetail>(
    `${API_PREFIX}/plugins/${encodeURIComponent(remoteId)}`,
  );
  if (snapshot !== undefined) {
    await assertResourceContext({ owner: detail.owner });
    await assertResourceContextSnapshot(snapshot);
  }
  return detail;
}

export async function createSharedPlugin(
  request: SharedPluginCreateRequest,
): Promise<SharedPluginDetail> {
  return requestJson<SharedPluginDetail>(`${API_PREFIX}/plugins`, {
    method: 'POST',
    body: JSON.stringify({
      ref: request.ref,
      name: request.name,
      ...(request.description !== undefined
        ? { description: request.description }
        : {}),
      ...(request.shareScope !== undefined
        ? { shareScope: request.shareScope }
        : {}),
      ...(request.teamId !== undefined ? { teamId: request.teamId } : {}),
      ...(request.organizationId !== undefined
        ? { organizationId: request.organizationId }
        : {}),
    }),
  });
}

export async function updateSharedPlugin(
  request: SharedPluginUpdateRequest,
): Promise<SharedPluginDetail> {
  if (resourceContextEnabled()) await getSharedPlugin(request.remoteId);
  return requestJson<SharedPluginDetail>(
    `${API_PREFIX}/plugins/${encodeURIComponent(request.remoteId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        ref: request.ref,
        name: request.name,
        ...(request.description !== undefined
          ? { description: request.description }
          : {}),
        ...(request.shareScope !== undefined
          ? { shareScope: request.shareScope }
          : {}),
        ...(request.teamId !== undefined ? { teamId: request.teamId } : {}),
        ...(request.organizationId !== undefined
          ? { organizationId: request.organizationId }
          : {}),
      }),
    },
  );
}

export async function deleteSharedPlugin(remoteId: string): Promise<void> {
  if (resourceContextEnabled()) await getSharedPlugin(remoteId);
  await requestNoContent(
    `${API_PREFIX}/plugins/${encodeURIComponent(remoteId)}`,
    { method: 'DELETE' },
  );
}

export async function publishPluginPublicShare(
  remoteId: string,
): Promise<SharedPluginPublicShareInfo> {
  if (resourceContextEnabled()) await getSharedPlugin(remoteId);
  const response = await requestJson<{
    publicShare: SharedPluginPublicShareInfo;
  }>(`${API_PREFIX}/plugins/${encodeURIComponent(remoteId)}/public-share`, {
    method: 'POST',
  });
  return response.publicShare;
}

export async function revokePluginPublicShare(remoteId: string): Promise<void> {
  if (resourceContextEnabled()) await getSharedPlugin(remoteId);
  await requestNoContent(
    `${API_PREFIX}/plugins/${encodeURIComponent(remoteId)}/public-share`,
    { method: 'DELETE' },
  );
}
