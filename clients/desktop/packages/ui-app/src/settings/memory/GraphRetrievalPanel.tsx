'use client';

import { useRef, useState, type FormEvent, type JSX } from 'react';
import type { ExplorerRetrievalPreview } from '@canopy/protocol/settings/organization-memory';
import { useSettingsClient } from '../host';
import { previewMemorySearch } from './api';
import { useMemoryErrorCopy } from './memory-error-copy';
import { gateSummary } from './RetrievalPreview';
import { FactCard } from './FactCard';

interface GraphRetrievalPanelProps {
  orgId: string;
  preview: ExplorerRetrievalPreview | null;
  // Highlighted entities missing from the current node set (filtered out).
  hiddenEntityCount: number;
  onPreview: (preview: ExplorerRetrievalPreview | null) => void;
}

// Compact retrieval probe for the graph page: runs the same preview-search
// pipeline as the Facts tab's RetrievalPreview and reports the result to the
// parent, which projects it onto the graph as a highlight.
export function GraphRetrievalPanel({
  orgId,
  preview,
  hiddenEntityCount,
  onPreview,
}: GraphRetrievalPanelProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);
    try {
      const payload = await previewMemorySearch(client, orgId, trimmed);
      if (requestSequence.current === sequence) {
        onPreview(payload);
      }
    } catch (caught) {
      if (requestSequence.current === sequence) {
        setError(errorCopy.actionCopy(caught, 'preview retrieval'));
      }
    } finally {
      if (requestSequence.current === sequence) {
        setLoading(false);
      }
    }
  };

  const onQueryChange = (value: string): void => {
    setQuery(value);
    // Clearing the input clears the graph highlight immediately, mirroring the
    // corpus search behavior; non-empty edits wait for an explicit submit.
    if (value.trim().length === 0) {
      // Supersede any in-flight preview so a late response cannot restore the
      // highlight the user just cleared.
      requestSequence.current += 1;
      setLoading(false);
      setError(null);
      onPreview(null);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Preview retrieval and highlight matched entities"
          aria-label="Retrieval highlight query"
          className="w-full rounded-lg border bg-base px-3 py-2.5 text-s fg-primary placeholder:fg-tertiary focus:border-line-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || query.trim().length === 0}
          className="shrink-0 rounded-lg border bg-base px-4 py-2 text-s font-medium fg-primary hover:bg-card disabled:opacity-50"
        >
          {loading ? 'Previewing…' : 'Highlight'}
        </button>
      </form>
      <p className="mt-2 text-xs fg-secondary">
        Runs the exact turn-time retrieval pipeline. Entities of injected facts
        get a solid ring, near-miss candidates a dashed ring. Each preview
        counts against the shared search rate limit.
      </p>

      {error !== null && (
        <p className="mt-3 rounded-lg bg-destructive-subtle px-3 py-2 text-s fg-destructive">
          {error}
        </p>
      )}

      {preview !== null && (
        <div className="mt-3 space-y-3">
          <div
            className={`rounded-lg border px-3 py-2 ${
              preview.gatePassed
                ? 'border-line-positive/40 bg-success-subtle'
                : 'border-line-attention/40 bg-warning-subtle'
            }`}
            data-testid="graph-retrieval-gate"
          >
            <p
              className={`text-xs font-semibold ${
                preview.gatePassed ? 'fg-success' : 'fg-warning'
              }`}
            >
              {preview.gatePassed ? 'Gate passed' : 'Gate blocked'}
            </p>
            <p className="mt-1 text-s fg-primary">{gateSummary(preview)}</p>
            <p className="mt-1 font-mono text-xs fg-secondary">
              top rerank {preview.diagnostics.topRerankScore?.toFixed(4) ?? '—'}{' '}
              · top cosine{' '}
              {preview.diagnostics.topCosineScore?.toFixed(4) ?? '—'} ·{' '}
              {preview.candidates.length} near-miss candidate
              {preview.candidates.length === 1 ? '' : 's'} ·{' '}
              {preview.diagnostics.latencyMs} ms
            </p>
          </div>
          {hiddenEntityCount > 0 && (
            <p className="text-xs fg-warning">
              {hiddenEntityCount} retrieved{' '}
              {hiddenEntityCount === 1 ? 'entity is' : 'entities are'} not
              visible with the current filters.
            </p>
          )}
          {preview.facts.length > 0 && (
            <div className="grid max-h-64 gap-3 overflow-y-auto lg:grid-cols-2">
              {preview.facts.map((fact) => (
                <FactCard key={fact.id} fact={fact} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
