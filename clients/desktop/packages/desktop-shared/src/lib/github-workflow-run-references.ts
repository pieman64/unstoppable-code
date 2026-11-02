import type {
  GitHubWorkflowRunInput,
  GitHubWorkflowRunReference,
  GitHubWorkflowRunTarget,
  WatchGitHubItemsResult,
} from '../types/github-watchers';

const INVALID_REFERENCE_MESSAGE =
  'Use a workflow run ID, owner/repository#run_id, or a GitHub workflow run, attempt, job, or step URL.';
const GITHUB_COM_ONLY_MESSAGE =
  'Only GitHub.com workflow references are supported.';
const REPOSITORY_REQUIRED_MESSAGE =
  'A repository is required for a bare workflow run ID. Add repository: "owner/repository" or pass a GitHub workflow URL.';
const REFERENCE_CONFLICT_MESSAGE =
  'The repository, run ID, or attempt values in this item do not agree.';
const UNSAFE_ID_MESSAGE =
  "Quote workflow run IDs larger than JavaScript's safe integer range.";
const MAX_GITHUB_REPOSITORY_SEGMENT_LENGTH = 100;
const MAX_GITHUB_NUMERIC_ID_DIGITS = 20;

type ReferenceFailure = Extract<WatchGitHubItemsResult, { ok: false }>;

export interface ParsedGitHubWorkflowRunReference {
  repository?: string;
  runId?: string;
  requestedAttempt?: number;
  jobId?: string;
}

export interface PreparedGitHubWorkflowRunReference extends ParsedGitHubWorkflowRunReference {
  repository: string;
  itemIndex: number;
}

export type ParseGitHubWorkflowRunReferenceResult =
  | { ok: true; value: ParsedGitHubWorkflowRunReference }
  | ReferenceFailure;

export type NormalizeGitHubWorkflowRunTargetsResult =
  | {
      ok: true;
      targets: GitHubWorkflowRunTarget[];
      sourceIndexByKey: Map<string, number>;
    }
  | ReferenceFailure;

export interface GitHubJobResolution {
  repository: string;
  runId: string;
  runAttempt: number;
}

export class GitHubWorkflowRunResolutionError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause: unknown;

  constructor(
    readonly itemIndex: number,
    cause: unknown,
  ) {
    super('GitHub workflow reference resolution failed.');
    this.name = 'GitHubWorkflowRunResolutionError';
    this.cause = cause;
  }
}

function failure(
  code: ReferenceFailure['code'],
  message: string,
  itemIndex?: number,
  field?: ReferenceFailure['field'],
): ReferenceFailure {
  return {
    ok: false,
    code,
    message,
    ...(itemIndex !== undefined ? { itemIndex } : {}),
    ...(field !== undefined ? { field } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizePositiveDecimal(
  value: unknown,
): { ok: true; value: string } | ReferenceFailure {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      return failure('invalid_reference', UNSAFE_ID_MESSAGE);
    }
    if (value <= 0) {
      return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
    return { ok: true, value: String(value) };
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_GITHUB_NUMERIC_ID_DIGITS ||
    !/^\d+$/.test(value)
  ) {
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
  try {
    const numeric = BigInt(value);
    return numeric > BigInt(0)
      ? { ok: true, value: numeric.toString() }
      : failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  } catch {
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
}

function normalizeAttempt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function decodePathSegment(value: string): string | null {
  if (/%2f|%5c/i.test(value)) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeRepositoryParts(
  owner: string,
  repository: string,
): string | null {
  const decodedOwner = decodePathSegment(owner);
  const decodedRepository = decodePathSegment(repository);
  if (!decodedOwner || !decodedRepository) return null;
  const repo = decodedRepository.replace(/\.git$/i, '');
  if (
    decodedOwner === '.' ||
    decodedOwner === '..' ||
    repo === '.' ||
    repo === '..' ||
    decodedOwner.length > MAX_GITHUB_REPOSITORY_SEGMENT_LENGTH ||
    repo.length > MAX_GITHUB_REPOSITORY_SEGMENT_LENGTH ||
    !/^[A-Za-z0-9_.-]+$/.test(decodedOwner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo)
  ) {
    return null;
  }
  return `${decodedOwner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Normalize an owner/repository slug or a normal GitHub repository URL. */
export function normalizeGitHubRepositoryReference(
  value: unknown,
): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    return null;
  }
  if (!value.includes('://')) {
    const segments = value.split('/');
    return segments.length === 2
      ? normalizeRepositoryParts(segments[0], segments[1])
      : null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname.toLowerCase() !== 'github.com' &&
      url.hostname.toLowerCase() !== 'www.github.com') ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  if (/\/{2,}/.test(url.pathname)) return null;
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  return segments.length === 2
    ? normalizeRepositoryParts(segments[0], segments[1])
    : null;
}

function parseUrlReference(
  value: string,
): ParseGitHubWorkflowRunReferenceResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    !['github.com', 'www.github.com', 'api.github.com'].includes(host) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return failure('invalid_reference', GITHUB_COM_ONLY_MESSAGE);
  }
  if (/\/{2,}/.test(url.pathname)) {
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
  const path = url.pathname.replace(/\/$/, '');
  const segments = path.split('/').filter(Boolean);
  const readId = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const parsed = normalizePositiveDecimal(raw);
    return parsed.ok ? parsed.value : null;
  };
  const readAttempt = (raw: string | undefined): number | null => {
    const id = readId(raw);
    if (!id) return null;
    const numeric = Number(id);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
  };

  if (host === 'api.github.com') {
    if (segments.length < 6 || segments[0] !== 'repos') {
      return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
    const repository = normalizeRepositoryParts(segments[1], segments[2]);
    if (!repository || segments[3] !== 'actions') {
      return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
    if (segments[4] === 'jobs' && segments.length === 6) {
      const jobId = readId(segments[5]);
      return jobId
        ? { ok: true, value: { repository, jobId } }
        : failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
    if (segments[4] === 'runs') {
      const runId = readId(segments[5]);
      if (!runId)
        return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
      if (segments.length === 6) {
        return { ok: true, value: { repository, runId } };
      }
      if (segments.length === 8 && segments[6] === 'attempts') {
        const requestedAttempt = readAttempt(segments[7]);
        return requestedAttempt
          ? { ok: true, value: { repository, runId, requestedAttempt } }
          : failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
      }
    }
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }

  if (segments.length < 5) {
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
  const repository = normalizeRepositoryParts(segments[0], segments[1]);
  if (!repository)
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  if (segments[2] === 'actions' && segments[3] === 'runs') {
    const runId = readId(segments[4]);
    if (!runId) return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    if (segments.length === 5)
      return { ok: true, value: { repository, runId } };
    if (segments.length === 7 && segments[5] === 'attempts') {
      const requestedAttempt = readAttempt(segments[6]);
      return requestedAttempt
        ? { ok: true, value: { repository, runId, requestedAttempt } }
        : failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
    if (segments.length === 7 && segments[5] === 'job') {
      const jobId = readId(segments[6]);
      return jobId
        ? { ok: true, value: { repository, runId, jobId } }
        : failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
  }
  if (
    segments[2] === 'runs' &&
    segments[4] === 'jobs' &&
    segments.length === 6
  ) {
    const runId = readId(segments[3]);
    const jobId = readId(segments[5]);
    return runId && jobId
      ? { ok: true, value: { repository, runId, jobId } }
      : failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
  return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
}

/** Parse one scalar/URL reference without making any GitHub request. */
export function parseGitHubWorkflowRunReference(
  reference: GitHubWorkflowRunReference,
): ParseGitHubWorkflowRunReferenceResult {
  if (typeof reference === 'number') {
    const runId = normalizePositiveDecimal(reference);
    return runId.ok ? { ok: true, value: { runId: runId.value } } : runId;
  }
  if (typeof reference !== 'string' || reference !== reference.trim()) {
    return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
  }
  if (/^https?:\/\//i.test(reference)) return parseUrlReference(reference);
  const compact = reference.match(/^([^/#]+\/[^/#]+)#(\d+)(?:\/(\d+))?$/);
  if (compact) {
    const repository = normalizeGitHubRepositoryReference(compact[1]);
    const runId = normalizePositiveDecimal(compact[2]);
    const requestedAttempt = compact[3]
      ? normalizeAttempt(Number(compact[3]))
      : undefined;
    if (!repository || !runId.ok || (compact[3] && !requestedAttempt)) {
      return failure('invalid_reference', INVALID_REFERENCE_MESSAGE);
    }
    return {
      ok: true,
      value: {
        repository,
        runId: runId.value,
        ...(requestedAttempt ? { requestedAttempt } : {}),
      },
    };
  }
  const runId = normalizePositiveDecimal(reference);
  return runId.ok ? { ok: true, value: { runId: runId.value } } : runId;
}

function withItemIndex(
  error: ReferenceFailure,
  itemIndex: number,
): ReferenceFailure {
  return { ...error, itemIndex, field: 'items' };
}

export function prepareGitHubWorkflowRunTargets(options: {
  items: readonly GitHubWorkflowRunInput[];
  repository?: unknown;
  repositoryCandidates?: readonly string[];
}):
  | { ok: true; references: PreparedGitHubWorkflowRunReference[] }
  | ReferenceFailure {
  const topRepository =
    options.repository === undefined
      ? undefined
      : normalizeGitHubRepositoryReference(options.repository);
  if (options.repository !== undefined && !topRepository) {
    return failure(
      'invalid_reference',
      'Use a GitHub owner/repository slug or repository URL.',
      undefined,
      'repository',
    );
  }
  const candidates = Array.from(
    new Set(
      (options.repositoryCandidates ?? [])
        .map(normalizeGitHubRepositoryReference)
        .filter((entry): entry is string => entry !== null),
    ),
  );
  const contextualRepository =
    candidates.length === 1 ? candidates[0] : undefined;
  const references: PreparedGitHubWorkflowRunReference[] = [];
  const localKeys = new Map<string, number>();

  for (let itemIndex = 0; itemIndex < options.items.length; itemIndex += 1) {
    const raw = options.items[itemIndex];
    let parsed: ParseGitHubWorkflowRunReferenceResult;
    let itemRepository: string | undefined;
    let structuredAttempt: number | undefined;

    if (typeof raw === 'string' || typeof raw === 'number') {
      parsed = parseGitHubWorkflowRunReference(raw);
    } else if (isRecord(raw)) {
      if (
        !hasOnlyKeys(raw, [
          'kind',
          'target',
          'repository',
          'runId',
          'runAttempt',
        ]) ||
        raw.kind !== 'workflow_run' ||
        'target' in raw === 'runId' in raw
      ) {
        return withItemIndex(
          failure('invalid_input', 'Invalid WatchGitHubItems input.'),
          itemIndex,
        );
      }
      if (raw.repository !== undefined) {
        itemRepository =
          normalizeGitHubRepositoryReference(raw.repository) ?? undefined;
        if (!itemRepository) {
          return withItemIndex(
            failure(
              'invalid_reference',
              'Use a GitHub owner/repository slug or repository URL.',
            ),
            itemIndex,
          );
        }
      }
      if (raw.runAttempt !== undefined) {
        structuredAttempt = normalizeAttempt(raw.runAttempt) ?? undefined;
        if (!structuredAttempt) {
          return withItemIndex(
            failure('invalid_reference', INVALID_REFERENCE_MESSAGE),
            itemIndex,
          );
        }
      }
      if ('target' in raw) {
        parsed = parseGitHubWorkflowRunReference(raw.target);
      } else {
        const id = normalizePositiveDecimal(raw.runId);
        parsed = id.ok ? { ok: true, value: { runId: id.value } } : id;
      }
    } else {
      return withItemIndex(
        failure('invalid_input', 'Invalid WatchGitHubItems input.'),
        itemIndex,
      );
    }

    if (!parsed.ok) return withItemIndex(parsed, itemIndex);
    if (
      parsed.value.repository &&
      itemRepository &&
      parsed.value.repository !== itemRepository
    ) {
      return withItemIndex(
        failure('reference_conflict', REFERENCE_CONFLICT_MESSAGE),
        itemIndex,
      );
    }
    if (
      parsed.value.requestedAttempt &&
      structuredAttempt &&
      parsed.value.requestedAttempt !== structuredAttempt
    ) {
      return withItemIndex(
        failure('reference_conflict', REFERENCE_CONFLICT_MESSAGE),
        itemIndex,
      );
    }
    const repository =
      parsed.value.repository ??
      itemRepository ??
      topRepository ??
      contextualRepository;
    if (!repository) {
      return withItemIndex(
        failure('repository_required', REPOSITORY_REQUIRED_MESSAGE),
        itemIndex,
      );
    }
    const reference: PreparedGitHubWorkflowRunReference = {
      ...parsed.value,
      repository,
      itemIndex,
      ...(structuredAttempt ? { requestedAttempt: structuredAttempt } : {}),
    };
    if (reference.runId || reference.jobId) {
      const key = reference.jobId
        ? `job:${repository}/${reference.jobId}/${reference.requestedAttempt ?? ''}`
        : `${repository}/${reference.runId}/${reference.requestedAttempt ?? ''}`;
      const prior = localKeys.get(key);
      if (prior !== undefined) {
        return withItemIndex(
          failure(
            'duplicate_item',
            'The same GitHub workflow run was supplied more than once.',
          ),
          itemIndex,
        );
      }
      localKeys.set(key, itemIndex);
    }
    references.push(reference);
  }
  return { ok: true, references };
}

/** Resolve a prepared job reference to its containing workflow run. */
export async function resolveGitHubWorkflowRunReference(
  reference: PreparedGitHubWorkflowRunReference,
  resolveJob: (input: {
    repository: string;
    jobId: string;
  }) => Promise<GitHubJobResolution>,
): Promise<GitHubWorkflowRunTarget | ReferenceFailure> {
  let runId = reference.runId;
  if (reference.jobId) {
    let resolved: GitHubJobResolution;
    try {
      resolved = await resolveJob({
        repository: reference.repository,
        jobId: reference.jobId,
      });
    } catch (error) {
      throw new GitHubWorkflowRunResolutionError(reference.itemIndex, error);
    }
    const repository = normalizeGitHubRepositoryReference(resolved.repository);
    const resolvedRunId = normalizePositiveDecimal(resolved.runId);
    const resolvedRunAttempt = normalizeAttempt(resolved.runAttempt);
    if (
      !repository ||
      !resolvedRunId.ok ||
      !resolvedRunAttempt ||
      repository !== reference.repository ||
      (runId !== undefined && runId !== resolvedRunId.value) ||
      (reference.requestedAttempt !== undefined &&
        reference.requestedAttempt !== resolvedRunAttempt)
    ) {
      return withItemIndex(
        failure('reference_conflict', REFERENCE_CONFLICT_MESSAGE),
        reference.itemIndex,
      );
    }
    runId = resolvedRunId.value;
  }
  if (!runId) {
    return withItemIndex(
      failure('invalid_reference', INVALID_REFERENCE_MESSAGE),
      reference.itemIndex,
    );
  }
  return {
    kind: 'workflow_run',
    repository: reference.repository,
    runId,
    ...(reference.requestedAttempt
      ? { requestedAttempt: reference.requestedAttempt }
      : {}),
  };
}

/** Pure-validate every item, then resolve job references in original item order. */
export async function normalizeGitHubWorkflowRunTargets(options: {
  items: readonly GitHubWorkflowRunInput[];
  repository?: unknown;
  repositoryCandidates?: readonly string[];
  resolveJob: (input: {
    repository: string;
    jobId: string;
  }) => Promise<GitHubJobResolution>;
}): Promise<NormalizeGitHubWorkflowRunTargetsResult> {
  const prepared = prepareGitHubWorkflowRunTargets(options);
  if (!prepared.ok) return prepared;
  const targets: GitHubWorkflowRunTarget[] = [];
  const sourceIndexByKey = new Map<string, number>();
  for (const reference of prepared.references) {
    const resolved = await resolveGitHubWorkflowRunReference(
      reference,
      options.resolveJob,
    );
    if ('ok' in resolved) return resolved;
    const target = resolved;
    const key = `${target.repository}/${target.runId}/${target.requestedAttempt ?? ''}`;
    if (sourceIndexByKey.has(key)) {
      return withItemIndex(
        failure(
          'duplicate_item',
          'The same GitHub workflow run was supplied more than once.',
        ),
        reference.itemIndex,
      );
    }
    sourceIndexByKey.set(key, reference.itemIndex);
    targets.push(target);
  }
  targets.sort((left, right) => {
    const repositoryOrder = left.repository.localeCompare(right.repository);
    if (repositoryOrder !== 0) return repositoryOrder;
    const runOrder =
      BigInt(left.runId) < BigInt(right.runId)
        ? -1
        : BigInt(left.runId) > BigInt(right.runId)
          ? 1
          : 0;
    return runOrder !== 0
      ? runOrder
      : (left.requestedAttempt ?? 0) - (right.requestedAttempt ?? 0);
  });
  return { ok: true, targets, sourceIndexByKey };
}
