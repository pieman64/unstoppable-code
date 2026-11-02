import type { ComponentType, JSX, MouseEvent, ReactNode } from 'react';
import { ClaudeLogo, CodexLogo } from '../icons';
import { AutomationsIcon, PersonIcon, TriggerIcon } from '../icons/AppIcons';
import { curatedLogoKey } from '../lib/curated-logo-key';
import {
  customizeRowEditedLine,
  customizeRowSecondLine,
  pendingSignInLabel,
  sharedByMeLine,
} from '../lib/customize-row-copy';
import { displayVersion } from '../lib/display-version';
import { formatRelativeTime } from '../lib/format-relative-time';
import { useMinuteClock } from '../lib/useMinuteClock';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import {
  CustomizeRowMenu,
  type CustomizeRowMenuItem,
} from './CustomizeRowMenu';
import { Button, buttonClassName } from './Button';
import { CustomizeSharedByMeSubtitle } from './CustomizeSharedByMeSubtitle';
import { EntrySourceLabel, showsEntrySourceLabel } from './EntrySourceLabel';
import { EntrySurfaceIcon } from './EntrySurfaceIcon';
import { McpConnectionStatusBadge } from './McpConnectionStatusBadge';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import { Tooltip } from './Tooltip';
import { WorkflowLastRunText } from './WorkflowLastRunText';
import { MarketplaceTypeLabel } from './MarketplaceTypeLabel';

// The read-only sign-in chip wears the clickable one's compact warning look,
// so the column keeps one chip size whether or not the row can connect.
const SIGN_IN_CHIP_CLASS = buttonClassName({
  variant: 'warning',
  size: 'compact',
});

const EDITED_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'full',
  timeStyle: 'long',
});

function CustomSkillMetadata({
  entry,
}: {
  readonly entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const editedAt = entry.editedAt;
  if (!editedAt || !Number.isFinite(Date.parse(editedAt))) return null;
  return (
    <span
      data-testid={`customize-row-subtitle-${entry.id}`}
      className="mt-0.5 block min-w-0 text-xs fg-tertiary"
    >
      <SkillUpdatedTime entryId={entry.id} editedAt={editedAt} />
    </span>
  );
}

function SkillUpdatedTime({
  entryId,
  editedAt,
}: {
  readonly entryId: string;
  readonly editedAt: string;
}): JSX.Element {
  const now = useMinuteClock();
  const fullDate = EDITED_TIME_FORMAT.format(new Date(editedAt));
  return (
    <Tooltip label={fullDate}>
      <span
        data-testid={`customize-row-edited-${entryId}`}
        className="inline-flex items-center whitespace-nowrap"
        aria-label={`Updated ${fullDate}`}
      >
        Updated&nbsp;
        <time dateTime={editedAt}>{formatRelativeTime(editedAt, now)}</time>
      </span>
    </Tooltip>
  );
}

function CustomSkillBadge({
  entry,
  selected,
}: {
  readonly entry: UnifiedPluginEntry;
  readonly selected: boolean;
}): JSX.Element {
  const creator = entry.authorName?.trim();
  const label = creator ? `Custom skill by ${creator}` : 'Custom skill';
  return (
    <span className="absolute -bottom-1 -right-1 z-10 inline-flex overflow-visible">
      <Tooltip
        label={
          <span className={creator ? REPLAY_BLOCK_CLASS : undefined}>
            {label}
          </span>
        }
      >
        <span
          data-testid={`customize-row-custom-${entry.id}`}
          role="img"
          aria-label={label}
          className={`inline-flex size-4 items-center justify-center rounded-full bg-fg-primary [color:var(--bg-primary)] ring-2 ${
            selected
              ? 'ring-selected'
              : 'ring-[var(--bg-primary)] group-hover/skill-row:ring-subtle'
          } ${creator ? REPLAY_BLOCK_CLASS : ''}`}
        >
          <PersonIcon
            size={10}
            exactSize
            drawnStrokeWidth={1.4}
            aria-hidden="true"
          />
        </span>
      </Tooltip>
    </span>
  );
}

/** A DOM id unique per section, since one entry may appear in several. */
export function customizeRowDomId(sectionId: string, entryId: string): string {
  return `customize-${encodeURIComponent(sectionId)}-${encodeURIComponent(entryId)}`;
}

export interface CustomizeInstalledRowProps {
  readonly entry: UnifiedPluginEntry;
  /** Owning section; qualifies DOM ids and scopes test ids. */
  readonly sectionId: string;
  readonly selected?: boolean;
  readonly showEntryType?: boolean;
  readonly onSelect: (entry: UnifiedPluginEntry) => void;
  /** Semantic link target; plain clicks still route through `onSelect`. */
  readonly href?: string;
  readonly menuItems?: readonly CustomizeRowMenuItem[];
  /** Extension slot for status controls supplied by a later surface. */
  readonly status?: ReactNode;
  /** Visible row actions such as Update or an unshare control. */
  readonly actions?: ReactNode;
  /**
   * Starts sign-in from the sign-in or attention chip. Omit when the row has
   * nothing to connect; the chip is then plain text.
   */
  readonly onConnect?: (entry: UnifiedPluginEntry) => void;
  /**
   * What the chip connects, for its accessible name, when that is not this
   * row (a plugin row signing in to a bundled server). Defaults to the row.
   */
  readonly connectName?: string;
  /**
   * A Disabled item (CAN-4838): the logo, name, inline badges, subtitle and
   * version text take 60% opacity; the harness icons, connection badge, focus
   * ring, status, actions and menu keep full ink.
   */
  readonly dimmed?: boolean;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}

function HarnessIcons({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const harnesses = entry.installedHarnesses;
  if (harnesses?.claude !== true && harnesses?.codex !== true) return null;
  return (
    <span
      data-testid={`customize-row-harnesses-${entry.id}`}
      className="flex shrink-0 items-center gap-1.5"
    >
      {harnesses.claude === true && (
        <Tooltip label="Installed for Claude">
          <ClaudeLogo
            width={14}
            height={14}
            role="img"
            aria-label="Installed for Claude"
            tabIndex={0}
            className="focus-ring shrink-0 rounded-sm fg-secondary"
          />
        </Tooltip>
      )}
      {harnesses.codex === true && (
        <Tooltip label="Installed for Codex">
          <CodexLogo
            width={14}
            height={14}
            role="img"
            aria-label="Installed for Codex"
            tabIndex={0}
            className="focus-ring shrink-0 rounded-sm fg-secondary"
          />
        </Tooltip>
      )}
    </span>
  );
}

/**
 * One Installed, Updates or Shared by me row. The primary control and the
 * trailing controls are siblings, so a secondary action never opens details.
 */
export function CustomizeInstalledRow({
  entry,
  sectionId,
  selected = false,
  showEntryType = false,
  onSelect,
  href,
  menuItems = [],
  status,
  actions,
  onConnect,
  connectName,
  dimmed = false,
  McpServerLogoComponent = McpServerLogo,
}: CustomizeInstalledRowProps): JSX.Element {
  const domId = customizeRowDomId(sectionId, entry.id);
  const version = displayVersion(entry.version);
  // The second line names where the item came from, or its description when
  // no source is worth naming (CAN-4840). A server a plugin bundled names its
  // plugin; the row menu leads there when the host can open entries
  // (`onOpenEntryId`).
  const bundledBy = entry.bundledBy;
  // Workflow rows keep their dedicated metadata lines.
  const workflow = bundledBy ? undefined : entry.workflow;
  const triggers = workflow?.triggers ?? [];
  const firstTrigger = triggers[0];
  const triggerLabel =
    triggers.length > 1
      ? `${String(triggers.length)} triggers`
      : firstTrigger?.label;
  const triggerSteps =
    workflow?.stepCount === undefined
      ? ''
      : ` · ${String(workflow.stepCount)} ${workflow.stepCount === 1 ? 'step' : 'steps'}`;
  const triggerTooltip =
    (triggers.length > 1
      ? triggers
          .map((trigger) => `${trigger.label}: ${trigger.explainer}`)
          .join(' · ')
      : `Trigger: ${firstTrigger?.explainer ?? ''}`) + triggerSteps;
  const customSkill = entry.kind === 'skill' && entry.custom === true;
  const showCustomMetadata =
    customSkill &&
    !entry.installedFrom &&
    !bundledBy &&
    sectionId !== 'shared-by-me';
  const sharedLine =
    sectionId === 'shared-by-me' ? sharedByMeLine(entry) : undefined;
  const subtitle =
    showCustomMetadata || sectionId === 'shared-by-me'
      ? undefined
      : customizeRowSecondLine(entry);
  // Keep the edit date whole while the preceding words truncate in CSS.
  const editedLine =
    sectionId === 'shared-by-me' || showCustomMetadata
      ? undefined
      : customizeRowEditedLine(entry);
  // Keep the source hook on catalog metadata only; authored, bundled and
  // shared rows retain the copy helper's higher-priority source.
  const showCatalogSource =
    sectionId !== 'shared-by-me' &&
    showsEntrySourceLabel(entry) &&
    subtitle === entry.sourceLabel?.trim();
  // Only real pending sign-ins are counted (`pendingSignIns`, set by the
  // entry projection); any other problem keeps `Needs attention`. A plugin
  // counts the sign-ins its bundled servers wait for. The host decides what
  // the chip connects through `onConnect`.
  const signInCount = entry.pendingSignIns ?? 0;
  const attentionLabel =
    signInCount > 0
      ? pendingSignInLabel(signInCount)
      : entry.state === 'needs-auth'
        ? 'Needs attention'
        : undefined;
  // Opacity on the control itself would dim its focus ring, so the content
  // wrapper carries it.
  const content = (
    <span
      data-testid={`customize-row-content-${entry.id}`}
      className={`flex min-w-0 flex-1 items-center gap-3${dimmed ? ' opacity-60' : ''}`}
    >
      <span className="relative inline-flex shrink-0 overflow-visible">
        <McpServerLogoComponent
          curatedKey={curatedLogoKey(entry)}
          logoUrl={entry.logoUrl}
          bundledLogo={entry.bundledLogo}
          brandMark={entry.brandMark}
          size={28}
          fallback="monogram"
          name={entry.name}
          shape="circle"
          fit="contain"
        />
        {customSkill && <CustomSkillBadge entry={entry} selected={selected} />}
      </span>
      <span className="min-w-0 flex-1">
        {/* The name and its labels stay on one line: a long name truncates
            instead of pushing the type label onto a line of its own. */}
        <span
          data-testid={`customize-row-name-line-${entry.id}`}
          className="flex min-w-0 items-center gap-x-1.5 overflow-hidden"
        >
          {/* The line clips rather than spilling into the row's controls.
              The name truncates as space runs out;
              the kind and surface icon stay whole. */}
          <span
            title={entry.name}
            className="min-w-0 truncate text-s font-medium fg-primary"
          >
            {entry.name}
          </span>
          {showEntryType && entry.typeLabel && (
            <MarketplaceTypeLabel
              kind={entry.kind}
              label={entry.typeLabel}
              dataTestId={`customize-row-type-${entry.id}`}
            />
          )}
          {entry.surface && (
            <EntrySurfaceIcon
              surface={entry.surface}
              testId={`plugins-surface-${entry.id}`}
            />
          )}
        </span>
        {workflow ? (
          <span className="mt-0.5 flex min-w-0 flex-col gap-0.5 text-xs fg-tertiary">
            <span
              data-testid={`customize-row-trigger-${entry.id}`}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5"
            >
              {firstTrigger && (
                <Tooltip
                  label={triggerTooltip}
                  contentClassName={
                    triggers.length > 1
                      ? 'max-w-xs whitespace-normal'
                      : undefined
                  }
                >
                  <span
                    tabIndex={0}
                    aria-label={`${triggerLabel}. ${triggerTooltip}`}
                    className="inline-flex items-center gap-1"
                  >
                    <TriggerIcon size={14} aria-hidden="true" />
                    <span>{triggerLabel}</span>
                  </span>
                </Tooltip>
              )}
              {workflow.schedule && (
                <Tooltip label={workflow.schedule.tooltip}>
                  <span className="inline-flex items-center gap-1">
                    <AutomationsIcon
                      width={14}
                      height={14}
                      aria-hidden="true"
                    />
                    <span>{workflow.schedule.label}</span>
                  </span>
                </Tooltip>
              )}
              {!workflow.triggers && !workflow.schedule && workflow.triggerText}
            </span>
            {workflow.sourceText && (
              <span
                data-testid={`customize-row-source-meta-${entry.id}`}
                className={
                  workflow.sourceIsPerson ? REPLAY_MASK_CLASS : undefined
                }
              >
                {workflow.sourceText}
              </span>
            )}
            {workflow.lastRun !== undefined && workflow.lastRun !== null && (
              <span data-testid={`customize-row-last-run-line-${entry.id}`}>
                <WorkflowLastRunText
                  lastRun={workflow.lastRun}
                  dataTestId={`customize-row-last-run-${entry.id}`}
                  variant="customize"
                />
              </span>
            )}
          </span>
        ) : showCustomMetadata ? (
          <CustomSkillMetadata entry={entry} />
        ) : sharedLine ? (
          <CustomizeSharedByMeSubtitle entryId={entry.id} line={sharedLine} />
        ) : subtitle ? (
          // A shared row's or shared copy's line names a person or their
          // team, so session replay never records it. A local agent always
          // reads `Created by you`, never its instructions.
          <span
            data-testid={
              bundledBy
                ? `customize-row-from-plugin-${entry.id}`
                : `customize-row-subtitle-${entry.id}`
            }
            className={`mt-0.5 min-w-0 text-xs fg-tertiary ${editedLine ? 'flex overflow-hidden' : 'block truncate'} ${entry.origin === 'shared' || entry.installedFrom ? REPLAY_BLOCK_CLASS : ''}`}
          >
            {editedLine ? (
              <>
                <span className="min-w-0 truncate">{editedLine.lead}</span>
                <span className="shrink-0 whitespace-pre">
                  {` ${editedLine.edited}`}
                </span>
              </>
            ) : showCatalogSource ? (
              <EntrySourceLabel
                entry={entry}
                testId={`customize-row-source-${entry.id}`}
                shrinkable
              />
            ) : (
              subtitle
            )}
          </span>
        ) : null}
      </span>
    </span>
  );
  const primaryProps = {
    id: domId,
    'data-marketplace-entry': 'true',
    'data-testid': `customize-row-${entry.id}`,
    'data-selected': selected ? 'true' : 'false',
    className: `focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-2.5 text-left pointer-coarse:min-h-11 ${
      selected ? 'bg-selected' : ''
    }`,
  };
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    onSelect(entry);
  };
  return (
    <li
      data-testid={`customize-${sectionId}-row-${entry.id}`}
      data-dimmed={dimmed ? 'true' : undefined}
      className="group/skill-row -ml-4 flex min-w-0 items-center gap-2 rounded-xl pr-4 transition-colors hover:bg-subtle"
    >
      {href !== undefined ? (
        <a {...primaryProps} href={href} onClick={onLinkClick}>
          {content}
        </a>
      ) : (
        <button {...primaryProps} type="button" onClick={() => onSelect(entry)}>
          {content}
        </button>
      )}
      {entry.custom !== true && version ? (
        <span
          data-testid={`customize-row-version-${entry.id}`}
          className="flex max-w-28 shrink-0 items-center gap-1 text-xs fg-tertiary"
        >
          {version && (
            <span className={`truncate${dimmed ? ' opacity-60' : ''}`}>
              {version}
            </span>
          )}
        </span>
      ) : null}
      {attentionLabel !== undefined &&
        (onConnect ? (
          <Button
            variant="warning"
            size="compact"
            data-testid={`customize-row-sign-in-${entry.id}`}
            aria-label={`${attentionLabel}. Connect ${connectName ?? entry.name}`}
            onClick={() => onConnect(entry)}
          >
            {attentionLabel}
          </Button>
        ) : (
          <span
            data-testid={`customize-row-sign-in-${entry.id}`}
            className={SIGN_IN_CHIP_CLASS}
          >
            {attentionLabel}
          </span>
        ))}
      <HarnessIcons entry={entry} />
      {/* Health shows only once a check has a result; a server that was
          never checked shows nothing rather than a "Not checked" chip. */}
      {entry.connection && entry.connection.status !== 'unknown' && (
        <McpConnectionStatusBadge
          badge={{
            status: entry.connection.status,
            isProvider: entry.connection.provider === true,
          }}
          dataTestId={`plugins-connection-status-${entry.id}`}
          providerTestId={`plugins-connection-provider-${entry.id}`}
        />
      )}
      {status}
      {actions}
      <CustomizeRowMenu
        entryName={entry.name}
        idPrefix={domId}
        items={menuItems}
        testId={`customize-row-menu-${entry.id}`}
      />
    </li>
  );
}
