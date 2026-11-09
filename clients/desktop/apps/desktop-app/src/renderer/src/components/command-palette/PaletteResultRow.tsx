import { Badge } from '@canopy/ui-shared/components/Badge';
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
import { ListRow } from '@canopy/ui-shared/components';
import { WORKTREE_STATUS_META } from '@/lib/worktree-status';
import { ModelProviderIcon } from '@canopy/ui-shared/components';
import type { UiAgentProvider } from '@/lib/providerLabels';
import type { PaletteItem, PaletteItemKind } from './paletteItems';

/** Raw Lucide entries retain their numeric sizing contract. */
type KindIcon = ComponentType<{ size?: number }>;

const KIND_ICON: Record<Exclude<PaletteItemKind, 'worktree'>, KindIcon> = {
  command: Terminal,
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
  const Icon = item.kind === 'worktree' ? null : KIND_ICON[item.kind];
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

  const subtitleClassName =
    item.subtitleMatchRanges || item.subtitleReplayBlocked
      ? POSTHOG_REPLAY_BLOCK_CLASS
      : item.subtitleReplayMasked
        ? POSTHOG_REPLAY_MASK_CLASS
        : undefined;
  const hasTrailing =
    Boolean(item.statusBadge) ||
    Boolean(item.shortcut) ||
    item.timestamp !== undefined;

  return (
    <li
      ref={(node): void => registerRef(index, node)}
      data-palette-kind={item.kind}
    >
      <ListRow
        role="option"
        aria-selected={isSelected}
        selected={isSelected}
        data-testid={commandTestId}
        onMouseEnter={(): void => onHover(index)}
        onClick={(): void => onActivate(item)}
        icon={
          Icon === null ? (
            <GitBranch
              size="sm"
              data-testid={`command-palette-kind-${item.kind}`}
              aria-hidden
            />
          ) : (
            <Icon
              size={16}
              data-testid={`command-palette-kind-${item.kind}`}
              aria-hidden
            />
          )
        }
        description={
          item.subtitle ? (
            // A tier-2 content snippet (`subtitleMatchRanges`) quotes chat
            // transcript or plan text, and a flagged subtitle quotes a
            // prompt: both are blocked in session replay.
            <span className={subtitleClassName}>
              {subtitleSegments ? (
                <HighlightedSegments segments={subtitleSegments} />
              ) : (
                item.subtitle
              )}
            </span>
          ) : undefined
        }
        trailing={
          hasTrailing ? (
            <span className="flex shrink-0 items-center gap-2">
              {item.statusBadge && (
                <Badge data-testid="command-palette-status-badge">
                  {item.statusBadge}
                </Badge>
              )}
              {item.shortcut && (
                <span
                  data-testid="command-palette-shortcut"
                  className="whitespace-nowrap tabular-nums fg-quaternary"
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
          ) : undefined
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          {dotClass && (
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full border ${dotClass}`}
              data-testid="command-palette-worktree-status"
              aria-hidden
            />
          )}
          {provider && (
            <ModelProviderIcon
              size="md"
              provider={provider}
              tone="secondary"
              className="shrink-0"
              data-testid={`command-palette-provider-${provider}`}
              aria-hidden
            />
          )}
          <span
            className={
              item.titleReplayMasked
                ? `${POSTHOG_REPLAY_MASK_CLASS} min-w-0 truncate`
                : 'min-w-0 truncate'
            }
          >
            <HighlightedSegments segments={titleSegments} />
          </span>
          {item.archived && (
            <span
              data-testid="command-palette-archive-badge"
              data-archive-state={item.archiveState ?? 'archived'}
              className="inline-flex shrink-0"
            >
              <Badge>
                {item.archiveState === 'deleted' ? 'Deleted' : 'Archived'}
              </Badge>
            </span>
          )}
        </span>
      </ListRow>
    </li>
  );
}

export const PaletteResultRow = memo(PaletteResultRowInner);
