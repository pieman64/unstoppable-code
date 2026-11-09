import {
  extractCreateFromReferences,
  type CreateFromLinkReference,
  type ParsedGitHubRepositoryReference,
} from '@canopy/desktop-shared/lib/create-from-reference';
import type {
  BranchEntry,
  GitHubRepoSummary,
  LinearTicketSearchResult,
  ProbeCloneDestinationResponse,
  RepoSlug,
  ResolvePullRequestResponse,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { extractIpcErrorMessage, extractIpcErrorName } from '@/lib/errors';
import { workspaceRepoPathForCreateFrom } from '@/lib/createFromSource';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import type { HomeBranchTarget } from '@/stores/homeComposerStore';

/**
 * CAN-3606: a supported link in a chat-mode Home draft proposes a worktree
 * destination. This module owns the pure selection, read-only resolution, and
 * accepted-send materialization. Host effects arrive through injected deps so
 * preview never changes the selected workspace, branch, or context.
 */

export const HOME_LINK_RESOLVE_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type HomeLinkSelection =
  | { kind: 'none'; referenceKeys: string[] }
  | {
      kind: 'single';
      key: string;
      reference: CreateFromLinkReference;
      /**
       * A Linear identifier typed without its URL. Ordinary prose (`GPT-4`)
       * shares the shape; the user can dismiss the intent to send ordinary prose.
       */
      bareIdentifier: boolean;
      referenceKeys: string[];
    }
  | {
      kind: 'ambiguous';
      key: string;
      incomplete: boolean;
      references: CreateFromLinkReference[];
      referenceKeys: string[];
    };

/**
 * Picks the link the draft would use. Dismissed references are ignored, a
 * chosen reference wins among several, and several distinct candidates are
 * never narrowed silently.
 */
export function selectHomeLink(
  text: string,
  dismissedKeys: readonly string[],
  chosenKey: string | null,
): HomeLinkSelection {
  const extracted = extractCreateFromReferences(text);
  const referenceKeys = extracted.references.map((reference) => reference.key);
  const incompleteKey = `incomplete:${text}`;
  if (!extracted.complete) referenceKeys.push(incompleteKey);
  const dismissed = new Set(dismissedKeys);
  if (!extracted.complete && dismissed.has(incompleteKey))
    return { kind: 'none', referenceKeys };
  const active = extracted.references.filter(
    (reference) => !dismissed.has(reference.key),
  );
  const chosen =
    chosenKey === null
      ? undefined
      : active.find((reference) => reference.key === chosenKey);
  if (chosen) {
    return {
      kind: 'single',
      key: chosen.key,
      reference: chosen,
      bareIdentifier: isBareLinearIdentifier(text, chosen),
      referenceKeys,
    };
  }
  if (active.length === 0 && extracted.complete)
    return { kind: 'none', referenceKeys };
  if (active.length === 1 && extracted.complete) {
    return {
      kind: 'single',
      key: active[0].key,
      reference: active[0],
      bareIdentifier: isBareLinearIdentifier(text, active[0]),
      referenceKeys,
    };
  }
  return {
    kind: 'ambiguous',
    incomplete: !extracted.complete,
    key: `choose:${active.map((reference) => reference.key).join('|')}`,
    references: active,
    referenceKeys,
  };
}

function isBareLinearIdentifier(
  text: string,
  reference: CreateFromLinkReference,
): boolean {
  if (reference.kind !== 'linear') return false;
  // Identifiers are `[A-Z][A-Z0-9]*-\d+`, so they are regex-safe.
  return !new RegExp(
    `linear\\.app/[^\\s/]+/issue/${reference.identifier}(?![0-9])`,
    'i',
  ).test(text);
}

export function describeHomeLinkReference(
  reference: CreateFromLinkReference,
): string {
  switch (reference.kind) {
    case 'pr':
      return `${reference.owner}/${reference.repo}#${reference.number}`;
    case 'repository':
      return `${reference.owner}/${reference.repo}`;
    case 'linear':
      return reference.identifier;
  }
}

/** Dismissals only outlive edits while their reference stays in the draft. */
export function pruneDismissedHomeLinkKeys(
  dismissedKeys: readonly string[],
  referenceKeys: readonly string[],
): string[] {
  const present = new Set(referenceKeys);
  return dismissedKeys.filter((key) => present.has(key));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type HomeLinkPendingBranch =
  | { kind: 'default-branch' }
  | { kind: 'pr'; number: number; url: string }
  | {
      kind: 'linear-issue';
      identifier: string;
      title: string;
      branchName: string;
    };

export interface HomeLinkRepository {
  owner: string;
  repo: string;
  repositoryKey: string;
  cloneUrl: string;
  isArchived: boolean;
}

export type HomeLinkPlan =
  | {
      kind: 'existing-project';
      workspaceId: string;
      workspaceName: string;
      branchTarget: HomeBranchTarget;
      repositoryKey?: string;
      repoPath?: string;
      linearIssue?: HomeLinkIssueContext;
    }
  | {
      kind: 'create-project';
      repository: HomeLinkRepository;
      pending: HomeLinkPendingBranch;
      linearIssue?: HomeLinkIssueContext;
    };

export type HomeLinkIssueContext = Pick<
  LinearTicketSearchResult,
  'identifier' | 'title' | 'description' | 'url'
>;

export function homeLinkPromptWithIssueContext(
  prompt: string,
  issue?: HomeLinkIssueContext,
): string {
  if (!issue) return prompt;
  return [
    prompt,
    '',
    `Linear issue ${issue.identifier}: ${issue.title}`,
    issue.url,
    issue.description ?? '',
  ].join('\n');
}

export type HomeLinkAction =
  | { kind: 'retry' }
  | { kind: 'connect-github' }
  /** Offer the GitHub sign-in, for a credential failure (CAN-4466). */
  | { kind: 'sign-in-github' }
  | { kind: 'connect-linear' }
  | { kind: 'choose-project' }
  | { kind: 'use-project'; workspaceId: string; label: string }
  | { kind: 'add-new-project' }
  | { kind: 'choose-attachment'; key: string; label: string }
  | { kind: 'switch-context'; workspaceId: string; label: string }
  | { kind: 'choose-reference'; key: string; label: string };

export type HomeLinkResolution =
  | { status: 'ready'; plan: HomeLinkPlan }
  /** Not a worktree intent after all; send as the draft would otherwise. */
  | { status: 'inactive' }
  | { status: 'blocked'; message: string; actions: HomeLinkAction[] };

export type HomeLinkTargetState =
  | { status: 'idle' }
  | {
      status: 'resolving';
      key: string;
      fingerprint: string;
      /**
       * The last destination shown for this same link, kept while an edit
       * re-checks it so the project picker does not flicker. Display only:
       * sending always waits for a current `ready` plan.
       */
      previousPlan?: HomeLinkPlan;
    }
  | { status: 'inactive'; key: string; fingerprint: string }
  | {
      status: 'ready';
      key: string;
      fingerprint: string;
      plan: HomeLinkPlan;
    }
  | {
      status: 'blocked';
      key: string;
      fingerprint: string;
      message: string;
      actions: HomeLinkAction[];
    }
  | {
      status: 'submitting';
      key: string;
      fingerprint: string;
      plan: HomeLinkPlan;
      progress: string;
      canCancel: boolean;
    };

export const IDLE_HOME_LINK_TARGET: HomeLinkTargetState = { status: 'idle' };

export interface HomeLinkResolveContext {
  workspaceId: string | null;
  /** True only when the user picked the project, not MRU or fallback. */
  workspaceSelectionExplicit: boolean;
  /** Projects in the selected Personal/organization scope. */
  projects: readonly SidebarItem[];
  /** Projects the user can reach only by switching context. */
  otherScopeProjects: readonly SidebarItem[];
  /** A new project is Personal; organization scopes cannot create one here. */
  canCreatePersonalProject: boolean;
  chosenAttachmentKey?: string | null;
  chosenAttachmentReferenceKey?: string | null;
}

export interface HomeLinkResolveDeps {
  getRepoSlug: (repoPath: string) => Promise<RepoSlug | null>;
  resolvePullRequest: (
    repoPath: string,
    reference: string,
  ) => Promise<ResolvePullRequestResponse>;
  searchLinearIssues: (query: string) => Promise<LinearTicketSearchResult[]>;
  listUserGitHubRepos: () => Promise<GitHubRepoSummary[]>;
}

/** Inputs whose change makes an earlier resolution stale. */
export function homeLinkFingerprint(input: {
  key: string;
  mode: string;
  workspaceId: string | null;
  workspaceSelectionExplicit: boolean;
  scopeKey: string;
  projectsSignature: string;
  connectionGeneration: number;
  retryGeneration: number;
  draftRevision?: string;
}): string {
  return JSON.stringify([
    input.key,
    input.mode,
    input.workspaceId,
    input.workspaceSelectionExplicit,
    input.scopeKey,
    input.projectsSignature,
    input.connectionGeneration,
    input.retryGeneration,
    input.draftRevision,
  ]);
}

export function homeLinkProjectsSignature(
  projects: readonly SidebarItem[],
): string {
  return projects
    .map((project) =>
      [
        project.id,
        workspaceRepoPathForCreateFrom(project) ?? '',
        JSON.stringify(project.owner),
        project.name,
      ].join(':'),
    )
    .join('|');
}

function slugKey(slug: RepoSlug): string {
  return `github.com/${slug.owner.toLowerCase()}/${slug.repo.toLowerCase()}`;
}

interface ProjectMatches {
  matches: SidebarItem[];
  /** A code project whose origin could not be read. */
  unknown: boolean;
}

async function findProjectsForRepository(
  projects: readonly SidebarItem[],
  repositoryKey: string,
  deps: Pick<HomeLinkResolveDeps, 'getRepoSlug'>,
): Promise<ProjectMatches> {
  const entries: Array<{ project: SidebarItem; key: string | null } | null> =
    [];
  for (let offset = 0; offset < projects.length; offset += 8) {
    entries.push(
      ...(await Promise.all(
        projects
          .slice(offset, offset + 8)
          .map(
            async (
              project,
            ): Promise<{ project: SidebarItem; key: string | null } | null> => {
              const repoPath = workspaceRepoPathForCreateFrom(project);
              if (repoPath === null) return null;
              try {
                const slug = await deps.getRepoSlug(repoPath);
                return { project, key: slug ? slugKey(slug) : null };
              } catch {
                return { project, key: null };
              }
            },
          ),
      )),
    );
  }
  const resolved = entries.filter(
    (entry): entry is { project: SidebarItem; key: string | null } =>
      entry !== null,
  );
  return {
    matches: resolved
      .filter((entry) => entry.key === repositoryKey)
      .map((entry) => entry.project),
    // A null slug is a project without a GitHub origin or an unreadable one;
    // either way it is not proof the repository is absent.
    unknown: resolved.some((entry) => entry.key === null),
  };
}

function projectName(project: SidebarItem): string {
  return getWorkspaceDisplayName(project);
}

function projectChoiceActions(
  projects: readonly SidebarItem[],
): HomeLinkAction[] {
  return projects.map(
    (project): HomeLinkAction => ({
      kind: 'use-project',
      workspaceId: project.id,
      label: `Use ${projectName(project)}`,
    }),
  );
}

function blocked(
  message: string,
  actions: HomeLinkAction[] = [],
): HomeLinkResolution {
  return { status: 'blocked', message, actions };
}

function classifyGitHubError(error: unknown): HomeLinkResolution {
  const message = extractIpcErrorMessage(error);
  if (/rate limit|429|too many requests/i.test(message)) {
    return blocked('GitHub is rate limiting requests. Try again shortly.', [
      { kind: 'retry' },
    ]);
  }
  // Offline catalog copy says "connection"; that is not a sign-in failure.
  if (/auth|token|credential|connect(?!ion)|401|sign in/i.test(message)) {
    return blocked('Connect GitHub to add this repository as a project.', [
      { kind: 'sign-in-github' },
      { kind: 'retry' },
    ]);
  }
  if (/404|not found|access denied|forbidden/i.test(message)) {
    return blocked(
      'The GitHub resource was not found or you don’t have access. Check the link and connection, then try again.',
      [{ kind: 'connect-github' }, { kind: 'retry' }],
    );
  }
  return blocked(`Couldn’t reach GitHub: ${message}`, [{ kind: 'retry' }]);
}

async function branchTargetForExistingProject(
  project: SidebarItem,
  pending: HomeLinkPendingBranch,
  deps: Pick<HomeLinkResolveDeps, 'resolvePullRequest'>,
): Promise<
  { ok: true; branchTarget: HomeBranchTarget } | { ok: false; message: string }
> {
  if (pending.kind === 'default-branch') {
    return { ok: true, branchTarget: { kind: 'new-worktree' } };
  }
  if (pending.kind === 'linear-issue') {
    return { ok: true, branchTarget: pending };
  }
  const repoPath = workspaceRepoPathForCreateFrom(project);
  if (repoPath === null) {
    return {
      ok: false,
      message: `${projectName(project)} has no repository to open PR #${pending.number} in.`,
    };
  }
  try {
    const pr = await deps.resolvePullRequest(repoPath, pending.url);
    return {
      ok: true,
      branchTarget: {
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        url: pr.url,
      },
    };
  } catch (error: unknown) {
    return { ok: false, message: extractIpcErrorMessage(error) };
  }
}

async function readyForProject(
  project: SidebarItem,
  pending: HomeLinkPendingBranch,
  deps: HomeLinkResolveDeps,
  repositoryKey?: string,
): Promise<HomeLinkResolution> {
  const result = await branchTargetForExistingProject(project, pending, deps);
  if (!result.ok) return blocked(result.message, [{ kind: 'retry' }]);
  return {
    status: 'ready',
    plan: {
      kind: 'existing-project',
      workspaceId: project.id,
      workspaceName: projectName(project),
      branchTarget: result.branchTarget,
      repoPath: workspaceRepoPathForCreateFrom(project) ?? undefined,
      ...(repositoryKey ? { repositoryKey } : {}),
    },
  };
}

async function resolveRepositoryDestination(
  repository: ParsedGitHubRepositoryReference,
  pending: HomeLinkPendingBranch,
  context: HomeLinkResolveContext,
  deps: HomeLinkResolveDeps,
): Promise<HomeLinkResolution> {
  const repoLabel = `${repository.owner}/${repository.repo}`;
  const { matches, unknown } = await findProjectsForRepository(
    context.projects,
    repository.repositoryKey,
    deps,
  );
  const selected = context.projects.find(
    (project) => project.id === context.workspaceId,
  );
  const explicitCodeProject =
    context.workspaceSelectionExplicit &&
    selected !== undefined &&
    selected.type !== 'cowork'
      ? selected
      : undefined;

  if (explicitCodeProject && matches.includes(explicitCodeProject)) {
    return readyForProject(
      explicitCodeProject,
      pending,
      deps,
      repository.repositoryKey,
    );
  }
  if (explicitCodeProject) {
    return blocked(
      `${projectName(explicitCodeProject)} isn’t connected to ${repoLabel}.`,
      matches.length > 0
        ? projectChoiceActions(matches)
        : [{ kind: 'add-new-project' }],
    );
  }
  if (matches.length === 1)
    return readyForProject(matches[0], pending, deps, repository.repositoryKey);
  if (matches.length > 1) {
    return blocked(
      `${repoLabel} is in more than one project. Choose one.`,
      projectChoiceActions(matches),
    );
  }
  if (unknown) {
    return blocked(
      `Couldn’t read every project’s repository, so adding ${repoLabel} might duplicate a project.`,
      [{ kind: 'retry' }, { kind: 'choose-project' }],
    );
  }

  const elsewhere = await findProjectsForRepository(
    context.otherScopeProjects,
    repository.repositoryKey,
    deps,
  );
  if (elsewhere.matches.length > 0) {
    return blocked(
      `${repoLabel} is already a project in another context. Switch context to use it.`,
      elsewhere.matches.map(
        (project): HomeLinkAction => ({
          kind: 'switch-context',
          workspaceId: project.id,
          label: `Switch context for ${projectName(project)}`,
        }),
      ),
    );
  }
  if (elsewhere.unknown) {
    return blocked(
      'Couldn’t read a project’s repository in another context. Try again before adding this project.',
      [{ kind: 'retry' }],
    );
  }
  if (!context.canCreatePersonalProject) {
    return blocked(
      `Switch to Personal to add ${repoLabel} as a project, or choose a project here.`,
      [{ kind: 'choose-project' }],
    );
  }

  let summaries: GitHubRepoSummary[];
  try {
    summaries = await deps.listUserGitHubRepos();
  } catch (error: unknown) {
    return classifyGitHubError(error);
  }
  // The listing is capped and cached, so absence is not proof of denied
  // access. Cloning remains the authoritative access check.
  const summary = summaries.find(
    (candidate) => candidate.fullName.toLowerCase() === repoLabel,
  );
  if (!summary) {
    return blocked(
      `GitHub’s cached repository list doesn’t confirm access to ${repoLabel}. The list may be incomplete. Refresh your GitHub connection and try again, or choose a project.`,
      [
        { kind: 'connect-github' },
        { kind: 'retry' },
        { kind: 'choose-project' },
      ],
    );
  }
  return {
    status: 'ready',
    plan: {
      kind: 'create-project',
      repository: {
        owner: summary.ownerLogin,
        repo: summary.name,
        repositoryKey: repository.repositoryKey,
        cloneUrl: summary.cloneUrl,
        isArchived: summary.isArchived,
      },
      pending,
    },
  };
}

async function resolveLinearDestination(
  identifier: string,
  context: HomeLinkResolveContext,
  deps: HomeLinkResolveDeps,
): Promise<HomeLinkResolution> {
  let results: LinearTicketSearchResult[];
  try {
    results = await deps.searchLinearIssues(identifier);
  } catch (error: unknown) {
    const message = extractIpcErrorMessage(error);
    return blocked(
      message,
      /connect|auth|credential|token/i.test(message)
        ? [{ kind: 'connect-linear' }, { kind: 'retry' }]
        : [{ kind: 'retry' }],
    );
  }
  const issue = results.find(
    (candidate) => candidate.identifier.toUpperCase() === identifier,
  );
  if (!issue) {
    return blocked(
      `Couldn’t find ${identifier} in Linear. Check that Linear is connected and you can open the issue.`,
      [{ kind: 'connect-linear' }, { kind: 'retry' }],
    );
  }
  const linearBranch: HomeLinkPendingBranch = {
    kind: 'linear-issue',
    identifier: issue.identifier,
    title: issue.title,
    branchName: issue.branchName,
  };
  const linearIssue: HomeLinkIssueContext = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
  };
  async function withIssueContext(
    pendingResolution: Promise<HomeLinkResolution>,
  ): Promise<HomeLinkResolution> {
    const resolution = await pendingResolution;
    return resolution.status === 'ready'
      ? { ...resolution, plan: { ...resolution.plan, linearIssue } }
      : resolution;
  }

  const prs = new Map<
    string,
    Extract<CreateFromLinkReference, { kind: 'pr' }>
  >();
  const repositories = new Map<string, ParsedGitHubRepositoryReference>();
  for (const attachment of issue.attachments ?? []) {
    for (const reference of extractCreateFromReferences(attachment.url)
      .references) {
      if (reference.kind === 'linear') continue;
      repositories.set(reference.repositoryKey, reference);
      if (reference.kind === 'pr') prs.set(reference.key, reference);
    }
  }
  const complete = issue.attachmentsComplete === true;

  if (complete && (prs.size > 1 || repositories.size > 1)) {
    const candidates = Array.from(prs.values());
    const prRepos = new Set(
      candidates.map((candidate) => candidate.repositoryKey),
    );
    const choices: CreateFromLinkReference[] = [
      ...candidates,
      ...Array.from(repositories.values())
        .filter((repository) => !prRepos.has(repository.repositoryKey))
        .map(
          (repository): CreateFromLinkReference => ({
            ...repository,
            kind: 'repository',
            key: repository.repositoryKey,
          }),
        ),
    ];
    const chosen = choices.find(
      (choice) =>
        choice.key === context.chosenAttachmentKey &&
        context.chosenAttachmentReferenceKey === `linear:${identifier}`,
    );
    if (chosen && chosen.kind !== 'linear') {
      return withIssueContext(
        resolveRepositoryDestination(
          chosen,
          chosen.kind === 'pr'
            ? { kind: 'pr', number: chosen.number, url: chosen.url }
            : linearBranch,
          context,
          deps,
        ),
      );
    }
    return blocked(
      `${identifier} links to more than one ${prs.size > 1 ? 'pull request' : 'repository'}. Choose which to use.`,
      choices.map(
        (choice): HomeLinkAction => ({
          kind: 'choose-attachment',
          key: choice.key,
          label: describeHomeLinkReference(choice),
        }),
      ),
    );
  }
  const [repository] = Array.from(repositories.values());
  const [pr] = Array.from(prs.values());
  if (complete && repository) {
    return withIssueContext(
      resolveRepositoryDestination(
        repository,
        pr ? { kind: 'pr', number: pr.number, url: pr.url } : linearBranch,
        context,
        deps,
      ),
    );
  }

  // No unique repository evidence: an explicitly chosen code project is the
  // user's answer. A lone or inherited project is never proof of ownership.
  const selected = context.projects.find(
    (project) => project.id === context.workspaceId,
  );
  if (
    context.workspaceSelectionExplicit &&
    selected !== undefined &&
    selected.type !== 'cowork'
  ) {
    return withIssueContext(readyForProject(selected, linearBranch, deps));
  }
  return blocked(
    `Choose a project for ${identifier}. Its links don’t identify one repository.`,
    [{ kind: 'choose-project' }],
  );
}

/** Several distinct candidates always need the user's choice. */
export function ambiguousHomeLinkResolution(
  selection: Extract<HomeLinkSelection, { kind: 'ambiguous' }>,
): HomeLinkResolution {
  return blocked(
    selection.incomplete
      ? selection.references.length === 0
        ? 'This draft is too long to check for links. Shorten it or dismiss this suggestion.'
        : 'This draft has more links than can be checked. Choose one or dismiss this suggestion.'
      : 'This message has more than one link. Choose which to use for the worktree.',
    selection.references.map(
      (reference): HomeLinkAction => ({
        kind: 'choose-reference',
        key: reference.key,
        label: describeHomeLinkReference(reference),
      }),
    ),
  );
}

/** Read-only: never clones, registers, selects, or switches context. */
export async function resolveHomeLink(
  selection: HomeLinkSelection,
  context: HomeLinkResolveContext,
  deps: HomeLinkResolveDeps,
): Promise<HomeLinkResolution> {
  if (selection.kind === 'none') {
    return blocked('No link to use.');
  }
  if (selection.kind === 'ambiguous') {
    return ambiguousHomeLinkResolution(selection);
  }
  const { reference } = selection;
  switch (reference.kind) {
    case 'repository':
      return resolveRepositoryDestination(
        reference,
        { kind: 'default-branch' },
        context,
        deps,
      );
    case 'pr':
      return resolveRepositoryDestination(
        reference,
        { kind: 'pr', number: reference.number, url: reference.url },
        context,
        deps,
      );
    case 'linear':
      return resolveLinearDestination(reference.identifier, context, deps);
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function describeBranchTarget(target: HomeBranchTarget): string {
  switch (target.kind) {
    case 'pr':
      return `PR #${target.number} (${target.headRefName})`;
    case 'linear-issue':
      return `${target.identifier} (${target.branchName})`;
    case 'branch':
      return target.branchName;
    case 'worktree':
    case 'new-worktree':
      return 'the default branch';
  }
}

function describePending(pending: HomeLinkPendingBranch): string {
  switch (pending.kind) {
    case 'default-branch':
      return 'the default branch';
    case 'pr':
      return `PR #${pending.number}`;
    case 'linear-issue':
      return `${pending.identifier} (${pending.branchName})`;
  }
}

export function describeHomeLinkPlan(plan: HomeLinkPlan): {
  label: string;
  detail?: string;
} {
  if (plan.kind === 'existing-project') {
    return {
      label: `New worktree on ${describeBranchTarget(plan.branchTarget)} in ${plan.workspaceName}`,
    };
  }
  const repoLabel = `${plan.repository.owner}/${plan.repository.repo}`;
  return {
    label: `New worktree on ${describePending(plan.pending)} in ${repoLabel}`,
    detail: `Adds ${repoLabel} as a Personal project${
      plan.repository.isArchived ? ' (archived repository)' : ''
    }${plan.pending.kind === 'pr' ? '. Validates the PR after checkout before creating the worktree.' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

export interface HomeLinkMaterializeDeps extends HomeLinkResolveDeps {
  /** Current projects in the selected scope, read fresh at submission. */
  getProjects: () => readonly SidebarItem[];
  canCreatePersonalProject: () => boolean;
  getDefaultCloneDirectory: () => Promise<string>;
  probeCloneDestination: (request: {
    remoteUrl: string;
    destinationDir: string;
  }) => Promise<ProbeCloneDestinationResponse>;
  /** Registers an existing checkout and reloads projects. */
  addLocalRepo: (repoPath: string) => Promise<string | null>;
  /** Clones as a tracked clone job and reloads projects. */
  addRemoteRepo: (
    remoteUrl: string,
    destinationDir: string,
    jobId: string,
  ) => Promise<string | null>;
  listBranches: (workspaceId: string) => Promise<BranchEntry[]>;
  createJobId: () => string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  cancelCloneJob?: (jobId: string) => Promise<void>;
  getOtherScopeProjects?: () => readonly SidebarItem[];
}

export type HomeLinkMaterializeResult =
  | {
      ok: true;
      workspaceId: string;
      branchTarget: HomeBranchTarget;
      branches: BranchEntry[];
    }
  | {
      ok: false;
      message: string;
      retryable: boolean;
      /** The clone failed on GitHub credentials that a sign-in can fix. */
      githubAuthFailure?: true;
    };

/** Repositories this renderer is currently adding, to stop duplicate sends. */
const repositoriesBeingAdded = new Set<string>();

async function finishWithProject(
  project: SidebarItem,
  pending: HomeLinkPendingBranch,
  deps: HomeLinkMaterializeDeps,
  createdNow: boolean,
): Promise<HomeLinkMaterializeResult> {
  const result = await branchTargetForExistingProject(project, pending, deps);
  if (deps.signal?.aborted)
    return {
      ok: false,
      message: createdNow
        ? `Worktree creation cancelled. ${projectName(project)} remains available as a project.`
        : 'Worktree creation cancelled.',
      retryable: true,
    };
  if (!result.ok) {
    return {
      ok: false,
      message: createdNow
        ? `Added ${projectName(project)} as a project, but couldn’t open ${describePending(pending)}: ${result.message}`
        : result.message,
      retryable: true,
    };
  }
  let branches: BranchEntry[] = [];
  if (result.branchTarget.kind === 'linear-issue') {
    try {
      branches = await deps.listBranches(project.id);
    } catch {
      branches = [];
    }
  }
  return {
    ok: true,
    workspaceId: project.id,
    branchTarget: result.branchTarget,
    branches,
  };
}

/**
 * Turns an accepted plan into an explicit `{ workspaceId, branchTarget }`.
 * Reuses a project registered since preview; never deletes a project or a
 * checkout it registered when a later step fails.
 */
export async function materializeHomeLinkPlan(
  plan: HomeLinkPlan,
  deps: HomeLinkMaterializeDeps,
): Promise<HomeLinkMaterializeResult> {
  if (deps.signal?.aborted)
    return {
      ok: false,
      message: 'Worktree creation cancelled.',
      retryable: true,
    };
  if (plan.kind === 'existing-project') {
    const project = deps
      .getProjects()
      .find((candidate) => candidate.id === plan.workspaceId);
    if (!project) {
      return {
        ok: false,
        message: `${plan.workspaceName} is no longer available. Review the link and try again.`,
        retryable: false,
      };
    }
    const repoPath = workspaceRepoPathForCreateFrom(project);
    if (
      (plan.repoPath && plan.repoPath !== repoPath) ||
      (plan.repositoryKey &&
        (!repoPath ||
          slugKey(
            (await deps.getRepoSlug(repoPath)) ?? { owner: '', repo: '' },
          ) !== plan.repositoryKey))
    ) {
      return {
        ok: false,
        message:
          'The project’s repository changed. Review the link and try again.',
        retryable: true,
      };
    }
    if (plan.branchTarget.kind === 'pr') {
      return finishWithProject(
        project,
        {
          kind: 'pr',
          number: plan.branchTarget.number,
          url: plan.branchTarget.url,
        },
        deps,
        false,
      );
    }
    let branches: BranchEntry[] = [];
    if (plan.branchTarget.kind === 'linear-issue') {
      try {
        branches = await deps.listBranches(project.id);
      } catch {
        branches = [];
      }
    }
    return {
      ok: true,
      workspaceId: project.id,
      branchTarget: plan.branchTarget,
      branches,
    };
  }

  const { repository, pending } = plan;
  const repoLabel = `${repository.owner}/${repository.repo}`;
  const recheck = await findProjectsForRepository(
    deps.getProjects(),
    repository.repositoryKey,
    deps,
  );
  const elsewhere = await findProjectsForRepository(
    deps.getOtherScopeProjects?.() ?? [],
    repository.repositoryKey,
    deps,
  );
  if (deps.signal?.aborted)
    return {
      ok: false,
      message: 'Worktree creation cancelled.',
      retryable: true,
    };
  if (elsewhere.matches.length > 0 || elsewhere.unknown)
    return {
      ok: false,
      message:
        'Review projects in the other context before adding this repository.',
      retryable: true,
    };
  if (recheck.matches.length === 1) {
    return finishWithProject(recheck.matches[0], pending, deps, false);
  }
  if (recheck.matches.length > 1) {
    return {
      ok: false,
      message: `${repoLabel} is in more than one project. Choose one.`,
      retryable: false,
    };
  }
  if (recheck.unknown) {
    return {
      ok: false,
      message: `Couldn’t read every project’s repository, so adding ${repoLabel} might duplicate a project.`,
      retryable: true,
    };
  }
  if (!deps.canCreatePersonalProject()) {
    return {
      ok: false,
      message: `Switch to Personal to add ${repoLabel} as a project.`,
      retryable: false,
    };
  }
  if (repositoriesBeingAdded.has(repository.repositoryKey)) {
    return {
      ok: false,
      message: `${repoLabel} is already being added.`,
      retryable: false,
    };
  }

  repositoriesBeingAdded.add(repository.repositoryKey);
  let workspaceId: string | null;
  try {
    const destinationDir = await deps.getDefaultCloneDirectory();
    const probe = await deps.probeCloneDestination({
      remoteUrl: repository.cloneUrl,
      destinationDir,
    });
    if (deps.signal?.aborted)
      return {
        ok: false,
        message: 'Worktree creation cancelled.',
        retryable: true,
      };
    const latest = await findProjectsForRepository(
      deps.getProjects(),
      repository.repositoryKey,
      deps,
    );
    if (latest.matches.length === 1)
      return finishWithProject(latest.matches[0], pending, deps, false);
    if (latest.unknown || latest.matches.length > 1)
      return {
        ok: false,
        message: 'The project list changed. Review the link and try again.',
        retryable: true,
      };
    const otherScope = await findProjectsForRepository(
      deps.getOtherScopeProjects?.() ?? [],
      repository.repositoryKey,
      deps,
    );
    if (otherScope.unknown || otherScope.matches.length > 0)
      return {
        ok: false,
        message:
          'The repository may already have a project in another context. Review the link and try again.',
        retryable: true,
      };
    if (deps.signal?.aborted || !deps.canCreatePersonalProject())
      return {
        ok: false,
        message:
          'Worktree creation stopped. Review the selected context and try again.',
        retryable: true,
      };
    if (probe.reusablePath) {
      deps.onProgress?.(`Adding ${repoLabel}…`);
      workspaceId = await deps.addLocalRepo(probe.reusablePath);
    } else {
      // A conflicting directory is never overwritten: the clone backend
      // chooses a de-duplicated destination for an occupied name.
      deps.onProgress?.(`Cloning ${repoLabel}…`);
      const jobId = deps.createJobId();
      const cancel = (): void => {
        void deps.cancelCloneJob?.(jobId).catch((): undefined => undefined);
      };
      deps.signal?.addEventListener('abort', cancel, { once: true });
      try {
        workspaceId = await deps.addRemoteRepo(
          repository.cloneUrl,
          destinationDir,
          jobId,
        );
      } finally {
        deps.signal?.removeEventListener('abort', cancel);
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      message: `Couldn’t add ${repoLabel}: ${extractIpcErrorMessage(error)}`,
      retryable: true,
      ...(extractIpcErrorName(error) === 'GitHubAuthFailureError'
        ? { githubAuthFailure: true as const }
        : {}),
    };
  } finally {
    repositoriesBeingAdded.delete(repository.repositoryKey);
  }

  const project = workspaceId
    ? deps.getProjects().find((candidate) => candidate.id === workspaceId)
    : undefined;
  if (!project) {
    return {
      ok: false,
      message: `Added ${repoLabel}, but couldn’t open the new project. Try again.`,
      retryable: true,
    };
  }
  if (deps.signal?.aborted)
    return {
      ok: false,
      message: `Worktree creation cancelled. ${projectName(project)} remains available as a project.`,
      retryable: true,
    };
  if (pending.kind === 'pr') {
    deps.onProgress?.(`Opening PR #${pending.number}…`);
  }
  return finishWithProject(project, pending, deps, true);
}
