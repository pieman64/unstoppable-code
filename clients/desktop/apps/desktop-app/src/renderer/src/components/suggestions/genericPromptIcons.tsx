import type { JSX } from 'react';
import {
  BugReportIcon,
  CodeMediumIcon,
  DataUsageIcon,
  DocumentPencilIcon,
  ExperimentIcon,
  FileText,
  GitCommitIcon,
  KanbanIcon,
  Mail,
  SearchIcon,
  ThinkingIcon,
  type AppIcon,
  WrenchIcon,
} from '@canopy/ui-shared/icons/AppIcons';

const ICON_SIZE = 16;

function promptIcon(Icon: AppIcon): JSX.Element {
  return (
    <Icon
      size={ICON_SIZE}
      className="shrink-0 fg-tertiary"
      aria-hidden="true"
    />
  );
}

/** App icon glyph per generic fallback prompt id (for tests and reuse). */
export const GENERIC_PROMPT_ICON_GLYPHS: Readonly<Record<string, AppIcon>> = {
  'generic-1': WrenchIcon,
  'generic-2': BugReportIcon,
  'generic-3': GitCommitIcon,
  'generic-4': ExperimentIcon,
  'generic-5': FileText,
  'generic-home-1': SearchIcon,
  'generic-home-2': KanbanIcon,
  'generic-home-3': DocumentPencilIcon,
  'generic-home-4': Mail,
  // Deliberately not BugReportIcon: that glyph signals debugging on a
  // non-technical spreadsheet prompt in the zero-setup Home surface.
  'generic-home-5': DataUsageIcon,
  'generic-home-6': CodeMediumIcon,
};

export const DEFAULT_GENERIC_PROMPT_ICON_GLYPH: AppIcon = ThinkingIcon;

export const GENERIC_PROMPT_ICONS: Readonly<Record<string, JSX.Element>> =
  Object.fromEntries(
    Object.entries(GENERIC_PROMPT_ICON_GLYPHS).map(([id, Icon]) => [
      id,
      promptIcon(Icon),
    ]),
  );

export const DEFAULT_GENERIC_PROMPT_ICON: JSX.Element = promptIcon(
  DEFAULT_GENERIC_PROMPT_ICON_GLYPH,
);
