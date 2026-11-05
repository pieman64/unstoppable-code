import type { ComponentsLabEntry } from './componentsLabCatalog';
import {
  LiveToolActivitySpecimen,
  ToolApprovalWaitSpecimen,
  ToolDisplaySpecimen,
} from './componentsLabChatToolHelpers';
import {
  ToolApprovalCardSpecimen,
  ToolApprovalDockSpecimen,
} from './componentsLabChatTurnApproval';
import {
  TurnFileChipSpecimen,
  TurnFilesSummarySpecimen,
} from './componentsLabChatTurnFiles';
import {
  TurnMoreMenuSpecimen,
  TurnOutcomeTooltipSpecimen,
  TurnResumeNoticeSpecimen,
  TurnWorkHeaderSpecimen,
} from './componentsLabChatTurnHeader';
import { SubagentsListSpecimen } from './componentsLabChatTurnSubagents';

/** Sheets for the chat turn and approval parts (component completeness). */
export const CHAT_TURN_LAB_ENTRIES: readonly ComponentsLabEntry[] = [
  {
    id: 'chat-tool-display',
    name: 'Tool display',
    group: 'Unified',
    note: 'The helper behind every tool row: the icon and words for a call, and the family it belongs to.',
    source: 'packages/ui-shared/src/components/chat/tool-display.tsx',
    prs: [],
    View: ToolDisplaySpecimen,
  },
  {
    id: 'chat-tool-approval-wait',
    name: 'Tool approval wait',
    group: 'Unified',
    note: 'The provider rows read to say a call waits for approval; without one nothing waits.',
    source: 'packages/ui-shared/src/components/chat/tool-approval-wait.tsx',
    prs: [],
    View: ToolApprovalWaitSpecimen,
  },
  {
    id: 'chat-live-tool-activity',
    name: 'Live tool activity',
    group: 'Unified',
    note: 'The live line for a running call: its icon and words, and the waiting mark for a call held for approval.',
    source: 'packages/ui-shared/src/components/chat/live-tool-activity.tsx',
    prs: [],
    View: LiveToolActivitySpecimen,
  },
  {
    id: 'chat-turn-work-header',
    name: 'Turn header',
    group: 'Unified',
    note: 'The line over a turn’s steps: Starting…, Working for 28s, Worked for 3m 24s, or how it ended; foldable, with outcome counts and pinned actions.',
    source: 'packages/ui-shared/src/components/chat/TurnWorkHeader.tsx',
    prs: [],
    View: TurnWorkHeaderSpecimen,
  },
  {
    id: 'chat-turn-resume-notice',
    name: 'Turn resume notice',
    group: 'Unified',
    note: 'The composer offer to resume a turn that did not finish: Resume is the primary action on the right, with busy and error states.',
    source: 'packages/ui-shared/src/components/chat/TurnResumeNotice.tsx',
    prs: [],
    View: TurnResumeNoticeSpecimen,
  },
  {
    id: 'chat-turn-outcome-tooltip',
    name: 'Turn outcome tooltip',
    group: 'Unified',
    note: 'What the outcome control shows on hover: blocked steps, then errors, then interrupted ones, five at most, or count sentences when rows are not loaded.',
    source: 'packages/ui-shared/src/components/chat/TurnOutcomeTooltip.tsx',
    prs: [],
    View: TurnOutcomeTooltipSpecimen,
  },
  {
    id: 'chat-turn-more-menu',
    name: 'Turn more menu',
    group: 'Unified',
    note: 'The … at the end of a reply’s action row; the less-used actions live in this small menu, and picking a row closes it.',
    source: 'packages/ui-shared/src/components/chat/TurnMoreMenu.tsx',
    prs: [],
    View: TurnMoreMenuSpecimen,
  },
  {
    id: 'chat-turn-file-chip',
    name: 'Turn file chip',
    group: 'Unified',
    note: 'One file a turn created or updated: open it, see it being written or held for approval, and reveal it in the file manager.',
    source: 'packages/ui-shared/src/components/chat/TurnFileChipView.tsx',
    prs: [],
    View: TurnFileChipSpecimen,
  },
  {
    id: 'chat-turn-files-summary',
    name: 'Turn files summary',
    group: 'Unified',
    note: 'The framed summary of a turn’s changed and saved files: folded or open, with one-file shortcuts and header actions.',
    source: 'packages/ui-shared/src/components/chat/TurnFilesSummaryView.tsx',
    prs: [],
    View: TurnFilesSummarySpecimen,
  },
  {
    id: 'chat-tool-approval-card',
    name: 'Tool approval card',
    group: 'Unified',
    note: 'The prompt that asks before a tool runs: every request kind, remembered-rule options, deny with a reason, and the read-only viewer.',
    source: 'packages/ui-shared/src/components/chat/ToolApprovalCard.tsx',
    prs: [],
    View: ToolApprovalCardSpecimen,
  },
  {
    id: 'chat-tool-approval-dock',
    name: 'Tool approval dock',
    group: 'Unified',
    note: 'Docked above the composer: one card alone, or Approval N of M with arrows when several wait.',
    source: 'packages/ui-shared/src/components/chat/ToolApprovalDock.tsx',
    prs: [],
    View: ToolApprovalDockSpecimen,
  },
  {
    id: 'chat-subagents-list',
    name: 'Subagents list',
    group: 'Unified',
    note: 'The subagent panel’s list view: four column sets by width, capped indent, folding parents, workflow runs, and an Open chat action per row.',
    source:
      'packages/ui-shared/src/components/chat/subagents/panel/SubagentsList.tsx',
    prs: [],
    View: SubagentsListSpecimen,
  },
];
