import { type JSX, type ReactNode, type Ref } from 'react';
import { SidebarPageNav as SharedSidebarPageNav } from '@canopy/ui-app/sidebar';
import { SIDEBAR_DEFAULT_WIDTH } from '@/stores/sidebarStore';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import { localPlatform } from '@/lib/local-platform';

interface SidebarPageNavProps {
  readonly ariaLabel: string;
  readonly sidebarTestId: string;
  readonly backTestId: string;
  readonly resizeHandleTestId: string;
  readonly scrollViewportTestId: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
  readonly width?: number;
  readonly onResize?: (widthPx: number) => void;
  readonly backButtonRef?: Ref<HTMLButtonElement>;
}

/**
 * Desktop adapter for the shared page navigation used by secondary app pages
 * such as Settings. It supplies the app sidebar material, window drag strip,
 * default width, and resize edge; the shell itself lives in
 * `@canopy/ui-app/sidebar`.
 */
export function SidebarPageNav({
  ariaLabel,
  sidebarTestId,
  backTestId,
  resizeHandleTestId,
  scrollViewportTestId,
  onBack,
  children,
  width = SIDEBAR_DEFAULT_WIDTH,
  onResize,
  backButtonRef,
}: SidebarPageNavProps): JSX.Element {
  return (
    <SharedSidebarPageNav
      ariaLabel={ariaLabel}
      sidebarTestId={sidebarTestId}
      backTestId={backTestId}
      scrollViewportTestId={scrollViewportTestId}
      onBack={onBack}
      backButtonRef={backButtonRef}
      width={width}
      surface="app-material"
      controlsInDragRegion
      topInset={
        usesNativeWindowFrame(localPlatform()) ? undefined : (
          <div className="electron-drag h-10 shrink-0" />
        )
      }
      trailing={
        onResize ? (
          <SidebarResizeHandle
            onResize={onResize}
            width={width}
            testId={resizeHandleTestId}
          />
        ) : undefined
      }
    >
      {children}
    </SharedSidebarPageNav>
  );
}
