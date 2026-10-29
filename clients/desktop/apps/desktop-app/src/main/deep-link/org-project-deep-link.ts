import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
export interface OrgProjectLinkTarget {
  organizationId: string;
  projectId: string;
  workspaceId: string | null;
}
export interface OrgProjectLinkDeps {
  accountId: () => Promise<string>;
  /**
   * Monotonic counter bumped on every account event. The id alone cannot see a
   * sign-out and sign-in that lands back on the same account, so the epoch is
   * what actually fences this operation.
   */
  accountEpoch: () => number;
  enabled: () => boolean;
  projects: (organizationId: string) => Promise<readonly OrgProjectSummary[]>;
  workspaceId: (
    organizationId: string,
    projectId: string,
  ) => Promise<string | null>;
  switchContext: (organizationId: string) => Promise<void>;
  deliver: (target: OrgProjectLinkTarget) => void;
  unavailable: () => void;
}
export async function openOrgProjectDeepLink(
  projectId: string,
  organizationId: string,
  deps: OrgProjectLinkDeps,
): Promise<void> {
  try {
    if (deps.enabled() === false) {
      deps.unavailable();
      return;
    }
    // Sampled BEFORE the first read: a transition inside that await would
    // otherwise pair a pre-transition id with a post-transition epoch, and a
    // same-id sign-out/sign-in would pass every later check.
    const epoch = deps.accountEpoch();
    const accountId = await deps.accountId();
    if (accountId.length === 0 || deps.accountEpoch() !== epoch) {
      deps.unavailable();
      return;
    }
    const sameAccount = async (): Promise<boolean> =>
      (await deps.accountId()) === accountId && deps.accountEpoch() === epoch;
    const projects = await deps.projects(organizationId);
    const project = projects.find(
      (item) =>
        item.id === projectId &&
        item.organizationId === organizationId &&
        item.state === 'ACTIVE' &&
        item.capabilities.use,
    );
    if (
      project === undefined ||
      (await sameAccount()) === false ||
      deps.enabled() === false
    ) {
      deps.unavailable();
      return;
    }
    const workspaceId = await deps.workspaceId(organizationId, projectId);
    if ((await sameAccount()) === false) {
      deps.unavailable();
      return;
    }
    await deps.switchContext(organizationId);
    if ((await sameAccount()) === false || deps.enabled() === false) {
      deps.unavailable();
      return;
    }
    deps.deliver({ projectId, organizationId, workspaceId });
  } catch {
    deps.unavailable();
  }
}
