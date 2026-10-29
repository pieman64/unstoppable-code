export interface OrgProjectsCapabilityRefreshDeps {
  flags: {
    isEnabled(): boolean;
    onSnapshotChanged(listener: () => void): () => void;
  };
  /** Re-read the account so its server-minted capabilities are current. */
  refresh(): Promise<void>;
}

/**
 * The desktop's organization-projects flag updates live from LaunchDarkly, but
 * the `org-projects-v1` capability the catalog and organization Chats need is
 * minted into the stored account only when the account is re-read. Without a
 * prompt re-read the switcher appears up to one periodic refresh interval
 * before anything behind it works. Refresh the account whenever the flag
 * changes value, in either direction, so the capability follows it.
 */
export function installOrgProjectsCapabilityRefresh(
  deps: OrgProjectsCapabilityRefreshDeps,
): () => void {
  let enabled = deps.flags.isEnabled();
  return deps.flags.onSnapshotChanged((): void => {
    const next = deps.flags.isEnabled();
    if (next === enabled) return;
    enabled = next;
    void deps.refresh().catch((): void => {
      // The periodic refresh retries; a failed prompt re-read is not fatal.
    });
  });
}
