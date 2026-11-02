import { memo, useId, type JSX } from 'react';
import { FileIcon } from '../../icons';
import { ArrowUpRightIcon, FolderIcon } from '../../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';
import { Tooltip } from '../Tooltip';
import { useCleanChatLook } from '../chat-look';
import { TOOL_APPROVAL_WAITING_LABEL } from './tool-approval-wait';
import { TURN_FILE_ROW_CLASS_NAME } from './turn-file-styles';

const filenameSegments = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

export interface TurnFileChipReveal {
  /** Accessible name naming the file, such as "Show report.csv in Finder". */
  readonly label: string;
  readonly tooltip: string;
  /** Host-local file-manager name, such as "Open in Finder". */
  readonly actionLabel?: string;
  readonly onReveal: () => void;
}
export interface TurnFileChipViewProps {
  readonly filename: string;
  readonly change?: 'updated';
  /** The change is still in flight: shown, not openable. */
  readonly pending?: boolean;
  /** A pending change held for the person's approval, not yet running. */
  readonly waiting?: boolean;
  readonly opening?: boolean;
  /** Host status (opening, an error); a pending chip says its own otherwise. */
  readonly status?: string;
  readonly location?: string;
  readonly onOpen: () => void;
  readonly reveal?: TurnFileChipReveal;
  /** Header content for a one-file summary, without the list row's insets. */
  readonly presentation?: 'row' | 'summary';
}

function FileReveal({
  reveal,
  describedBy,
}: {
  reveal: TurnFileChipReveal;
  describedBy: string;
}): JSX.Element {
  const clean = useCleanChatLook();
  const button = (
    <button
      type="button"
      data-testid="turn-file-chip-reveal"
      onClick={reveal.onReveal}
      aria-label={reveal.label}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      className={
        clean
          ? 'focus-ring flex size-8 shrink-0 items-center justify-center rounded-sm pointer-coarse:size-11'
          : 'focus-ring m-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary'
      }
    >
      {clean ? (
        <>
          <ArrowUpRightIcon
            width={14}
            height={14}
            aria-hidden="true"
            className="fg-quaternary"
          />
        </>
      ) : (
        <FolderIcon width={14} height={14} aria-hidden="true" />
      )}
    </button>
  );
  return <Tooltip label={reveal.tooltip}>{button}</Tooltip>;
}

function FileLabel({
  filename,
  location,
  locationId,
}: {
  filename: string;
  location?: string;
  locationId: string;
}): JSX.Element {
  const clean = useCleanChatLook();
  const characters = Array.from(
    filenameSegments.segment(filename),
    ({ segment }) => segment,
  );
  const middle = Math.ceil(characters.length / 2);
  return (
    <span
      className={clean ? 'flex w-full min-w-0 items-center gap-3' : 'contents'}
    >
      <span
        className={
          clean
            ? 'flex min-w-0 flex-1 items-center gap-1.5'
            : 'flex min-w-0 items-center gap-1.5'
        }
      >
        {!clean && (
          <span className="flex h-3 w-3 shrink-0 items-center justify-center fg-secondary">
            <FileIcon width={12} height={12} aria-hidden="true" />
          </span>
        )}
        {clean ? (
          <span className={`${REPLAY_MASK_CLASS} flex min-w-0 fg-primary`}>
            <span className="min-w-0 truncate whitespace-pre">
              {characters.slice(0, middle).join('')}
            </span>
            <span className="flex min-w-0 shrink justify-end overflow-hidden">
              <span className="whitespace-pre">
                {characters.slice(middle).join('')}
              </span>
            </span>
          </span>
        ) : (
          <span className="min-w-0 truncate fg-primary">{filename}</span>
        )}
      </span>
      {location && (
        <span
          id={locationId}
          data-testid="turn-file-chip-location"
          className={`${REPLAY_MASK_CLASS} ${clean ? 'hidden min-w-0 max-w-2/5 shrink-0 truncate text-xs fg-secondary @min-[28rem]/turn-file:block' : 'mt-1 block truncate text-3xs fg-secondary'}`}
        >
          {location}
        </span>
      )}
    </span>
  );
}

/** What a pending chip says: "Creating…", "Updating…" or "Waiting for approval". */
export function turnFilePendingStatus(
  change: 'updated' | undefined,
  waiting: boolean,
): string {
  if (waiting) return TOOL_APPROVAL_WAITING_LABEL;
  return change === 'updated' ? 'Updating…' : 'Creating…';
}

/** Separate preview/reveal controls preserve each host's routing and focus. */
export const TurnFileChipView = memo(function TurnFileChipView({
  filename,
  change,
  pending = false,
  waiting = false,
  opening = false,
  status: hostStatus,
  location,
  onOpen,
  reveal,
  presentation = 'row',
}: TurnFileChipViewProps): JSX.Element {
  const clean = useCleanChatLook();
  const id = useId();
  const locationId = `${id}-location`;
  const statusId = `${id}-status`;
  const shownLocation = pending ? undefined : location;
  const isWaiting = pending && waiting;
  const status = isWaiting
    ? TOOL_APPROVAL_WAITING_LABEL
    : hostStatus || (pending ? turnFilePendingStatus(change, false) : '');
  // A waiting chip is not working on anything yet, so it is never busy.
  const busy = !isWaiting && (opening || pending);
  const disabled = opening || pending;
  const describedBy = [
    shownLocation ? locationId : undefined,
    status ? statusId : undefined,
  ]
    .filter((value) => value !== undefined)
    .join(' ');
  return (
    <div
      data-testid="turn-file-chip"
      data-file-change={change ?? 'created'}
      data-file-approval={isWaiting ? 'waiting' : undefined}
      className={
        clean
          ? presentation === 'summary'
            ? '@container/turn-file group/turn-file flex min-w-0 flex-1 items-center gap-3 text-s'
            : `@container/turn-file group/turn-file ${TURN_FILE_ROW_CLASS_NAME}`
          : 'flex min-w-0 max-w-full items-start rounded-md border bg-fg-primary/[0.02] text-xs transition-colors hover:bg-fg-primary/[0.04]'
      }
    >
      <Tooltip
        label={<span className={REPLAY_MASK_CLASS}>{filename}</span>}
        allowShrink
        className="flex-1 self-stretch"
        contentClassName="max-w-80 whitespace-normal wrap-anywhere"
        delay="long"
      >
        <button
          type="button"
          data-testid="turn-file-chip-open"
          onClick={disabled ? undefined : onOpen}
          aria-label={
            isWaiting
              ? `${filename}, ${TOOL_APPROVAL_WAITING_LABEL.toLowerCase()}`
              : pending
                ? `${change === 'updated' ? 'Updating' : 'Creating'} ${filename}`
                : `Open ${filename}`
          }
          aria-busy={busy}
          aria-disabled={disabled}
          {...(describedBy ? { 'aria-describedby': describedBy } : {})}
          className={
            clean
              ? 'focus-ring flex min-h-8 min-w-0 flex-1 flex-col items-start justify-center rounded-sm text-left aria-disabled:cursor-default pointer-coarse:min-h-11'
              : 'focus-ring min-w-0 flex-1 cursor-pointer rounded-md px-2 py-1.5 text-left aria-disabled:cursor-default'
          }
        >
          <FileLabel
            filename={filename}
            location={shownLocation}
            locationId={locationId}
          />
          {status && (
            <span
              id={statusId}
              role="status"
              data-testid="turn-file-chip-status"
              className={
                clean
                  ? 'block w-full whitespace-normal wrap-anywhere text-xs fg-tertiary'
                  : 'mt-1 block whitespace-normal wrap-anywhere text-3xs fg-secondary'
              }
            >
              {status}
            </span>
          )}
        </button>
      </Tooltip>
      {reveal && !pending && (
        <FileReveal reveal={reveal} describedBy={describedBy} />
      )}
    </div>
  );
});
