import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  type AnchoredMenuPosition,
  useAnchoredMenuPosition,
} from './useAnchoredMenuPosition';
import { useCloseOnOutsideMouseDown } from './useCloseOnOutsideMouseDown';

export function useAnchoredMenu(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  menuWidth: number,
): AnchoredMenuPosition | null {
  const position = useAnchoredMenuPosition(open, anchorRef, menuRef, menuWidth);
  const closeMenu = useCallback((): void => setOpen(false), [setOpen]);

  useCloseOnOutsideMouseDown(open, anchorRef, menuRef, closeMenu);

  return position;
}
