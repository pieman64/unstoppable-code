import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useCloseOnOutsideMouseDown } from '@/hooks/useCloseOnOutsideMouseDown';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { GlobeIcon } from '@canopy/ui-shared/icons';
import { DropdownMenuSurface } from '@canopy/ui-shared';
import { ActionMenuRowStyle, Button } from '@canopy/ui-shared/components';
import { DevServerMenuItem } from './DevServerMenuItem';
import {
  getDevServerOpenAriaLabel,
  getDevServerOpenButtonText,
  openDevServerHit,
  type DevServerOpenContext,
} from './devServerOpen';

interface DevServerOpenControlProps {
  hits: DevServerHit[];
  /** Worktree context used to route `in-app` opens to the Browser tab. */
  context: DevServerOpenContext;
}

/**
 * "Open dev server URL" affordance rendered inside the live script ribbon and
 * the enlarged run modal. A single hit renders as a direct button; two or
 * more hits render as an `Open (N)` trigger that opens a small menu of
 * deduped URLs.
 *
 * Only hits already validated by detection (http/https) are rendered, but
 * each open click defensively re-checks the protocol; non-http(s) URLs are
 * ignored.
 */
export function DevServerOpenControl({
  hits,
  context,
}: DevServerOpenControlProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((): void => {
    setMenuOpen(false);
  }, []);

  useCloseOnOutsideMouseDown(menuOpen, triggerRef, menuRef, close);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [menuOpen, close]);

  if (hits.length === 0) {
    return <></>;
  }

  if (hits.length === 1) {
    const [hit] = hits;
    return (
      <Button
        variant="ghost-accent"
        size="compact"
        onClick={(): void => openDevServerHit(hit, context)}
        aria-label={getDevServerOpenAriaLabel(hit)}
      >
        <GlobeIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {getDevServerOpenButtonText(hit)}
      </Button>
    );
  }

  return (
    <div className="relative inline-flex">
      <Button
        ref={triggerRef}
        variant="ghost-accent"
        size="compact"
        onClick={(): void => setMenuOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
      >
        <GlobeIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Open ({hits.length})
      </Button>
      {menuOpen && (
        <DropdownMenuSurface
          ref={menuRef}
          id={menuId}
          className="absolute right-0 top-full z-10 mt-1 min-w-48 max-w-96"
        >
          <ActionMenuRowStyle>
            {hits.map((hit, index) => (
              <DevServerMenuItem
                key={hit.url}
                hit={hit}
                context={context}
                icon={
                  index === 0 ? (
                    <GlobeIcon className="h-4 w-4" aria-hidden="true" />
                  ) : null
                }
                onSelect={close}
              />
            ))}
          </ActionMenuRowStyle>
        </DropdownMenuSurface>
      )}
    </div>
  );
}
