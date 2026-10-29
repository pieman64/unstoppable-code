import {
  PIPELINE_PACKAGE_MAX_FILE_BYTES,
  PIPELINE_PACKAGE_MAX_FILES,
  PIPELINE_PACKAGE_MAX_TOTAL_BYTES,
} from '@canopy/protocol/pipelines';
import { formatPipelinePackageBytes } from '@canopy/ui-shared/lib/pipeline-package-display';
import type {
  PipelinePackageAnalysisBlocker,
  PipelinePackageBlockerCode,
  PipelinePackageInvocationDismissal,
  PipelinePackageLimit,
} from '@canopy/protocol/pipelines';

/**
 * Pure presentation layer for publisher-facing dependency problems.
 *
 * The main process emits a typed `code` plus a `subject` (the token or member
 * the problem is about); every user-visible sentence is composed here, because
 * this copy is governed by `docs/ux-writing.md` and because grouping and
 * ordering need a stable identity that English prose is not. The legacy
 * `message` survives as a fallback and as the technical detail behind a
 * disclosure — it is never the headline.
 *
 * Display only: no fetching, no stores, no `window.api`.
 */

/**
 * The one code a publisher may mark as "not a command". An allowlist rather
 * than a denylist, so a code added later is non-dismissible until someone
 * deliberately decides otherwise. Security findings are structurally
 * undismissible in the analyzer too — this is the second lock, not the only
 * one.
 */
/**
 * The words in a dismissible problem's detail that the row turns into the
 * "not a command" link, so the action reads as part of the sentence.
 */
export const DISMISS_INVOCATION_PHRASE = 'mark it as not a command';

export const DISMISSIBLE_BLOCKER_CODES: ReadonlySet<PipelinePackageBlockerCode> =
  new Set<PipelinePackageBlockerCode>(['UNRESOLVED_INVOCATION']);

/**
 * Severity order for a deterministic list: security findings first (they are
 * about what would leave the machine), then a dependency that vanished, then
 * ambiguity, then a token that did not resolve, then the whole-package check.
 */
const SEVERITY_RANK: Record<PipelinePackageBlockerCode, number> = {
  SUSPECTED_SECRET: 0,
  SOURCE_PATH_ESCAPE: 1,
  SYMLINK_BLOCKED: 2,
  NATIVE_EXECUTABLE_BLOCKED: 3,
  OPAQUE_EXECUTABLE_BLOCKED: 4,
  EXPORT_DENIED_FILE: 5,
  MISSING_DEPENDENCY_SOURCE: 6,
  AMBIGUOUS_INVOCATION: 7,
  UNRESOLVED_INVOCATION: 8,
  PACKAGE_LIMIT_EXCEEDED: 9,
  INVALID_PACKAGE: 10,
};

export interface CapabilityPackageProblem {
  /** Stable, index-free key for React and for `data-testid` suffixes. */
  slug: string;
  code: PipelinePackageBlockerCode;
  subject?: string;
  /** The headline sentence, without a trailing full stop. */
  title: string;
  /** What to do about it, as one sentence. */
  detail: string;
  /** Raw main-process prose, shown only behind the Details disclosure. */
  message: string;
  relativePath?: string;
  occurrences: ReadonlyArray<{ jobId: string; stepId: string }>;
  dismissal?: { provider: 'claude' | 'codex'; token: string };
  dismissible: boolean;
}

function limitTitle(
  limit: PipelinePackageLimit | undefined,
  subject: string | undefined,
): string {
  const file = subject ?? 'A file';
  switch (limit) {
    case 'file_size':
      return `${file} is larger than ${formatPipelinePackageBytes(PIPELINE_PACKAGE_MAX_FILE_BYTES)}`;
    case 'file_count':
      return `${file} goes past the ${PIPELINE_PACKAGE_MAX_FILES.toLocaleString('en-US')}-file limit`;
    case 'total_size':
    case undefined:
      return `${file} pushes the share past ${formatPipelinePackageBytes(PIPELINE_PACKAGE_MAX_TOTAL_BYTES)}`;
  }
}

function titleFor(
  code: PipelinePackageBlockerCode,
  subject: string | undefined,
  message: string,
  limit: PipelinePackageLimit | undefined,
): string {
  switch (code) {
    case 'UNRESOLVED_INVOCATION':
      return subject ? `${subject} was not found` : message;
    case 'AMBIGUOUS_INVOCATION':
      return subject
        ? `${subject} matches more than one command`
        : 'A step matches more than one command';
    case 'MISSING_DEPENDENCY_SOURCE':
      return subject
        ? `${subject} is no longer on this machine`
        : 'A dependency is no longer on this machine';
    case 'SUSPECTED_SECRET':
      return subject
        ? `${subject} may contain a credential`
        : 'A dependency file may contain a credential';
    case 'SYMLINK_BLOCKED':
      return subject
        ? `${subject} is a symbolic link`
        : 'A dependency is a symbolic link';
    case 'SOURCE_PATH_ESCAPE':
      return 'A dependency points outside its source folder';
    case 'NATIVE_EXECUTABLE_BLOCKED':
      return subject
        ? `${subject} is a compiled program`
        : 'A dependency is a compiled program';
    case 'OPAQUE_EXECUTABLE_BLOCKED':
      return subject
        ? `${subject} is an unreadable executable`
        : 'A dependency is an unreadable executable';
    case 'EXPORT_DENIED_FILE':
      return subject ? `${subject} can't be shared` : "A file can't be shared";
    case 'PACKAGE_LIMIT_EXCEEDED':
      return limitTitle(limit, subject);
    case 'INVALID_PACKAGE':
      return 'The package failed a safety check';
  }
}

function detailFor(
  code: PipelinePackageBlockerCode,
  origin: PipelinePackageAnalysisBlocker['origin'],
  dismissible: boolean,
): string {
  switch (code) {
    case 'UNRESOLVED_INVOCATION':
      if (origin === 'transitive') {
        return dismissible
          ? `A packaged dependency references it. Install it, or ${DISMISS_INVOCATION_PHRASE}.`
          : 'A packaged dependency references it. Install it.';
      }
      return dismissible
        ? `Install it, or ${DISMISS_INVOCATION_PHRASE} if the prompt only mentions it.`
        : 'Install it.';
    case 'AMBIGUOUS_INVOCATION':
      return 'Point the step at one plugin, or rename the other command.';
    case 'MISSING_DEPENDENCY_SOURCE':
      return 'Reinstall it, or remove it from the step.';
    case 'SUSPECTED_SECRET':
      return 'Remove the credential from this file.';
    case 'SYMLINK_BLOCKED':
      return 'Replace it with the file it points to.';
    case 'SOURCE_PATH_ESCAPE':
      return 'Move the file inside the dependency folder.';
    case 'NATIVE_EXECUTABLE_BLOCKED':
      return 'Compiled programs are not shared. Remove it from the dependency.';
    case 'OPAQUE_EXECUTABLE_BLOCKED':
      return 'Replace it with a plain script, or remove it from the dependency.';
    case 'EXPORT_DENIED_FILE':
      return 'Remove it from the dependency folder.';
    case 'PACKAGE_LIMIT_EXCEEDED':
      return 'Move it out of the shared folder.';
    case 'INVALID_PACKAGE':
      return 'Close this and share again to recheck.';
  }
}

/** Lowercase, hyphen-joined, ASCII-only slug fragment. */
export function slugifyProblemPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 64) : 'item';
}

/**
 * Set equality for dismissal lists, ignoring order. Both share modals compare
 * their queued dismissals against main's echo to decide whether to re-issue
 * them, so the comparison lives here rather than in either caller.
 */
export function sameInvocationSet(
  left: readonly PipelinePackageInvocationDismissal[],
  right: readonly PipelinePackageInvocationDismissal[],
): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(
    right.map(({ provider, token }) => `${provider}\0${token}`),
  );
  return left.every(({ provider, token }) => seen.has(`${provider}\0${token}`));
}

function stableProblemSlugSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Project the wire blockers into renderable problems: one row each, severity
 * ordered, with stable slugs. Order inside a severity tier follows the
 * analyzer's emission order so two runs over the same tree agree.
 */
export function buildCapabilityPackageProblems(
  blockers: readonly PipelinePackageAnalysisBlocker[],
): CapabilityPackageProblem[] {
  const identities = blockers.map(
    (blocker) => blocker.subject ?? blocker.relativePath ?? blocker.message,
  );
  const bases = blockers.map(
    (blocker, index) =>
      `${slugifyProblemPart(blocker.code)}-${slugifyProblemPart(identities[index] ?? blocker.message)}`,
  );
  const baseCounts = new Map<string, number>();
  for (const base of bases) {
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const problems = blockers.map((blocker, index): CapabilityPackageProblem => {
    const identity = identities[index] ?? blocker.message;
    const base = bases[index] ?? slugifyProblemPart(blocker.code);
    // The analyzer has already deduplicated exact identities. When two
    // different identities normalize to the same ASCII test-id fragment, use
    // an identity-derived suffix rather than a list position so reordering
    // cannot rename either row.
    const slug =
      (baseCounts.get(base) ?? 0) > 1
        ? `${base}-${stableProblemSlugSuffix(
            `${blocker.dismissal?.provider ?? ''}\0${identity}`,
          )}`
        : base;
    const dismissible =
      DISMISSIBLE_BLOCKER_CODES.has(blocker.code) &&
      blocker.dismissal !== undefined;
    return {
      slug,
      code: blocker.code,
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      title: titleFor(
        blocker.code,
        blocker.subject,
        blocker.message,
        blocker.limit,
      ),
      detail: detailFor(blocker.code, blocker.origin, dismissible),
      message: blocker.message,
      ...(blocker.relativePath !== undefined
        ? { relativePath: blocker.relativePath }
        : {}),
      occurrences: blocker.occurrences ?? [],
      ...(blocker.dismissal ? { dismissal: blocker.dismissal } : {}),
      dismissible,
    };
  });
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort(
      (left, right) =>
        SEVERITY_RANK[left.problem.code] - SEVERITY_RANK[right.problem.code] ||
        left.index - right.index,
    )
    .map(({ problem }) => problem);
}
