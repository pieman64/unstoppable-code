import { useMemo, type JSX, type ReactNode } from 'react';
import {
  UnifiedTable as SharedUnifiedTable,
  type ProviderSupportScope,
  type UnifiedTableSelectedFilter,
  type UnifiedTableRow as SharedUnifiedTableRow,
} from '@canopy/ui-shared';
import type {
  SourceOption,
  UnifiedTableRow,
} from '../../hooks/useUnifiedTableData';
import { BrandLogo } from '../BrandLogo';
import { McpServerLogo } from './McpServerLogo';

export interface UnifiedTableProps {
  rows: UnifiedTableRow[];
  sourceOptions: SourceOption[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onView: (row: UnifiedTableRow) => void;
  showCollectionKind?: boolean;
  /** @deprecated Compatibility alias retained for older tests/callers. */
  showBundleKind?: boolean;
  loading?: boolean;
  defaultSelectedFilter?: UnifiedTableSelectedFilter;
  hideSelectionSummary?: boolean;
  providerIconScope?: ProviderSupportScope;
  toolbarTrailing?: ReactNode;
}

function renderMcpLogo(row: SharedUnifiedTableRow): JSX.Element {
  return (
    <McpServerLogo
      curatedKey={row.curatedKey}
      logoUrl={row.logoUrl}
      size={16}
      fallback="monogram"
      name={row.name}
      imgTestId="unified-table-mcp-logo"
    />
  );
}

function renderAppLogo(): JSX.Element {
  return <BrandLogo className="shrink-0 fg-secondary" width={12} height={12} />;
}

/** Desktop compatibility facade over the shared pure display component. */
export function UnifiedTable({
  rows,
  sourceOptions,
  selectedKeys,
  onToggle,
  onView,
  showCollectionKind,
  showBundleKind,
  loading,
  defaultSelectedFilter,
  hideSelectionSummary,
  providerIconScope,
  toolbarTrailing,
}: UnifiedTableProps): JSX.Element {
  const rowsByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  return (
    <SharedUnifiedTable
      rows={rows}
      sourceOptions={sourceOptions}
      selectedKeys={selectedKeys}
      onToggle={onToggle}
      onView={(row): void => {
        const desktopRow = rowsByKey.get(row.key);
        if (desktopRow) onView(desktopRow);
      }}
      showCollectionKind={showCollectionKind ?? showBundleKind ?? false}
      loading={loading}
      defaultSelectedFilter={defaultSelectedFilter}
      hideSelectionSummary={hideSelectionSummary}
      providerIconScope={providerIconScope}
      renderMcpLogo={renderMcpLogo}
      renderAppLogo={renderAppLogo}
      toolbarTrailing={toolbarTrailing}
      // Session replay records the rows as a same-size placeholder: opening a
      // picker inserts the whole list at once, which the recorder would
      // otherwise serialize and mask in one long task.
      blockRowsFromReplay
    />
  );
}
