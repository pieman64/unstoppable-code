import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { useCloseOnOutsideMouseDown } from '@/hooks/useCloseOnOutsideMouseDown';
import { useWindowPositionInvalidation } from '@/hooks/useWindowPositionInvalidation';
import { ChevronIcon, GlobeIcon } from '@canopy/ui-shared/icons';
import {
  DropdownMenuDivider,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from '@canopy/ui-shared';
import {
  ActionMenuRowStyle,
  HeaderActionButton,
} from '@canopy/ui-shared/components';
import { DevServerMenuItem } from './DevServerMenuItem';
import {
  getDevServerOpenAriaLabel,
  getDevServerOpenButtonText,
  openDevServerHit,
  type DevServerOpenContext,
} from './devServerOpen';
import { Tooltip } from '@canopy/ui-shared';

const MENU_WIDTH = 280;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;

interface MenuPosition {
  top: number;
  left: number;
}

function computeBelowPosition(
  anchorEl: HTMLElement,
  menuWidth: number,
): MenuPosition {
  const rect = anchorEl.getBoundingClientRect();
  const top = rect.bottom + MENU_GAP;
  const maxLeft = Math.max(
    VIEWPORT_PADDING,
    window.innerWidth - menuWidth - VIEWPORT_PADDING,
  );
  const left = Math.min(Math.max(VIEWPORT_PADDING, rect.left), maxLeft);
  return { top, left };
}

export interface ActivityOpenSection {
  scriptKey: string;
  scriptLabel: string;
  /**
   * Optional repo / workspace-root tag rendered above the script label in
   * the dropdown header. Populated only for multi-repo workspaces so single
   * repo headers stay uncluttered.
   */
  repoContext?: string;
  hits: DevServerHit[];
}

interface ActivityOpenControlProps {
  sections: ActivityOpenSection[];
  /** Worktree context used to route `in-app` opens to the Browser tab. */
  context: DevServerOpenContext;
  variant?: 'header' | 'collapsed';
}

export function ActivityOpenControl({
  sections,
  context,
  variant = 'header',
}: ActivityOpenControlProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const totalHits = useMemo(
    () => sections.reduce((sum, section) => sum + section.hits.length, 0),
    [sections],
  );

  const singleHit = useMemo((): DevServerHit | null => {
    if (totalHits !== 1) return null;
    for (const section of sections) {
      if (section.hits.length > 0) {
        return section.hits[0];
      }
    }
    return null;
  }, [sections, totalHits]);

  const [position, setPosition] = useState<MenuPosition | null>(null);
  const updatePosition = useCallback((): void => {
    const anchorEl = triggerRef.current;
    if (!anchorEl) return;
    const next = computeBelowPosition(anchorEl, MENU_WIDTH);
    setPosition((prev) => {
      if (prev && prev.top === next.top && prev.left === next.left) return prev;
      return next;
    });
  }, []);

  useLayoutEffect((): void => {
    if (!menuOpen) return;
    updatePosition();
  }, [menuOpen, updatePosition]);

  useWindowPositionInvalidation(menuOpen, updatePosition);

  const closeMenu = useCallback((): void => setMenuOpen(false), []);
  useCloseOnOutsideMouseDown(menuOpen, triggerRef, menuRef, closeMenu);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [menuOpen]);

  if (totalHits === 0) {
    return <></>;
  }

  // The header's accent action, like the Create PR button it sits beside.
  const triggerClass = variant === 'collapsed' ? 'w-full' : undefined;

  const globeSizeClass = variant === 'collapsed' ? 'h-3 w-3' : 'h-4 w-4';

  if (singleHit) {
    return (
      <Tooltip label={singleHit.url}>
        <HeaderActionButton
          tone="accent"
          onClick={(): void => openDevServerHit(singleHit, context)}
          aria-label={getDevServerOpenAriaLabel(singleHit)}
          className={triggerClass}
        >
          <GlobeIcon className={globeSizeClass} aria-hidden="true" />
          {getDevServerOpenButtonText(singleHit)}
        </HeaderActionButton>
      </Tooltip>
    );
  }

  const showSectionHeaders = sections.length > 1;

  return (
    <div className={variant === 'collapsed' ? 'w-full' : 'inline-flex'}>
      <HeaderActionButton
        ref={triggerRef}
        tone="accent"
        onClick={(): void => setMenuOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        className={triggerClass}
      >
        <GlobeIcon className={globeSizeClass} aria-hidden="true" />
        <span>Open</span>
        <ChevronIcon open={menuOpen} />
      </HeaderActionButton>
      {menuOpen &&
        createPortal(
          <DropdownMenuSurface
            ref={menuRef}
            id={menuId}
            style={{
              position: 'fixed',
              zIndex: 'var(--z-index-dropdown)',
              width: MENU_WIDTH,
              ...(position
                ? { top: position.top, left: position.left }
                : { visibility: 'hidden' }),
            }}
          >
            <ActionMenuRowStyle>
              {sections.map((section, sectionIndex) => (
                <Fragment key={`${section.scriptKey}-${sectionIndex}`}>
                  {showSectionHeaders && sectionIndex > 0 && (
                    <DropdownMenuDivider />
                  )}
                  {showSectionHeaders && (
                    <DropdownMenuLabel>
                      {section.repoContext && (
                        <span className="block truncate">
                          {section.repoContext}
                        </span>
                      )}
                      <span className="block truncate">
                        {section.scriptLabel}
                      </span>
                    </DropdownMenuLabel>
                  )}
                  {/* Every row opens a dev server: one icon per section,
                      shown on its first row. */}
                  {section.hits.map((hit, hitIndex) => (
                    <DevServerMenuItem
                      key={`${section.scriptKey}-${hit.url}`}
                      hit={hit}
                      context={context}
                      icon={
                        hitIndex === 0 ? (
                          <GlobeIcon className="h-4 w-4" aria-hidden="true" />
                        ) : null
                      }
                      onSelect={closeMenu}
                    />
                  ))}
                </Fragment>
              ))}
            </ActionMenuRowStyle>
          </DropdownMenuSurface>,
          document.body,
        )}
    </div>
  );
}
