import {
  Children,
  useEffect,
  useId,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons';
import { FileDiff } from '../../icons/AppIcons';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { useCleanChatLook } from '../chat-look';

export interface TurnFilesSummaryViewProps {
  readonly heading: string | undefined;
  readonly classicHeading?: ReactNode;
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly showFiles?: boolean;
  readonly turnId?: string;
  /** A single file takes the header's content slot, without a duplicate row. */
  readonly singleFile?: ReactNode;
  /** Git rows form their own list, separated from saved outputs by a hairline. */
  readonly changedFiles?: ReactNode;
  /** Count stays available while a folded host defers its Git row elements. */
  readonly changedFileCount?: number;
  readonly children: ReactNode;
}

/** Restore a file viewer's origin, or its disclosure while the list is folded. */
export function restoreTurnFileFocus(origin: HTMLElement): void {
  if (!origin.isConnected) return;
  const hidden = origin.closest<HTMLElement>('[hidden]');
  if (!hidden) {
    origin.focus({ preventScroll: true });
    return;
  }
  const disclosure = Array.from(
    hidden.parentElement?.querySelectorAll<HTMLButtonElement>(
      'button[aria-controls]',
    ) ?? [],
  ).find((button) => button.getAttribute('aria-controls') === hidden.id);
  disclosure?.focus({ preventScroll: true });
}

/** Bounded list: ordinary pointer rows are 32px; touch and status rows can grow. */
function FileList({
  children,
  label,
  inline = false,
}: {
  children: ReactNode;
  label: string;
  inline?: boolean;
}): JSX.Element {
  // The wrapper is stable for 1, 2, 3 and 4+ files, preserving host file state.
  return (
    <OverlayScrollArea
      className={inline ? '' : 'mx-1'}
      viewportClassName={inline ? '' : 'max-h-30 overscroll-contain'}
      contentClassName={inline ? '' : 'flex flex-col py-1'}
      railClassName={inline ? 'hidden' : '-right-1'}
      edgeFadeSize={inline ? 0 : 8}
      viewportProps={{
        role: inline ? undefined : 'region',
        'aria-label': inline ? undefined : label,
        tabIndex:
          !inline && Children.toArray(children).length > 3 ? 0 : undefined,
        'data-testid': 'turn-files-scroll',
      }}
    >
      {children}
    </OverlayScrollArea>
  );
}

function SummaryFiles({
  changedFiles,
  children,
  inline,
}: {
  changedFiles: ReactNode;
  children: ReactNode;
  inline: boolean;
}): JSX.Element {
  const clean = useCleanChatLook();
  if (!clean)
    return (
      <>
        {changedFiles}
        {children}
      </>
    );
  const hasChanges = Children.toArray(changedFiles).length > 0;
  const hasOutputs = Children.toArray(children).length > 0;
  return (
    <>
      {hasChanges && <FileList label="Changed files">{changedFiles}</FileList>}
      {hasOutputs && (
        <div className={hasChanges ? 'border-t' : undefined}>
          <FileList label="Saved files" inline={inline}>
            {children}
          </FileList>
        </div>
      )}
    </>
  );
}

function SummaryDisclosure({
  heading,
  detail,
  expanded,
  onToggle,
  id,
}: Pick<
  TurnFilesSummaryViewProps,
  'heading' | 'detail' | 'expanded' | 'onToggle'
> & { id: string }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={expanded ? 'Collapse changed files' : 'Expand changed files'}
      aria-expanded={expanded}
      aria-controls={id}
      className="focus-ring flex min-w-0 flex-auto flex-col justify-center rounded-sm text-left text-s pointer-coarse:min-h-11"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate fg-primary" data-turn-files-title="">
          {heading}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 fg-tertiary [&_svg]:size-3.5"
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      </span>
      {detail}
    </button>
  );
}

/** Shared summary chrome; file authorization, diff policy and actions stay in hosts. */
export function TurnFilesSummaryView({
  heading,
  classicHeading,
  detail,
  actions,
  expanded,
  onToggle,
  showFiles,
  turnId,
  singleFile,
  changedFiles,
  changedFileCount,
  children,
}: TurnFilesSummaryViewProps): JSX.Element {
  const clean = useCleanChatLook();
  const id = useId();
  const changeCount = changedFileCount ?? Children.toArray(changedFiles).length;
  const singleOutput =
    clean &&
    !singleFile &&
    changeCount === 0 &&
    Children.toArray(children).length === 1;
  const visible =
    singleOutput || (!(clean && singleFile) && (showFiles ?? expanded));
  // Keep opened output controls mounted while folded: their host owns the
  // browser identity and focus-return subscription. Closed history stays lazy.
  const [hasOpened, setHasOpened] = useState(visible);
  useEffect(() => {
    if (visible) setHasOpened(true);
  }, [visible]);
  return (
    <div
      data-testid="turn-files"
      data-turn-id={turnId}
      className={
        clean
          ? `overflow-hidden rounded-xl border bg-base ${singleOutput ? 'group/turn-file grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-3 pl-3 pr-4' : ''}`
          : 'rounded-md border bg-fg-primary/[0.02] px-3 py-2'
      }
    >
      {clean ? (
        <div
          className={
            singleOutput
              ? 'contents group/turn-file'
              : `group/turn-file flex flex-wrap items-center gap-x-3 gap-y-2 pl-3 pr-4 ${singleFile || !detail ? 'py-3' : 'py-2.5'}`
          }
        >
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fg-primary/[0.06] fg-secondary [&_svg]:size-4"
          >
            <FileDiff size="md" />
          </span>
          {singleFile ??
            (!singleOutput && (
              <SummaryDisclosure
                heading={heading}
                detail={detail}
                expanded={expanded}
                onToggle={onToggle}
                id={id}
              />
            ))}
          {actions}
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={id}
          className="flex w-full items-center gap-x-2 text-xs pointer-coarse:min-h-11"
        >
          <span className="flex-shrink-0 fg-secondary">
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          {classicHeading ?? (
            <span className="font-medium fg-primary">{heading}</span>
          )}
        </button>
      )}
      <div
        id={id}
        hidden={!visible}
        className={
          !visible
            ? 'hidden'
            : singleOutput
              ? `min-w-0 col-start-2 row-start-1 ${actions ? 'col-end-3' : 'col-end-4'}`
              : clean
                ? 'border-t'
                : 'mt-2 flex flex-wrap gap-2'
        }
      >
        {!(clean && singleFile) && (visible || hasOpened) && (
          <SummaryFiles changedFiles={changedFiles} inline={singleOutput}>
            {children}
          </SummaryFiles>
        )}
      </div>
    </div>
  );
}
