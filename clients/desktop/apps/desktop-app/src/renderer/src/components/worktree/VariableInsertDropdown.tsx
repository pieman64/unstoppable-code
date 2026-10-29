import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import { DropdownMenuSurface } from '@canopy/ui-shared';
import { Tooltip } from '@canopy/ui-shared';
import { ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

interface VariableInsertDropdownItem {
  name: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface VariableInsertDropdownProps {
  variables: VariableInsertDropdownItem[];
  onInsert: (variableName: string) => void;
  ownerDocument?: Document;
}

export function VariableInsertDropdown({
  variables,
  onInsert,
  ownerDocument,
}: VariableInsertDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndexOnOpenRef = useRef<number | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const closeMenu = (): void => {
    setOpen(false);
    focusIndexOnOpenRef.current = null;
  };

  const focusItem = (index: number): void => {
    if (variables.length === 0) {
      return;
    }

    const normalizedIndex =
      ((index % variables.length) + variables.length) % variables.length;
    setActiveIndex(normalizedIndex);
    itemRefs.current[normalizedIndex]?.focus();
  };

  const openMenu = (indexToFocus?: number): void => {
    if (variables.length === 0) {
      return;
    }

    const nextIndex = indexToFocus ?? 0;
    setActiveIndex(nextIndex);
    focusIndexOnOpenRef.current = nextIndex;
    setOpen(true);
  };

  useEffect((): (() => void) | undefined => {
    if (!open) {
      return undefined;
    }

    const positionMenu = (): void => {
      const btn = buttonRef.current;
      if (!btn) {
        return;
      }

      const rect = btn.getBoundingClientRect();
      setMenuStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };

    positionMenu();
    if (focusIndexOnOpenRef.current !== null) {
      requestAnimationFrame(() => {
        const indexToFocus = focusIndexOnOpenRef.current;
        if (indexToFocus === null) {
          return;
        }
        itemRefs.current[indexToFocus]?.focus();
        focusIndexOnOpenRef.current = null;
      });
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    };

    const menuDocument =
      ownerDocument ?? buttonRef.current?.ownerDocument ?? document;
    const menuWindow = menuDocument.defaultView ?? window;
    menuDocument.addEventListener('mousedown', handleClickOutside);
    menuWindow.addEventListener('resize', positionMenu);
    menuWindow.addEventListener('scroll', positionMenu, true);
    return (): void => {
      menuDocument.removeEventListener('mousedown', handleClickOutside);
      menuWindow.removeEventListener('resize', positionMenu);
      menuWindow.removeEventListener('scroll', positionMenu, true);
    };
  }, [open, ownerDocument, variables.length]);

  return (
    <div>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu(0);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(variables.length - 1);
          }
        }}
        className="focus-ring flex w-full items-center justify-between gap-3 rounded-lg border bg-card/30 px-3 py-2 text-left text-xs font-medium fg-primary hover:bg-accent-subtle/30"
      >
        <span>Insert variable</span>
        <AppCatalogChevronDownMediumIcon
          width="12"
          height="12"
          className={`fg-secondary transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <DropdownMenuSurface
            id={menuId}
            ref={menuRef}
            style={menuStyle}
            aria-label="Available variables"
            className="z-dropdown max-h-64 overflow-y-auto"
          >
            {variables.map((variable, index) => (
              <Tooltip
                key={variable.name}
                label={variable.disabledReason}
                disabled={!variable.disabled}
                className="w-full"
              >
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role="menuitem"
                  aria-disabled={variable.disabled ? true : undefined}
                  onFocus={() => setActiveIndex(index)}
                  onClick={(event) => {
                    if (variable.disabled) {
                      event.preventDefault();
                      return;
                    }
                    onInsert(variable.name);
                    closeMenu();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      focusItem(index + 1);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      focusItem(index - 1);
                      return;
                    }
                    if (event.key === 'Home') {
                      event.preventDefault();
                      focusItem(0);
                      return;
                    }
                    if (event.key === 'End') {
                      event.preventDefault();
                      focusItem(variables.length - 1);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeMenu();
                      buttonRef.current?.focus();
                    }
                  }}
                  className={`focus-ring block w-full rounded-md px-3 py-2 text-left hover:bg-accent-subtle/40 ${
                    activeIndex === index ? 'bg-accent-subtle/40' : ''
                  } ${variable.disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : ''}`}
                >
                  <span className="block font-mono text-xs fg-primary">
                    {variable.name}
                  </span>
                  <span className="mt-0.5 block text-2xs fg-secondary">
                    {variable.description}
                  </span>
                </button>
              </Tooltip>
            ))}
          </DropdownMenuSurface>,
          (ownerDocument ?? buttonRef.current?.ownerDocument ?? document).body,
        )}
    </div>
  );
}
