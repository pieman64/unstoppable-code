import { memo, type ComponentType, type JSX } from 'react';
import {
  Bot,
  Archive,
  CalendarClock,
  ClipboardList,
  Eye,
  FileText,
  MessageSquare,
  Puzzle,
  Settings2,
  Sparkles,
  Terminal,
  Workflow,
} from 'lucide-react';
import { GitBranch } from '@canopy/ui-shared/icons/AppIcons';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { formatRelativeTime } from '@/lib/format';
import {
  HighlightedSegments,
  rangesToIndices,
  splitMatchSegments,
} from '@canopy/ui-shared';
import { WORKTREE_STATUS_META } from '@/lib/worktree-status';
import { AgentProviderIcon } from '@/lib/providerUi';
import type { UiAgentProvider } from '@/lib/providerLabels';
import type { PaletteItem, PaletteItemKind } from './paletteItems';

/** Lucide icons and the app's git glyphs both satisfy this render contract. */
type KindIcon = ComponentType<{ className?: string }>;

const KIND_ICON: Record<PaletteItemKind, KindIcon> = {
  command: Terminal,
  worktree: GitBranch,
  archive: Archive,
  chat: MessageSquare,
  'chat-content': FileText,
  plan: ClipboardList,
  pipeline: Workflow,
  automation: CalendarClock,
  watcher: Eye,
  agent: Bot,
  plugin: Puzzle,
  skill: Sparkles,
  setting: Settings2,
};

interface PaletteResultRowProps {
  item: PaletteItem;
  titleIndices: number[];
  index: number;
  isSelected: boolean;
  onHover: (index: number) => void;
  onActivate: (item: PaletteItem) => void;
  registerRef: (index: number, node: HTMLLIElement | null) => void;
}

function PaletteResultRowInner({
  item,
  titleIndices,
  index,
  isSelected,
  onHover,
  onActivate,
  registerRef,
}: PaletteResultRowProps): JSX.Element {
  const Icon = KIND_ICON[item.kind];
  const dotClass =
    item.worktreeStatus !== undefined
      ? WORKTREE_STATUS_META[item.worktreeStatus].dotClass
      : null;
  const provider: UiAgentProvider | null =
    item.providerType === 'claude' ||
    item.providerType === 'codex' ||
    item.providerType === 'ollama'
      ? item.providerType
      : null;
  const titleSegments = splitMatchSegments(item.title, titleIndices);
  const commandTestId =
    item.kind === 'command' &&
    (item.navigation.commandKey === 'open-cost-panel' ||
      item.navigation.commandKey === 'open-session-breakdown')
      ? `command-palette-command-${item.navigation.commandKey}`
      : 'command-palette-result';
  const subtitleSegments = item.subtitle
    ? item.subtitleMatchRanges
      ? splitMatchSegments(
          item.subtitle,
          rangesToIndices([...item.subtitleMatchRanges]),
        )
      : null
    : null;

  return (
    <li
      ref={(node): void => registerRef(index, node)}
      data-palette-kind={item.kind}
    >
      <button
        type="button"
        role="option"
        aria-selected={isSelected}
        data-testid={commandTestId}
        onMouseEnter={(): void => onHover(index)}
        onClick={(): void => onActivate(item)}
        className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
          isSelected
            ? 'bg-accent-subtle fg-accent'
            : 'fg-primary hover:bg-secondary'
        }`}
      >
        <span className="flex shrink-0 items-center gap-1.5 fg-secondary">
          <Icon
            className="h-4 w-4"
            data-testid={`command-palette-kind-${item.kind}`}
            aria-hidden
          />
          {dotClass && (
            <span
              className={`h-2.5 w-2.5 rounded-full border ${dotClass}`}
              data-testid="command-palette-worktree-status"
              aria-hidden
            />
          )}
          {provider && (
            <AgentProviderIcon
              provider={provider}
              className="h-4 w-4"
              data-testid={`command-palette-provider-${provider}`}
              aria-hidden
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={
                item.titleReplayMasked
                  ? `${POSTHOG_REPLAY_MASK_CLASS} truncate text-s font-medium`
                  : 'truncate text-s font-medium'
              }
            >
              <HighlightedSegments segments={titleSegments} />
            </span>
            {item.archived && (
              <span
                data-testid="command-palette-archive-badge"
                data-archive-state={item.archiveState ?? 'archived'}
                className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-3xs fg-secondary"
              >
                {item.archiveState === 'deleted' ? 'Deleted' : 'Archived'}
              </span>
            )}
          </span>
          {item.subtitle && (
            <span
              // A tier-2 content snippet (`subtitleMatchRanges`) quotes chat
              // transcript or plan text, and a flagged subtitle quotes a
              // prompt: both are blocked in session replay.
              className={
                item.subtitleMatchRanges || item.subtitleReplayBlocked
                  ? `${POSTHOG_REPLAY_BLOCK_CLASS} mt-0.5 block truncate text-xs fg-secondary`
                  : item.subtitleReplayMasked
                    ? `${POSTHOG_REPLAY_MASK_CLASS} mt-0.5 block truncate text-xs fg-secondary`
                    : 'mt-0.5 block truncate text-xs fg-secondary'
              }
            >
              {subtitleSegments ? (
                <HighlightedSegments segments={subtitleSegments} />
              ) : (
                item.subtitle
              )}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {item.statusBadge && (
            <span
              data-testid="command-palette-status-badge"
              className="rounded-full bg-secondary px-2 py-0.5 text-3xs fg-secondary"
            >
              {item.statusBadge}
            </span>
          )}
          {item.shortcut && (
            <span
              data-testid="command-palette-shortcut"
              className="text-xs whitespace-nowrap tabular-nums fg-quaternary"
            >
              {item.shortcut}
            </span>
          )}
          {item.timestamp !== undefined && (
            <span className="text-2xs fg-secondary">
              {formatRelativeTime(item.timestamp)}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export const PaletteResultRow = memo(PaletteResultRowInner);
