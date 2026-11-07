import type { JSX } from 'react';
import { Skeleton } from '@canopy/ui-shared/components';

/** The cloud account connection a catalog server binds to. */
export function McpAccountBindingSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading account connections"
      testId="mcp-account-binding-loading"
    >
      <p className="fg-secondary">Account connection: GitHub</p>
    </Skeleton>
  );
}
