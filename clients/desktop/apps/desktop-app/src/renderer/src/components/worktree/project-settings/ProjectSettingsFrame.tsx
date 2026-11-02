import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useOverlayEscape } from '@canopy/ui-shared/components';
import { SidebarNavRow } from '@/components/sidebar/SidebarNavRow';
import { SidebarPageNav } from '@/components/sidebar/SidebarPageNav';
import { BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE } from '@/lib/browserNativeOverlay';
import { useSidebarPageHandoffStore } from '@/stores/sidebarPageHandoffStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { ProjectIcon } from '../../shared/ProjectIcon';

export interface ProjectSettingsNavItem<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly icon: ReactNode;
}

interface ProjectSettingsFrameProps<T extends string> {
  readonly projectName: string;
  readonly projectColor?: string;
  readonly repoPath: string;
  readonly pages: readonly ProjectSettingsNavItem<T>[];
  readonly activePage: T;
  readonly onNavigate: (page: T) => void;
  readonly onClose: () => void;
  /** Resets the page scroll when it changes, such as a page or a drill-in. */
  readonly scrollKey: string;
  readonly children: ReactNode;
}

/**
 * Project settings as a page shaped like Settings: a short rail with the
 * project's pages beside one card that holds the 640px column. It covers the
 * window like Settings and closes with Back or Escape.
 */
export function ProjectSettingsFrame<T extends string>({
  projectName,
  projectColor,
  repoPath,
  pages,
  activePage,
  onNavigate,
  onClose,
  scrollKey,
  children,
}: ProjectSettingsFrameProps<T>): JSX.Element {
  const sidebarWidth = useSidebarStore((state) => state.width);
  const setSidebarWidth = useSidebarStore((state) => state.setWidth);
  const scrollRef = useRef<HTMLDivElement>(null);
  useOverlayEscape(true, onClose);

  // The main sidebar's content steps aside while this page's rail shows, and
  // the shell under the page hides, as they do for Settings.
  useEffect(() => {
    const handoff = useSidebarPageHandoffStore.getState();
    handoff.setActive(true, { coversMainShell: true });
    return (): void => handoff.setActive(false);
  }, []);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [scrollKey]);

  const page = (
    <div
      {...{ [BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE]: 'true' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-settings-title"
      // Settings is controls and their labels, not text to copy; fields and
      // values stay selectable through `.settings-page-overlay`.
      className="settings-page-overlay fixed inset-0 z-modal flex select-none fg-primary"
      data-open="true"
      data-settings-layout="inset"
      data-testid="project-settings-page"
    >
      <div className="flex h-full shrink-0">
        <SidebarPageNav
          ariaLabel="Project settings"
          sidebarTestId="project-settings-sidebar"
          backTestId="project-settings-back"
          resizeHandleTestId="project-settings-sidebar-resize-handle"
          scrollViewportTestId="project-settings-nav-scroll-container"
          onBack={onClose}
          width={sidebarWidth}
          onResize={setSidebarWidth}
        >
          <div className="flex min-w-0 items-center gap-2.5 px-2 pb-2 pt-3">
            <ProjectIcon
              kind="single-repo"
              color={projectColor}
              repoPath={repoPath}
            />
            <div className="min-w-0">
              <h2
                id="project-settings-title"
                className={`truncate text-s font-medium fg-primary ${POSTHOG_REPLAY_MASK_CLASS}`}
              >
                {projectName}
              </h2>
              <div className="text-xs fg-tertiary">Project settings</div>
            </div>
          </div>
          <nav
            className="flex flex-col gap-px"
            aria-label="Project settings pages"
          >
            {pages.map((page) => (
              <SidebarNavRow
                key={page.id}
                onClick={() => onNavigate(page.id)}
                data-testid={`project-settings-nav-${page.id}`}
                className="text-left"
                selected={activePage === page.id}
                aria-current={activePage === page.id ? 'page' : undefined}
                icon={page.icon}
              >
                {page.label}
              </SidebarNavRow>
            ))}
          </nav>
        </SidebarPageNav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="electron-drag h-11.5 shrink-0" />
        <div
          className="relative flex min-h-0 flex-1 flex-col bg-base"
          data-settings-card=""
          data-testid="project-settings-content"
        >
          <div
            ref={scrollRef}
            className="page-scroll-gutter flex-1 overflow-auto"
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
  // Portaled: while this page shows, the main window under it is hidden
  // and inert, and this page must not inherit that.
  return typeof document === 'undefined'
    ? page
    : createPortal(page, document.body);
}
