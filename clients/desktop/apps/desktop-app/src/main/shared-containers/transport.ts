import type {
  ListSharedContainersResponse,
  SharedContainerDetail,
  SharedContainerDownloadUrlsResponse,
  SharedContainerFetchRevisionResponse,
} from '@canopy/protocol/shared-containers';
import {
  fetchLatestSharedContainerRevision,
  fetchSharedContainerRevision,
  listSharedContainersWithMe,
  requestSharedContainerArtifactDownloadUrls,
  type ListSharedContainersWithMeRequest,
} from './canopy-server-client';
import {
  createSharedContainerRealtimeSubscription,
  type CreateSharedContainerRealtimeSubscriptionOptions,
  type SharedContainerRealtimeSubscription,
} from './realtime-subscription';

export interface SharedContainerReplicaTransport {
  listSharedWithMe?(
    request: ListSharedContainersWithMeRequest,
  ): Promise<ListSharedContainersResponse>;
  resolveLatest(
    containerId: string,
    /** Ownership hint; absent for a personal container. */
    organizationId: string | undefined,
    signal?: AbortSignal,
  ): Promise<SharedContainerDetail>;
  fetchRevision(
    containerId: string,
    revisionId: string,
    /** Ownership hint; absent for a personal container. */
    organizationId: string | undefined,
    signal?: AbortSignal,
  ): Promise<SharedContainerFetchRevisionResponse>;
  requestDownloadUrls(
    containerId: string,
    revisionId: string,
    /** Ownership hint; absent for a personal container. */
    organizationId: string | undefined,
    artifactIds: string[],
    signal?: AbortSignal,
  ): Promise<SharedContainerDownloadUrlsResponse>;
  subscribe?(
    options: CreateSharedContainerRealtimeSubscriptionOptions,
  ): SharedContainerRealtimeSubscription;
}

export const canopySharedContainerReplicaTransport: SharedContainerReplicaTransport =
  {
    listSharedWithMe: listSharedContainersWithMe,
    resolveLatest: fetchLatestSharedContainerRevision,
    fetchRevision: fetchSharedContainerRevision,
    requestDownloadUrls: requestSharedContainerArtifactDownloadUrls,
    subscribe: createSharedContainerRealtimeSubscription,
  };
