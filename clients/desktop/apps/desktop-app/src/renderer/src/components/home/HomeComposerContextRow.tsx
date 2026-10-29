import type { JSX, ReactNode } from 'react';

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

/** Context pickers for the Home composer; spacing lives on the depth overhang. */
export function HomeComposerContextRow({
  visible,
  children,
}: HomeComposerContextRowProps): JSX.Element | null {
  if (!visible) return null;

  return (
    <div
      data-testid="home-composer-context"
      // Bottom gap under the pickers is owned by the grey overhang (`p-1` /
      // `pb-5`): 4px visible inset after the `-mb-4` tuck under the composer.
      className={SINGLE_LINE_ROW_CLASS_NAME}
    >
      {children}
    </div>
  );
}
