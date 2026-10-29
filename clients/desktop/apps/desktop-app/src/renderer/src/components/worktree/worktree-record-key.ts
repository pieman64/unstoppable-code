export function getWorktreeRecordKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}
