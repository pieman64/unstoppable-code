import { useCallback, useEffect, useState, type JSX } from 'react';
import type { FileTabViewMode } from '@canopy/desktop-shared/types';
import { DesktopSharedFileViewer } from './DesktopSharedFileViewer';

export interface FileViewerTabDescriptor {
  id: string;
  projectId: string;
  worktreeId: string;
  filePath: string;
  fileViewMode?: FileTabViewMode;
  recheckAfterWorktreeSetup?: boolean;
}

interface FileViewerPanelHostProps {
  fileTabs: FileViewerTabDescriptor[];
  activeFileTab: FileViewerTabDescriptor | null;
}

/**
 * Hosts the file-viewer subtree for a worktree's file tabs.
 *
 * Switching tabs used to unmount the single active `FileViewerPanel`, which
 * destroyed its DOM scroll containers. Renderer-owned viewers restore their
 * scroll on remount via `useTabScrollPosition`, but a sandboxed HTML preview's
 * internal iframe scroll cannot be read or restored through the iframe sandbox's
 * opaque-origin boundary. To preserve HTML reading position the host keeps the
 * mounted (but hidden) panel alive while its tab stays open — the iframe DOM,
 * and thus its native scroll state, survives the switch.
 *
 * Only the active tab plus any tabs that have asked to be preserved (HTML
 * previews) are mounted. Every other inactive file tab unmounts to keep memory
 * bounded for large files.
 */
export function FileViewerPanelHost({
  fileTabs,
  activeFileTab,
}: FileViewerPanelHostProps): JSX.Element {
  const [preservedTabIds, setPreservedTabIds] = useState<Set<string>>(
    () => new Set(),
  );

  const handlePreserveMountedChange = useCallback(
    (tabId: string, shouldPreserve: boolean): void => {
      setPreservedTabIds((previous) => {
        const alreadyPreserved = previous.has(tabId);
        if (alreadyPreserved === shouldPreserve) return previous;

        const next = new Set(previous);
        if (shouldPreserve) next.add(tabId);
        else next.delete(tabId);
        return next;
      });
    },
    [],
  );

  // Drop preserved entries for tabs that no longer exist (closed tabs) so the
  // host never keeps a stale panel mounted.
  useEffect(() => {
    const liveIds = new Set(fileTabs.map((tab) => tab.id));
    setPreservedTabIds((previous) => {
      const next = new Set(
        Array.from(previous).filter((tabId) => liveIds.has(tabId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [fileTabs]);

  const renderedTabs = fileTabs.filter(
    (tab) => tab.id === activeFileTab?.id || preservedTabIds.has(tab.id),
  );

  return (
    <>
      {renderedTabs.map((tab) => {
        const isActive = tab.id === activeFileTab?.id;
        return (
          <div
            key={tab.id}
            aria-hidden={!isActive}
            className={
              isActive
                ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'hidden'
            }
          >
            <DesktopSharedFileViewer
              tabId={tab.id}
              projectId={tab.projectId}
              worktreeId={tab.worktreeId}
              filePath={tab.filePath}
              viewMode={tab.fileViewMode ?? 'raw'}
              active={isActive}
              {...(tab.recheckAfterWorktreeSetup
                ? { recheckAfterWorktreeSetup: true }
                : {})}
              onPreserveMountedChange={handlePreserveMountedChange}
            />
          </div>
        );
      })}
    </>
  );
}
