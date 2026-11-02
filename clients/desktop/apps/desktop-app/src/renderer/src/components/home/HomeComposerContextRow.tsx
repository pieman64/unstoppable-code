import type { JSX, ReactNode } from 'react';
import { ComposerDrawerSection } from '@canopy/ui-shared/components';

interface HomeComposerContextRowProps {
  visible: boolean;
  children: ReactNode;
}

/**
 * Early access: the pickers stay on one line. The project picker is the one
 * that gives way, truncating its name, so the worktree and branch pickers
 * keep their labels. The 13rem cap sits on the picker itself: a cap only on
 * its trigger let the picker keep the full name's width, leaving an empty gap
 * after the truncated name. The trigger then fills the picker and no more.
 */
const SINGLE_LINE_ROW_CLASS_NAME =
  "flex flex-nowrap min-w-0 items-center gap-0 *:shrink-0 [&>[data-testid='home-workspace-picker']]:min-w-0 [&>[data-testid='home-workspace-picker']]:max-w-52 [&>[data-testid='home-workspace-picker']]:shrink [&_[data-testid='home-workspace-select']]:max-w-full";

/** Context pickers for the Home composer; spacing lives on its drawer. */
export function HomeComposerContextRow({
  visible,
  children,
}: HomeComposerContextRowProps): JSX.Element | null {
  if (!visible) return null;

  return (
    // The 4px inset around the pickers is the drawer's (`ComposerDrawer`).
    <ComposerDrawerSection>
      <div
        data-testid="home-composer-context"
        className={SINGLE_LINE_ROW_CLASS_NAME}
      >
        {children}
      </div>
    </ComposerDrawerSection>
  );
}
