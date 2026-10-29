'use client';

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ComponentType,
  type JSX,
} from 'react';
import {
  ExternalTextLink,
  SecurityAuditSummary,
} from '@canopy/ui-shared/components';
import { isGitHubTreeUrl } from '@canopy/ui-shared/lib/github-tree-url';
import { parseSecurityAudit } from '@canopy/ui-shared/lib/security-audit';
import {
  ChatComposerToolbarChip,
  DeferredPluginsControl,
  DialogModal,
  Notice,
  PluginMemberDetails,
  UnifiedTable,
  type UnifiedTableRow,
  type UnifiedTableSourceOption,
} from '@canopy/ui-shared';
import { PluginsIcon } from '@canopy/ui-shared/icons';
import type { CapabilityUnavailable } from '@canopy/protocol/capability-bundle';
import type { InstalledItemSnapshot } from '@canopy/protocol/installed-items';
import {
  CAPABILITY_DESKTOP_ONLY_LABEL,
  CAPABILITY_NEEDS_RECONNECTING_LABEL,
  CAPABILITY_NO_LONGER_AVAILABLE_LABEL,
  CAPABILITY_NO_LONGER_SHARED_LABEL,
  CAPABILITY_NOT_SIGNED_IN_LABEL,
  CAPABILITY_REMOVE_LABEL,
  CAPABILITY_TURNED_OFF_LABEL,
  capabilityUnavailableLabel,
  goneCapabilitySelections,
  INHERITED_DEFAULT_BADGE_LABELS,
  mcpSelectionKey as mcpKey,
  pluginSelectionKey as pluginKey,
  skillSelectionKey as skillKey,
  UnavailableRemoveAction,
  withUnavailableRows,
  type CapabilitySelectionRef,
} from '../../capability/selectionRows';
import {
  portalCatalogEntryBlocker,
  type PortalChatTabPluginSelections,
  type PortalMcpConnectionMetadata,
  type PortalPluginCatalog,
  type PortalPluginCatalogUnifiedEntry,
} from '@canopy/protocol/portal';
/** What the picker says inline once a marketplace was added. */
export interface AddMarketplaceConfirmation {
  message: string;
  /** `attention` when the marketplace landed but something still needs a look. */
  intent: 'positive' | 'attention';
}

export type AddMarketplaceDialogComponent = ComponentType<{
  onClose: () => void;
  onCatalogRefresh: () => void | Promise<void>;
  /**
   * Called once the marketplace is added, just before the dialog closes; the
   * picker shows the confirmation inline instead of a Done screen (CAN-3710).
   */
  onAdded?: (confirmation: AddMarketplaceConfirmation) => void;
}>;

/**
 * Everything the host must supply for the "Add marketplace" affordance to
 * work: the dialog itself, and the callback that reloads the catalog the host
 * owns.
 *
 * The dialog is injected rather than imported because it talks to the hosting
 * app's own marketplace endpoints, and the host is also what decides how to
 * code-split it — this picker sits on the always-mounted chat input surface,
 * so the web app hands in a lazily loaded component.
 *
 * The two travel together in one optional object so a host cannot supply a
 * dialog with no way to refresh, or a refresh with no dialog to trigger it:
 * either combination type-checks but renders nothing. Omit the whole object
 * and the button that would open the dialog is not rendered.
 */
export interface AddMarketplaceSeam {
  dialog: AddMarketplaceDialogComponent;
  onCatalogRefresh: () => void | Promise<void>;
}

export interface AccountMcpEntryComponentProps {
  entry: PortalPluginCatalogUnifiedEntry;
  onRefresh?: () => void | Promise<void>;
}

/**
 * Everything the host supplies for account-tier MCP servers (entries carrying
 * a `connectionState`): the tool editor shown in a connected server's details,
 * and the focus-driven catalog refresh that picks up a connection completed in
 * another tab. Both talk to the hosting app's own connection endpoints, which
 * is why they are injected rather than imported. The picker only attaches
 * servers: it lists every account server, signed in or not, and signing in
 * happens in the chat's MCP Servers panel.
 */
export interface AccountMcpSeam {
  toolsEditor: ComponentType<AccountMcpEntryComponentProps>;
  catalogRefresh: ComponentType<{
    enabled: boolean;
    onRefresh?: () => void | Promise<void>;
  }>;
  onCatalogRefresh?: () => void | Promise<void>;
}

export interface PortalPluginsPickerProps {
  installedItems?: InstalledItemSnapshot;
  /** Stable target identity, available before deferred-policy hydration. */
  scopeKey?: string;
  catalog: PortalPluginCatalog | null;
  selections: PortalChatTabPluginSelections;
  providerType?: string;
  loading?: boolean;
  brandDisplayName: string;
  onChange: (selections: PortalChatTabPluginSelections) => void | Promise<void>;
  /** Supplied only when the selected host supports atomic policy commits. */
  deferredTools?: {
    key: string;
    allowed: boolean;
    save: (
      selections: PortalChatTabPluginSelections,
      allowed: boolean,
    ) => Promise<void>;
  };
  onOpen?: () => void;
  cloudScope?: boolean;
  marketplacesEnabled?: boolean;
  addMarketplace?: AddMarketplaceSeam;
  accountMcp?: AccountMcpSeam;
  notice?: string;
  /**
   * The part of `selections` the chat inherits from its project's default
   * plugins. Matching rows get a "Project default" badge and stay toggleable;
   * Save still sends the full effective selection.
   */
  inheritedSelections?: PortalChatTabPluginSelections;
  /**
   * The server's records of selected capabilities the chat's bundle could not
   * carry (REG-3042). A selected ref with a record gets its status and a
   * Remove action, and one the catalog no longer lists gets a row of its own,
   * so the chip count, the subtitle, and the rows always agree. A ref the
   * server calls gone is never saved back.
   */
  unavailable?: readonly CapabilityUnavailable[];
  /**
   * Called synchronously from the Save click, after `onChange`, with the
   * saved and the previous selection. A host that starts a sign-in for what
   * was just added opens its popup here, inside the user's gesture.
   */
  onApplied?: (
    next: PortalChatTabPluginSelections,
    previous: PortalChatTabPluginSelections,
  ) => void;
}

interface PickerDraft {
  collectionIds: Set<string>;
  skillKeys: Set<string>;
  pluginKeys: Set<string>;
  mcpKeys: Set<string>;
}

type DraftSetName = keyof PickerDraft;

interface PickerTableProjection {
  rows: UnifiedTableRow[];
  sources: UnifiedTableSourceOption[];
  setNameByKey: Map<string, DraftSetName>;
  selectionKeyByKey: Map<string, string>;
  detailsByKey: Map<string, PortalPluginCatalogUnifiedEntry>;
  /** Rows of selected capabilities the server recorded as unavailable. */
  removableKeys: Set<string>;
}

/**
 * Quiet row statuses for account servers that still need signing in. The row
 * stays selectable; signing in happens in the chat's MCP Servers panel.
 */
export const PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL =
  CAPABILITY_NOT_SIGNED_IN_LABEL;
export const PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL =
  CAPABILITY_NEEDS_RECONNECTING_LABEL;
export const PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL =
  INHERITED_DEFAULT_BADGE_LABELS.project;
export const PORTAL_PLUGINS_NO_LONGER_AVAILABLE_LABEL =
  CAPABILITY_NO_LONGER_AVAILABLE_LABEL;
export const PORTAL_PLUGINS_NO_LONGER_SHARED_LABEL =
  CAPABILITY_NO_LONGER_SHARED_LABEL;
export const PORTAL_PLUGINS_DESKTOP_ONLY_LABEL = CAPABILITY_DESKTOP_ONLY_LABEL;
export const PORTAL_PLUGINS_TURNED_OFF_LABEL = CAPABILITY_TURNED_OFF_LABEL;
export const PORTAL_PLUGINS_REMOVE_LABEL = CAPABILITY_REMOVE_LABEL;
export const portalPluginsUnavailableLabel = capabilityUnavailableLabel;

type McpConnectionState = PortalMcpConnectionMetadata['connectionState'];

function mcpSignInStatus(
  connectionState: McpConnectionState,
): string | undefined {
  if (connectionState === 'not_connected')
    return PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL;
  if (connectionState === 'reauth_required')
    return PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL;
  return undefined;
}

function pickerRowKey(
  kind: UnifiedTableRow['kind'],
  selectionKey: string,
): string {
  return `${kind}:${selectionKey}`;
}

function draftSelectionKey(
  setName: DraftSetName,
  selectionKey: string,
): string {
  return `${setName}:${selectionKey}`;
}

function draftSelectionKeys(
  selections: PortalChatTabPluginSelections | undefined,
): Set<string> {
  if (!selections) return new Set();
  return new Set([
    ...selections.collectionIds.map((id) =>
      draftSelectionKey('collectionIds', id),
    ),
    ...selections.skillRefs.map((ref) =>
      draftSelectionKey('skillKeys', skillKey(ref.sourceId, ref.skillName)),
    ),
    ...selections.pluginRefs.map((ref) =>
      draftSelectionKey(
        'pluginKeys',
        pluginKey(ref.marketplaceId, ref.pluginName),
      ),
    ),
    ...(selections.mcpServerRefs ?? []).map((ref) =>
      draftSelectionKey('mcpKeys', mcpKey(ref.serverId, ref.configId)),
    ),
  ]);
}

export function countPortalPluginSelections(
  selections: PortalChatTabPluginSelections,
): number {
  return (
    selections.collectionIds.length +
    selections.skillRefs.length +
    selections.pluginRefs.length +
    (selections.mcpServerRefs?.length ?? 0)
  );
}

function sourceIcon(
  support: PortalPluginCatalogUnifiedEntry['providerSupport'],
): UnifiedTableRow['sourceIcon'] {
  if (support.claude && support.codex) return 'mixed';
  if (support.claude) return 'claude';
  if (support.codex) return 'codex';
  return 'marketplace';
}

/** A relayed license is display text only when it is a non-empty string. */
function provenanceLicense(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unifiedSelectionKey(entry: PortalPluginCatalogUnifiedEntry): {
  key: string;
  kind: UnifiedTableRow['kind'];
  setName: DraftSetName;
} | null {
  const ref = entry.selectionRef;
  if (ref.type === 'skill') {
    return {
      key: skillKey(ref.sourceId, ref.skillName),
      kind: 'skill',
      setName: 'skillKeys',
    };
  }
  if (ref.type === 'marketplace-plugin') {
    return {
      key: pluginKey(ref.marketplaceId, ref.pluginName),
      kind: 'plugin',
      setName: 'pluginKeys',
    };
  }
  if (ref.type === 'mcp-server') {
    return {
      key: mcpKey(ref.serverId, ref.configId),
      kind: 'mcp',
      setName: 'mcpKeys',
    };
  }
  return null;
}

function entryUnsupported(
  entry: PortalPluginCatalogUnifiedEntry,
  providerType: string | undefined,
): boolean {
  if (providerType === 'claude') return !entry.providerSupport.claude;
  if (providerType === 'codex') return !entry.providerSupport.codex;
  return false;
}

function projectPickerTable(
  catalog: PortalPluginCatalog,
  providerType: string | undefined,
  retainedSkillKeys: ReadonlySet<string>,
  retainedMcpKeys: ReadonlySet<string> | null,
  inheritedKeys: ReadonlySet<string>,
  selectedKeys: ReadonlySet<string>,
  unavailable: readonly CapabilityUnavailable[],
  installedItems?: InstalledItemSnapshot,
): PickerTableProjection {
  const rows: UnifiedTableRow[] = [];
  const setNameByKey = new Map<string, DraftSetName>();
  const selectionKeyByKey = new Map<string, string>();
  const detailsByKey = new Map<string, PortalPluginCatalogUnifiedEntry>();

  const mapSelection = (
    rowKey: string,
    selectionKey: string,
    setName: DraftSetName,
  ): void => {
    setNameByKey.set(rowKey, setName);
    selectionKeyByKey.set(rowKey, selectionKey);
  };

  if (catalog.entries !== undefined) {
    for (const entry of catalog.entries) {
      const selection = unifiedSelectionKey(entry);
      if (!selection) continue;
      // Cloud scope hides stateless standalone servers unless they are
      // already selected: cloud has never offered them for browsing
      // (CAN-2966). Every account server is listed, signed in or not.
      if (
        selection.setName === 'mcpKeys' &&
        retainedMcpKeys !== null &&
        !retainedMcpKeys.has(selection.key) &&
        entry.connectionState === undefined
      )
        continue;
      const signInStatus =
        selection.setName === 'mcpKeys'
          ? mcpSignInStatus(entry.connectionState)
          : undefined;
      const unsupported = entryUnsupported(entry, providerType);
      // Plugins that contain only MCP members cannot run in cloud yet.
      // First-class app rows keep the existing curated-MCP selection
      // behavior; their connection-requiring cases are labeled by the catalog
      // and handled by the bundle producer's established skip-with-warning
      // path.
      const blocker = portalCatalogEntryBlocker(entry);
      const syncError = entry.syncError?.slice(0, 300);
      const rowKey = pickerRowKey(selection.kind, selection.key);
      rows.push({
        kind: selection.kind,
        key: rowKey,
        name: entry.name,
        description: entry.description,
        ...(signInStatus === undefined
          ? {}
          : { badges: [{ label: signInStatus, tone: 'neutral' as const }] }),
        source: entry.source.label,
        sourceId: entry.source.id,
        sourceSubtitle: '',
        sourceIcon: sourceIcon(entry.providerSupport),
        lastUpdated: entry.lastUpdated,
        providerSupport:
          entry.kind === 'plugin'
            ? {
                claude: entry.providerSupport.claude ? 'native' : 'none',
                // Reserve native for a future real Codex-native plugin facet.
                codex: entry.providerSupport.codex ? 'compat' : 'none',
              }
            : undefined,
        toggleMode: blocker !== null || unsupported ? 'unsupported' : 'normal',
        toggleReason:
          blocker === 'desktop_only'
            ? 'Available on desktop only'
            : syncError
              ? syncError
              : blocker === 'mcp_only_plugin'
                ? 'Not yet available in cloud sessions'
                : blocker === 'unavailable'
                  ? 'Unavailable until marketplace sync succeeds'
                  : unsupported
                    ? 'Unsupported by this provider'
                    : undefined,
        viewDisabled: entry.memberInventory === undefined,
      });
      mapSelection(rowKey, selection.key, selection.setName);
      detailsByKey.set(rowKey, entry);
    }
    for (const skill of catalog.skills) {
      const key = skillKey(skill.sourceId, skill.skillName);
      const rowKey = pickerRowKey('skill', key);
      if (!retainedSkillKeys.has(key) || setNameByKey.has(rowKey)) continue;
      rows.push({
        kind: 'skill',
        key: rowKey,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        sourceId: skill.sourceId,
        sourceSubtitle: 'Selected individually',
        sourceIcon: 'repo',
        lastUpdated: '',
        viewDisabled: true,
      });
      mapSelection(rowKey, key, 'skillKeys');
    }
    // Collections remain in their additive legacy bucket until cloud resolves
    // them; desktop-relayed catalogs can still carry them alongside entries.
    for (const collection of catalog.collections) {
      const rowKey = pickerRowKey('collection', collection.id);
      rows.push({
        kind: 'collection',
        key: rowKey,
        name: collection.name,
        description: collection.description,
        source: 'Collections',
        sourceId: 'collections',
        sourceSubtitle: `${String(collection.skillCount)} skills · ${String(collection.pluginCount)} plugins · ${String(collection.mcpServerCount)} MCP`,
        sourceIcon: 'none',
        lastUpdated: '',
        viewDisabled: true,
      });
      mapSelection(rowKey, collection.id, 'collectionIds');
    }
  } else {
    for (const skill of catalog.skills) {
      const key = skillKey(skill.sourceId, skill.skillName);
      const rowKey = pickerRowKey('skill', key);
      rows.push({
        kind: 'skill',
        key: rowKey,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        sourceId: skill.sourceId,
        sourceSubtitle: '',
        sourceIcon: 'repo',
        lastUpdated: '',
        viewDisabled: true,
      });
      mapSelection(rowKey, key, 'skillKeys');
    }
    for (const plugin of catalog.plugins) {
      const key = pluginKey(plugin.marketplaceId, plugin.pluginName);
      const rowKey = pickerRowKey('plugin', key);
      const unsupported =
        (providerType === 'claude' && !plugin.claudeSupported) ||
        (providerType === 'codex' && !plugin.codexSupported);
      rows.push({
        kind: 'plugin',
        key: rowKey,
        name: plugin.name,
        description: plugin.description,
        source: plugin.marketplaceName,
        sourceId: plugin.marketplaceId,
        sourceSubtitle: '',
        sourceIcon: sourceIcon({
          claude: plugin.claudeSupported,
          codex: plugin.codexSupported,
        }),
        lastUpdated: '',
        providerSupport: {
          claude: plugin.claudeSupported ? 'native' : 'none',
          codex: plugin.codexSupported ? 'native' : 'none',
        },
        toggleMode: unsupported ? 'unsupported' : 'normal',
        toggleReason: unsupported ? 'Unsupported by this provider' : undefined,
        viewDisabled: true,
      });
      mapSelection(rowKey, key, 'pluginKeys');
    }
    for (const server of catalog.mcpServers) {
      const key = mcpKey(server.serverId, server.configId);
      // Legacy rows are hidden in cloud scope unless selected (CAN-2966).
      if (retainedMcpKeys !== null && !retainedMcpKeys.has(key)) continue;
      const rowKey = pickerRowKey('mcp', key);
      rows.push({
        kind: 'mcp',
        key: rowKey,
        name: `${server.serverName} — ${server.configName}`,
        description: server.description,
        source: server.transport === 'command' ? 'CLI' : 'HTTP',
        sourceId: server.transport,
        sourceSubtitle: '',
        sourceIcon: 'none',
        lastUpdated: '',
        viewDisabled: true,
      });
      mapSelection(rowKey, key, 'mcpKeys');
    }
    for (const collection of catalog.collections) {
      const rowKey = pickerRowKey('collection', collection.id);
      rows.push({
        kind: 'collection',
        key: rowKey,
        name: collection.name,
        description: collection.description,
        source: 'Collections',
        sourceId: 'collections',
        sourceSubtitle: '',
        sourceIcon: 'none',
        lastUpdated: '',
        viewDisabled: true,
      });
      mapSelection(rowKey, collection.id, 'collectionIds');
    }
  }

  const projected = withUnavailableRows(rows, unavailable, {
    rowKey: (selection) => pickerRowKey(selection.kind, selection.key),
    isSelected: (selection) =>
      selectedKeys.has(
        draftSelectionKey(SET_NAME_BY_KIND[selection.kind], selection.key),
      ),
    // The catalog no longer lists it, so without this row a selected
    // capability would count in the chip and subtitle with nothing to show.
    synthesize: (row): UnifiedTableRow => ({
      ...row,
      description: '',
      source: '',
      sourceSubtitle: '',
      sourceIcon: 'none',
      lastUpdated: '',
      viewDisabled: true,
    }),
  });
  rows.splice(0, rows.length, ...projected.rows);
  for (const { rowKey, selection } of projected.added)
    mapSelection(rowKey, selection.key, SET_NAME_BY_KIND[selection.kind]);
  const { removableKeys } = projected;

  const disabledRows = new Set<string>();
  for (const item of installedItems?.items ?? []) {
    if (item.status !== 'disabled') continue;
    const ref = item.target;
    if (ref.kind === 'plugin') {
      const pluginRefs = [
        ...catalog.plugins,
        ...(catalog.entries ?? []).flatMap((entry) =>
          entry.selectionRef.type === 'marketplace-plugin'
            ? [entry.selectionRef]
            : [],
        ),
      ];
      for (const plugin of pluginRefs) {
        if (
          plugin.marketplaceId === ref.marketplaceId &&
          plugin.pluginName.toLowerCase() === ref.pluginName.toLowerCase()
        )
          disabledRows.add(
            pickerRowKey(
              'plugin',
              pluginKey(plugin.marketplaceId, plugin.pluginName),
            ),
          );
      }
      disabledRows.add(
        pickerRowKey('plugin', pluginKey(ref.marketplaceId, ref.pluginName)),
      );
    } else if (ref.kind === 'skill')
      disabledRows.add(
        pickerRowKey('skill', skillKey(ref.sourceId, ref.skillName)),
      );
    else if (ref.kind === 'collection')
      disabledRows.add(pickerRowKey('collection', ref.collectionId));
    else if (ref.kind === 'mcp-config')
      disabledRows.add(pickerRowKey('mcp', mcpKey(ref.serverId, ref.configId)));
    else if (ref.kind === 'account-mcp' && item.selectionRef) {
      disabledRows.add(
        pickerRowKey(
          'mcp',
          mcpKey(item.selectionRef.serverId, item.selectionRef.configId),
        ),
      );
      disabledRows.add(
        pickerRowKey(
          'mcp',
          mcpKey(`account:${ref.connectionId}`, item.selectionRef.configId),
        ),
      );
    }
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!disabledRows.has(row.key)) continue;
    const setName = setNameByKey.get(row.key);
    const selectionKey = selectionKeyByKey.get(row.key);
    if (
      !setName ||
      !selectionKey ||
      !selectedKeys.has(draftSelectionKey(setName, selectionKey))
    ) {
      rows.splice(index, 1);
      continue;
    }
    row.badges = [
      ...(row.badges ?? []),
      { label: 'Disabled', tone: 'neutral' },
    ];
    row.toggleMode = 'unsupported';
    row.toggleReason = 'Installed, but turned off';
  }

  for (const row of rows) {
    const setName = setNameByKey.get(row.key);
    const selectionKey = selectionKeyByKey.get(row.key);
    if (
      setName === undefined ||
      selectionKey === undefined ||
      !inheritedKeys.has(draftSelectionKey(setName, selectionKey))
    )
      continue;
    row.badges = [
      ...(row.badges ?? []),
      { label: PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL, tone: 'neutral' },
    ];
  }

  const sourceById = new Map<string, UnifiedTableSourceOption>();
  for (const row of rows) {
    const value = row.sourceId ?? row.source;
    if (!value || sourceById.has(value)) continue;
    sourceById.set(value, {
      value,
      label: row.source,
      icon:
        row.sourceIcon === 'none' || row.sourceIcon === 'app'
          ? 'marketplace'
          : row.sourceIcon,
    });
  }
  return {
    rows,
    sources: [...sourceById.values()],
    setNameByKey,
    selectionKeyByKey,
    detailsByKey,
    removableKeys,
  };
}

const SET_NAME_BY_KIND: Record<CapabilitySelectionRef['kind'], DraftSetName> = {
  skill: 'skillKeys',
  plugin: 'pluginKeys',
  mcp: 'mcpKeys',
};

/** Draft keys of the refs the server says are gone for good. */
function goneDraftKeys(
  unavailable: readonly CapabilityUnavailable[],
): Set<string> {
  return new Set(
    goneCapabilitySelections(unavailable).map((selection) =>
      draftSelectionKey(SET_NAME_BY_KIND[selection.kind], selection.key),
    ),
  );
}

/**
 * Browser-safe port of the desktop `ChatPluginsModal` (CAN-1219). The trigger
 * reuses the shared {@link ChatComposerToolbarChip} so it renders identically to
 * the desktop plugins chip (purple active treatment + selection-count badge);
 * the selector is a {@link DialogModal} listing the four inventory kinds
 * (collections, skills, plugins, MCP servers) the desktop projected over
 * `portal.chat.list_plugin_catalog`. It never touches the local filesystem —
 * every candidate comes from the catalog, and Save fires
 * `portal.chat.set_plugin_selections`; the desktop is the write authority and
 * the chip reconciles from the next projection.
 */
const NO_UNAVAILABLE: readonly CapabilityUnavailable[] = [];

const PortalPluginsPickerContent = memo(function PortalPluginsPickerContent({
  catalog,
  selections: projectedSelections,
  providerType,
  loading = false,
  brandDisplayName,
  onChange,
  onOpen,
  cloudScope = false,
  marketplacesEnabled = false,
  addMarketplace,
  accountMcp,
  notice,
  inheritedSelections,
  unavailable = NO_UNAVAILABLE,
  onApplied,
  deferredTools,
  installedItems,
}: PortalPluginsPickerProps): JSX.Element {
  const refreshCatalog =
    accountMcp?.onCatalogRefresh ?? addMarketplace?.onCatalogRefresh ?? onOpen;
  const [open, setOpen] = useState(false);
  const [confirmedSelections, setConfirmedSelections] = useState<{
    before: string;
    value: PortalChatTabPluginSelections;
  } | null>(null);
  const projectionFingerprint = JSON.stringify(projectedSelections);
  const selections =
    confirmedSelections?.before === projectionFingerprint
      ? confirmedSelections.value
      : projectedSelections;
  if (
    confirmedSelections &&
    confirmedSelections.before !== projectionFingerprint
  )
    setConfirmedSelections(null);

  const [draftAllowed, setDraftAllowed] = useState<boolean | null>(null);
  const [confirmedAllowed, setConfirmedAllowed] = useState<boolean | null>(
    null,
  );
  const allowed =
    draftAllowed ?? confirmedAllowed ?? deferredTools?.allowed ?? true;
  if (confirmedAllowed !== null && deferredTools?.allowed === confirmedAllowed)
    setConfirmedAllowed(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const generation = useRef(0);
  const savingRef = useRef(false);
  useEffect(
    () => (): void => {
      generation.current += 1;
    },
    [],
  );
  const [draft, setDraft] = useState<PickerDraft | null>(null);
  const [detailEntry, setDetailEntry] =
    useState<PortalPluginCatalogUnifiedEntry | null>(null);
  const detailSecurityAudit = parseSecurityAudit(detailEntry?.securityAudit);
  const [marketplaceDialogOpen, setMarketplaceDialogOpen] = useState(false);
  const [marketplaceAdded, setMarketplaceAdded] =
    useState<AddMarketplaceConfirmation | null>(null);
  const projection = useMemo(
    () =>
      open && catalog
        ? projectPickerTable(
            catalog,
            providerType,
            new Set(
              cloudScope
                ? selections.skillRefs.map((ref) =>
                    skillKey(ref.sourceId, ref.skillName),
                  )
                : [],
            ),
            cloudScope
              ? new Set(
                  (selections.mcpServerRefs ?? []).map((ref) =>
                    mcpKey(ref.serverId, ref.configId),
                  ),
                )
              : null,
            draftSelectionKeys(inheritedSelections),
            draftSelectionKeys(selections),
            unavailable,
            installedItems,
          )
        : null,
    [
      open,
      catalog,
      providerType,
      cloudScope,
      selections,
      inheritedSelections,
      unavailable,
      installedItems,
    ],
  );

  const handleOpen = useCallback((): void => {
    generation.current += 1;
    savingRef.current = false;
    setSaving(false);
    setSaveError(false);
    setDraftAllowed(null);
    setDraft({
      collectionIds: new Set(selections.collectionIds),
      skillKeys: new Set(
        selections.skillRefs.map((ref) =>
          skillKey(ref.sourceId, ref.skillName),
        ),
      ),
      pluginKeys: new Set(
        selections.pluginRefs.map((ref) =>
          pluginKey(ref.marketplaceId, ref.pluginName),
        ),
      ),
      mcpKeys: new Set(
        (selections.mcpServerRefs ?? []).map((ref) =>
          mcpKey(ref.serverId, ref.configId),
        ),
      ),
    });
    setOpen(true);
    onOpen?.();
  }, [onOpen, selections]);
  const handleClose = useCallback((): void => {
    if (savingRef.current) return;
    generation.current += 1;
    setOpen(false);
    setDraft(null);
    setDetailEntry(null);
    setMarketplaceDialogOpen(false);
    setMarketplaceAdded(null);
  }, []);
  const toggle = useCallback(
    (key: string): void => {
      if (savingRef.current) return;
      const setName = projection?.setNameByKey.get(key);
      const selectionKey = projection?.selectionKeyByKey.get(key);
      if (!setName || selectionKey === undefined) return;
      setDraft((current) => {
        if (!current) return current;
        const nextSet = new Set(current[setName]);
        if (nextSet.has(selectionKey)) nextSet.delete(selectionKey);
        else nextSet.add(selectionKey);
        return { ...current, [setName]: nextSet };
      });
    },
    [projection],
  );
  const selectedRowKeys = useMemo(() => {
    if (!draft) return new Set<string>();
    const result = new Set<string>();
    for (const [rowKey, setName] of projection?.setNameByKey ?? []) {
      const selectionKey = projection?.selectionKeyByKey.get(rowKey);
      if (selectionKey !== undefined && draft[setName].has(selectionKey)) {
        result.add(rowKey);
      }
    }
    return result;
  }, [draft, projection]);
  const tableRows = useMemo(
    (): UnifiedTableRow[] =>
      (projection?.rows ?? []).map((row) =>
        projection?.removableKeys.has(row.key) && selectedRowKeys.has(row.key)
          ? {
              ...row,
              rowAction: (
                <UnavailableRemoveAction
                  name={row.name}
                  onRemove={(): void => toggle(row.key)}
                />
              ),
            }
          : row,
      ),
    [projection, selectedRowKeys, toggle],
  );
  const selectedCount = draft
    ? draft.collectionIds.size +
      draft.skillKeys.size +
      draft.pluginKeys.size +
      draft.mcpKeys.size
    : 0;

  const handleSave = useCallback((): void => {
    if (savingRef.current) return;
    if (!draft) return handleClose();
    const skillLookup = new Map<
      string,
      { sourceId: string; skillName: string }
    >();
    for (const skill of catalog?.skills ?? []) {
      skillLookup.set(skillKey(skill.sourceId, skill.skillName), {
        sourceId: skill.sourceId,
        skillName: skill.skillName,
      });
    }
    const pluginLookup = new Map<
      string,
      { marketplaceId: string; pluginName: string }
    >();
    for (const plugin of catalog?.plugins ?? []) {
      pluginLookup.set(pluginKey(plugin.marketplaceId, plugin.pluginName), {
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
      });
    }
    const mcpLookup = new Map<string, { serverId: string; configId: string }>();
    for (const server of catalog?.mcpServers ?? []) {
      mcpLookup.set(mcpKey(server.serverId, server.configId), {
        serverId: server.serverId,
        configId: server.configId,
      });
    }
    for (const entry of catalog?.entries ?? []) {
      const ref = entry.selectionRef;
      if (ref.type === 'skill') {
        skillLookup.set(skillKey(ref.sourceId, ref.skillName), {
          sourceId: ref.sourceId,
          skillName: ref.skillName,
        });
      } else if (ref.type === 'marketplace-plugin') {
        pluginLookup.set(pluginKey(ref.marketplaceId, ref.pluginName), {
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
        });
      } else if (ref.type === 'mcp-server') {
        mcpLookup.set(mcpKey(ref.serverId, ref.configId), {
          serverId: ref.serverId,
          configId: ref.configId,
        });
      }
    }
    for (const ref of selections.skillRefs) {
      skillLookup.set(skillKey(ref.sourceId, ref.skillName), ref);
    }
    for (const ref of selections.pluginRefs) {
      pluginLookup.set(pluginKey(ref.marketplaceId, ref.pluginName), ref);
    }
    for (const ref of selections.mcpServerRefs ?? []) {
      mcpLookup.set(mcpKey(ref.serverId, ref.configId), ref);
    }
    // A ref the server says is gone is never carried back, inherited or not:
    // the server prunes a gone inherited default from the project defaults
    // rather than recording it turned off here. Every other ref the catalog
    // does not list survives the save.
    const gone = goneDraftKeys(unavailable);
    const resolve = <T,>(
      setName: DraftSetName,
      keys: Set<string>,
      lookup: Map<string, T>,
    ): T[] =>
      [...keys].flatMap((key) => {
        const value = lookup.get(key);
        return value === undefined || gone.has(draftSelectionKey(setName, key))
          ? []
          : [value];
      });
    const mcpServerRefs = resolve('mcpKeys', draft.mcpKeys, mcpLookup);
    const next: PortalChatTabPluginSelections = {
      ...selections,
      collectionIds: [...draft.collectionIds],
      skillRefs: resolve('skillKeys', draft.skillKeys, skillLookup),
      pluginRefs: resolve('pluginKeys', draft.pluginKeys, pluginLookup),
    };
    if (mcpServerRefs.length > 0) next.mcpServerRefs = mcpServerRefs;
    else delete next.mcpServerRefs;
    if (deferredTools) {
      const currentGeneration = generation.current;
      savingRef.current = true;
      setSaving(true);
      setSaveError(false);
      // A policy update is complete only when its host commit succeeds.
      void Promise.resolve()
        .then(() => deferredTools.save(next, allowed))
        .then(
          () => {
            if (generation.current !== currentGeneration) return;
            savingRef.current = false;
            setSaving(false);
            setConfirmedAllowed(allowed);
            setConfirmedSelections({
              before: projectionFingerprint,
              value: next,
            });
            onApplied?.(next, selections);
            handleClose();
          },
          () => {
            if (generation.current !== currentGeneration) return;
            savingRef.current = false;
            setSaving(false);
            setSaveError(true);
          },
        );
      return;
    }
    void Promise.resolve(onChange(next)).catch(() => undefined);
    onApplied?.(next, selections);
    handleClose();
  }, [
    catalog,
    draft,
    deferredTools,
    allowed,
    projectionFingerprint,
    handleClose,
    onApplied,
    onChange,
    selections,
    unavailable,
  ]);

  return (
    <div className="relative shrink-0">
      <ChatComposerToolbarChip
        variant="capsule"
        icon={<PluginsIcon width={16} height={16} />}
        label="Plugins"
        labelClassName="hidden lg:inline"
        trailing={
          countPortalPluginSelections(selections) > 0 ? (
            <span
              data-testid="portal-plugins-count"
              className="ml-0.5 inline-flex min-w-4.5 items-center justify-center rounded-full bg-fg-primary/10 px-1 text-3xs font-medium"
            >
              {countPortalPluginSelections(selections)}
            </span>
          ) : undefined
        }
        active={countPortalPluginSelections(selections) > 0}
        activeStyle={{
          backgroundColor: 'var(--bg-info-subtle)',
          color: 'var(--fg-info)',
        }}
        ariaLabel="Plugins"
        ariaHasPopup="dialog"
        ariaExpanded={open}
        title="Plugins"
        dataTestId="portal-chat-plugins-button"
        onClick={handleOpen}
      />
      {open && draft && (
        <DialogModal
          onClose={handleClose}
          title="Plugins"
          titleId="portal-plugins-dialog-title"
          subtitle={`${String(selectedCount)} selected`}
          maxWidth="5xl"
          dataTestId="portal-plugins-modal"
          topRightActions={
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              data-testid="portal-plugins-save"
              className="focus-ring inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-s font-medium fg-emphasis hover:bg-accent/90 lg:min-h-0 lg:py-1"
            >
              Save
            </button>
          }
        >
          <div className="flex min-h-96 flex-1 flex-col p-5 pt-4">
            {notice && (
              <Notice
                role="none"
                className="mb-4"
                data-testid="portal-plugins-notice"
              >
                {notice.split('\n').map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </Notice>
            )}
            <UnifiedTable
              rows={tableRows}
              sourceOptions={projection?.sources ?? []}
              selectedKeys={selectedRowKeys}
              onToggle={toggle}
              onView={(row): void => {
                setDetailEntry(projection?.detailsByKey.get(row.key) ?? null);
              }}
              showCollectionKind={(catalog?.collections.length ?? 0) > 0}
              loading={loading && !catalog}
              providerIconScope={
                providerType === 'claude' || providerType === 'codex'
                  ? providerType
                  : 'mixed'
              }
              rowCheckboxTestId="portal-plugins-row-checkbox"
            />
            {marketplaceAdded && (
              <Notice
                role="status"
                intent={marketplaceAdded.intent}
                className="mt-3"
                data-testid="portal-plugins-marketplace-added"
              >
                {marketplaceAdded.message}
              </Notice>
            )}
            {cloudScope && marketplacesEnabled && addMarketplace && (
              <div className="mt-3 flex justify-start border-t pt-3">
                <button
                  type="button"
                  onClick={() => {
                    setMarketplaceAdded(null);
                    setMarketplaceDialogOpen(true);
                  }}
                  data-testid="portal-plugins-add-marketplace"
                  className="focus-ring inline-flex min-h-11 items-center rounded-md border px-3 text-s font-medium fg-primary hover:bg-secondary/50 lg:min-h-0 lg:py-1.5"
                >
                  Add marketplace
                </button>
              </div>
            )}
            {deferredTools && (
              <div className="mt-3 flex flex-col gap-2 border-t pt-3">
                <DeferredPluginsControl
                  allowed={allowed}
                  disabled={saving}
                  onChange={setDraftAllowed}
                />
                {saveError && (
                  <p role="alert" className="text-xs text-destructive">
                    Could not save plugin settings. Try again.
                  </p>
                )}
              </div>
            )}
            {!loading && !catalog && (
              <p className="py-2 text-center text-xs fg-secondary">
                No plugins are available from {brandDisplayName}.
              </p>
            )}
          </div>
        </DialogModal>
      )}
      {detailEntry?.memberInventory && (
        <DialogModal
          onClose={() => setDetailEntry(null)}
          title={detailEntry.name}
          titleId="portal-plugin-details-dialog-title"
          subtitle={detailEntry.source.label}
          maxWidth="2xl"
          dataTestId="portal-plugin-details-modal"
        >
          <div className="p-5">
            {(provenanceLicense(detailEntry.license) !== undefined ||
              isGitHubTreeUrl(detailEntry.sourceUrl) ||
              detailSecurityAudit !== null) && (
              <p
                className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs fg-secondary"
                data-testid="portal-plugin-details-provenance"
              >
                {provenanceLicense(detailEntry.license) !== undefined && (
                  <span>License: {provenanceLicense(detailEntry.license)}</span>
                )}
                {isGitHubTreeUrl(detailEntry.sourceUrl) && (
                  <ExternalTextLink
                    href={detailEntry.sourceUrl}
                    label="View source"
                  />
                )}
                {detailSecurityAudit !== null && (
                  <SecurityAuditSummary
                    audit={detailSecurityAudit}
                    dataTestId="portal-plugin-details-security-audit"
                  />
                )}
              </p>
            )}
            <PluginMemberDetails
              inventory={detailEntry.memberInventory}
              connectionState={detailEntry.connectionState}
              toolsEditor={
                accountMcp ? (
                  <accountMcp.toolsEditor
                    key={detailEntry.connectionId}
                    entry={detailEntry}
                    onRefresh={refreshCatalog}
                  />
                ) : undefined
              }
              hooksStripped={detailEntry.cloudCapabilities.hooksStripped}
              mcpUnavailable={detailEntry.kind === 'plugin'}
            />
          </div>
        </DialogModal>
      )}
      {marketplaceDialogOpen && addMarketplace && (
        <addMarketplace.dialog
          onClose={() => setMarketplaceDialogOpen(false)}
          onCatalogRefresh={addMarketplace.onCatalogRefresh}
          onAdded={setMarketplaceAdded}
        />
      )}
      {accountMcp && (
        <accountMcp.catalogRefresh
          enabled={
            cloudScope &&
            // Desktop only is brand-wide state, set for guests and with
            // account connections off; it never signals an account catalog.
            Boolean(
              catalog?.entries?.some(
                (entry) =>
                  entry.connectionState !== undefined &&
                  entry.connectionState !== 'desktop_only',
              ),
            )
          }
          onRefresh={refreshCatalog}
        />
      )}
    </div>
  );
});

/** Remount staged settings when their account/session/chat target changes. */
export function PortalPluginsPicker(
  props: PortalPluginsPickerProps,
): JSX.Element {
  return (
    <PortalPluginsPickerContent
      key={props.scopeKey ?? props.deferredTools?.key ?? 'legacy'}
      {...props}
    />
  );
}
