'use client';

import type { JSX } from 'react';
import type {
  CuratedPipelineDetail,
  CuratedPipelineListQuery,
  CuratedPipelineSummary,
} from '@canopy/protocol/pipeline-catalog';
import {
  formatPipelinePackageFileSummary,
  pipelinePackageKindLabel,
  pipelinePackageRequirementKindLabel,
} from '../lib/pipeline-package-display';
import { Button } from './Button';

export interface CuratedPipelineCatalogProps {
  cloudDisplayName: string;
  rows: CuratedPipelineSummary[];
  query: CuratedPipelineListQuery;
  onQueryChange: (query: CuratedPipelineListQuery) => void;
  loading: boolean;
  error?: string | null;
  stale?: boolean;
  nextCursor?: string | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  selectedKey?: string | null;
  detail?: CuratedPipelineDetail | null;
  detailLoading?: boolean;
  detailError?: string | null;
  onSelect: (row: CuratedPipelineSummary) => void;
  onBack: () => void;
  onImport: (detail: CuratedPipelineDetail) => void;
  onDownload?: (detail: CuratedPipelineDetail) => void;
  importing?: boolean;
  importError?: string | null;
  importedPipelineId?: string | null;
  onOpenImported?: (id: string) => void;
  importDisabledReason?: string;
  hideSearch?: boolean;
  /**
   * Whether the previewed template appears when running a pipeline, and how
   * to change that. The host owns the preference; omit it where the host
   * keeps none.
   */
  launchAvailability?: CuratedPipelineLaunchAvailability;
}

export interface CuratedPipelineLaunchAvailability {
  enabled: boolean;
  pending?: boolean;
  onChange: (enabled: boolean) => void;
}

const FIELD =
  'focus-ring min-w-0 rounded-md ring-1 ring-inset ring-line-base bg-base px-3 py-2 text-sm fg-primary';

export function curatedPipelineStaleMessage(cloudDisplayName: string): string {
  return `Showing saved catalog metadata. Connect to ${cloudDisplayName} to preview or add a workflow.`;
}

/** Display only: all content loading, authorization and import work belongs to the host. */
export function CuratedPipelineCatalog(
  props: CuratedPipelineCatalogProps,
): JSX.Element {
  const { detail, selectedKey, query, importedPipelineId } = props;
  const filter = (next: Partial<CuratedPipelineListQuery>): void =>
    props.onQueryChange({ ...query, ...next, cursor: undefined });
  return (
    <section
      className="min-w-0 space-y-4"
      data-testid="curated-pipeline-catalog"
      aria-label="Workflow templates"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold fg-primary">
            Workflow templates
          </h2>
          <p className="mt-1 text-sm fg-secondary">
            Ready-made workflows you can add and customize.
          </p>
        </div>
        <Button
          disabled={props.loading}
          onClick={props.onRefresh}
          data-testid="curated-pipeline-refresh"
        >
          Refresh catalog
        </Button>
      </div>
      {props.stale && (
        <p role="status" className="text-sm fg-secondary">
          {curatedPipelineStaleMessage(props.cloudDisplayName)}
        </p>
      )}
      {props.error && (
        <p role="alert" className="break-words text-sm fg-destructive">
          {props.error}
        </p>
      )}
      {selectedKey ? (
        <div
          className="min-w-0 space-y-4 rounded-lg ring-1 ring-inset ring-line-base bg-base p-4"
          data-testid="curated-pipeline-detail"
        >
          <Button onClick={props.onBack}>Back to workflow templates</Button>
          {props.launchAvailability && (
            <LaunchAvailabilityControl {...props.launchAvailability} />
          )}
          {props.detailLoading && (
            <p role="status" className="text-sm fg-secondary">
              Loading workflow preview…
            </p>
          )}
          {props.detailError && (
            <p role="alert" className="break-words text-sm fg-destructive">
              {props.detailError}
            </p>
          )}
          {detail && (
            <>
              <div className="min-w-0 space-y-2">
                <h3 className="break-words text-lg font-semibold fg-primary">
                  {detail.name}
                </h3>
                <p className="break-words text-sm fg-secondary">
                  {detail.shortDescription}
                </p>
                <p className="break-words text-xs fg-secondary">
                  {detail.version
                    ? `Version ${detail.version}`
                    : `Revision ${detail.revision}`}{' '}
                  · {detail.jobCount} jobs · {detail.stepCount} steps ·{' '}
                  {detail.scopes.join(', ')} · {detail.triggerTypes.join(', ')}
                </p>
                {detail.authorName && (
                  <p className="text-sm fg-secondary">By {detail.authorName}</p>
                )}
                {detail.docsUrl && /^https?:\/\//.test(detail.docsUrl) && (
                  <a
                    className="text-sm fg-accent underline"
                    href={detail.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Documentation
                  </a>
                )}
              </div>
              {props.onDownload && (
                <Button
                  onClick={() => props.onDownload?.(detail)}
                  data-testid="curated-pipeline-download"
                >
                  Download YAML
                </Button>
              )}
              {detail.package && (
                <details
                  className="rounded-lg ring-1 ring-inset ring-line-base p-3"
                  data-testid="curated-pipeline-package-summary"
                >
                  <summary className="cursor-pointer text-sm font-medium fg-primary">
                    Included dependencies ·{' '}
                    {formatPipelinePackageFileSummary(
                      detail.package.totalFiles,
                      detail.package.totalBytes,
                    )}
                  </summary>
                  {detail.package.resources.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {detail.package.resources.map((resource) => (
                        <li key={resource.id} className="text-sm fg-primary">
                          {resource.displayName}
                          <span className="ml-1 text-xs fg-secondary">
                            {pipelinePackageKindLabel(resource.kind)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.package.environmentRequirements.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium fg-secondary">
                        Setup required
                      </p>
                      <ul className="mt-1 space-y-1">
                        {detail.package.environmentRequirements.map(
                          (requirement) => (
                            <li
                              key={requirement.id}
                              className="text-xs fg-secondary"
                            >
                              {requirement.displayName} ·{' '}
                              {pipelinePackageRequirementKindLabel(
                                requirement.kind,
                              )}
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                </details>
              )}
              <details className="min-w-0">
                <summary className="cursor-pointer text-sm font-medium fg-primary">
                  View workflow YAML
                </summary>
                <pre
                  className="mt-2 max-h-80 overflow-auto rounded-md ring-1 ring-inset ring-line-base bg-secondary p-3 text-xs fg-primary"
                  data-testid="curated-pipeline-yaml"
                >
                  {detail.rawPipeline}
                </pre>
              </details>
              <p className="text-sm fg-secondary">
                Adds an editable copy to your workflows. Review its commands and
                required tools before running. Future catalog changes do not
                replace your copy.
              </p>
              {props.importDisabledReason && (
                <p className="text-sm fg-secondary">
                  {props.importDisabledReason}
                </p>
              )}
              {props.importError && (
                <p role="alert" className="break-words text-sm fg-destructive">
                  {props.importError}
                </p>
              )}
              {importedPipelineId ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-3 text-sm fg-success"
                >
                  Added to your workflows.
                  {props.onOpenImported && (
                    <Button
                      onClick={() => props.onOpenImported?.(importedPipelineId)}
                      data-testid="curated-pipeline-open-imported"
                    >
                      Open workflow
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  variant="primary"
                  disabled={props.importing || !!props.importDisabledReason}
                  onClick={() => props.onImport(detail)}
                  data-testid="curated-pipeline-add"
                >
                  {props.importing ? 'Adding workflow…' : 'Add to my workflows'}
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {!props.hideSearch && (
              <input
                className={`${FIELD} flex-1`}
                aria-label="Search workflow templates"
                placeholder="Search workflow templates…"
                value={query.q ?? ''}
                onChange={(event) =>
                  filter({ q: event.target.value || undefined })
                }
                data-testid="curated-pipeline-search"
              />
            )}
            <input
              className={FIELD}
              aria-label="Workflow template category"
              placeholder="Category"
              value={query.category ?? ''}
              onChange={(event) =>
                filter({ category: event.target.value || undefined })
              }
            />
            <select
              className={FIELD}
              aria-label="Workflow template trigger"
              value={query.triggerType ?? ''}
              onChange={(event) =>
                filter({
                  triggerType:
                    event.target.value === 'dispatch' ||
                    event.target.value === 'plan_ready' ||
                    event.target.value === 'task_ready'
                      ? event.target.value
                      : undefined,
                })
              }
            >
              <option value="">All triggers</option>
              <option value="dispatch">Manual</option>
              <option value="plan_ready">Plan ready</option>
              <option value="task_ready">Task ready</option>
            </select>
            <select
              className={FIELD}
              aria-label="Workflow template scope"
              value={query.scope ?? ''}
              onChange={(event) =>
                filter({
                  scope:
                    event.target.value === 'global' ||
                    event.target.value === 'directory' ||
                    event.target.value === 'worktree'
                      ? event.target.value
                      : undefined,
                })
              }
            >
              <option value="">All execution scopes</option>
              <option value="global">Global</option>
              <option value="directory">Directory</option>
              <option value="worktree">Worktree</option>
            </select>
          </div>
          {props.loading && (
            <p role="status" className="text-sm fg-secondary">
              Loading workflow templates…
            </p>
          )}
          {!props.loading && !props.error && props.rows.length === 0 && (
            <p className="text-sm fg-secondary">
              No workflow templates match these filters.
            </p>
          )}
          <ul
            className="divide-y rounded-lg ring-1 ring-inset ring-line-base"
            data-testid="curated-pipeline-rows"
          >
            {props.rows.map((row) => (
              <li key={row.key} className="flex min-w-0 items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-semibold fg-primary">
                    {row.name}
                  </h3>
                  <p className="mt-1 break-words text-sm fg-secondary">
                    {row.shortDescription}
                  </p>
                  <p className="mt-2 break-words text-xs fg-secondary">
                    {row.jobCount} jobs · {row.stepCount} steps ·{' '}
                    {row.categories.join(', ') || 'General'} ·{' '}
                    {row.scopes.join(', ')}
                  </p>
                </div>
                <Button
                  onClick={() => props.onSelect(row)}
                  data-testid={`curated-pipeline-preview-${row.key}`}
                  aria-label={`Preview ${row.name}`}
                >
                  Preview
                </Button>
              </li>
            ))}
          </ul>
          {props.nextCursor && (
            <Button
              disabled={props.loading}
              onClick={props.onLoadMore}
              data-testid="curated-pipeline-load-more"
            >
              Load more templates
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Available without the definition, so a disabled template can be re-enabled
 * even when its preview cannot load.
 */
function LaunchAvailabilityControl({
  enabled,
  pending = false,
  onChange,
}: CuratedPipelineLaunchAvailability): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid="curated-pipeline-availability"
    >
      <p className="text-sm fg-secondary">
        {enabled
          ? 'Enabled. It appears when you run a workflow.'
          : 'Disabled. It is hidden when you run a workflow.'}
      </p>
      <Button
        disabled={pending}
        onClick={() => onChange(!enabled)}
        data-testid="curated-pipeline-toggle-enabled"
      >
        {enabled ? 'Disable workflow' : 'Enable workflow'}
      </Button>
    </div>
  );
}
