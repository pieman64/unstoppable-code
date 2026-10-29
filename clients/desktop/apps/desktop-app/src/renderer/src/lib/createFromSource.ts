import {
  detectCreateFromReference,
  parseLinearIdentifier,
  type DetectedReference,
  type CreateFromSource,
} from '@canopy/desktop-shared/lib/create-from-reference';
import type {
  LinearTicketSearchResult,
  ResolvePullRequestResponse,
  SidebarItem,
} from '@canopy/desktop-shared/types';

/**
 * Options threaded into `useProjectsStore.createWorktree` by the
 * "Create from ..." flows (ECW-8121). Exactly one of the two fields is set.
 */
export interface CreateFromOptions {
  existingBranch?: string;
  branchName?: string;
  suggestedBranch?: string;
}

export interface ResolvedCreateFromTarget {
  createOptions: CreateFromOptions;
  /** Suggested task text (empty when the source has none). */
  prefillText: string;
  /** Short human-readable description of what was resolved. */
  resolvedLabel: string;
}

export interface ResolvedCreateFromReferenceInput {
  detected: DetectedReference | null;
  referenceQuery: string;
}

export function resolveCreateFromReferenceInput(
  input: string,
  linearAvailable: boolean,
): ResolvedCreateFromReferenceInput {
  const detected = detectCreateFromReference(input);
  return {
    detected,
    referenceQuery:
      detected?.mode === 'linear' && linearAvailable ? detected.value : input,
  };
}

export function isWorkspaceEligibleForCreateFrom(
  workspace: SidebarItem,
): boolean {
  return workspaceRepoPathForCreateFrom(workspace) !== null;
}

export function workspaceRepoPathForCreateFrom(
  workspace: SidebarItem,
): string | null {
  if (workspace.type === 'single-repo') {
    return workspace.repoPath;
  }
  if (workspace.type === 'multi-repo') {
    return workspace.sourceRepoPath ?? null;
  }
  return null;
}

export function createOptionsForBranch(branchName: string): CreateFromOptions {
  return { existingBranch: branchName };
}

export function createOptionsForPr(
  pr: ResolvePullRequestResponse,
): CreateFromOptions {
  return { existingBranch: pr.headRefName };
}

/**
 * Let the backend atomically decide whether the Linear-suggested branch should
 * be checked out or created. Renderer branch snapshots are advisory UI data
 * and can be stale or scoped to a previously selected workspace.
 */
export function createOptionsForLinear(
  ticket: LinearTicketSearchResult,
): CreateFromOptions {
  return { suggestedBranch: ticket.branchName };
}

export function buildLinearTaskText(ticket: LinearTicketSearchResult): string {
  const description = ticket.description?.trim() ?? '';
  if (description.length > 0) {
    return `${ticket.identifier}: ${ticket.title}\n\n${description}`;
  }
  return `${ticket.identifier}: ${ticket.title}`;
}

export function replaceGeneratedTaskText(
  currentText: string,
  previousGeneratedText: string,
  nextGeneratedText: string,
): string {
  if (
    currentText.trim().length === 0 ||
    currentText === previousGeneratedText
  ) {
    return nextGeneratedText;
  }
  return currentText;
}

/**
 * Resolve a raw reference string for one source into worktree-create options.
 * Shared by the Create Task modal and the App Advisor
 * `worktree.create_from` action so both paths behave identically.
 */
export async function resolveCreateFromTarget(
  source: CreateFromSource,
  reference: string,
  workspace: SidebarItem,
): Promise<ResolvedCreateFromTarget> {
  switch (source) {
    case 'branch': {
      const branchName = reference.trim();
      if (branchName.length === 0) {
        throw new Error('A branch name is required.');
      }
      return {
        createOptions: createOptionsForBranch(branchName),
        prefillText: '',
        resolvedLabel: `branch ${branchName}`,
      };
    }
    case 'pr': {
      const repoPath = workspaceRepoPathForCreateFrom(workspace);
      if (!repoPath) {
        throw new Error(
          'This project has no repository to resolve a pull request against.',
        );
      }
      const pr = await window.api.resolvePullRequest({
        repoPath,
        reference: reference.trim(),
      });
      return {
        createOptions: createOptionsForPr(pr),
        prefillText: pr.title,
        resolvedLabel: `PR #${pr.number} (${pr.headRefName})`,
      };
    }
    case 'linear': {
      const identifier = parseLinearIdentifier(reference) ?? reference.trim();
      const results = await window.api.searchLinearIssues(identifier);
      const ticket = results.find(
        (candidate) =>
          candidate.identifier.toUpperCase() === identifier.toUpperCase(),
      );
      if (!ticket) {
        throw new Error(`No Linear issue found for "${reference}".`);
      }
      return {
        createOptions: createOptionsForLinear(ticket),
        prefillText: buildLinearTaskText(ticket),
        resolvedLabel: `${ticket.identifier} (${ticket.branchName})`,
      };
    }
  }
}
