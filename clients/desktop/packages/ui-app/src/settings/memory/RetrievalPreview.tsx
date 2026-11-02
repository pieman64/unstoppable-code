'use client';

import { useRef, useState, type FormEvent, type JSX } from 'react';
import type { ExplorerRetrievalPreview } from '@canopy/protocol/settings/organization-memory';
import { buildPreviewQuery } from '@canopy/protocol/settings/memory-preview-query';
import { Button, CopyButton } from '@canopy/ui-shared/components';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsClient, useSettingsPrivacy } from '../host';
import { previewMemorySearch } from './api';
import { useMemoryErrorCopy } from './memory-error-copy';
import { FactCard } from './FactCard';

interface RetrievalPreviewProps {
  orgId: string;
}

// Also reused by the graph page's GraphRetrievalPanel.
export function gateSummary(preview: ExplorerRetrievalPreview): string {
  if (preview.gatePassed) {
    return `${preview.facts.length} fact${preview.facts.length === 1 ? '' : 's'} would be injected into the agent turn.`;
  }
  if (preview.candidateCount === 0) {
    return 'No candidates retrieved — nothing would be injected.';
  }
  return `${preview.candidateCount} candidate${preview.candidateCount === 1 ? '' : 's'} retrieved, but none cleared the calibration gate — nothing would be injected.`;
}

function formatScores(scores: number[]): string {
  if (scores.length === 0) return '—';
  return scores.map((score) => score.toFixed(4)).join(', ');
}

export function RetrievalPreview({
  orgId,
}: RetrievalPreviewProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useMemoryErrorCopy();
  const { blockClassName } = useSettingsPrivacy();
  const [query, setQuery] = useState('');
  const [usePrefix, setUsePrefix] = useState(false);
  const [repo, setRepo] = useState('');
  const [worktree, setWorktree] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExplorerRetrievalPreview | null>(null);
  const requestSequence = useRef(0);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const effectiveQuery = usePrefix
      ? buildPreviewQuery(query, { repo, worktree })
      : buildPreviewQuery(query);
    if (effectiveQuery.length === 0) return;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError(null);
    try {
      const payload = await previewMemorySearch(client, orgId, effectiveQuery);
      if (requestSequence.current === sequence) {
        setPreview(payload);
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

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="rounded-xl border bg-card p-4"
      >
        <p className="text-xs fg-secondary">
          Runs the exact turn-time retrieval pipeline — calibration gate,
          injection cap, and rendered block — and shows what the agent would
          see. Each preview counts against the shared search rate limit.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Query text, as an agent turn would send it"
            aria-label="Preview query"
            className="w-full rounded-lg border bg-base px-3 py-2.5 text-s fg-primary placeholder:fg-tertiary focus:border-line-accent focus:outline-none"
          />
          <Button
            type="submit"
            size="compact"
            disabled={loading || query.trim().length === 0}
            className="self-center"
          >
            {loading ? 'Previewing…' : 'Preview'}
          </Button>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs fg-secondary">
          <input
            type="checkbox"
            checked={usePrefix}
            onChange={(event) => setUsePrefix(event.target.checked)}
          />
          Add context prefix (real turns send “repo — worktree — query”)
        </label>
        {usePrefix && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="Repo label"
              aria-label="Context repo label"
              className="rounded-lg border bg-base px-3 py-2 text-s fg-primary placeholder:fg-tertiary focus:border-line-accent focus:outline-none"
            />
            <input
              type="text"
              value={worktree}
              onChange={(event) => setWorktree(event.target.value)}
              placeholder="Worktree name"
              aria-label="Context worktree name"
              className="rounded-lg border bg-base px-3 py-2 text-s fg-primary placeholder:fg-tertiary focus:border-line-accent focus:outline-none"
            />
          </div>
        )}
      </form>

      {error !== null && (
        <p className="rounded-lg bg-destructive-subtle px-3 py-2 text-s fg-destructive">
          {error}
        </p>
      )}

      {preview === null ? (
        !loading &&
        error === null && (
          <div className="rounded-xl border border-dashed py-16 text-center">
            <p className="text-s fg-secondary">
              Submit a query to preview what would be injected.
            </p>
          </div>
        )
      ) : (
        <div className="space-y-4">
          <div
            className={`rounded-xl border p-4 ${
              preview.gatePassed
                ? 'border-line-positive/40 bg-success-subtle'
                : 'border-line-attention/40 bg-warning-subtle'
            }`}
            data-testid="retrieval-preview-gate"
          >
            <p
              className={`text-s font-semibold ${
                preview.gatePassed ? 'fg-success' : 'fg-warning'
              }`}
            >
              {preview.gatePassed ? 'Gate passed' : 'Gate blocked'}
            </p>
            <p className="mt-1 text-s fg-primary">{gateSummary(preview)}</p>
          </div>

          {preview.facts.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              {preview.facts.map((fact) => (
                <FactCard key={fact.id} fact={fact} />
              ))}
            </div>
          )}
          {preview.truncated && (
            <p className="text-xs fg-secondary">
              The injection block was truncated by the fact or character cap.
            </p>
          )}

          {preview.renderedBlock !== null && (
            <details className="rounded-xl border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-s font-medium fg-primary">
                Rendered injection block
              </summary>
              <div className="border-t p-4">
                <div className="flex justify-end">
                  <CopyButton
                    size="compact"
                    variant="secondary"
                    value={preview.renderedBlock}
                    ariaLabel="Copy rendered block"
                    title="Copy rendered block"
                    label="Copy"
                    dataTestId="retrieval-preview-copy-block"
                  />
                </div>
                <pre
                  className={withPrivacyClass(
                    'mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-base p-3 font-mono text-xs fg-primary',
                    blockClassName,
                  )}
                >
                  {preview.renderedBlock}
                </pre>
              </div>
            </details>
          )}

          <section className="rounded-xl border bg-card p-4">
            <h3 className="text-s font-semibold fg-primary">Diagnostics</h3>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-4 border-b pb-2">
                <dt className="fg-secondary">Lane counts</dt>
                <dd className="text-right font-mono fg-primary">
                  vector {preview.diagnostics.laneCounts.vector} · fts{' '}
                  {preview.diagnostics.laneCounts.fts} · trigram{' '}
                  {preview.diagnostics.laneCounts.trigram} · graph{' '}
                  {preview.diagnostics.laneCounts.graph}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4 border-b pb-2">
                <dt className="fg-secondary">Reranker</dt>
                <dd className="text-right font-mono fg-primary">
                  {preview.diagnostics.rerankUsed
                    ? `used · top ${preview.diagnostics.topRerankScore?.toFixed(4) ?? '—'}`
                    : 'not used (cosine fallback)'}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4 border-b pb-2">
                <dt className="fg-secondary">Top cosine</dt>
                <dd className="text-right font-mono fg-primary">
                  {preview.diagnostics.topCosineScore?.toFixed(4) ?? '—'}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4 border-b pb-2">
                <dt className="fg-secondary">Latency</dt>
                <dd className="text-right font-mono fg-primary">
                  {preview.diagnostics.latencyMs} ms
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4 border-b pb-2">
                <dt className="shrink-0 fg-secondary">Rerank scores</dt>
                <dd className="break-all text-right font-mono fg-primary">
                  {formatScores(preview.diagnostics.topScores.rerank)}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4 border-b pb-2">
                <dt className="shrink-0 fg-secondary">Cosine scores</dt>
                <dd className="break-all text-right font-mono fg-primary">
                  {formatScores(preview.diagnostics.topScores.cosine)}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="shrink-0 fg-secondary">RRF scores</dt>
                <dd className="break-all text-right font-mono fg-primary">
                  {formatScores(preview.diagnostics.topScores.rrf)}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
