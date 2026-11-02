import { type JSX, useState } from 'react';
import type {
  PipelineExecutionScope,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import {
  CheckIcon,
  CopyIcon,
  DocumentSearchIcon,
  EyeIcon,
  EyeOffIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons';
import {
  DocumentPencilIcon,
  ShareIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Link as LinkIcon } from 'lucide-react';
import { PipelineShareLabel } from './PipelineShareLabel';
import { TriggerBadge } from './PipelineTriggerBadge';
import { getTriggerMeta } from './pipeline-trigger-meta';
import { PIPELINE_SOURCE_META } from './pipeline-source-meta';
import {
  PIPELINE_EXECUTION_SCOPE_BADGE_CLASS,
  PIPELINE_EXECUTION_SCOPE_META,
} from './pipeline-execution-scope-meta';
import { readPipelineInfoScopes } from '@/lib/pipelineExecutionScope';
import { resolveSharedPipelineUrl } from '@/lib/share-links';
import { pipelineSharePath } from '@canopy/protocol/pipelines';
import { useClipboardCopy } from '@/hooks/useClipboardCopy';
import {
  ActionTooltip,
  TableActionButton,
  TableActionsCell,
} from '@canopy/ui-shared';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';

function ExecutionScopeBadge({
  scope,
}: {
  scope: PipelineExecutionScope;
}): JSX.Element {
  const meta = PIPELINE_EXECUTION_SCOPE_META[scope];

  return (
    <ActionTooltip title={meta.label} description={meta.description}>
      <button
        type="button"
        aria-label={`${meta.label}: ${meta.description}`}
        className={`focus-ring ${PIPELINE_EXECUTION_SCOPE_BADGE_CLASS}`}
      >
        {meta.label}
      </button>
    </ActionTooltip>
  );
}

type ShareLinkAction = { sharePath: string };

/**
 * A public link wins; team and organization shares copy their member-only
 * lander. Private-only rows are hidden by the server and carry no action.
 */
function resolveShareLinkAction(
  pipeline: PipelineInfo,
): ShareLinkAction | null {
  if (pipeline.publicShare) {
    return { sharePath: pipeline.publicShare.sharePath };
  }
  if (pipeline.source !== 'shared' || !pipeline.remoteId) return null;
  if (
    pipeline.shareScope === 'team' ||
    pipeline.shareScope === 'organization'
  ) {
    return { sharePath: pipelineSharePath(pipeline.remoteId) };
  }
  return null;
}

interface PipelineTableRowProps {
  pipeline: PipelineInfo;
  /** Whether the pipeline is enabled (shown in run pickers). */
  enabled: boolean;
  /** Toggle the pipeline's enabled state. */
  onToggleEnabled: (enabled: boolean) => Promise<void>;
  onEdit: (pipeline: PipelineInfo) => void;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (pipeline: PipelineInfo) => Promise<void>;
  /** Raise a Share request for this row. Omitted when sharing is unavailable. */
  onShare?: (pipeline: PipelineInfo) => void;
  /** Disables Share while this row's definition is being loaded. */
  sharePending?: boolean;
}

export function PipelineTableRow({
  pipeline,
  enabled,
  onToggleEnabled,
  onEdit,
  onDelete,
  onDuplicate,
  onShare,
  sharePending = false,
}: PipelineTableRowProps): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const { copied, copy } = useClipboardCopy();
  const description = markdownDescriptionToPlainText(pipeline.description);

  async function handleToggleEnabled(): Promise<void> {
    setToggling(true);
    try {
      await onToggleEnabled(!enabled);
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await onDelete(pipeline.id);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  async function handleDuplicate(): Promise<void> {
    setBusy(true);
    try {
      await onDuplicate(pipeline);
    } finally {
      setBusy(false);
    }
  }

  // For local pipelines (`bundled`, `project`), readonly is "anything that
  // isn't `user`". For shared pipelines, readonly is gated on the API user's
  // `canUpdate` permission for that specific row (creator/admin can edit).
  const isShared = pipeline.source === 'shared';
  const sharedCanUpdate = isShared && pipeline.canUpdate === true;
  const sharedCanDelete = isShared && pipeline.canDelete === true;
  const isReadonly =
    pipeline.source === 'bundled' ||
    pipeline.source === 'curated' ||
    pipeline.source === 'project' ||
    (isShared && !sharedCanUpdate);
  const shareLink = resolveShareLinkAction(pipeline);
  // Shared rows always allow Duplicate (it produces a fresh local copy).
  const showDuplicate = pipeline.source !== 'user';
  const triggers = (pipeline.triggerTypes ?? []).filter(
    (type) => getTriggerMeta(type) !== null,
  );
  const sourceMeta = PIPELINE_SOURCE_META[pipeline.source];
  const executionScopes = readPipelineInfoScopes(pipeline);

  return (
    <tr
      data-testid={`pipeline-row-${pipeline.source === 'curated' ? pipeline.id : `${pipeline.source}:${pipeline.id}`}`}
      className={`border-b last:border-b-0 hover:bg-secondary/30 transition-colors ${
        enabled ? '' : 'opacity-55'
      }`}
    >
      {/* Pipeline: icon + name + description */}
      <td className="px-3 py-2.5 align-middle">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 w-9 h-9 rounded-lg bg-accent-subtle flex items-center justify-center text-m">
            {pipeline.icon || '⚡'}
          </div>
          <div className="min-w-0">
            <h3 className="text-s font-medium fg-primary truncate">
              {pipeline.name}
            </h3>
            {description && (
              <p className="text-xs fg-secondary mt-0.5 truncate">
                {description}
              </p>
            )}
          </div>
        </div>
      </td>

      {/* Source */}
      <td className="px-3 py-2.5 align-middle">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`shrink-0 px-1.5 py-0.5 text-3xs font-medium rounded ${sourceMeta.badgeClass}`}
          >
            {sourceMeta.label}
          </span>
          {isShared && (
            <PipelineShareLabel
              shareScope={pipeline.shareScope}
              owner={pipeline.owner}
            />
          )}
        </div>
      </td>

      {/* Execution scope */}
      <td className="px-3 py-2.5 align-middle">
        <div
          className="flex items-center gap-1.5 flex-wrap"
          data-testid={`pipeline-scope-${pipeline.id}`}
        >
          {executionScopes.map((scope) => (
            <ExecutionScopeBadge key={`scope-${scope}`} scope={scope} />
          ))}
        </div>
      </td>

      {/* Triggers */}
      <td className="px-3 py-2.5 align-middle">
        {triggers.length > 0 ? (
          <div className="flex items-center gap-1.5">
            {triggers.map((t) => (
              <TriggerBadge key={t} type={t} />
            ))}
          </div>
        ) : (
          <span className="text-xs fg-secondary">—</span>
        )}
      </td>

      {/* Actions: always-visible icon group, right aligned. The enabled
          toggle folds in here rather than owning its own column — disabled
          pipelines are hidden from every run picker but stay listed so they
          can be re-enabled. */}
      <td className="px-3 py-2.5 align-middle">
        <TableActionsCell
          onFocusLeave={(): void => setConfirmDelete(false)}
          // Only consume Escape when there is actually an armed delete to
          // disarm, so Escape still reaches an enclosing dialog otherwise.
          onEscape={(): boolean => {
            if (!confirmDelete) {
              return false;
            }
            setConfirmDelete(false);
            return true;
          }}
        >
          {/* The accessible name states the action the next click performs
              ("Disable workflow" while enabled), so `aria-pressed` is
              deliberately NOT set here: pairing a state-flipping name with a
              pressed state announces "Disable workflow, toggle button, pressed",
              which contradicts itself. Use `ariaPressed` on this primitive only
              with a name that stays constant across states. */}
          <TableActionButton
            label={enabled ? 'Disable workflow' : 'Enable workflow'}
            onClick={(): void => {
              void handleToggleEnabled();
            }}
            disabled={toggling}
            testId={`pipeline-toggle-enabled-${pipeline.id}`}
          >
            {enabled ? (
              <EyeIcon width={14} height={14} />
            ) : (
              <EyeOffIcon width={14} height={14} />
            )}
          </TableActionButton>

          {shareLink && (
            <TableActionButton
              label={copied ? 'Copied' : 'Copy share link'}
              onClick={(): void => {
                const { sharePath } = shareLink;
                void resolveSharedPipelineUrl(sharePath).then((url) =>
                  copy(url ?? sharePath),
                );
              }}
              testId={`pipeline-copy-link-${pipeline.id}`}
            >
              {copied ? (
                <CheckIcon width={14} height={14} />
              ) : (
                <LinkIcon width={14} height={14} aria-hidden />
              )}
            </TableActionButton>
          )}

          {/* `View` deliberately uses the document-search glyph, not an eye:
              the enabled toggle already owns eye semantics in this group. */}
          <TableActionButton
            label={isReadonly ? 'View' : 'Edit'}
            onClick={(): void => onEdit(pipeline)}
            testId={`pipeline-edit-${pipeline.id}`}
          >
            {isReadonly ? (
              <DocumentSearchIcon width={14} height={14} />
            ) : (
              <DocumentPencilIcon width={14} height={14} />
            )}
          </TableActionButton>

          {/* Share is offered for every source: non-user pipelines publish a
              snapshot copy, matching `PipelineToolbar`. */}
          {onShare && (
            <TableActionButton
              label="Share"
              onClick={(): void => onShare(pipeline)}
              disabled={sharePending}
              testId={`pipeline-share-${pipeline.id}`}
            >
              <ShareIcon width={14} height={14} />
            </TableActionButton>
          )}

          {/* Duplicate is shown for every non-user source (including shared,
              regardless of canUpdate / canDelete) so users always have an
              escape hatch to fork the pipeline locally. */}
          {showDuplicate && (
            <TableActionButton
              label="Duplicate"
              onClick={(): void => {
                void handleDuplicate();
              }}
              disabled={busy}
              testId={`pipeline-duplicate-${pipeline.id}`}
            >
              <CopyIcon width={14} height={14} />
            </TableActionButton>
          )}

          {/* Delete is gated by source:
                - user: always
                - shared: only when canDelete
                - bundled / curated / project: never
              Two-step: the first click arms the button, the second deletes.
              Moving focus out of the group disarms it. */}
          {(pipeline.source === 'user' || sharedCanDelete) && (
            <TableActionButton
              label={confirmDelete ? 'Confirm delete' : 'Delete'}
              onClick={(): void => {
                void handleDelete();
              }}
              disabled={busy}
              tone={confirmDelete ? 'destructive' : 'default'}
              testId={`pipeline-delete-${pipeline.id}`}
            >
              <TrashIcon width={14} height={14} />
            </TableActionButton>
          )}
        </TableActionsCell>
      </td>
    </tr>
  );
}
