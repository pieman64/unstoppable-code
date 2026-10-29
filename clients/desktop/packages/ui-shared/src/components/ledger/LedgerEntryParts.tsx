'use client';

import type { JSX, ReactNode } from 'react';
import type {
  LedgerActorKind,
  LedgerActorLabel,
  LedgerEntrySearchItem,
  LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import {
  ArchiveIcon,
  BuildingIcon,
  ChatIcon,
  FileIcon,
  MacbookIcon,
  MessageIcon,
  PersonIcon,
  PipelineIcon,
  type AppIcon,
} from '../../icons/AppIcons';
import {
  LEDGER_SYNC_STATE_LABELS,
  formatLedgerFullDateTime,
  formatLedgerRelativeTime,
  ledgerEntryShowsOwner,
  ledgerEntryShowsStatus,
  type LedgerSourceActionGlyph,
} from '../../lib/ledger-display';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../Button';
import { Tooltip } from '../Tooltip';
import { LedgerActorGlyph } from './LedgerActorAvatar';
import { LedgerStatusPill } from './LedgerStatusPill';
import { LedgerEntryTypeLabel } from './LedgerEntryTypeLabel';
import {
  ledgerActorReplayClass,
  ledgerAttributedActorName,
  type LedgerEntryRowDetails,
} from './ledger-entry-attribution';
import type { LedgerDensity, LedgerEntrySlots } from './ledger-entry-slots';
import { LedgerEntryMarkdown } from './ledger-entry-markdown';

const ORIGIN_CLASS_NAME = 'inline-flex items-baseline gap-1';
const ORIGIN_ICON_CLASS_NAME = 'shrink-0 self-center';

export interface LedgerRelativeTimeProps {
  readonly iso: string;
  readonly now: Date;
}

/** A relative time whose tooltip shows the full local date and time. */
export function LedgerRelativeTime({
  iso,
  now,
}: LedgerRelativeTimeProps): JSX.Element {
  return (
    <Tooltip label={formatLedgerFullDateTime(iso)}>
      <time dateTime={iso}>{formatLedgerRelativeTime(iso, now)}</time>
    </Tooltip>
  );
}

export interface LedgerEntryHeaderProps {
  readonly entry: LedgerEntrySearchItem;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly density: LedgerDensity;
  readonly now: Date;
  readonly timeField: 'createdAt' | 'updatedAt';
  readonly details?: LedgerEntryRowDetails;
  readonly statusControl?: ReactNode;
  readonly ownerControl?: ReactNode;
}

/**
 * Heads an entry's row: what kind of entry it is and who owns it, with its
 * status at the trailing edge, so statuses line up down the column. Who
 * recorded it follows on a quieter line, behind the glyph of what recorded it
 * (a person, a chat, a delegate, a pipeline agent), then where and when.
 */
export function LedgerEntryHeader({
  entry,
  actors,
  density,
  now,
  timeField,
  details,
  statusControl,
  ownerControl,
}: LedgerEntryHeaderProps): JSX.Element {
  const attribution = details?.attribution;
  const origin = rowOrigin(entry, details);
  const time = entry[timeField];
  const syncState =
    entry.syncState === 'mirrored' ? undefined : entry.syncState;
  const hasStatus =
    statusControl !== undefined || ledgerEntryShowsStatus(entry);
  const hasOwner = ownerControl !== undefined || ledgerEntryShowsOwner(entry);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-start gap-2">
        <div
          // As tall as the status pill, so the type and the status share a center line.
          className={`flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 font-medium fg-primary ${density === 'page' ? 'text-s' : 'text-xs'}`}
        >
          {/* The row's avatar is the type's glyph, so the name stands alone. */}
          <LedgerEntryTypeLabel type={entry.type} icon={false} />
          {hasOwner && (
            <div className="inline-flex min-w-0 items-center gap-x-2 text-2xs font-normal fg-secondary">
              <span aria-hidden="true" className="fg-tertiary">
                ·
              </span>
              {ownerControl !== undefined ? (
                ownerControl
              ) : (
                <span data-testid="ledger-entry-row-owner">
                  Owner:{' '}
                  <LedgerActorNameText
                    kind={entry.owner.kind}
                    localUser={attribution?.kind !== 'teammate'}
                    name={ledgerAttributedActorName(
                      entry.owner,
                      actors,
                      attribution,
                    )}
                  />
                </span>
              )}
            </div>
          )}
        </div>
        {hasStatus &&
          (statusControl !== undefined ? (
            statusControl
          ) : (
            <LedgerStatusPill
              status={entry.status}
              data-testid="ledger-entry-row-status"
            />
          ))}
      </div>
      {/* The gap spaces the separators: a flex item drops its own edge spaces. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-2xs fg-tertiary">
        <span className="inline-flex min-w-0 items-center gap-1 fg-secondary">
          <span
            aria-hidden="true"
            data-testid="ledger-entry-row-author-icon"
            data-actor-kind={entry.author.kind}
            className="inline-flex shrink-0"
          >
            <LedgerActorGlyph kind={entry.author.kind} size={12} />
          </span>
          <span
            data-testid="ledger-entry-row-author"
            className={`${ledgerActorReplayClass(entry.author.kind, attribution?.kind !== 'teammate')} truncate`}
          >
            {ledgerAttributedActorName(entry.author, actors, attribution)}
          </span>
        </span>
        {origin !== null && (
          <>
            <span aria-hidden="true">·</span>
            {origin}
          </>
        )}
        <span aria-hidden="true">·</span>
        <LedgerRelativeTime iso={time} now={now} />
        {syncState !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <span
              data-testid="ledger-entry-row-sync"
              data-sync-state={syncState}
              className={
                syncState === 'repair_needed' ? 'fg-attention' : undefined
              }
            >
              {LEDGER_SYNC_STATE_LABELS[syncState]}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function rowOrigin(
  entry: LedgerEntrySearchItem,
  details: LedgerEntryRowDetails | undefined,
): JSX.Element | null {
  const attribution = details?.attribution;
  if (attribution?.kind === 'teammate') {
    const ownEntry = entry.author.kind === 'user';
    const Icon = ownEntry ? BuildingIcon : PersonIcon;
    return (
      <span className={`${ORIGIN_CLASS_NAME} fg-secondary`}>
        <Icon size={12} aria-hidden="true" className={ORIGIN_ICON_CLASS_NAME} />
        <span className="sr-only">Teammate: </span>
        <span data-testid="ledger-entry-row-teammate">
          {/* The teammate's name is blocked from replay; the organization is not. */}
          {!ownEntry && (
            <>
              <span className={REPLAY_BLOCK_CLASS}>{attribution.name}</span>
              {', '}
            </>
          )}
          {attribution.organization}
        </span>
      </span>
    );
  }
  if (attribution?.kind === 'device') {
    return (
      <span className={ORIGIN_CLASS_NAME}>
        <MacbookIcon
          size={12}
          aria-hidden="true"
          className={ORIGIN_ICON_CLASS_NAME}
        />
        <span className="sr-only">Device: </span>
        <span data-testid="ledger-entry-row-device">{attribution.label}</span>
      </span>
    );
  }
  if (details?.context === undefined) return null;
  return <span data-testid="ledger-entry-row-context">{details.context}</span>;
}

export interface LedgerActorNameTextProps {
  readonly kind: LedgerActorKind;
  readonly name: string;
  readonly localUser?: boolean;
}

/** An actor's name; a teammate's is blocked from session replay. */
export function LedgerActorNameText({
  kind,
  name,
  localUser = false,
}: LedgerActorNameTextProps): JSX.Element {
  const replayClassName = ledgerActorReplayClass(kind, localUser);
  return (
    <span className={replayClassName === '' ? undefined : replayClassName}>
      {name}
    </span>
  );
}

export interface LedgerEntryTitleProps {
  readonly title: string;
  readonly density: LedgerDensity;
}

/** Shows an entry title as text. */
export function LedgerEntryTitle({
  title,
  density,
}: LedgerEntryTitleProps): JSX.Element {
  // Deliberately deviates from DESIGN.md's 400/450 weight hierarchy (Typography): Ledger entry titles use font-bold (500) so they read heavier than their content.
  // Entry text is agent-written from conversations: replay records a box.
  const titleClassName = `${REPLAY_BLOCK_CLASS} min-w-0 break-words font-bold fg-primary ${density === 'page' ? 'text-m' : 'text-s'}`;
  return (
    <h3 data-testid="ledger-entry-row-title" className={titleClassName}>
      {title}
    </h3>
  );
}

function ledgerFileLabel(file: LedgerFileRef): string {
  return file.startLine === undefined
    ? file.path
    : `${file.path}:${file.startLine}`;
}

export interface LedgerFileChipProps {
  readonly file: LedgerFileRef;
  readonly onOpen: (file: LedgerFileRef) => void;
}

/** Opens a referenced file from an entry. */
export function LedgerFileChip({
  file,
  onOpen,
}: LedgerFileChipProps): JSX.Element {
  const label = ledgerFileLabel(file);
  return (
    <button
      type="button"
      data-testid="ledger-entry-file-ref"
      aria-label={`Open ${label}`}
      onClick={() => onOpen(file)}
      className="focus-ring inline-flex max-w-full items-center gap-1 rounded-md bg-subtle px-2 py-1 font-mono text-2xs fg-secondary hover:bg-secondary hover:fg-primary"
    >
      <FileIcon size={12} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export interface LedgerEntryBodyProps {
  readonly entry: LedgerEntrySearchItem;
  readonly density: LedgerDensity;
  readonly onOpenFile: (file: LedgerFileRef) => void;
  readonly title?: ReactNode | null;
}

/** Shows the title, content, highlights and files of an entry. */
export function LedgerEntryBody({
  entry,
  density,
  onOpenFile,
  title,
}: LedgerEntryBodyProps): JSX.Element {
  const defaultTitle =
    entry.titlePending === true ? null : (
      <LedgerEntryTitle title={entry.title} density={density} />
    );
  return (
    <div className="flex flex-col gap-2">
      {title === undefined ? defaultTitle : title}
      <div className={REPLAY_BLOCK_CLASS}>
        <LedgerEntryMarkdown
          content={entry.content}
          density={density}
          data-testid="ledger-entry-row-content"
        />
      </div>
      {entry.highlights.length > 0 && (
        <ul
          className={`${REPLAY_BLOCK_CLASS} flex list-disc flex-col gap-0.5 pl-5 fg-primary ${density === 'page' ? 'text-s' : 'text-xs'}`}
        >
          {entry.highlights.map((highlight, index) => (
            <li key={`${index}:${highlight}`}>{highlight}</li>
          ))}
        </ul>
      )}
      {entry.referenceFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.referenceFiles.map((file, index) => (
            <LedgerFileChip
              key={`${index}:${file.rootId}:${ledgerFileLabel(file)}`}
              file={file}
              onOpen={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const SOURCE_ACTION_ICONS: Readonly<Record<LedgerSourceActionGlyph, AppIcon>> =
  {
    chat: ChatIcon,
    run: PipelineIcon,
    archived: ArchiveIcon,
  };

export interface LedgerEntryActionsProps {
  readonly slots: LedgerEntrySlots;
  /** Whether this entry's details show; labels the toggle and sets aria-expanded. */
  readonly detailsOpen: boolean;
  /** Shows or hides this entry's details. */
  readonly onToggleDetails: () => void;
}

/**
 * Shows an entry's source action, details toggle and correction action or
 * read-only note. A source action that opens an archived chat takes the
 * archive glyph and says whose chat it is in its tooltip.
 *
 * That tooltip deliberately deviates from DESIGN.md's "A row or button that
 * already shows its label gets no tooltip that repeats or describes it"
 * (Interaction states), on this action only: the label cannot say whether the
 * archived chat is the entry's own or the one that started its delegate.
 */
export function LedgerEntryActions({
  slots,
  detailsOpen,
  onToggleDetails,
}: LedgerEntryActionsProps): JSX.Element {
  const sourceAction = slots.sourceAction ?? null;
  const onOpenSource = slots.onOpenSource;
  const onAddCorrection = slots.onAddCorrection;
  const disabledReason = slots.addCorrectionDisabledReason;
  const addCorrectionDisabled =
    typeof disabledReason === 'string' && disabledReason.length > 0;
  const addCorrection = slots.readOnlyNote === undefined &&
    onAddCorrection !== undefined && (
      <Button
        type="button"
        variant="ghost"
        size="control"
        data-testid="ledger-entry-add-correction"
        disabled={addCorrectionDisabled}
        aria-description={addCorrectionDisabled ? disabledReason : undefined}
        onClick={onAddCorrection}
      >
        <MessageIcon size={14} aria-hidden="true" />
        {slots.addCorrectionLabel ?? 'Add correction'}
      </Button>
    );
  const SourceIcon =
    sourceAction === null ? null : SOURCE_ACTION_ICONS[sourceAction.glyph];
  const openSource = sourceAction !== null &&
    SourceIcon !== null &&
    onOpenSource !== undefined && (
      <Button
        type="button"
        variant="ghost"
        size="control"
        data-testid="ledger-entry-source-open"
        data-source-archived={
          sourceAction.glyph === 'archived' ? 'true' : undefined
        }
        onClick={onOpenSource}
      >
        <SourceIcon size={14} aria-hidden="true" />
        {sourceAction.label}
      </Button>
    );
  return (
    <div className="-ml-2.5 flex min-w-0 flex-wrap items-center gap-1">
      {openSource !== false &&
      sourceAction !== null &&
      sourceAction.tooltip !== null ? (
        <Tooltip label={sourceAction.tooltip}>{openSource}</Tooltip>
      ) : (
        openSource
      )}
      <Button
        type="button"
        variant="ghost"
        size="control"
        data-testid="ledger-entry-details-toggle"
        aria-expanded={detailsOpen}
        onClick={onToggleDetails}
      >
        {detailsOpen ? 'Hide details' : 'Show details'}
      </Button>
      {slots.readOnlyNote !== undefined && (
        <span
          data-testid="ledger-entry-read-only"
          className="px-2.5 py-1.5 text-xs fg-tertiary"
        >
          {slots.readOnlyNote}
        </span>
      )}
      {/* A disabled button takes no pointer events, so the reason's tooltip
          hangs on its wrapper. */}
      {addCorrection !== false && addCorrectionDisabled ? (
        <Tooltip label={disabledReason}>{addCorrection}</Tooltip>
      ) : (
        addCorrection
      )}
    </div>
  );
}
