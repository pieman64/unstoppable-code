import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chatStore';

/**
 * Absolute path of the currently selected worktree, or undefined when no
 * worktree is selected or resolution fails (CAN-2382). Mirrors the
 * `PipelinesPage` cwd derivation so project-local pipelines resolve the same
 * way on every related-item surface. Fail-soft: consumers simply omit
 * project pipelines when no cwd is available.
 */
export function useActiveWorktreeCwd(): string | undefined {
  const selectedWorktree = useChatStore(useShallow((s) => s.selectedWorktree));
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!selectedWorktree) {
      setCwd(undefined);
      return undefined;
    }
    // Do not expose the previous worktree's path while this selection resolves.
    setCwd(undefined);
    void (async (): Promise<void> => {
      try {
        const nextCwd = await window.api.getWorktreePath({
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
        });
        if (!cancelled) {
          setCwd(nextCwd);
        }
      } catch {
        if (!cancelled) {
          setCwd(undefined);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [selectedWorktree]);
  return cwd;
}
