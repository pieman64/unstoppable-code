import type { WorkspaceContext } from './workspace-context';

/** Exact operation captured before switching its visibility epoch. */
export interface ForeignActivityTarget {
  source: 'chat' | 'pipeline' | 'script';
  operationId: string;
  workspaceId: string;
  worktreeId: string;
  chatId?: string;
  resultToken: string | null;
}
export interface ForeignActivityWorkspace {
  workspaceId: string;
  name: string;
  running: number;
  unread: number;
  interrupted: boolean;
  latestTarget: ForeignActivityTarget;
  stopTargets: ForeignActivityTarget[];
}
export interface ForeignActivityProjection {
  epoch: string;
  sequence: number;
  groups: Array<{
    context: WorkspaceContext;
    workspaces: ForeignActivityWorkspace[];
  }>;
}
export interface ForeignActivityStopRequest {
  epoch: string;
  target: ForeignActivityTarget;
}
