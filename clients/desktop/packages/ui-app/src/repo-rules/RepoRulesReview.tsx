'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type {
  RepoRuleFlag,
  RepoRuleKind,
  RepoRuleProposal,
  RepoRuleSkipped,
  RepoRulesScanResponse,
  RepoRulesStatus,
} from '@canopy/protocol/repo-rules';
import { useCanopyClient } from '@canopy/app-state';
import {
  Button,
  ErrorBanner,
  LoadingSpinner,
  Notice,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { CapabilityGate } from '../capability/CapabilityGate';

/**
 * Review flow for using a project's Cursor rules in chats (CAN-2053): choose a
 * workspace when the entry point has none, explain what is read, scan, review
 * each rule, and save the workspace policy. Hosts supply the flow through the
 * `repoRules.*` client operations and the `repoRulesImport` capability; a host
 * without it renders the unsupported state and makes no client calls.
 */
export interface RepoRulesReviewWorkspace {
  readonly id: string;
  readonly name: string;
}

export interface RepoRulesReviewProps {
  /** Product name for copy, from the host's brand helper. */
  readonly appName: string;
  /** Code workspaces the user can choose from. */
  readonly workspaces: readonly RepoRulesReviewWorkspace[];
  /**
   * The workspace to review. Without it the user chooses one; the flow never
   * picks one from collection order.
   */
  readonly initialWorkspaceId?: string;
  readonly onClose: () => void;
  /** Called after a successful save, before `onClose`. */
  readonly onApplied?: (result: {
    readonly workspaceId: string;
    readonly status: RepoRulesStatus;
  }) => void;
}

type Phase =
  | { readonly kind: 'choose' }
  | { readonly kind: 'consent' }
  | { readonly kind: 'scanning' }
  | { readonly kind: 'scan-error'; readonly message: string }
  | { readonly kind: 'review'; readonly scan: RepoRulesScanResponse };

type StatusState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: RepoRulesStatus }
  | { readonly kind: 'error' };

type PreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly body: string }
  | { readonly kind: 'error'; readonly message: string };

/** Previews are for reading, not archiving: keep the DOM bounded. */
const PREVIEW_CHAR_LIMIT = 20_000;

const KIND_LABELS: Record<RepoRuleKind, string> = {
  always: 'Always',
  'legacy-cursorrules': 'Always',
  auto: 'Matching files',
  'agent-requested': 'When relevant',
  manual: 'When mentioned',
};

const KIND_DESCRIPTIONS: Record<RepoRuleKind, string> = {
  always: 'Added to every new chat.',
  'legacy-cursorrules': 'Legacy root rules file, added to every new chat.',
  auto: 'The agent reads it before working on matching files.',
  'agent-requested': 'The agent reads it when the description fits the task.',
  manual: 'The agent reads it only when you mention it.',
};

const FLAG_LABELS: Record<RepoRuleFlag, string> = {
  duplicate: 'Repeats AGENTS.md or CLAUDE.md',
  'malformed-frontmatter': "Header couldn't be read",
  'unsupported-frontmatter': 'Unknown header fields ignored',
  'missing-file-reference': 'References a missing file',
  'unsupported-glob': 'Unsupported file pattern',
};

const SKIP_REASONS: Record<RepoRuleSkipped['reason'], string> = {
  unavailable: "Couldn't be read",
  'unsafe-path': 'Points outside the repository',
  'too-large': 'Larger than 64 KB',
  changed: 'Changed during the scan',
  limit: 'Over the 200-rule limit',
  'unsupported-git': "Repository files couldn't be listed",
};

const DIAGNOSTIC_MESSAGES: Record<
  NonNullable<RepoRulesStatus['diagnostic']>,
  string | null
> = {
  missing: null,
  invalid:
    "Saved Cursor rule settings couldn't be read, so rules are off. Review them to turn them on again.",
  'unsupported-version':
    'Saved Cursor rule settings came from a newer version, so rules are off.',
  unavailable: "This project's checkout is unavailable.",
};

const SNAPSHOT_NOTE =
  'Changes apply to new chats. Chats already running keep their inline instructions and rule index. Files read through rule entries or @file references remain live.';

function activationKind(rule: RepoRuleProposal): RepoRuleKind {
  return rule.kind === 'auto' && rule.flags.includes('unsupported-glob')
    ? 'manual'
    : rule.kind;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function needsRescan(message: string): boolean {
  return /scan again/i.test(message);
}

function ruleCountLabel(count: number): string {
  return count === 1 ? '1 rule' : `${count} rules`;
}

/** Unsupported state shown where the host can't read local repositories. */
function RepoRulesUnsupported({
  onClose,
}: {
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4" data-testid="repo-rules-unsupported">
      <Notice intent="neutral" title="Cursor rules need the desktop app">
        Reviewing Cursor rules reads files in your local checkout. Open this
        project in the desktop app to turn them on.
      </Notice>
      <div className="flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

export function RepoRulesReview(props: RepoRulesReviewProps): JSX.Element {
  return (
    <CapabilityGate
      when={(capabilities) => capabilities.repoRulesImport === true}
      fallback={<RepoRulesUnsupported onClose={props.onClose} />}
    >
      <RepoRulesReviewFlow
        key={props.initialWorkspaceId ?? 'choose'}
        {...props}
      />
    </CapabilityGate>
  );
}

function RepoRulesReviewFlow({
  appName,
  workspaces,
  initialWorkspaceId,
  onClose,
  onApplied,
}: RepoRulesReviewProps): JSX.Element {
  const client = useCanopyClient();
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? null,
  );
  const [phase, setPhase] = useState<Phase>(
    initialWorkspaceId ? { kind: 'consent' } : { kind: 'choose' },
  );
  const [statusState, setStatusState] = useState<StatusState>({
    kind: 'loading',
  });
  // Local selection edits, keyed by rule id. They survive a failed save and
  // a rescan so the user doesn't lose their choices.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  // Bumps on workspace change and unmount so late responses are ignored.
  const generation = useRef(0);
  const scanGeneration = useRef(0);
  const previewRequests = useRef<Record<string, number>>({});
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  const workspaceName = workspace?.name ?? 'this project';

  useEffect(() => {
    const responses = generation;
    return (): void => {
      responses.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    const current = ++generation.current;
    setStatusState({ kind: 'loading' });
    client
      .query('repoRules.status', { workspaceId })
      .then((status) => {
        if (generation.current === current)
          setStatusState({ kind: 'ready', status });
      })
      .catch(() => {
        if (generation.current === current) setStatusState({ kind: 'error' });
      });
  }, [client, workspaceId]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase.kind]);

  const scan = useCallback((): void => {
    if (!workspaceId) return;
    scanGeneration.current += 1;
    const current = generation.current;
    setApplyError(null);
    setPreviews({});
    setPhase({ kind: 'scanning' });
    client
      .query('repoRules.scan', { workspaceId })
      .then((result) => {
        if (generation.current === current)
          setPhase({ kind: 'review', scan: result });
      })
      .catch((error: unknown) => {
        if (generation.current === current)
          setPhase({
            kind: 'scan-error',
            message: errorMessage(error, "Couldn't scan this project's rules."),
          });
      });
  }, [client, workspaceId]);

  const apply = (
    request:
      | { readonly enabled: false }
      | { readonly enabled: true; readonly scan: RepoRulesScanResponse },
  ): void => {
    if (!workspaceId || applying) return;
    const current = generation.current;
    setApplying(true);
    setApplyError(null);
    const args = request.enabled
      ? {
          workspaceId,
          enabled: true,
          scanId: request.scan.scanId,
          disabledRuleIds: request.scan.proposals
            .filter((rule) => !(overrides[rule.id] ?? rule.selected))
            .map((rule) => rule.id),
        }
      : { workspaceId, enabled: false };
    client
      .command('repoRules.apply', args)
      .then((status) => {
        if (generation.current !== current) return;
        setApplying(false);
        onApplied?.({ workspaceId, status });
        onClose();
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return;
        setApplying(false);
        setApplyError(
          errorMessage(error, "Couldn't save your Cursor rule settings."),
        );
      });
  };

  const togglePreview = (ruleId: string, scanId: string): void => {
    if (!workspaceId) return;
    const previewRequest = (previewRequests.current[ruleId] ?? 0) + 1;
    previewRequests.current[ruleId] = previewRequest;
    if (previews[ruleId]) {
      setPreviews((prev) => {
        const next = { ...prev };
        delete next[ruleId];
        return next;
      });
      return;
    }
    const current = generation.current;
    const currentScan = scanGeneration.current;
    setPreviews((prev) => ({ ...prev, [ruleId]: { kind: 'loading' } }));
    client
      .query('repoRules.preview', { workspaceId, scanId, ruleId })
      .then(({ body }) => {
        if (
          generation.current !== current ||
          scanGeneration.current !== currentScan ||
          previewRequests.current[ruleId] !== previewRequest
        )
          return;
        setPreviews((prev) =>
          prev[ruleId] ? { ...prev, [ruleId]: { kind: 'ready', body } } : prev,
        );
      })
      .catch((error: unknown) => {
        if (
          generation.current !== current ||
          scanGeneration.current !== currentScan ||
          previewRequests.current[ruleId] !== previewRequest
        )
          return;
        setPreviews((prev) =>
          prev[ruleId]
            ? {
                ...prev,
                [ruleId]: {
                  kind: 'error',
                  message: errorMessage(error, "Couldn't load this rule."),
                },
              }
            : prev,
        );
      });
  };

  const status = statusState.kind === 'ready' ? statusState.status : null;
  const enabled = status?.enabled === true;
  const diagnostic = status?.diagnostic
    ? DIAGNOSTIC_MESSAGES[status.diagnostic]
    : null;

  const turnOffButton = enabled ? (
    <Button
      variant="secondary"
      disabled={applying}
      onClick={(): void => apply({ enabled: false })}
      data-testid="repo-rules-turn-off"
    >
      Turn off Cursor rules
    </Button>
  ) : null;

  let announcement: ReactNode = '';
  let body: ReactNode;
  switch (phase.kind) {
    case 'choose':
      body = (
        <ChooseWorkspace
          headingRef={headingRef}
          workspaces={workspaces}
          onChoose={(id): void => {
            setWorkspaceId(id);
            setOverrides({});
            setPhase({ kind: 'consent' });
          }}
          onClose={onClose}
        />
      );
      break;
    case 'consent':
      body = (
        <section className="space-y-4" data-testid="repo-rules-consent">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-m font-medium fg-primary outline-none"
          >
            Use Cursor rules from{' '}
            <span className={REPLAY_MASK_CLASS}>{workspaceName}</span>
          </h3>
          <div className="space-y-2 text-s fg-secondary">
            <p>{appName} reads these files in each repository:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <code className="font-mono">.cursorrules</code> at the
                repository root
              </li>
              <li>
                <code className="font-mono">.mdc</code> files in{' '}
                <code className="font-mono">.cursor/rules</code> folders,
                including nested ones
              </li>
              <li>
                Root AGENTS.md and CLAUDE.md, to find rules that repeat them
              </li>
            </ul>
            <p>
              It checks whether files a rule mentions exist, without opening
              them. Nothing in the repository changes.
            </p>
            <p>
              Once rules are on, each new chat reads the current rules, so edits
              and new files in these folders apply without another review. Rules
              in new nested folders need another scan. AGENTS.md and CLAUDE.md
              win when they conflict. Cursor reads these rules itself and
              doesn&apos;t get a copy.
            </p>
          </div>
          <StatusSummary
            statusState={statusState}
            diagnostic={diagnostic}
            disabledCount={status?.disabledRuleIds.length ?? 0}
          />
          {applyError ? <ErrorBanner className="" error={applyError} /> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {turnOffButton}
            <Button
              variant="primary"
              disabled={applying}
              onClick={scan}
              data-testid="repo-rules-scan"
            >
              Scan rules
            </Button>
          </div>
        </section>
      );
      break;
    case 'scanning':
      announcement = (
        <>
          Scanning Cursor rules in{' '}
          <span className={REPLAY_MASK_CLASS}>{workspaceName}</span>
        </>
      );
      body = (
        <section
          className="flex items-center gap-3 py-6"
          data-testid="repo-rules-scanning"
        >
          <LoadingSpinner tone="tertiary" decorative />
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-s fg-secondary outline-none"
          >
            Scanning Cursor rules…
          </h3>
        </section>
      );
      break;
    case 'scan-error':
      announcement = phase.message;
      body = (
        <section className="space-y-4" data-testid="repo-rules-scan-error">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-m font-medium fg-primary outline-none"
          >
            Couldn&apos;t scan Cursor rules
          </h3>
          <ErrorBanner className="" error={phase.message} />
          {applyError ? <ErrorBanner className="" error={applyError} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {turnOffButton}
            <Button variant="primary" onClick={scan}>
              Try again
            </Button>
          </div>
        </section>
      );
      break;
    case 'review': {
      const { scan: result } = phase;
      const selectedCount = result.proposals.filter(
        (rule) => overrides[rule.id] ?? rule.selected,
      ).length;
      announcement = `Found ${ruleCountLabel(result.proposals.length)}`;
      body = (
        <ReviewStep
          headingRef={headingRef}
          scan={result}
          workspaceName={workspaceName}
          overrides={overrides}
          previews={previews}
          onToggle={(ruleId, next): void =>
            setOverrides((prev) => ({ ...prev, [ruleId]: next }))
          }
          onPreview={(ruleId): void => togglePreview(ruleId, result.scanId)}
          disabled={applying}
          footer={
            <>
              {applyError ? (
                <ErrorBanner
                  className=""
                  error={applyError}
                  blockMessageFromReplay
                />
              ) : null}
              <p className="text-xs fg-tertiary">{SNAPSHOT_NOTE}</p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" disabled={applying} onClick={onClose}>
                  Cancel
                </Button>
                {applyError && needsRescan(applyError) ? (
                  <Button
                    disabled={applying}
                    onClick={scan}
                    data-testid="repo-rules-rescan"
                  >
                    Scan again
                  </Button>
                ) : null}
                {turnOffButton}
                {result.proposals.length > 0 ? (
                  <Button
                    variant="primary"
                    disabled={applying || selectedCount === 0}
                    onClick={(): void => apply({ enabled: true, scan: result })}
                    data-testid="repo-rules-apply"
                  >
                    {applying ? <LoadingSpinner decorative /> : null}
                    {enabled
                      ? 'Save'
                      : `Turn on ${ruleCountLabel(selectedCount)}`}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={onClose}>
                    Done
                  </Button>
                )}
              </div>
            </>
          }
        />
      );
      break;
    }
  }

  return (
    <div className="space-y-4" data-testid="repo-rules-review">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {body}
      {workspaceId && initialWorkspaceId === undefined ? (
        <Button
          variant="ghost"
          disabled={applying}
          data-testid="repo-rules-change-project"
          onClick={(): void => {
            generation.current += 1;
            scanGeneration.current += 1;
            setWorkspaceId(null);
            setOverrides({});
            setPreviews({});
            setApplyError(null);
            setStatusState({ kind: 'loading' });
            setPhase({ kind: 'choose' });
          }}
        >
          Choose another project
        </Button>
      ) : null}
    </div>
  );
}

function ChooseWorkspace({
  headingRef,
  workspaces,
  onChoose,
  onClose,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly workspaces: readonly RepoRulesReviewWorkspace[];
  readonly onChoose: (workspaceId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <section className="space-y-4" data-testid="repo-rules-choose">
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="text-m font-medium fg-primary outline-none"
      >
        Choose a project
      </h3>
      {workspaces.length === 0 ? (
        <p className="text-s fg-secondary">
          Add a code project first, then review its Cursor rules.
        </p>
      ) : (
        <>
          <p className="text-s fg-secondary">
            Cursor rules are saved per project and apply to all of its
            worktrees.
          </p>
          <ul className="space-y-1">
            {workspaces.map((entry) => (
              <li key={entry.id}>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={(): void => onChoose(entry.id)}
                  data-testid={`repo-rules-choose-${entry.id}`}
                >
                  <span className={`truncate ${REPLAY_MASK_CLASS}`}>
                    {entry.name}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function StatusSummary({
  statusState,
  diagnostic,
  disabledCount,
}: {
  readonly statusState: StatusState;
  readonly diagnostic: string | null;
  readonly disabledCount: number;
}): JSX.Element | null {
  if (statusState.kind === 'loading') return null;
  if (statusState.kind === 'error') {
    return (
      <Notice intent="attention" data-testid="repo-rules-status-error">
        Couldn&apos;t load the saved setting. You can still scan.
      </Notice>
    );
  }
  if (diagnostic) {
    return (
      <Notice intent="attention" data-testid="repo-rules-status-diagnostic">
        {diagnostic}
      </Notice>
    );
  }
  if (!statusState.status.enabled) return null;
  return (
    <Notice intent="positive" data-testid="repo-rules-status-enabled">
      Cursor rules are on for this project
      {disabledCount > 0
        ? `, with ${ruleCountLabel(disabledCount)} turned off.`
        : '.'}{' '}
      {SNAPSHOT_NOTE}
    </Notice>
  );
}

function ReviewStep({
  headingRef,
  scan,
  workspaceName,
  overrides,
  previews,
  onToggle,
  onPreview,
  footer,
  disabled,
}: {
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly scan: RepoRulesScanResponse;
  readonly workspaceName: string;
  readonly overrides: Readonly<Record<string, boolean>>;
  readonly previews: Readonly<Record<string, PreviewState>>;
  readonly onToggle: (ruleId: string, next: boolean) => void;
  readonly onPreview: (ruleId: string) => void;
  readonly disabled: boolean;
  readonly footer: ReactNode;
}): JSX.Element {
  const repoIds = [...new Set(scan.proposals.map((rule) => rule.repoId))];
  const multiRepo = repoIds.length > 1;
  const diagnostic = scan.diagnostic
    ? DIAGNOSTIC_MESSAGES[scan.diagnostic]
    : null;
  return (
    <section className="space-y-4" data-testid="repo-rules-review-step">
      <div className="space-y-1">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="text-m font-medium fg-primary outline-none"
        >
          {scan.proposals.length === 0 ? (
            'No Cursor rules found'
          ) : (
            <>
              Found {ruleCountLabel(scan.proposals.length)} in{' '}
              <span className={REPLAY_MASK_CLASS}>{workspaceName}</span>
            </>
          )}
        </h3>
        <p className="text-s fg-secondary">
          {scan.worktreeId
            ? 'Scanned the selected checkout.'
            : "Scanned the project's repositories."}{' '}
          Other branches can have different rules.
        </p>
      </div>
      {diagnostic ? <Notice intent="attention">{diagnostic}</Notice> : null}
      {scan.proposals.length === 0 ? (
        <p className="text-s fg-secondary" data-testid="repo-rules-empty">
          Add <code className="font-mono">.mdc</code> files to a{' '}
          <code className="font-mono">.cursor/rules</code> folder, then scan
          again.
        </p>
      ) : (
        repoIds.map((repoId) => (
          <div key={repoId} className="space-y-2">
            {multiRepo ? (
              <h4 className="text-xs font-medium fg-tertiary">
                <span className={REPLAY_BLOCK_CLASS}>{repoId}</span>
              </h4>
            ) : null}
            <ul className="divide-y rounded-lg border">
              {scan.proposals
                .filter((rule) => rule.repoId === repoId)
                .map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    selected={overrides[rule.id] ?? rule.selected}
                    preview={previews[rule.id] ?? null}
                    disabled={disabled}
                    onToggle={(next): void => onToggle(rule.id, next)}
                    onPreview={(): void => onPreview(rule.id)}
                  />
                ))}
            </ul>
          </div>
        ))
      )}
      {scan.skipped.length > 0 ? (
        <div className="space-y-2" data-testid="repo-rules-skipped">
          <h4 className="text-s font-medium fg-primary">Not included</h4>
          <p className="text-xs fg-tertiary">
            These files were found but can&apos;t be used.
          </p>
          <ul className="space-y-1">
            {scan.skipped.map((item) => (
              <li
                key={`${item.repoId}:${item.path}`}
                className="flex flex-wrap items-baseline justify-between gap-2 text-s"
              >
                <code
                  className={`min-w-0 truncate font-mono fg-secondary ${REPLAY_BLOCK_CLASS}`}
                >
                  {item.path}
                </code>
                <span className="text-xs fg-tertiary">
                  {SKIP_REASONS[item.reason]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {footer}
    </section>
  );
}

function RuleRow({
  rule,
  selected,
  preview,
  onToggle,
  onPreview,
  disabled,
}: {
  readonly rule: RepoRuleProposal;
  readonly selected: boolean;
  readonly preview: PreviewState | null;
  readonly onToggle: (next: boolean) => void;
  readonly onPreview: () => void;
  readonly disabled: boolean;
}): JSX.Element {
  const previewId = useId();
  const pathId = useId();
  return (
    <li
      className="space-y-2 p-3"
      role="group"
      aria-labelledby={pathId}
      data-testid="repo-rules-rule"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <code
            id={pathId}
            className={`block truncate font-mono text-s fg-primary ${REPLAY_BLOCK_CLASS}`}
          >
            {rule.path}
          </code>
          <p className="text-xs fg-secondary">
            <span className="font-medium">
              {rule.scope && rule.kind === 'always'
                ? 'Before working in this folder'
                : KIND_LABELS[activationKind(rule)]}
            </span>
            {' · '}
            {rule.scope && rule.kind === 'always'
              ? 'The agent reads it before reading or editing files in this scope.'
              : activationKind(rule) === 'manual'
                ? 'The agent reads it only when you explicitly mention its path.'
                : KIND_DESCRIPTIONS[activationKind(rule)]}
            {rule.scope ? (
              <>
                {' '}
                Applies in{' '}
                <code className={`font-mono ${REPLAY_BLOCK_CLASS}`}>
                  {rule.scope}
                </code>
                .
              </>
            ) : null}
          </p>
          {rule.description ? (
            <p className={`text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}>
              {rule.description}
            </p>
          ) : null}
          {rule.globs.length > 0 ? (
            <p
              className={`font-mono text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
            >
              {rule.globs.join(', ')}
            </p>
          ) : null}
          {rule.flags.length > 0 ? (
            <ul className="flex flex-wrap gap-1" aria-label="Notes">
              {rule.flags.map((flag) => (
                <li
                  key={flag}
                  className="rounded bg-secondary px-1.5 py-0.5 text-xs fg-secondary"
                >
                  {FLAG_LABELS[flag]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={preview !== null}
            aria-controls={previewId}
            onClick={onPreview}
            data-testid="repo-rules-preview-toggle"
          >
            {preview ? 'Hide' : 'Preview'}
          </Button>
          <ToggleSwitch
            checked={selected}
            disabled={disabled}
            label="Use this rule"
            onChange={onToggle}
            dataTestId="repo-rules-rule-toggle"
          />
        </div>
      </div>
      {preview ? (
        <div id={previewId}>
          {preview.kind === 'loading' ? (
            <LoadingSpinner tone="tertiary" />
          ) : preview.kind === 'error' ? (
            <ErrorBanner className="" error={preview.message} />
          ) : (
            <pre
              className={`max-h-64 overflow-auto whitespace-pre-wrap rounded bg-secondary p-2 font-mono text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
              data-testid="repo-rules-preview"
            >
              {preview.body.length > PREVIEW_CHAR_LIMIT
                ? `${preview.body.slice(0, PREVIEW_CHAR_LIMIT)}\n…`
                : preview.body || '(empty)'}
            </pre>
          )}
        </div>
      ) : null}
    </li>
  );
}
