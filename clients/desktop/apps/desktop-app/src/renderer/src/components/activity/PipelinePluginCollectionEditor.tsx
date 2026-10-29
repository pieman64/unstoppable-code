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
} from '@canopy/desktop-shared/types/pipeline';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

interface PipelinePluginCollectionEditorProps {
  collection: PipelinePluginCollection;
  previewItems: PipelinePluginDefaultPreviewItem[];
  preference: PipelinePluginCollectionPreference;
  onChange: (next: PipelinePluginCollectionPreference) => void;
}

function ChevronIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <AppCatalogChevronRightMediumIcon
      width="12"
      height="12"
      className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      aria-hidden="true"
    />
  );
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

  const contentId = `pipeline-plugin-collection-${collection.id}-content`;

  return (
    <div
      className="rounded-lg border bg-fg-primary/[0.02]"
      data-testid={`pipeline-plugin-collection-${collection.id}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition hover:bg-fg-primary/[0.04]"
      >
        <span className="mt-0.5 fg-secondary">
          <ChevronIcon expanded={expanded} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-s font-medium fg-primary">
            {collection.name}
          </span>
          {collection.description && (
            <span className="block truncate text-xs fg-secondary">
              {collection.description}
            </span>
          )}
          <span className="mt-0.5 block text-xs fg-secondary">
            {selectionSummary}
          </span>
        </span>
      </button>
      {expanded && (
        <div id={contentId} className="border-t p-3">
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
        </div>
      )}
    </div>
  );
}
