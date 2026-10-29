'use client';

import {
  useId,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import { ActionMenuRowStyle } from './ActionMenuItems';
import { FloatingMenu } from './FloatingMenu';
import { SidebarNavRow } from './SidebarNavRow';
import {
  SIDEBAR_LIST_ICON_CLASSNAME,
  sidebarNavIconItemClassName,
} from './sidebar-item-classes';
import { Tooltip } from './Tooltip';

export interface SidebarMoreControlProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly children: ReactNode;
  readonly triggerTestId: string;
  readonly menuTestId: string;
  readonly onboardingAnchor?: string;
  readonly compact?: boolean;
  readonly touchTarget?: 'coarse' | 'always' | 'none';
  readonly menuSize?: 'sidebar' | 'content';
  /** A landmark only where the control is a distinct navigation region. */
  readonly landmarkLabel?: string;
}

/** Shared trigger and focus lifecycle; destinations remain owned by the caller. */
export function SidebarMoreControl({
  open,
  onOpenChange,
  triggerRef,
  children,
  triggerTestId,
  menuTestId,
  onboardingAnchor,
  compact = false,
  touchTarget = 'coarse',
  menuSize = 'content',
  landmarkLabel,
}: SidebarMoreControlProps): JSX.Element {
  const menuId = useId();
  const triggerProps = {
    ref: triggerRef,
    onClick: (): void => onOpenChange(!open),
    'data-testid': triggerTestId,
    'data-onboarding-anchor': onboardingAnchor,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  } satisfies ButtonHTMLAttributes<HTMLButtonElement> & {
    ref: RefObject<HTMLButtonElement | null>;
    'data-testid': string;
    'data-onboarding-anchor': string | undefined;
  };
  const control = (
    <>
      {compact ? (
        <Tooltip label="More">
          <button
            {...triggerProps}
            type="button"
            aria-label="More"
            className={sidebarNavIconItemClassName(false)}
          >
            <span className={`${SIDEBAR_LIST_ICON_CLASSNAME} fg-secondary`}>
              <MoreHorizontalIcon size={16} />
            </span>
          </button>
        </Tooltip>
      ) : (
        <SidebarNavRow
          {...triggerProps}
          icon={<MoreHorizontalIcon size={16} />}
          touchTarget={touchTarget}
        >
          More
        </SidebarNavRow>
      )}
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={triggerRef}
        placement="bottom-left"
        aria-label="More"
        data-testid={menuTestId}
        className={menuSize === 'sidebar' ? 'w-56' : 'min-w-48'}
      >
        {/* The destinations take the action-menu rows (small text, tertiary
            icons), like every other row menu. */}
        <ActionMenuRowStyle>{children}</ActionMenuRowStyle>
      </FloatingMenu>
    </>
  );
  return landmarkLabel ? (
    <nav aria-label={landmarkLabel} className="relative">
      {control}
    </nav>
  ) : (
    <div className="relative">{control}</div>
  );
}
