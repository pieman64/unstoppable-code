import {
  countCapabilityPackageDistinctFiles,
  groupCapabilityPackageProviderTwins,
  isCapabilityPackageSubjectBinding,
  listCapabilityPackageExecutablePaths,
} from '@canopy/protocol/pipelines';
import { useId, useState, type JSX, type ReactNode } from 'react';
import {
  formatPipelinePackageExecutableFiles,
  formatPipelinePackageFileSummary,
  pipelinePackageKindLabel,
  pipelinePackageRequirementKindLabel,
  PIPELINE_PACKAGE_PUBLISHER_NO_CREDENTIALS_NOTE,
  PIPELINE_PACKAGE_PUBLISHER_SETUP_HEADING,
} from '@canopy/ui-shared/lib/pipeline-package-display';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageEnvironmentRequirement,
  PipelinePackageInvocationDismissal,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';
import {
  computeRequiredResourceIds,
  computeResourceClosureIds,
  describeDependencyReason,
} from './capability-package-closure';
import { CapabilityPackageProblems } from './CapabilityPackageProblems';

/**
 * Publisher-facing dependency review for a self-contained capability share.
 * The shared share dialog renders it for every resource: a summary row of
 * what the share includes, collapsed by default, that expands into the
 * analyzed member closure that will be copied into the package, the
 * recipient environment requirements that will NOT be copied, and any
 * blockers. Blockers always render above the summary, so collapsing never
 * hides why Share is unavailable.
 *
 * Display + selection only: it never reads dependency bytes (the main process
 * keeps them) and never decides whether the share is allowed — the hosting
 * modal owns submission. The selection does not depend on whether the
 * details are open.
 */

const INCLUDED_FILES_HEADING = 'Included files';
const DEFINITION_ONLY_LABEL = 'Definition only';
const LOADING_LABEL = 'Checking included files…';
const REVALIDATING_LABEL = 'Rechecking included files…';
const ANALYSIS_FAILURE_LABEL = "Couldn't check the included files. Try again.";
const RETRY_LABEL = 'Try again';
const SHOW_DETAILS_LABEL = 'Show details';
const HIDE_DETAILS_LABEL = 'Hide details';
/** A failure reason is diagnostic text from the host; keep it to a line or two. */
const MAX_ERROR_REASON_LENGTH = 240;

function AnalysisFailureReason({
  reason,
  testIdPrefix,
}: {
  reason: string | null | undefined;
  testIdPrefix: string;
}): JSX.Element | null {
  if (!reason) return null;
  return (
    <p
      className="text-xs fg-secondary break-words"
      data-testid={`${testIdPrefix}-dependencies-error-reason`}
      title={reason}
    >
      Details:{' '}
      {reason.length > MAX_ERROR_REASON_LENGTH
        ? `${reason.slice(0, MAX_ERROR_REASON_LENGTH - 1).trimEnd()}…`
        : reason}
    </p>
  );
}

const BADGE_CLASS =
  'inline-flex items-center rounded-md px-1.5 py-0.5 text-3xs font-medium';
const DISCLOSURE_CLASS =
  'focus-ring rounded text-xs fg-secondary underline-offset-2 hover:fg-primary hover:underline';

interface CapabilityPackageDependenciesProps {
  /** Reference mode lists recipient setup without claiming files are copied. */
  mode?: 'package' | 'reference';
  analysis: PipelinePackageAnalysisSummary | null;
  /** True while an analysis request is in flight. */
  loading: boolean;
  /** Set when the analysis request itself failed (not a content blocker). */
  errored: boolean;
  /** Why the analysis failed, shown beneath the generic failure copy. */
  errorReason?: string | null;
  /** Optional resource ids the publisher has opted in to. */
  selectedOptionalResourceIds: readonly string[];
  onToggleOptionalResource: (resourceId: string) => void;
  onRetry: () => void;
  /**
   * Tokens the publisher marked as not commands, as echoed by main.
   *
   * Dismissal only exists because pipeline steps carry free-text prompts
   * whose `@skill` tokens are parsed heuristically. A host whose capabilities
   * are explicit refs has no ambiguous token to dismiss, so it omits these
   * three props and no dismissal affordance renders.
   */
  dismissedInvocations?: readonly PipelinePackageInvocationDismissal[];
  onDismissInvocation?: (dismissal: PipelinePackageInvocationDismissal) => void;
  onRestoreInvocation?: (dismissal: PipelinePackageInvocationDismissal) => void;
  /**
   * Turn one manifest binding into a location label, or `null` to omit it.
   * Formatting a location is the host's job — the component must not know
   * what a job or a step is. Defaults to the pipeline `job.step` form.
   */
  bindingLabelFor?: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  /** Lower-case noun for the resource being shared ("pipeline", "skill"). */
  subjectLabel?: string;
  /**
   * Test-id prefix of the hosting dialog, e.g. `share-skill`. Sections get
   * `${testIdPrefix}-dependencies*` and `${testIdPrefix}-dependency-problems*`.
   */
  testIdPrefix: string;
  disabled: boolean;
  /** Opens a repair chat for the blocking problems; absent when unsupported. */
  onFixWithAI?: () => void;
  fixWithAIDisabled?: boolean;
  fixWithAIPending?: boolean;
  fixWithAIFailed?: boolean;
}

const DEFAULT_BINDING_LABEL = (binding: {
  jobId: string;
  stepId: string;
}): string => `${binding.jobId}.${binding.stepId}`;

function sourceBadge(
  visibility: PipelinePackageResource['sourceVisibility'],
): string | null {
  if (visibility === 'private') return 'Private source';
  if (visibility === 'local') return 'Local source';
  return null;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The summary line: files and size of what the selected closure copies, or
 * Definition only, plus how many setup requirements recipients meet.
 */
function includedSummary({
  mode,
  includedResources,
  requirementCount,
}: {
  mode: 'package' | 'reference';
  includedResources: readonly PipelinePackageResource[];
  requirementCount: number;
}): string {
  const { files, bytes } =
    mode === 'reference'
      ? { files: 0, bytes: 0 }
      : countCapabilityPackageDistinctFiles(includedResources);
  const parts = [
    files === 0
      ? DEFINITION_ONLY_LABEL
      : formatPipelinePackageFileSummary(files, bytes),
  ];
  if (requirementCount > 0) {
    parts.push(
      plural(requirementCount, 'setup requirement', 'setup requirements'),
    );
  }
  return parts.join(' · ');
}

export function CapabilityPackageDependencies({
  analysis,
  loading,
  errored,
  errorReason,
  selectedOptionalResourceIds,
  onToggleOptionalResource,
  onRetry,
  dismissedInvocations,
  onDismissInvocation,
  onRestoreInvocation,
  bindingLabelFor = DEFAULT_BINDING_LABEL,
  subjectLabel = 'pipeline',
  testIdPrefix,
  disabled,
  mode = 'package',
  onFixWithAI,
  fixWithAIDisabled = false,
  fixWithAIPending = false,
  fixWithAIFailed = false,
}: CapabilityPackageDependenciesProps): JSX.Element {
  // Local to this dialog instance, so it survives re-analysis.
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const helperText =
    mode === 'reference'
      ? `Only a reference is shared. Recipients set up the requirements listed here; no files, credentials, or private configuration are copied.`
      : `These files will be copied into this share so recipients can run the ${subjectLabel} without access to the original sources.`;
  const emptyDependenciesLabel =
    mode === 'reference'
      ? `No additional setup requirements were detected for this ${subjectLabel}.`
      : `This ${subjectLabel} has no local dependencies to copy.`;
  // Only the very first analysis collapses the section to a bare label. A
  // re-run triggered by a dismissal keeps the previous result on screen and
  // marks itself busy, so marking one token never blanks the list.
  if (loading && analysis === null) {
    return (
      <section
        className="space-y-2"
        data-testid={`${testIdPrefix}-dependencies`}
        data-state="loading"
      >
        <SummaryRow
          testIdPrefix={testIdPrefix}
          summary={LOADING_LABEL}
          toggle={null}
        />
      </section>
    );
  }

  if (errored || !analysis) {
    return (
      <section
        className="space-y-2"
        data-testid={`${testIdPrefix}-dependencies`}
        data-state="error"
      >
        <SummaryRow
          testIdPrefix={testIdPrefix}
          summary={null}
          toggle={
            <button
              type="button"
              onClick={onRetry}
              disabled={disabled}
              data-testid={`${testIdPrefix}-dependencies-retry`}
              className="focus-ring shrink-0 rounded-md border px-2 py-1 text-xs fg-primary disabled:opacity-40"
            >
              {RETRY_LABEL}
            </button>
          }
        >
          {/* One alert region, so the reason is announced with the failure. */}
          <div className="space-y-1" role="alert">
            <p className="text-xs fg-destructive">{ANALYSIS_FAILURE_LABEL}</p>
            <AnalysisFailureReason
              reason={errorReason}
              testIdPrefix={testIdPrefix}
            />
          </div>
        </SummaryRow>
      </section>
    );
  }

  const manifest = analysis.manifest;
  const resources = manifest?.resources ?? [];
  const requiredIds = manifest
    ? computeRequiredResourceIds(manifest)
    : new Set<string>();
  const selectedClosureIds = manifest
    ? computeResourceClosureIds(manifest, selectedOptionalResourceIds)
    : new Set<string>();
  const includedIds = manifest
    ? computeResourceClosureIds(manifest, [
        ...Array.from(requiredIds),
        ...selectedOptionalResourceIds,
      ])
    : new Set<string>();
  const requirements = manifest?.environmentRequirements ?? [];
  const blockerCount = analysis.blockers.length;
  // Without a manifest the renderer has no evidence of emptiness, so it must
  // stay silent rather than claim there is nothing to copy. That missing
  // `manifest !== undefined` clause is what let "No local dependency files
  // were detected." render directly above a wall of failures.
  const showEmptyState =
    !loading &&
    !errored &&
    manifest !== undefined &&
    resources.length === 0 &&
    requirements.length === 0 &&
    blockerCount === 0;
  // The problem card above already says what blocks the share, so the
  // summary adds no second count of it.
  const summary =
    blockerCount > 0
      ? null
      : loading
        ? REVALIDATING_LABEL
        : includedSummary({
            mode,
            includedResources: resources.filter((resource) =>
              includedIds.has(resource.id),
            ),
            requirementCount: requirements.length,
          });

  return (
    <section
      className="space-y-3"
      data-testid={`${testIdPrefix}-dependencies`}
      data-state={loading ? 'revalidating' : analysis.state}
      data-busy={loading ? 'true' : 'false'}
    >
      {loading && blockerCount > 0 && (
        <p
          className="text-xs fg-secondary"
          data-testid={`${testIdPrefix}-dependencies-revalidating`}
        >
          {REVALIDATING_LABEL}
        </p>
      )}

      <CapabilityPackageProblems
        blockers={analysis.blockers}
        {...(dismissedInvocations !== undefined
          ? { dismissedInvocations }
          : {})}
        {...(onDismissInvocation !== undefined
          ? { onDismiss: onDismissInvocation }
          : {})}
        {...(onRestoreInvocation !== undefined
          ? { onRestore: onRestoreInvocation }
          : {})}
        bindingLabelFor={bindingLabelFor}
        disabled={disabled || loading}
        {...(onFixWithAI !== undefined ? { onFixWithAI } : {})}
        fixWithAIDisabled={fixWithAIDisabled}
        fixWithAIPending={fixWithAIPending}
        fixWithAIFailed={fixWithAIFailed}
        testIdPrefix={testIdPrefix}
      />

      <SummaryRow
        testIdPrefix={testIdPrefix}
        summary={summary}
        {...(loading && blockerCount === 0
          ? { summaryTestId: `${testIdPrefix}-dependencies-revalidating` }
          : {})}
        toggle={
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={(): void => {
              setExpanded((open) => !open);
            }}
            data-testid={`${testIdPrefix}-dependencies-toggle`}
            className={`${DISCLOSURE_CLASS} shrink-0`}
          >
            {expanded ? HIDE_DETAILS_LABEL : SHOW_DETAILS_LABEL}
          </button>
        }
      />

      <div
        id={detailsId}
        hidden={!expanded}
        className="space-y-3"
        data-testid={`${testIdPrefix}-dependencies-details`}
      >
        {expanded && (
          <>
            <p className="text-xs fg-secondary">{helperText}</p>

            {showEmptyState && (
              <p
                className="text-xs fg-secondary"
                data-testid={`${testIdPrefix}-dependencies-empty`}
              >
                {emptyDependenciesLabel}
              </p>
            )}

            {resources.length > 0 && (
              <ul
                className="divide-y divide-line-base"
                data-testid={`${testIdPrefix}-dependencies-list`}
              >
                {/* A skill packaged for both providers is one folder, so its
                    per-provider resources share a row and toggle together. */}
                {groupCapabilityPackageProviderTwins(resources).map((group) => {
                  const [resource] = group;
                  if (!resource) return null;
                  const ids = group.map((member) => member.id);
                  return (
                    <DependencyRow
                      key={resource.id}
                      resource={resource}
                      group={group}
                      required={ids.some(
                        (id) =>
                          requiredIds.has(id) ||
                          (selectedClosureIds.has(id) &&
                            !selectedOptionalResourceIds.includes(id)),
                      )}
                      checked={ids.every(
                        (id) =>
                          requiredIds.has(id) || selectedClosureIds.has(id),
                      )}
                      reason={
                        manifest
                          ? describeDependencyReason(manifest, resource.id)
                          : null
                      }
                      bindings={Array.from(
                        new Set(
                          (manifest?.bindings ?? [])
                            .flatMap((binding) =>
                              // A whole-share binding has no location to name:
                              // it *is* the share, so it contributes no label
                              // rather than an empty `.` one.
                              isCapabilityPackageSubjectBinding(binding) ||
                              !binding.resourceIds.some((id) =>
                                ids.includes(id),
                              )
                                ? []
                                : [bindingLabelFor(binding)],
                            )
                            .filter((label): label is string => label !== null),
                        ),
                      )}
                      disabled={disabled}
                      testIdPrefix={testIdPrefix}
                      onToggle={(): void => {
                        for (const id of ids) onToggleOptionalResource(id);
                      }}
                    />
                  );
                })}
              </ul>
            )}

            {requirements.length > 0 && (
              <RecipientSetupList
                requirements={requirements}
                bindingLabelFor={bindingLabelFor}
                testIdPrefix={testIdPrefix}
              />
            )}

            {(analysis.unpackageableSelectionLabels?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium fg-primary">
                  Kept private when sharing
                </p>
                <ul
                  className="list-disc pl-5 text-xs fg-secondary"
                  data-testid={`${testIdPrefix}-dependencies-unpackageable`}
                >
                  {analysis.unpackageableSelectionLabels?.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function SummaryRow({
  testIdPrefix,
  summary,
  summaryTestId,
  toggle,
  children,
}: {
  testIdPrefix: string;
  summary: string | null;
  summaryTestId?: string;
  toggle: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex items-start justify-between gap-3"
      data-testid={`${testIdPrefix}-dependencies-summary`}
    >
      <div className="min-w-0 space-y-0.5">
        <h3 className="text-s font-medium fg-primary">
          {INCLUDED_FILES_HEADING}
        </h3>
        {summary !== null && (
          <p
            className="text-xs fg-secondary"
            {...(summaryTestId !== undefined
              ? { 'data-testid': summaryTestId }
              : {})}
          >
            {summary}
          </p>
        )}
        {children}
      </div>
      {toggle}
    </div>
  );
}

interface DependencyRowProps {
  /** The resource whose name and source the row shows. */
  resource: PipelinePackageResource;
  /** Every resource the row stands for, including `resource`. */
  group: readonly PipelinePackageResource[];
  required: boolean;
  checked: boolean;
  reason: string | null;
  /**
   * Pre-formatted location labels for the places this resource is bound.
   * Each host formats its own — pipelines render `job.step`, an automation
   * has exactly one implicit location and passes none.
   */
  bindings: readonly string[];
  disabled: boolean;
  testIdPrefix: string;
  onToggle: () => void;
}

function DependencyRow({
  resource,
  group,
  required,
  checked,
  reason,
  bindings,
  disabled,
  testIdPrefix,
  onToggle,
}: DependencyRowProps): JSX.Element {
  const [showSteps, setShowSteps] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const badge = sourceBadge(resource.sourceVisibility);
  // Each file once, however many provider copies carry it.
  const { files: fileCount, bytes: totalBytes } =
    countCapabilityPackageDistinctFiles(group);
  const executableFiles = formatPipelinePackageExecutableFiles(
    Array.from(
      new Set(group.flatMap(listCapabilityPackageExecutablePaths)),
    ).sort(),
  );

  return (
    <li
      className="py-2"
      data-testid={`${testIdPrefix}-dependencies-item-${resource.id}`}
      data-required={required ? 'true' : 'false'}
    >
      <div className="flex items-start gap-2.5">
        {/* Only an optional file is a choice; a required one says so. The
            placeholder keeps every row's text on one column. */}
        {required ? (
          <span aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            aria-label={`Include ${resource.displayName}`}
            className="mt-0.5 h-4 w-4 shrink-0 rounded"
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-s font-medium fg-primary">
              {resource.displayName}
            </span>
            <span
              className={`${BADGE_CLASS} bg-fg-primary/[0.06] fg-secondary`}
            >
              {pipelinePackageKindLabel(resource.kind)}
            </span>
            {badge && (
              <span className={`${BADGE_CLASS} bg-warning-subtle fg-warning`}>
                {badge}
              </span>
            )}
          </div>
          <p className="text-xs fg-secondary">
            {resource.sourceLabel} ·{' '}
            {formatPipelinePackageFileSummary(fileCount, totalBytes)}
          </p>
          {executableFiles !== null && (
            <p
              className="text-xs fg-primary"
              data-testid="capability-package-executable-files"
            >
              {executableFiles}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {bindings.length > 0 && (
              <button
                type="button"
                aria-expanded={showSteps}
                onClick={(): void => {
                  setShowSteps((open) => !open);
                }}
                className={DISCLOSURE_CLASS}
              >
                Used by {bindings.length}{' '}
                {bindings.length === 1 ? 'step' : 'steps'}
              </button>
            )}
            {reason && (
              <button
                type="button"
                aria-expanded={showReason}
                onClick={(): void => {
                  setShowReason((open) => !open);
                }}
                className={DISCLOSURE_CLASS}
              >
                Why is this included?
              </button>
            )}
          </div>
          {showSteps && bindings.length > 0 && (
            <p className="text-xs fg-secondary">
              Used by {bindings.join(', ')}
            </p>
          )}
          {showReason && reason && (
            <p className="text-xs fg-secondary">{reason}</p>
          )}
        </div>
        {required && (
          <span className="shrink-0 text-xs fg-tertiary">Required</span>
        )}
      </div>
    </li>
  );
}

function RecipientSetupList({
  requirements,
  bindingLabelFor,
  testIdPrefix,
}: {
  testIdPrefix: string;
  requirements: readonly PipelinePackageEnvironmentRequirement[];
  bindingLabelFor: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
}): JSX.Element {
  return (
    <div
      className="space-y-1.5"
      data-testid={`${testIdPrefix}-dependencies-recipient-setup`}
    >
      <h4 className="text-s font-medium fg-primary">
        {PIPELINE_PACKAGE_PUBLISHER_SETUP_HEADING}
      </h4>
      <p className="text-xs fg-secondary">
        {PIPELINE_PACKAGE_PUBLISHER_NO_CREDENTIALS_NOTE}
      </p>
      <ul className="space-y-1">
        {requirements.map((requirement) => {
          const locations = requirement.affectedSteps
            .map(bindingLabelFor)
            .filter((label): label is string => label !== null);
          return (
            <li
              key={requirement.id}
              className="rounded-lg border bg-base px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-s fg-primary">
                  {requirement.displayName}
                </span>
                <span
                  className={`${BADGE_CLASS} bg-fg-primary/[0.06] fg-secondary`}
                >
                  {pipelinePackageRequirementKindLabel(requirement.kind)}
                </span>
                {requirement.required && (
                  <span className={`${BADGE_CLASS} bg-accent-subtle fg-accent`}>
                    Required
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs fg-secondary">
                {requirement.setupHint}
              </p>
              {locations.length > 0 && (
                <p className="mt-0.5 text-xs fg-secondary">
                  Affects {locations.join(', ')}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
