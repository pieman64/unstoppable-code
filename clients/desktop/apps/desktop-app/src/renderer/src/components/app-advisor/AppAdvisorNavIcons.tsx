/**
 * Shared glyphs for the App Advisor nav controls. The controls render in two
 * homes depending on collapse state — the expanded {@link AppAdvisorNav}
 * header, or the collapsed titlebar corner inside {@link AppAdvisorTopBar} —
 * so their icons live here to keep both renderings identical.
 *
 * All three come from AppIcons (review ask): the sidebar toggle is the
 * SAME glyph the main window's `SidebarToggleButton` uses, and the gear is
 * the same one Settings surfaces use, so the advisor's chrome no longer
 * carries hand-rolled lookalikes that drift from the app's icon family.
 */
import type { JSX } from 'react';
import {
  PlusMediumIcon,
  SettingsIcon,
  SidebarHiddenLeftWideIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Same panel-left glyph as the main window's sidebar toggle, in both states —
 * the previous hand-rolled version added an inner chevron while expanded,
 * which the main toggle does not do.
 */
export function SidebarPanelToggleIcon(): JSX.Element {
  return <SidebarHiddenLeftWideIcon size={16} aria-hidden="true" />;
}

export function SettingsGearIcon(): JSX.Element {
  return <SettingsIcon size={14} aria-hidden="true" />;
}

export function PlusIcon(): JSX.Element {
  return <PlusMediumIcon size={14} aria-hidden="true" />;
}
