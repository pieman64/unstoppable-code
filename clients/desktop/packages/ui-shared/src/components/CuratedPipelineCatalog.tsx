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
import { Disclosure } from './Disclosure';
import { ErrorBanner } from './StatusBlocks';
import { Button } from './Button';
import { TextInput } from './Field';
import { SearchField } from './SearchField';
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect';
import { Heading } from './Heading';

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

const TRIGGER_FILTER_OPTIONS: readonly SettingsSelectOption<
  '' | 'dispatch' | 'plan_ready' | 'task_ready'
>[] = [
  { value: '', label: 'All triggers' },
  { value: 'dispatch', label: 'Manual' },
  { value: 'plan_ready', label: 'Plan ready' },
  { value: 'task_ready', label: 'Task ready' },
];

const SCOPE_FILTER_OPTIONS: readonly SettingsSelectOption<
  '' | 'global' | 'directory' | 'worktree'
>[] = [
  { value: '', label: 'All execution scopes' },
  { value: 'global', label: 'Global' },
  { value: 'directory', label: 'Directory' },
  { value: 'worktree', label: 'Worktree' },
];

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
          <Heading level={2} variant="section">
            Workflow templates
          </Heading>
          <p className="mt-1 text-s fg-secondary">
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
        <p role="status" className="text-s fg-secondary">
          {curatedPipelineStaleMessage(props.cloudDisplayName)}
        </p>
      )}
      <ErrorBanner className="" error={props.error} />
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
            <p role="status" className="text-s fg-secondary">
              Loading workflow preview…
            </p>
          )}
          <ErrorBanner className="" error={props.detailError} />
          {detail && (
            <>
              <div className="min-w-0 space-y-2">
                <Heading level={3} variant="section" className="break-words">
                  {detail.name}
                </Heading>
                <p className="break-words text-s fg-secondary">
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
                  <p className="text-s fg-secondary">By {detail.authorName}</p>
                )}
                {detail.docsUrl && /^https?:\/\//.test(detail.docsUrl) && (
                  <a
                    className="text-s fg-accent underline"
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
                <Disclosure
                  variant="box"
                  label="Included dependencies"
                  meta={formatPipelinePackageFileSummary(
                    detail.package.totalFiles,
                    detail.package.totalBytes,
                  )}
                  keepMounted
                  dataTestId="curated-pipeline-package-summary"
                >
                  {detail.package.resources.length > 0 && (
                    <ul className="space-y-2">
                      {detail.package.resources.map((resource) => (
                        <li key={resource.id} className="text-s fg-primary">
                          {resource.displayName}
                          <span className="ml-1 text-xs fg-secondary">
                            {pipelinePackageKindLabel(resource.kind)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.package.environmentRequirements.length > 0 && (
                    <div>
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
                </Disclosure>
              )}
              <Disclosure
                label="View workflow YAML"
                keepMounted
                dataTestId="curated-pipeline-yaml-disclosure"
              >
                <pre
                  className="max-h-80 overflow-auto rounded-md ring-1 ring-inset ring-line-base bg-secondary p-3 text-xs fg-primary"
                  data-testid="curated-pipeline-yaml"
                >
                  {detail.rawPipeline}
                </pre>
              </Disclosure>
              <p className="text-s fg-secondary">
                Adds an editable copy to your workflows. Review its commands and
                required tools before running. Future catalog changes do not
                replace your copy.
              </p>
              {props.importDisabledReason && (
                <p className="text-s fg-secondary">
                  {props.importDisabledReason}
                </p>
              )}
              <ErrorBanner className="" error={props.importError} />
              {importedPipelineId ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-3 text-s fg-success"
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
              <SearchField
                className="flex-1"
                aria-label="Search workflow templates"
                placeholder="Search workflow templates…"
                value={query.q ?? ''}
                onValueChange={(next) => filter({ q: next || undefined })}
                // Escape closes the catalog, as it does from any other field.
                clearOnEscape={false}
                data-testid="curated-pipeline-search"
              />
            )}
            <div className="w-36">
              <TextInput
                density="compact"
                aria-label="Workflow template category"
                placeholder="Category"
                value={query.category ?? ''}
                onChange={(event) =>
                  filter({ category: event.target.value || undefined })
                }
              />
            </div>
            <SettingsSelect
              aria-label="Workflow template trigger"
              options={TRIGGER_FILTER_OPTIONS}
              value={query.triggerType ?? ''}
              onValueChange={(next) =>
                filter({ triggerType: next === '' ? undefined : next })
              }
            />
            <SettingsSelect
              aria-label="Workflow template scope"
              options={SCOPE_FILTER_OPTIONS}
              value={query.scope ?? ''}
              onValueChange={(next) =>
                filter({ scope: next === '' ? undefined : next })
              }
            />
          </div>
          {props.loading && (
            <p role="status" className="text-s fg-secondary">
              Loading workflow templates…
            </p>
          )}
          {!props.loading && !props.error && props.rows.length === 0 && (
            <p className="text-s fg-secondary">
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
                  <Heading level={3} variant="title" className="break-words">
                    {row.name}
                  </Heading>
                  <p className="mt-1 break-words text-s fg-secondary">
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
      <p className="text-s fg-secondary">
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
