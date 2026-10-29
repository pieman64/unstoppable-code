/**
 * Module-level registry of known cowork workspace ids, mirroring the
 * main-process pattern in
 * `apps/desktop-app/src/main/lib/workspace-registry.ts`.
 *
 * This exists to break an import cycle: `chatStore.ts` imports
 * `isCoworkChatTarget` from `./cowork`, and `projectsStore.ts` imports
 * `chatStore.ts`. If `cowork.ts` imported `projectsStore.ts` directly to
 * read `projects`, the graph would cycle back on itself
 * (projectsStore -> chatStore -> cowork -> projectsStore). Instead,
 * `projectsStore.ts` pushes cowork workspace ids into this registry
 * whenever its `projects` state changes, and `cowork.ts` does a cheap
 * synchronous read with no store dependency.
 */
const coworkWorkspaceIds = new Set<string>();

export function isRegisteredCoworkWorkspaceId(id: string): boolean {
  return coworkWorkspaceIds.has(id);
}

export function registerCoworkWorkspaceIds(ids: readonly string[]): void {
  coworkWorkspaceIds.clear();
  ids.forEach((id) => {
    coworkWorkspaceIds.add(id);
  });
}
