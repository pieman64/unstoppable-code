import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ActionMenuRowStyle,
  Button,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuSurface,
} from '@canopy/ui-shared';
import {
  ChatIcon,
  CheckIcon,
  CopyIcon,
  PipelineIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  ChevronDownMediumIcon,
  SearchIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useClipboardCopy } from '../../hooks/useClipboardCopy';
import { Tooltip } from '@canopy/ui-shared';

const EXECUTE_MENU_WIDTH = 160;
const EXECUTE_MENU_GAP = 4;
const VIEWPORT_PADDING = 8;
/**
 * Below this control-row width the labelled Explore/Share buttons stop fitting
 * alongside the Execute dropdown, so they collapse to icon-only. The Execute
 * dropdown keeps its label at all sizes. Extremely narrow rows wrap instead of
 * overflowing (see `flex-wrap` on the wrapper).
 */
const COMPACT_WIDTH = 248;

interface MenuPosition {
  top: number;
  left: number;
}

export interface PlanActionControlsProps {
  onExplore: () => void;
  onImplement: () => void;
  onPipeline: () => void;
  /** Plan markdown used for the Copy action. */
  planContent: string;
  /** Disable Explore when no plan id is available yet. */
  exploreDisabled?: boolean;
  /** Hide the Explore button entirely (e.g. when already inside Explore). */
  showExplore?: boolean;
  /**
   * Open the share flow. When provided, a Share button renders before the
   * Execute control. The caller owns the label/disabled/busy state machine.
   */
  onShare?: () => void;
  /** Visible label for the Share button (e.g. `Share`, `Shared`, `Retry share`). */
  shareLabel?: string;
  /** Tooltip for the Share button (e.g. why it is disabled). */
  shareTitle?: string;
  /** Disable the Share button (e.g. while viewing an old revision). */
  shareDisabled?: boolean;
  /** Reflect an in-flight share so the button cannot be re-triggered. */
  shareBusy?: boolean;
  /** Disable execution choices after a plan has already been acted on. */
  executeDisabled?: boolean;
  /** Render the dropdown in document.body for controls inside overflow containers. */
  menuPortal?: boolean;
  implementLabel?: string;
  dataTestIdPrefix: string;
}

export function PlanActionControls({
  onExplore,
  onImplement,
  onPipeline,
  planContent,
  exploreDisabled = false,
  showExplore = true,
  onShare,
  shareLabel = 'Share',
  shareTitle,
  shareDisabled = false,
  shareBusy = false,
  executeDisabled = false,
  menuPortal = false,
  implementLabel = 'Implement',
  dataTestIdPrefix,
}: PlanActionControlsProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const positionFrameRef = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [compact, setCompact] = useState(false);
  const { copied, copy } = useClipboardCopy();

  // Collapse Explore/Share to icon-only when the available row width narrows.
  // We measure the parent, not the wrapper itself: the wrapper is a shrink-to-fit
  // flex item, so measuring it would latch to compact once the buttons collapse
  // (smaller content -> smaller wrapper -> stays compact). The parent fills the
  // available width independent of how the buttons render.
  useLayoutEffect(() => {
    const target = wrapperRef.current?.parentElement;
    if (!target || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries): void => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') {
        setCompact(width < COMPACT_WIDTH);
      }
    });
    observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  const updateMenuPosition = useCallback((): void => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      setMenuPosition(null);
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const maxLeft = window.innerWidth - EXECUTE_MENU_WIDTH - VIEWPORT_PADDING;
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(rect.right - EXECUTE_MENU_WIDTH, maxLeft),
    );
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const belowTop = rect.bottom + EXECUTE_MENU_GAP;
    const aboveTop = rect.top - EXECUTE_MENU_GAP - menuHeight;
    const top =
      menuHeight > 0 &&
      belowTop + menuHeight > window.innerHeight - VIEWPORT_PADDING &&
      aboveTop >= VIEWPORT_PADDING
        ? aboveTop
        : belowTop;

    setMenuPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen || !menuPortal) {
      setMenuPosition(null);
      return;
    }

    updateMenuPosition();
  }, [menuOpen, menuPortal, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen || !menuPortal) {
      return;
    }

    const scheduleMenuPositionUpdate = (): void => {
      if (positionFrameRef.current !== null) {
        return;
      }

      positionFrameRef.current = window.requestAnimationFrame((): void => {
        positionFrameRef.current = null;
        updateMenuPosition();
      });
    };

    window.addEventListener('resize', scheduleMenuPositionUpdate);
    window.addEventListener('scroll', scheduleMenuPositionUpdate, {
      capture: true,
      passive: true,
    });
    return (): void => {
      window.removeEventListener('resize', scheduleMenuPositionUpdate);
      window.removeEventListener('scroll', scheduleMenuPositionUpdate, {
        capture: true,
      });
      if (positionFrameRef.current !== null) {
        window.cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = null;
      }
    };
  }, [menuOpen, menuPortal, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleMouseDown = (e: MouseEvent): void => {
      const wrapper = wrapperRef.current;
      const menu = menuRef.current;
      if (
        e.target instanceof Node &&
        ((wrapper && wrapper.contains(e.target)) ||
          (menu && menu.contains(e.target)))
      ) {
        return;
      }
      setMenuOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return (): void => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const handleExplore = useCallback((): void => {
    if (exploreDisabled) {
      return;
    }
    onExplore();
  }, [exploreDisabled, onExplore]);

  const handleToggleMenu = useCallback((): void => {
    setMenuOpen((open) => !open);
  }, []);

  const handlePipeline = useCallback((): void => {
    if (executeDisabled) {
      return;
    }
    onPipeline();
    setMenuOpen(false);
  }, [executeDisabled, onPipeline]);

  const handleImplement = useCallback((): void => {
    if (executeDisabled) {
      return;
    }
    onImplement();
    setMenuOpen(false);
  }, [executeDisabled, onImplement]);

  const handleCopy = useCallback((): void => {
    void copy(planContent);
  }, [copy, planContent]);

  const handleShare = useCallback((): void => {
    if (shareDisabled || shareBusy) {
      return;
    }
    onShare?.();
  }, [onShare, shareBusy, shareDisabled]);

  const menuStyle: CSSProperties | undefined = menuPortal
    ? {
        position: 'fixed',
        width: EXECUTE_MENU_WIDTH,
        ...(menuPosition
          ? { top: menuPosition.top, left: menuPosition.left }
          : { visibility: 'hidden', top: 0, left: 0 }),
      }
    : undefined;

  const executeMenu = (
    <DropdownMenuSurface
      ref={menuRef}
      className={`z-dropdown min-w-40 ${
        menuPortal ? '' : 'absolute right-0 top-full mt-1'
      }`}
      style={menuStyle}
    >
      <ActionMenuRowStyle>
        <DropdownMenuItem
          onClick={handlePipeline}
          disabled={executeDisabled}
          data-testid={`${dataTestIdPrefix}-execute-pipeline`}
        >
          <DropdownMenuItemIcon>
            <PipelineIcon />
          </DropdownMenuItemIcon>
          Pipeline
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleImplement}
          disabled={executeDisabled}
          data-testid={`${dataTestIdPrefix}-execute-implement`}
        >
          <DropdownMenuItemIcon>
            <ChatIcon />
          </DropdownMenuItemIcon>
          {implementLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={handleCopy}
          data-testid={`${dataTestIdPrefix}-execute-copy`}
        >
          <DropdownMenuItemIcon>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </DropdownMenuItemIcon>
          {copied ? 'Copied' : 'Copy'}
        </DropdownMenuItem>
      </ActionMenuRowStyle>
    </DropdownMenuSurface>
  );

  return (
    <div
      ref={wrapperRef}
      className="relative flex flex-wrap items-center gap-2"
    >
      {/* The app's shared buttons, in the 28px control size: Explore and
          Share on the secondary surface, Execute as the primary action
          (secondary while the plan cannot run). */}
      {showExplore && (
        <Tooltip label="Explore" suppressed={!compact}>
          {compact ? (
            <Button
              size="control"
              variant="secondary"
              iconOnly
              aria-label="Explore"
              onClick={handleExplore}
              disabled={exploreDisabled}
              data-testid={`${dataTestIdPrefix}-explore`}
            >
              <SearchIcon width={16} height={16} />
            </Button>
          ) : (
            <Button
              size="control"
              variant="secondary"
              onClick={handleExplore}
              disabled={exploreDisabled}
              data-testid={`${dataTestIdPrefix}-explore`}
            >
              <SearchIcon width={16} height={16} />
              Explore
            </Button>
          )}
        </Tooltip>
      )}

      {onShare && (
        <Tooltip
          label={shareTitle ?? (compact ? shareLabel : undefined)}
          suppressed={shareTitle === undefined && !compact}
        >
          {compact ? (
            <Button
              size="control"
              variant="secondary"
              iconOnly
              aria-label={shareLabel}
              onClick={handleShare}
              disabled={shareDisabled || shareBusy}
              aria-busy={shareBusy}
              data-testid={`${dataTestIdPrefix}-share`}
            >
              <ShareIcon width={16} height={16} />
            </Button>
          ) : (
            <Button
              size="control"
              variant="secondary"
              onClick={handleShare}
              disabled={shareDisabled || shareBusy}
              aria-label={shareLabel}
              aria-busy={shareBusy}
              data-testid={`${dataTestIdPrefix}-share`}
            >
              <ShareIcon width={16} height={16} />
              {shareLabel}
            </Button>
          )}
        </Tooltip>
      )}

      <Button
        size="control"
        variant={executeDisabled ? 'secondary' : 'primary'}
        onClick={handleToggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid={`${dataTestIdPrefix}-execute`}
      >
        Execute
        <ChevronDownMediumIcon
          width={16}
          height={16}
          aria-hidden
          className={`shrink-0 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
        />
      </Button>

      {menuOpen &&
        (menuPortal ? createPortal(executeMenu, document.body) : executeMenu)}
    </div>
  );
}
