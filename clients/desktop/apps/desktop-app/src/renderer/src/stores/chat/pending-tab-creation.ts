import type { ChatCommandDisposition } from './revisioned-commands';

export interface PendingTabCreationDetails {
  promise: Promise<ChatCommandDisposition>;
  getRevision: () => number | undefined;
}

const pendingTabCreations = new Map<string, PendingTabCreationDetails>();

function pendingTabCreationKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

export function registerPendingTabCreation(
  projectId: string,
  worktreeId: string,
  chatId: string,
  creation: Promise<ChatCommandDisposition>,
  getRevision: () => number | undefined = () => undefined,
): void {
  const key = pendingTabCreationKey(projectId, worktreeId, chatId);
  const details = { promise: creation, getRevision };
  pendingTabCreations.set(key, details);
  void creation.finally(() => {
    if (pendingTabCreations.get(key) === details) {
      pendingTabCreations.delete(key);
    }
  });
}

export function pendingTabCreation(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ChatCommandDisposition> | undefined {
  return pendingTabCreationDetails(projectId, worktreeId, chatId)?.promise;
}

export function pendingTabCreationDetails(
  projectId: string,
  worktreeId: string,
  chatId: string,
): PendingTabCreationDetails | undefined {
  return pendingTabCreations.get(
    pendingTabCreationKey(projectId, worktreeId, chatId),
  );
}
