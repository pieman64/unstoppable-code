import {
  type ComponentType,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useCallback,
  useRef,
  useState,
} from 'react';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from './ActionMenuItems';
import { FloatingMenu } from './FloatingMenu';
import { isMenuOpenBodyFlagSet } from '../lib/menu-open-body-flag';
import { SECONDARY_ACTION_BUTTON_CLASS } from '../lib/row-chips';
import {
  ChevronRightMediumIcon,
  EyeIcon,
  LinkIcon,
  MoreHorizontalIcon,
} from '../icons/AppIcons';
import { curatedLogoKey } from '../lib/curated-logo-key';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import {
  collapsedSectionCount,
  visibleSectionEntries,
  type PluginsDiscoverySection,
} from '../lib/plugins-discovery-sections';
import type { UnifiedEntryState } from '@canopy/protocol/unified-entry';
import {
  UNIFIED_ENTRY_SURFACE_LABELS,
  type UnifiedPluginEntry,
} from '../lib/unified-plugin-entry';
import { marketplaceCardSubtitle } from '../lib/marketplace-card-subtitle';
import { marketplaceKindToneClass } from '../lib/marketplace-type-tabs';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../lib/customize-grid';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { ShareActionButton } from './ShareActionButton';
import type {
  MarketplaceEntryShareState,
  MarketplaceEntryShareStates,
} from '../lib/marketplace-share';
import { ShareAudienceLabel } from './ShareAudienceLabel';
import {
  alwaysAvailableReason,
  type InstalledEntryStatusStates,
} from '../lib/installed-item-status';
import { InstalledItemStatusPicker } from './InstalledItemStatusPicker';
import {
  InstalledItemStatusControl,
  type InstalledItemSetStatus,
} from './InstalledItemStatusRow';
import { McpConnectionStatusBadge } from './McpConnectionStatusBadge';

/**
 * Sectioned discovery grid for the capability marketplace.
 *
 * Cards carry `plugins-entry-<entry.id>`. Entries with a genuine secondary
 * action also carry `plugins-entry-menu-<entry.id>`. The section contract and
 * its collapsing helpers live in `./pluginsDiscoverySections`.
 */
export type {
  PluginsDiscoverySection,
  PluginsDiscoverySectionId,
} from '../lib/plugins-discovery-sections';

export interface PluginsDiscoveryListProps {
  sections: PluginsDiscoverySection[];
  /** Entry whose detail surface is currently open, if any. */
  selectedEntryId: string | null;
  onSelectEntry: (entry: UnifiedPluginEntry) => void;
  /**
   * Starts the entry's add flow without opening its detail surface first.
   * Omitted by hosts that have no add flow of their own (the public web
   * Marketplace, where installing happens on the share page), in which case
   * `available` cards render no Add button rather than one that merely
   * navigates.
   */
  onAddEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * Share state per entry id, supplied by a host with sharing capability.
   * An entry with a state shows Share: enabled, or disabled with its reason.
   * An entry without one shows no Share. Omit the map (or `onShareEntry`)
   * on hosts that cannot share.
   */
  entryShareStates?: MarketplaceEntryShareStates;
  /** Opens the share flow for an entry whose state is `shareable`. */
  onShareEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * Handles the card menu's "Connect" item, offered only for `needs-auth`
   * entries. Omitted by hosts that have no auth flow to route into.
   */
  onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * Opens another entry's detail by id, for the requirement chips a plugin
   * that needs several integrations carries (REG-3033). Omitted by hosts
   * without in-place navigation, in which case the chips are plain labels.
   */
  onOpenEntryId?: (entryId: string) => void;
  /** Rendered when every section is empty. */
  emptyMessage: string;
  /** Host-specific logo adapter; defaults to the browser-safe shared renderer. */
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  /** Desktop mixed pipeline catalogs label sources; other hosts retain their existing cards. */
  showPipelineSources?: boolean;
  hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  /**
   * `label`: installed and needs-auth cards show a disabled Installed action,
   * and the update pill moves to the Updates section. Default keeps cards as-is.
   */
  installedAction?: 'none' | 'label';
  /**
   * Installed status per entry (CAN-4255). Installed cards with a state show
   * the status picker; rows without one show none. Memoize it: the grid
   * re-renders on every keystroke.
   */
  entryStatus?: PluginsEntryStatusBinding;
}

export interface PluginsEntryStatusBinding {
  readonly states: InstalledEntryStatusStates;
  readonly pendingKeys: ReadonlySet<string>;
  /** Omit to show each status read-only. */
  readonly onSetStatus?: InstalledItemSetStatus;
  readonly onError?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * Badge for a card's state. `installed` is deliberately unlabeled: its dots
 * action communicates that it is already present without repeating status
 * copy in every search result.
 */
const STATE_BADGE_LABELS: Record<UnifiedEntryState, string | null> = {
  installed: null,
  'needs-auth': 'Needs attention',
  available: null,
};

interface PluginsEntryMenuProps {
  entry: UnifiedPluginEntry;
  onSelect: (entry: UnifiedPluginEntry) => void;
  onConnect?: (entry: UnifiedPluginEntry) => void;
}

/**
 * A card's compact actions menu. Installed entries expose View, while
 * needs-auth entries expose Connect when the host provides that flow.
 */
function PluginsEntryMenu({
  entry,
  onSelect,
  onConnect,
}: PluginsEntryMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const items: ActionMenuItem<'connect' | 'view'>[] = [];
  if (entry.state === 'needs-auth' && onConnect) {
    items.push({
      key: 'connect',
      label: 'Connect',
      icon: <LinkIcon />,
      testId: `plugins-menu-connect-${entry.id}`,
      onSelect: (): void => onConnect(entry),
    });
  }
  items.push({
    key: 'view',
    label: 'View',
    icon: <EyeIcon />,
    testId: `plugins-menu-view-${entry.id}`,
    onSelect: (): void => onSelect(entry),
  });

  return (
    <div className="relative mr-4 shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`plugins-entry-menu-${entry.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${entry.name}`}
        onPointerDown={() => {
          // FloatingMenu suppresses the click that completes an outside-menu
          // dismissal. Open on this pointerdown when another menu owns that
          // flag so switching directly between card menus still takes one
          // press.
          if (!open && isMenuOpenBodyFlagSet(document)) {
            setOpen(true);
          }
        }}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg fg-tertiary transition-colors hover:bg-subtle hover:fg-primary pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <MoreHorizontalIcon width={16} height={16} aria-hidden />
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        data-testid={`plugins-entry-menu-surface-${entry.id}`}
        className="min-w-40"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={items}
            onSelect={(item): void => {
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
              item.onSelect?.();
            }}
          />
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}

interface PluginsEntryCardProps {
  entry: UnifiedPluginEntry;
  selected: boolean;
  onSelect: (entry: UnifiedPluginEntry) => void;
  onAdd?: (entry: UnifiedPluginEntry) => void;
  shareState: MarketplaceEntryShareState | undefined;
  onShare?: (entry: UnifiedPluginEntry) => void;
  onConnect?: (entry: UnifiedPluginEntry) => void;
  onOpenEntryId?: (entryId: string) => void;
  McpServerLogoComponent: ComponentType<McpServerLogoProps>;
  showPipelineSources?: boolean;
  showEntryType: boolean;
  hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  installedAction: 'none' | 'label';
  entryStatus?: PluginsEntryStatusBinding;
}

/**
 * One discovery card. Memoized because the grid re-renders on every keystroke;
 * with a stable `onSelect` identity only the cards whose own props changed
 * re-render.
 */
const PluginsEntryCard = memo(function PluginsEntryCard({
  entry,
  selected,
  onSelect,
  onAdd,
  shareState,
  onShare,
  onConnect,
  onOpenEntryId,
  McpServerLogoComponent,
  showPipelineSources,
  showEntryType,
  hrefForEntry,
  installedAction,
  entryStatus,
}: PluginsEntryCardProps): JSX.Element {
  const statusState = entryStatus?.states[entry.id];
  // In a list that shows status, every installed row keeps the status slot,
  // even a kind without a status, so names and pickers align down the list.
  const statusSlot =
    entryStatus !== undefined &&
    (statusState !== undefined || entry.state !== 'available');
  // A built-in workflow has no status of its own; it is always Available.
  const fixedStatusReason = statusSlot
    ? alwaysAvailableReason(entry)
    : undefined;
  const pendingUninstall =
    statusState?.kind === 'ready' &&
    statusState.item.notices.some(
      (notice) => notice.code === 'partial_removal',
    );
  const showInstalledLabel =
    installedAction === 'label' &&
    (entry.state === 'installed' || entry.state === 'needs-auth');
  const shareBlockedReason =
    shareState?.status === 'blocked' ? shareState.reason : undefined;
  const showShare = onShare !== undefined && shareState !== undefined;
  // An MCP entry's connection badge is its status; the generic state badge
  // would repeat it.
  const stateBadge =
    entry.connection === undefined ? STATE_BADGE_LABELS[entry.state] : null;
  const includedPlugin = entry.integration?.plugin;
  const requirements = entry.requirements ?? [];
  const subtitle = entry.description
    ? marketplaceCardSubtitle(entry.name, entry.description)
    : '';

  const href = hrefForEntry?.(entry);
  const primaryProps = {
    'data-marketplace-entry': 'true',
    'data-testid': `plugins-entry-${entry.id}`,
    'data-selected': selected ? 'true' : 'false',
    className: `focus-ring flex min-w-0 flex-1 items-center gap-4 rounded-xl px-4 py-3.5 text-left pointer-coarse:min-h-11 ${
      selected ? 'bg-selected' : ''
    }`,
    children: (
      <>
        <McpServerLogoComponent
          curatedKey={curatedLogoKey(entry)}
          logoUrl={entry.logoUrl}
          bundledLogo={entry.bundledLogo}
          brandMark={entry.brandMark}
          size={36}
          fallback="monogram"
          name={entry.name}
          shape="circle"
          fit="contain"
          imgTestId={`marketplace-product-logo-${entry.id}`}
          fallbackTestId={`marketplace-product-logo-fallback-${entry.id}`}
        />
        <span
          data-testid={`plugins-card-copy-${entry.id}`}
          className="min-w-0 flex-1"
        >
          {/* Badges never wrap or squeeze the name: when the row is too
              narrow for both, they move under it as a group. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-s font-medium fg-primary">
              {entry.name}
            </span>
            {showEntryType && entry.typeLabel && (
              <span
                data-testid={`plugins-card-type-${entry.id}`}
                className={`shrink-0 text-xs ${marketplaceKindToneClass(entry.kind)}`}
              >
                {entry.typeLabel}
              </span>
            )}
            {entry.sharedWith && (
              <ShareAudienceLabel
                audience={entry.sharedWith.audience}
                personal={entry.sharedWith.personal}
                teamName={entry.sharedWith.name}
                dataTestId={`plugins-card-shared-with-${entry.id}`}
              />
            )}
            {showPipelineSources &&
              entry.kind === 'pipeline' &&
              entry.sourceLabel && (
                // Routine metadata, so plain text rather than a pill.
                <span
                  data-testid={`plugins-pipeline-source-${entry.id}`}
                  className="shrink-0 text-xs fg-tertiary"
                >
                  {entry.sourceLabel}
                </span>
              )}
            {entry.recommended && (
              <span className="shrink-0 rounded-full bg-accent-subtle px-1.5 py-0.5 text-3xs font-medium fg-accent whitespace-nowrap">
                Recommended
              </span>
            )}
            {stateBadge && (
              <span className="shrink-0 rounded-full bg-warning-subtle px-1.5 py-0.5 text-3xs font-medium fg-warning whitespace-nowrap">
                {stateBadge}
              </span>
            )}
            {entry.updateAvailable === true && installedAction !== 'label' && (
              <span
                data-testid={`plugins-update-available-${entry.id}`}
                className="shrink-0 rounded-full bg-accent-subtle px-1.5 py-0.5 text-3xs font-medium fg-accent whitespace-nowrap"
              >
                Update available
              </span>
            )}
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
            {entry.surface && (
              <span
                data-testid={`plugins-surface-${entry.id}`}
                className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary whitespace-nowrap"
              >
                {UNIFIED_ENTRY_SURFACE_LABELS[entry.surface]}
              </span>
            )}
          </span>
          {subtitle && (
            <span
              data-testid={`plugins-card-subtitle-${entry.id}`}
              className={`mt-0.5 block truncate text-xs fg-tertiary ${entry.ref.type === 'local-agent' ? REPLAY_BLOCK_CLASS : ''}`}
            >
              {subtitle}
            </span>
          )}
          {includedPlugin && includedPlugin.skills > 0 && (
            // One card per integration: the plugin that ships its skills is
            // part of the card, not a second card (REG-3033).
            <span
              data-testid={`plugins-includes-${entry.id}`}
              className="mt-1 block truncate text-xs fg-tertiary"
            >
              {`Includes ${includedPlugin.name} skills`}
            </span>
          )}
        </span>
      </>
    ),
  };

  return (
    <div className="-ml-4 flex flex-col rounded-xl transition-colors hover:bg-subtle">
      <div className="flex items-center gap-1">
        {href !== undefined ? (
          <a
            {...primaryProps}
            href={href}
            onClick={(event): void => {
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
            }}
          />
        ) : (
          <button
            {...primaryProps}
            type="button"
            onClick={() => onSelect(entry)}
          />
        )}

        {(showShare ||
          showInstalledLabel ||
          statusSlot ||
          (entry.state === 'available' && onAdd !== undefined)) && (
          <div
            data-testid={`plugins-card-actions-${entry.id}`}
            className="mr-4 flex min-w-16 shrink-0 items-center justify-center gap-2"
          >
            {statusSlot && (
              // A fixed, right-aligned 144px slot, so pickers line up down
              // the list whatever their status and installed rows without a
              // status keep the same text width.
              <span className="flex w-36 shrink-0 justify-end">
                {entryStatus && statusState !== undefined ? (
                  <InstalledItemStatusControl
                    itemName={entry.name}
                    state={statusState}
                    pendingKeys={entryStatus.pendingKeys}
                    onSetStatus={entryStatus.onSetStatus}
                    onError={entryStatus.onError}
                    testId={`plugins-entry-status-${entry.id}`}
                  />
                ) : (
                  fixedStatusReason !== undefined && (
                    <InstalledItemStatusPicker
                      itemName={entry.name}
                      status="available"
                      disabledReason={fixedStatusReason}
                      testId={`plugins-entry-status-${entry.id}`}
                    />
                  )
                )}
              </span>
            )}
            {/* One trailing slot of the same width on every row, so a Share
                icon and an Add button line up down the column. The
                accessible name distinguishes each resource. A disabled
                action explains the restriction in its tooltip. */}
            {showShare && onShare && (
              <ShareActionButton
                placement="row"
                dataTestId={`plugins-entry-share-${entry.id}`}
                ariaLabel={`Share ${entry.name}`}
                onClick={() => onShare(entry)}
                disabled={shareBlockedReason !== undefined}
                disabledReason={shareBlockedReason}
              />
            )}
            {entry.state === 'available' &&
              !pendingUninstall &&
              onAdd !== undefined && (
                <button
                  type="button"
                  data-testid={`plugins-entry-add-${entry.id}`}
                  aria-label={`Add ${entry.name}`}
                  onClick={() => onAdd(entry)}
                  className={SECONDARY_ACTION_BUTTON_CLASS}
                >
                  Add
                </button>
              )}
            {showInstalledLabel && (
              <button
                type="button"
                disabled
                data-testid={`plugins-entry-installed-${entry.id}`}
                aria-label={`${entry.name} is installed`}
                className={`${SECONDARY_ACTION_BUTTON_CLASS} disabled:cursor-default disabled:opacity-60`}
              >
                Installed
              </button>
            )}
          </div>
        )}

        {entry.state === 'needs-auth' && onConnect !== undefined && (
          <PluginsEntryMenu
            entry={entry}
            onSelect={onSelect}
            onConnect={onConnect}
          />
        )}
      </div>
      {requirements.length > 0 && (
        // The integrations a multi-connection plugin needs, each a control of
        // its own beside the card rather than nested inside its primary
        // control (REG-3033).
        <div
          data-testid={`plugins-requirements-${entry.id}`}
          className="flex flex-wrap items-center gap-1 px-4 pb-3 text-xs fg-tertiary"
        >
          <span className="w-9 shrink-0" aria-hidden />
          <span className="ml-4">Needs</span>
          {requirements.map((requirement) => (
            <button
              key={requirement.key}
              type="button"
              data-testid={`plugins-requirement-${entry.id}-${requirement.key}`}
              disabled={onOpenEntryId === undefined}
              onClick={() => onOpenEntryId?.(requirement.entryId)}
              className="focus-ring rounded-full bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary enabled:hover:fg-primary disabled:cursor-default"
            >
              {requirement.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

interface PluginsDiscoverySectionViewProps {
  section: PluginsDiscoverySection;
  selectedEntryId: string | null;
  onSelectEntry: (entry: UnifiedPluginEntry) => void;
  onAddEntry?: (entry: UnifiedPluginEntry) => void;
  entryShareStates?: MarketplaceEntryShareStates;
  onShareEntry?: (entry: UnifiedPluginEntry) => void;
  onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  onOpenEntryId?: (entryId: string) => void;
  McpServerLogoComponent: ComponentType<McpServerLogoProps>;
  showPipelineSources?: boolean;
  hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  installedAction: 'none' | 'label';
  entryStatus?: PluginsEntryStatusBinding;
}

function PluginsDiscoverySectionView({
  section,
  selectedEntryId,
  onSelectEntry,
  onAddEntry,
  entryShareStates,
  onShareEntry,
  onConnectEntry,
  onOpenEntryId,
  McpServerLogoComponent,
  showPipelineSources,
  hrefForEntry,
  installedAction,
  entryStatus,
}: PluginsDiscoverySectionViewProps): JSX.Element {
  const collapsedCount = collapsedSectionCount(section);
  const entries = visibleSectionEntries(section);
  const headingContent = section.onExpand ? (
    <button
      type="button"
      data-testid={`plugins-section-heading-${section.id}`}
      aria-label={`Browse ${section.title}`}
      onClick={section.onExpand}
      className="focus-ring group -ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1 text-left font-medium"
    >
      <span
        data-testid="plugins-section-heading-title"
        className="fg-primary transition-colors group-hover:fg-secondary"
      >
        {section.title}
      </span>
      <ChevronRightMediumIcon
        size={16}
        aria-hidden
        data-testid="plugins-section-heading-chevron"
        className="fg-tertiary transition-transform duration-200 ease-out group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
      />
    </button>
  ) : (
    <span className="fg-primary inline-flex h-7 items-center">
      {section.title}
    </span>
  );

  return (
    <section
      data-testid={`plugins-section-${section.id}`}
      // Cards this section currently contributes.
      data-row-count={entries.length}
      data-collapsed-count={collapsedCount}
      data-virtualized="false"
    >
      {/* Heading + hairline, per the reference: the rule spans the column and
          separates bands without boxing them, so the cards read as content on
          the page rather than rows in a table. */}
      {section.title !== '' &&
        (section.headerActions ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2">
            <h2 className="text-m font-medium">{headingContent}</h2>
            {section.headerActions}
          </div>
        ) : (
          <h2 className="border-b pb-2 text-m font-medium">{headingContent}</h2>
        ))}
      {entries.length === 0 && section.emptyMessage !== undefined && (
        <p
          data-testid={`plugins-section-empty-${section.id}`}
          className="py-10 text-center text-s fg-secondary"
        >
          {section.emptyMessage}
        </p>
      )}
      <div
        data-testid={`plugins-section-body-${section.id}`}
        className={`mt-3 ${CUSTOMIZE_ROW_GRID_CLASS}`}
      >
        {entries.map((entry) => (
          <PluginsEntryCard
            key={entry.id}
            entry={entry}
            selected={entry.id === selectedEntryId}
            onSelect={onSelectEntry}
            onAdd={onAddEntry}
            shareState={entryShareStates?.get(entry.id)}
            onShare={onShareEntry}
            onConnect={onConnectEntry}
            onOpenEntryId={onOpenEntryId}
            McpServerLogoComponent={McpServerLogoComponent}
            showPipelineSources={showPipelineSources}
            showEntryType={section.showEntryTypes === true}
            hrefForEntry={hrefForEntry}
            installedAction={installedAction}
            entryStatus={entryStatus}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function PluginsDiscoveryList({
  sections,
  selectedEntryId,
  onSelectEntry,
  onAddEntry,
  entryShareStates,
  onShareEntry,
  onConnectEntry,
  onOpenEntryId,
  emptyMessage,
  McpServerLogoComponent = McpServerLogo,
  showPipelineSources = false,
  hrefForEntry,
  installedAction = 'none',
  entryStatus,
}: PluginsDiscoveryListProps): JSX.Element {
  const populated = sections.filter(
    (section) =>
      section.entries.length > 0 || section.headerActions !== undefined,
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const entries = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          '[data-marketplace-entry="true"]',
        ),
      );
      const index = entries.findIndex(
        (entry) => entry === document.activeElement,
      );
      if (index === -1) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = entries[index + delta];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: 'nearest' });
    },
    [],
  );

  if (populated.length === 0) {
    return (
      <p className="py-10 text-center text-s fg-secondary">{emptyMessage}</p>
    );
  }

  return (
    <div
      className="space-y-10"
      data-testid="plugins-discovery-list"
      onKeyDown={handleKeyDown}
    >
      {populated.map((section) => (
        <PluginsDiscoverySectionView
          key={section.id}
          section={section}
          selectedEntryId={selectedEntryId}
          onSelectEntry={onSelectEntry}
          onAddEntry={onAddEntry}
          entryShareStates={entryShareStates}
          onShareEntry={onShareEntry}
          onConnectEntry={onConnectEntry}
          onOpenEntryId={onOpenEntryId}
          McpServerLogoComponent={McpServerLogoComponent}
          showPipelineSources={showPipelineSources}
          hrefForEntry={hrefForEntry}
          installedAction={installedAction}
          entryStatus={entryStatus}
        />
      ))}
    </div>
  );
}
