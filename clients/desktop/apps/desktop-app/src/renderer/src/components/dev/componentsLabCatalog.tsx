import type { JSX } from 'react';
import { AvatarsSpecimen } from './componentsLabAvatars';
import { ButtonsSpecimen, ListRowSpecimen } from './componentsLabButtons';
import { ChipSection, ContextSection } from './MarkersLabPage';
import {
  FailureSpecimen,
  NoticeSpecimen,
  ToastSpecimen,
} from './componentsLabFeedback';
import { IconScaleSpecimen } from './componentsLabIcons';
import {
  DialogsSpecimen,
  FieldsSpecimen,
  MarkersSpecimen,
} from './componentsLabGroups';
import {
  FactsSpecimen,
  ReferenceChipsSpecimen,
  SpacingSpecimen,
  TooltipSpecimen,
} from './componentsLabLayout';
import { LoadingSpecimen } from './componentsLabLoading';
import { TablesSpecimen } from './componentsLabTables';
import { PendingSpecimen } from './componentsLabPending';
import { ProgressSpecimen } from './componentsLabProgress';
import { SegmentedControlSpecimen, TabBarSpecimen } from './componentsLabTabs';
import {
  ButtonStage,
  ChipStage,
  FieldsStage,
  ListRowStage,
  MarkersStage,
  SegmentedControlStage,
  TabBarStage,
} from './componentsLabStagesControls';
import {
  DialogStage,
  FactsStage,
  FailureStage,
  LoadingStage,
  NoticeStage,
  ReferenceChipsStage,
  ToastStage,
  TooltipStage,
} from './componentsLabStagesFeedback';

export const COMPONENTS_LAB_GROUPS = ['Unified', 'Not unified yet'] as const;
export type ComponentsLabGroup = (typeof COMPONENTS_LAB_GROUPS)[number];

export interface ComponentsLabEntry {
  readonly id: string;
  readonly name: string;
  readonly group: ComponentsLabGroup;
  /** One sentence: what it is for and the rule it carries. */
  readonly note: string;
  /** Where the shared component lives. */
  readonly source: string;
  /** The pull requests that unified it. */
  readonly prs: readonly number[];
  /**
   * A stageshow stage: the component in a believable Canopy window with a
   * short cursor story, above the exhaustive specimen sheet.
   */
  readonly Stage?: () => JSX.Element;
  readonly View: () => JSX.Element;
}

export const COMPONENTS_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'button',
    name: 'Button',
    group: 'Unified',
    note: 'Every action is a capsule Button; links inside a sentence use variant="link". The stage shows hover, press, busy and done.',
    source: 'packages/ui-shared/src/components/Button.tsx',
    prs: [7044, 7062, 7066, 7067, 7068, 7070, 7071, 7076, 7198],
    Stage: ButtonStage,
    View: ButtonsSpecimen,
  },
  {
    id: 'list-row',
    name: 'ListRow',
    group: 'Unified',
    note: 'One full-width clickable row for every list: the sidebar row geometry, a 16px icon slot and quiet trailing text.',
    source: 'packages/ui-shared/src/components/ListRow.tsx',
    prs: [7076],
    Stage: ListRowStage,
    View: ListRowSpecimen,
  },
  {
    id: 'markers',
    name: 'Markers',
    group: 'Unified',
    note: 'Badge (regular and compact), Count, Dot (including connection dots) and StatusGlyph: every status and count uses these.',
    source:
      'packages/ui-shared/src/components/{Badge,Count,Dot,StatusGlyph}.tsx',
    prs: [7209],
    Stage: MarkersStage,
    View: MarkersSpecimen,
  },
  {
    id: 'chip',
    name: 'Chip',
    group: 'Unified',
    note: 'A removable or clickable token; every look is forced so hover and press show side by side.',
    source: 'packages/ui-shared/src/components/Chip.tsx',
    prs: [7209],
    Stage: ChipStage,
    View: ChipSection,
  },
  {
    id: 'markers-in-context',
    name: 'Markers in context',
    group: 'Unified',
    note: 'The markers placed in the rows and headers they ship in.',
    source:
      'apps/desktop-app/src/renderer/src/components/dev/MarkersLabPage.tsx',
    prs: [7209],
    View: ContextSection,
  },
  {
    id: 'tab-bar',
    name: 'TabBar',
    group: 'Unified',
    note: 'One tab list for page, dialog and panel tabs: default or compact density, an optional count, a destructive tone and a vertical rail.',
    source: 'packages/ui-shared/src/components/TabBar.tsx',
    prs: [7213],
    Stage: TabBarStage,
    View: TabBarSpecimen,
  },
  {
    id: 'segmented-control',
    name: 'SegmentedControl',
    group: 'Unified',
    note: 'The one segmented picker for Settings and popovers: a bg-depth track with a sliding secondary surface, rounded or capsule.',
    source: 'packages/ui-shared/src/components/SegmentedControl.tsx',
    prs: [],
    Stage: SegmentedControlStage,
    View: SegmentedControlSpecimen,
  },
  {
    id: 'fields',
    name: 'Form fields',
    group: 'Unified',
    note: 'TextInput, TextArea, Select, SettingsSelect, SearchField, InlineTextInput, form fields, Checkbox, Radio, ChoiceList and ToggleSwitch, with every state.',
    source:
      'packages/ui-shared/src/components/{Field,FormField,InlineTextInput,Choice}.tsx',
    prs: [7214, 7219, 7220, 7221, 7222, 7223, 7224, 7255, 7257],
    Stage: FieldsStage,
    View: FieldsSpecimen,
  },
  {
    id: 'icon-scale',
    name: 'Icon scale',
    group: 'Unified',
    note: 'Six named steps on every AppIcons icon; an icon with no size is sm. Never a number, width/height or a size class.',
    source: 'packages/ui-shared/src/icons/icon-size.ts',
    prs: [7236],
    View: IconScaleSpecimen,
  },
  {
    id: 'reference-chips',
    name: 'Reference chips',
    group: 'Unified',
    note: 'ID-only references in chat: an accent chip when it opens something, grey for code and paths; sized in em so it follows the copy.',
    source: 'packages/ui-shared/src/components/InlineMention.tsx',
    prs: [7116],
    Stage: ReferenceChipsStage,
    View: ReferenceChipsSpecimen,
  },
  {
    id: 'notice',
    name: 'Notice',
    group: 'Unified',
    note: 'A state to know about while working: four intents that tint only the icon, trailing or below actions with the primary last, and the composer, settings and toast shapes.',
    source: 'packages/ui-shared/src/components/Notice.tsx',
    prs: [7218, 7225, 7226, 7227, 7228, 7229, 7234],
    Stage: NoticeStage,
    View: NoticeSpecimen,
  },
  {
    id: 'toast',
    name: 'Toasts',
    group: 'Unified',
    note: 'An outcome to see once: a Notice in the toast shape inside the shared ToastStack, three at most.',
    source: 'packages/ui-shared/src/components/ToastStack.tsx',
    prs: [7218],
    Stage: ToastStage,
    View: ToastSpecimen,
  },
  {
    id: 'failures',
    name: 'Errors and empty states',
    group: 'Unified',
    note: 'ErrorBanner for a failure inside a surface, ErrorState when the whole panel failed, EmptyState and EmptyStateRow when there is nothing yet.',
    source: 'packages/ui-shared/src/components/StatusBlocks.tsx',
    prs: [7218, 7225, 7226, 7227, 7228, 7229, 7234, 7081],
    Stage: FailureStage,
    View: FailureSpecimen,
  },
  {
    id: 'loading',
    name: 'Loading',
    group: 'Unified',
    note: 'Nothing for 200ms, then a skeleton in the content’s own layout, then one slow note after 8s; spinners only inside the busy control.',
    source:
      'packages/ui-shared/src/components/{SkeletonBlock,LoadingButton,BusyLabel,DelayedLoadingPlaceholder}.tsx',
    prs: [7081],
    Stage: LoadingStage,
    View: LoadingSpecimen,
  },
  {
    id: 'progress',
    name: 'Progress',
    group: 'Unified',
    note: 'ProgressBar (6px, label and value above it), ProgressRing (16px) inside a small control, and ProgressSteps as 12px status glyphs; tones, never colors.',
    source: 'packages/ui-shared/src/components/Progress.tsx',
    prs: [7358, 7364, 7365],
    View: ProgressSpecimen,
  },
  {
    id: 'facts',
    name: 'Fact lists',
    group: 'Unified',
    note: 'FactList for a panel’s facts and stat tiles, ValueRows for figures, Settings rows for a detail page’s facts.',
    source:
      'packages/ui-shared/src/components/{FactList,settings/ValueRows,settings/SettingsRows}.tsx',
    prs: [7216, 7258],
    Stage: FactsStage,
    View: FactsSpecimen,
  },
  {
    id: 'dialogs',
    name: 'Dialogs',
    group: 'Unified',
    note: 'DialogModal with the 24px inset, the confirm variant and dialog tabs; ConfirmDialog for a question before an action (Cancel is secondary).',
    source: 'packages/ui-shared/src/components/{DialogModal,ConfirmDialog}.tsx',
    prs: [7215],
    Stage: DialogStage,
    View: DialogsSpecimen,
  },
  {
    id: 'spacing',
    name: 'Spacing',
    group: 'Unified',
    note: 'Sibling spacing comes from eight named roles on Stack and Inline, never a raw gap or margin.',
    source: 'packages/ui-shared/src/components/Stack.tsx',
    prs: [7215],
    View: SpacingSpecimen,
  },
  {
    id: 'tooltip-copy',
    name: 'Tooltip and CopyButton',
    group: 'Unified',
    note: 'One tooltip (with an optional shortcut) and one copy control that confirms in place.',
    source: 'packages/ui-shared/src/components/{Tooltip,CopyButton}.tsx',
    prs: [7082],
    Stage: TooltipStage,
    View: TooltipSpecimen,
  },
  {
    id: 'data-table',
    name: 'DataTable',
    group: 'Unified',
    note: 'Every data table is the framed card: a 32px header band, 36px rows split by a hairline, numbers right-aligned; rows fill on hover only when they open something.',
    source: 'packages/ui-shared/src/components/DataTable.tsx',
    prs: [],
    View: TablesSpecimen,
  },
  {
    id: 'avatars',
    name: 'Avatars',
    group: 'Unified',
    note: 'DisplayAvatar: a circle for people and a rounded square for groups, grey initials or a photo with a hairline edge, an actor glyph in the same shell; five steps from 16 to 40px.',
    source: 'packages/ui-shared/src/components/DisplayAvatar.tsx',
    prs: [7359, 7363, 7367],
    View: AvatarsSpecimen,
  },
  {
    id: 'not-unified',
    name: 'Waiting to be unified',
    group: 'Not unified yet',
    note: 'UI that still has more than one hand-made copy, with where the copies live and the shared component each one becomes.',
    source:
      'apps/desktop-app/src/renderer/src/components/dev/componentsLabPendingData.ts',
    prs: [],
    View: PendingSpecimen,
  },
];
