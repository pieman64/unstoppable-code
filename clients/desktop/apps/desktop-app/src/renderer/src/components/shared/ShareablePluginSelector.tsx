import { type JSX, useMemo } from 'react';
import {
  buildShareablePluginDisplay,
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/desktop-shared/plugin-refs';
import {
  useUnifiedTableData,
  type SourceOption,
  type UnifiedTableRow,
} from '@/hooks/useUnifiedTableData';
import { UnifiedTable } from './UnifiedTable';

interface ShareablePluginSelectorProps {
  selections: ShareablePluginRef[];
  onChange: (next: ShareablePluginRef[]) => void;
  emptyText?: string;
  helperText?: string;
  /** Show the selected portable manifest as a locked, read-only table. */
  manifestOnly?: boolean;
}

const DEFAULT_HELPER_TEXT =
  'Only shareable skills and marketplace plugins can be saved to canopy.json. Built-in and GitHub marketplace plugins are shareable; collections, MCP servers, and local-only installs stay local.';

const DEFAULT_EMPTY_TEXT =
  'No shareable skills or marketplace plugins are available.';

interface PortableRowEntry {
  row: UnifiedTableRow;
  ref: ShareablePluginRef;
  refKey: string;
}

function getEquivalentPluginRefKeys(ref: ShareablePluginRef): string[] {
  const refKey = getShareablePluginRefKey(ref);
  if (ref.type !== 'claude_plugin' && ref.type !== 'plugin') {
    return [refKey];
  }

  const alternateRef: ShareablePluginRef = {
    ...ref,
    type: ref.type === 'plugin' ? 'claude_plugin' : 'plugin',
  };
  return [refKey, getShareablePluginRefKey(alternateRef)];
}

function buildMissingSelectionRow(
  ref: ShareablePluginRef,
  refKey: string,
): UnifiedTableRow {
  const display = buildShareablePluginDisplay(ref);
  const kind = ref.type === 'skill' ? 'skill' : 'plugin';
  // GitHub-backed marketplace plugins render the repo glyph; built-in
  // marketplace plugins (and built-in skills) render the app glyph. The
  // historical `claude_plugin` discriminator is preserved for backward
  // compatibility but is not surfaced to end users.
  const sourceIcon =
    ref.type === 'codex_plugin'
      ? 'app'
      : ref.type === 'claude_plugin' || ref.type === 'plugin'
        ? ref.marketplace.type === 'builtin'
          ? 'app'
          : 'repo'
        : ref.source.type === 'builtin'
          ? 'app'
          : 'repo';

  return {
    rowOrigin: 'pipeline-derived',
    kind,
    key: `missing-shareable/${refKey}`,
    name: display.title,
    description:
      'Selected in project config but missing from the local catalog.',
    source: display.subtitle,
    sourceSubtitle: '',
    sourceIcon,
    lastUpdated: '',
    badges: [{ label: 'Missing locally', tone: 'warning' }],
    shareableRef: ref,
    viewDisabled: true,
  };
}

function buildSourceOptionForMissingRef(ref: ShareablePluginRef): SourceOption {
  const display = buildShareablePluginDisplay(ref);
  if (ref.type === 'codex_plugin') {
    return {
      value: display.subtitle,
      label: display.subtitle,
      subtitle: 'Codex built-in plugin',
      icon: 'app',
    };
  }
  if (ref.type === 'claude_plugin' || ref.type === 'plugin') {
    const isBuiltIn = ref.marketplace.type === 'builtin';
    return {
      value: display.subtitle,
      label: display.subtitle,
      subtitle: isBuiltIn ? 'Built-in plugin' : 'Marketplace plugin',
      icon: isBuiltIn ? 'app' : 'repo',
    };
  }
  if (ref.source.type === 'builtin') {
    return {
      value: display.subtitle,
      label: display.subtitle,
      icon: 'app',
    };
  }
  return {
    value: display.subtitle,
    label: display.subtitle,
    icon: 'repo',
  };
}

/**
 * Reusable selector for `ShareablePluginRef[]` arrays. Filters the unified
 * plugin/skill table to rows that carry a portable `shareableRef`, so callers
 * can edit `canopy.json.plugins`-style lists without exposing Collections, MCP
 * servers, or local-only catalog entries.
 *
 * Selections that are not currently visible (because the underlying entry
 * isn't installed locally yet) are preserved across renders so a user editing
 * source-controlled recommendations doesn't lose entries just because the
 * catalog hasn't caught up.
 */
export function ShareablePluginSelector({
  selections,
  onChange,
  emptyText,
  helperText,
  manifestOnly = false,
}: ShareablePluginSelectorProps): JSX.Element {
  // Map incoming refs by canonical key so toggle/save flows can round-trip
  // refs whose underlying catalog entries aren't currently visible.
  const selectedRefByKey = useMemo(() => {
    const map = new Map<string, ShareablePluginRef>();
    for (const ref of selections) {
      try {
        map.set(getShareablePluginRefKey(ref), ref);
      } catch {
        // Drop malformed selections; they cannot round-trip safely.
      }
    }
    return map;
  }, [selections]);

  const selectedRefEquivalentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const ref of selections) {
      try {
        for (const key of getEquivalentPluginRefKeys(ref)) {
          keys.add(key);
        }
      } catch {
        // Drop malformed selections; they cannot round-trip safely.
      }
    }
    return keys;
  }, [selections]);

  const { rows, sourceOptions, loading } = useUnifiedTableData({
    includeCollections: false,
    includeMcp: false,
  });

  // Pre-compute each portable row's canonical key alongside its ref so we
  // don't recompute keys during toggle handling.
  const portableRows = useMemo(() => {
    const result: PortableRowEntry[] = [];
    for (const row of rows) {
      const ref = row.shareableRef;
      if (!ref) {
        continue;
      }
      try {
        result.push({ row, ref, refKey: getShareablePluginRefKey(ref) });
      } catch {
        // Malformed ref; exclude it because callers cannot persist it anyway.
      }
    }
    return result;
  }, [rows]);

  const tableEntries = useMemo(() => {
    const result: PortableRowEntry[] = [...portableRows];
    const visibleRefKeys = new Set<string>();
    for (const entry of portableRows) {
      visibleRefKeys.add(entry.refKey);
    }

    for (const [refKey, ref] of Array.from(selectedRefByKey.entries())) {
      const isVisible = getEquivalentPluginRefKeys(ref).some((key) =>
        visibleRefKeys.has(key),
      );
      if (isVisible) {
        continue;
      }
      result.push({
        row: buildMissingSelectionRow(ref, refKey),
        ref,
        refKey,
      });
    }
    return result;
  }, [portableRows, selectedRefByKey]);

  const displayedEntries = useMemo(
    () =>
      manifestOnly
        ? tableEntries.filter((entry) =>
            selectedRefEquivalentKeys.has(entry.refKey),
          )
        : tableEntries,
    [manifestOnly, selectedRefEquivalentKeys, tableEntries],
  );

  const tableRows = useMemo(
    () =>
      displayedEntries.map((entry) =>
        manifestOnly
          ? { ...entry.row, toggleMode: 'locked' as const }
          : entry.row,
      ),
    [displayedEntries, manifestOnly],
  );

  const tableSourceOptions = useMemo(() => {
    const nextOptions = [...sourceOptions];
    const seenSources = new Set<string>();
    const portableRefKeys = new Set<string>();
    for (const option of nextOptions) {
      seenSources.add(option.value);
    }
    for (const row of portableRows) {
      portableRefKeys.add(row.refKey);
    }
    for (const entry of displayedEntries) {
      if (portableRefKeys.has(entry.refKey)) {
        continue;
      }
      const option = buildSourceOptionForMissingRef(entry.ref);
      if (!seenSources.has(option.value)) {
        seenSources.add(option.value);
        nextOptions.push(option);
      }
    }
    return nextOptions;
  }, [displayedEntries, portableRows, sourceOptions]);

  const refByRowKey = useMemo(() => {
    const map = new Map<string, { ref: ShareablePluginRef; refKey: string }>();
    for (const entry of displayedEntries) {
      map.set(entry.row.key, { ref: entry.ref, refKey: entry.refKey });
    }
    return map;
  }, [displayedEntries]);

  // Translate selected canonical ref keys into the row keys UnifiedTable uses.
  // Missing catalog entries are represented by synthetic rows so users can
  // remove source-controlled refs that are not installed locally.
  const selectedRowKeys = useMemo(() => {
    const next = new Set<string>();
    for (const entry of displayedEntries) {
      if (selectedRefEquivalentKeys.has(entry.refKey)) {
        next.add(entry.row.key);
      }
    }
    return next;
  }, [displayedEntries, selectedRefEquivalentKeys]);

  function handleToggle(rowKey: string): void {
    if (manifestOnly) return;
    const entry = refByRowKey.get(rowKey);
    if (!entry) {
      return;
    }
    const nextMap = new Map(selectedRefByKey);
    const equivalentKeys = getEquivalentPluginRefKeys(entry.ref);
    const existingKey = equivalentKeys.find((key) => nextMap.has(key));
    if (existingKey) {
      for (const key of equivalentKeys) {
        nextMap.delete(key);
      }
    } else {
      nextMap.set(entry.refKey, entry.ref);
    }
    onChange(Array.from(nextMap.values()));
  }

  const isEmpty = !loading && tableRows.length === 0;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <p className="px-6 pt-3 text-xs fg-secondary">
        {helperText ?? DEFAULT_HELPER_TEXT}
      </p>
      {isEmpty ? (
        <div className="px-6 py-3 text-xs fg-secondary">
          {emptyText ?? DEFAULT_EMPTY_TEXT}
        </div>
      ) : (
        <div className="flex flex-1 flex-col min-h-0 px-6 py-3">
          <UnifiedTable
            rows={tableRows}
            sourceOptions={tableSourceOptions}
            selectedKeys={selectedRowKeys}
            onToggle={handleToggle}
            onView={(): void => {
              // Detail overlays live on the global Plugins/Skills tabs;
              // selecting here is intentionally a flat checkbox UI.
            }}
            showCollectionKind={false}
            loading={loading}
          />
        </div>
      )}
    </div>
  );
}
