import type { BrowserProfileUsage, BrowserTaskScope } from './index';

export type BrowserMaintenanceOperation =
  | { kind: 'cache' }
  | { kind: 'site'; origin: string }
  | { kind: 'reset' };
export type BrowserDataJobStatus =
  | 'queued'
  | 'running'
  | 'irreversible'
  | 'complete'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export type BrowserDataJobKind =
  | 'inventory'
  | 'cache'
  | 'site'
  | 'reset'
  | 'download';
export interface BrowserDataJob {
  jobId: string;
  profileId: string;
  storageGeneration: number;
  kind: BrowserDataJobKind;
  status: BrowserDataJobStatus;
  createdAt: number;
  updatedAt: number;
  cancellable: boolean;
  retryable?: boolean;
  message?: string;
  approximateBytes?: number | null;
  completedEntries?: number;
  cleanupPending?: boolean;
  newStorageGeneration?: number;
}
export interface BrowserObservedSite {
  origin: string;
  topLevelOrigin: string;
  /** Chromium's domainAndRegistry, or the complete host for IP/localhost. */
  cookieDomain: string | null;
  observedAt: number;
}
export interface BrowserProfileInventory {
  profileId: string;
  storageGeneration: number;
  jobId?: string;
  measuredAt: number | null;
  approximateBytes: number | null;
  coverage: 'partial' | 'unknown';
  /** No native per-class size claims. */
  classBytes: { cache: null; indexedDB: null; opfs: null };
  sites: BrowserObservedSite[];
  cookieDomains: { domain: string; count: number }[];
  nextOffset?: number;
  truncated: boolean;
}
export interface BrowserClearPreview extends BrowserProfileUsage {
  token: string;
  profileId: string;
  storageGeneration: number;
  metadataRevision: number;
  operation: BrowserMaintenanceOperation;
  expiresAt: number;
  dataClasses: string[];
  cookieDomains: string[];
  contexts: { origin: string; topLevelOrigin: string }[];
  warning: string;
}
/** Captured in main; never accepted from IPC or agent payloads. */
export type BrowserDataActor =
  | { kind: 'user' }
  | {
      kind: 'agent';
      taskScope: BrowserTaskScope;
      taskIncarnationId: string;
    };

export interface BrowserProfileDataApi {
  inventoryStart(request: {
    operationId: string;
    profileId: string;
    storageGeneration: number;
  }): Promise<BrowserDataJob>;
  inventoryGet(request: {
    profileId: string;
    storageGeneration: number;
    offset?: number;
  }): Promise<BrowserProfileInventory>;
  jobGet(request: { jobId: string }): Promise<BrowserDataJob>;
  jobList(request?: {
    profileId?: string;
    offset?: number;
  }): Promise<{ jobs: BrowserDataJob[]; nextOffset?: number }>;
  jobCancel(request: { jobId: string }): Promise<BrowserDataJob>;
  previewClear(request: {
    profileId: string;
    storageGeneration: number;
    metadataRevision: number;
    operation: BrowserMaintenanceOperation;
  }): Promise<BrowserClearPreview>;
  clear(request: {
    operationId: string;
    token: string;
  }): Promise<BrowserDataJob>;
  retryJob(request: { jobId: string }): Promise<BrowserDataJob>;
  cleanupStatus(): Promise<{
    jobs: {
      jobId: string;
      profileId: string;
      storageGeneration: number;
      status: 'pending' | 'pending_restart' | 'failed';
      message?: string;
    }[];
  }>;
  retryCleanup(): Promise<{ remaining: number }>;
}
