import type { ComponentType, JSX, MouseEvent, ReactNode } from 'react';
import { ClaudeLogo, CodexLogo } from '../icons';
import { curatedLogoKey } from '../lib/curated-logo-key';
import { marketplaceCardSubtitle } from '../lib/marketplace-card-subtitle';
import { marketplaceKindToneClass } from '../lib/marketplace-type-tabs';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import {
  UNIFIED_ENTRY_SURFACE_LABELS,
  type UnifiedPluginEntry,
} from '../lib/unified-plugin-entry';
import {
  CustomizeRowMenu,
  type CustomizeRowMenuItem,
} from './CustomizeRowMenu';
import { McpConnectionStatusBadge } from './McpConnectionStatusBadge';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import { Tooltip } from './Tooltip';
import { UpdateMarker, displayVersion } from './UpdateMarker';

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
  McpServerLogoComponent = McpServerLogo,
}: CustomizeInstalledRowProps): JSX.Element {
  const domId = customizeRowDomId(sectionId, entry.id);
  const version = displayVersion(entry.version);
  const subtitle = entry.description
    ? marketplaceCardSubtitle(entry.name, entry.description)
    : '';
  const content = (
    <>
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
      <span className="min-w-0 flex-1">
        {/* Badges never squeeze the name to nothing: in a narrow grid
            column they move under it as a group, as on the Browse cards. */}
        <span
          data-testid={`customize-row-name-line-${entry.id}`}
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
        >
          <span className="min-w-0 max-w-full truncate text-s font-medium fg-primary">
            {entry.name}
          </span>
          {showEntryType && entry.typeLabel && (
            <span
              data-testid={`customize-row-type-${entry.id}`}
              className={`shrink-0 text-xs ${marketplaceKindToneClass(entry.kind)}`}
            >
              {entry.typeLabel}
            </span>
          )}
          {entry.state === 'needs-auth' && (
            <span className="shrink-0 rounded-full bg-warning-subtle px-1.5 py-0.5 text-3xs font-medium fg-warning">
              Needs attention
            </span>
          )}
          {entry.surface && (
            <span
              data-testid={`plugins-surface-${entry.id}`}
              className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary"
            >
              {UNIFIED_ENTRY_SURFACE_LABELS[entry.surface]}
            </span>
          )}
        </span>
        {subtitle && (
          // A local agent's description is its first instruction line, so
          // session replay never records it (same as the discovery cards).
          <span
            data-testid={`customize-row-subtitle-${entry.id}`}
            className={`mt-0.5 block truncate text-xs fg-tertiary ${entry.ref.type === 'local-agent' ? REPLAY_BLOCK_CLASS : ''}`}
          >
            {subtitle}
          </span>
        )}
      </span>
    </>
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
      className="-ml-4 flex min-w-0 items-center gap-2 rounded-xl pr-4 transition-colors hover:bg-subtle"
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
      {(version || entry.updateAvailable === true) && (
        <span
          data-testid={`customize-row-version-${entry.id}`}
          className="flex max-w-28 shrink-0 items-center gap-1 text-xs fg-tertiary"
        >
          {version && <span className="truncate">{version}</span>}
          {entry.updateAvailable === true && (
            <UpdateMarker
              latestVersion={entry.latestVersion}
              dataTestId={`customize-row-update-marker-${entry.id}`}
            />
          )}
        </span>
      )}
      <HarnessIcons entry={entry} />
      {entry.connection && (
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
