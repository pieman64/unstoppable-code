/** Client-supplied metadata stored alongside an opaque session bundle. */
export interface SessionExportUploadMetadata {
  title: string;
  workspaceName: string;
  workspaceType: string;
  manifestVersion: number;
  appVersion: string;
  sourceChatId: string;
  claudeSessionId?: string;
  codexThreadId?: string;
  repos: Array<{
    name: string;
    branchName: string;
    remoteUrl?: string;
  }>;
  contentHash: string;
}

/** Metadata returned for a persisted session export. */
export interface SessionExportRecord extends SessionExportUploadMetadata {
  id: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListSessionExportsRequest {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface ListSessionExportsResponse {
  data: SessionExportRecord[];
  nextCursor: string | null;
}
