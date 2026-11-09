// ---------------------------------------------------------------------------
// Per-collection editor used by `PipelinePluginCollectionsSection`.
//
// Renders a single `PipelinePluginCollection` as a collapsible card containing
// an annotated `UnifiedTable`: matched defaults are badged on the local row,
// unmatched defaults appear as synthetic rows, and bundles/extras are
// toggleable normally.
// ---------------------------------------------------------------------------

import { useMemo, useState, type JSX } from 'react';
import { UnifiedTable } from '@/components/shared/UnifiedTable';
import { useUnifiedTableData } from '@/hooks/useUnifiedTableData';
import {
  annotateRowsForCollection,
  applyToggleForCollection,
} from '@/lib/pipelinePluginCollections';
import type {
  PipelinePluginCollection,
  PipelinePluginCollectionPreference,
  PipelinePluginDefaultPreviewItem,
} from '@canopy/execution-engine/types/pipeline';
import { Disclosure } from '@canopy/ui-shared/components';

interface PipelinePluginCollectionEditorProps {
  collection: PipelinePluginCollection;
  previewItems: PipelinePluginDefaultPreviewItem[];
  preference: PipelinePluginCollectionPreference;
  onChange: (next: PipelinePluginCollectionPreference) => void;
}

function buildSelectionSummary(
  kindCounts: Record<'collection' | 'skill' | 'plugin' | 'mcp', number>,
): string {
  const parts: string[] = [];
  if (kindCounts.collection > 0) {
    parts.push(
      `${kindCounts.collection} collection${kindCounts.collection === 1 ? '' : 's'}`,
    );
  }
  if (kindCounts.skill > 0) {
    parts.push(`${kindCounts.skill} skill${kindCounts.skill === 1 ? '' : 's'}`);
  }
  if (kindCounts.plugin > 0) {
    parts.push(
      `${kindCounts.plugin} plugin${kindCounts.plugin === 1 ? '' : 's'}`,
    );
  }
  if (kindCounts.mcp > 0) {
    parts.push(
      `${kindCounts.mcp} MCP server${kindCounts.mcp === 1 ? '' : 's'}`,
    );
  }
  if (parts.length === 0) return 'Nothing selected';
  return `${parts.join(', ')} selected`;
}

export function PipelinePluginCollectionEditor({
  collection,
  previewItems,
  preference,
  onChange,
}: PipelinePluginCollectionEditorProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const {
    rows: catalogRows,
    sourceOptions,
    loading,
  } = useUnifiedTableData({
    includeCollections: true,
    includeMcp: false,
  });

  const { annotatedRows, selectedKeys } = useMemo(() => {
    const result = annotateRowsForCollection(
      catalogRows,
      previewItems,
      preference,
    );
    return {
      annotatedRows: result.rows,
      selectedKeys: result.selectedKeys,
    };
  }, [catalogRows, previewItems, preference]);

  const selectionSummary = useMemo(() => {
    const counts = { collection: 0, skill: 0, plugin: 0, mcp: 0 };
    for (const row of annotatedRows) {
      if (!selectedKeys.has(row.key)) continue;
      counts[row.kind]++;
    }
    return buildSelectionSummary(counts);
  }, [annotatedRows, selectedKeys]);

  function handleToggle(key: string): void {
    const row = annotatedRows.find((r) => r.key === key);
    if (!row) return;
    const next = applyToggleForCollection({
      row,
      items: previewItems,
      preference,
      selectedKeys,
    });
    onChange(next);
  }

  function handleView(): void {
    // The pipeline-collection editor doesn't render detail modals — the global
    // skills/plugins/bundles tabs already do that. Leave as a no-op so the
    // table still has a valid `onView` handler.
  }

  return (
    <Disclosure
      variant="box"
      open={expanded}
      onOpenChange={setExpanded}
      dataTestId={`pipeline-plugin-collection-${collection.id}`}
      label={
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{collection.name}</span>
          {collection.description && (
            <span className="truncate text-xs font-normal fg-secondary">
              {collection.description}
            </span>
          )}
          <span className="text-xs font-normal fg-secondary">
            {selectionSummary}
          </span>
        </span>
      }
    >
      <UnifiedTable
        rows={annotatedRows}
        sourceOptions={sourceOptions}
        selectedKeys={selectedKeys}
        onToggle={handleToggle}
        onView={handleView}
        showCollectionKind={true}
        loading={loading}
        defaultSelectedFilter="all"
        hideSelectionSummary
      />
    </Disclosure>
  );
}
