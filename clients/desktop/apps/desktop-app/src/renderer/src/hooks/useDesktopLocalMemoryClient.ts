import { useMemo } from 'react';
import type { LocalMemoryClient } from '@canopy/app-core/local-memory';
import {
  createIpcLocalMemoryClient,
  desktopLocalMemoryClient,
} from '@/client/ipc-local-memory-client';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';

/**
 * The Memory panel's desktop client for the selected context: source chats in
 * linked personal checkouts resolve while an organization is selected.
 */
export function useDesktopLocalMemoryClient(): LocalMemoryClient {
  const { linkedPersonalWorkspaceIds } = useContextScopedWorkspaces();
  const linkedKey = linkedPersonalWorkspaceIds.join('\n');
  return useMemo(
    () =>
      linkedKey
        ? createIpcLocalMemoryClient(linkedKey.split('\n'))
        : desktopLocalMemoryClient,
    [linkedKey],
  );
}
