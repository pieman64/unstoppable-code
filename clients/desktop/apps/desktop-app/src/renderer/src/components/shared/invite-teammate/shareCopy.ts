import type {
  SharedContainerBlockedReason,
  SharedContainerGithubBlockedReason,
  SharedContainerGithubReadiness,
  SharedContainerPublicationErrorReason,
  SharedContainerSharePreview,
} from '@canopy/desktop-shared/types';
import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import { formatOrgNameList } from '@canopy/ui-shared/lib/org-lapse-sentence';
import { brandText } from '@/lib/brand';

/**
 * Every user-visible string in the invite-a-teammate flow, plus the pure
 * functions that build copy from data.
 *
 * Collected here so the flow's voice can be read and changed in one place
 * rather than hunted through five components, and so the copy has no React
 * dependency to test around.
 */

/**
 * The dialog title follows the common share dialog: `Share <noun>`. The
 * dialog is the entry point to *all* sharing - inviting and revoking - so it
 * keeps that title whether or not somebody already has access.
 */
export const TITLE = `Share ${containerNoun()}`;
export const MANAGE_TITLE = 'Manage teammate access';
export const CLOUD_ACCOUNT_NAME = `${brandText.appName} Cloud`;
/** The frame's primary, and its label while an invite is in flight. */
export const SHARE_LABEL = 'Share';
export const SHARING_LABEL = 'Sharing…';
export const CHECKING_LABEL = 'Checking access…';
/** The "open to my layout" row, which sits under "Opens to:". */
export const LAYOUT_ROW_LABEL = 'Open to my layout';
export const LAYOUT_UPDATE_LABEL = 'Update to current layout';
/** Under "Opens to:" while the layout is off and the file is withheld. */
export const START_PAGE_WITHHELD_LABEL =
  'This file is withheld, so receivers will see the default view instead.';

/** The trailing section listing every grant, Google Docs style. */
export const PEOPLE_WITH_ACCESS_LABEL = 'People with access';
/** The publish status on the People with access heading, by resolved status. */
export const PUBLISHING_LABEL = 'Publishing changes…';
export const PUBLISHED_LABEL = 'Up to date';
export const NOT_PUBLISHED_LABEL = 'Not published yet';
export const PUBLISH_FAILED_LABEL = "Couldn't publish";
/** The reason used when an invite fails for no reason the server named. */
export const FAILURE_LABEL = 'Try again.';
export const INSUFFICIENT_ROLE_LABEL =
  'You do not have permission to invite teammates in this organization.';
export const BILLING_REFUSAL_LABEL =
  'This organization plan does not include teammate sharing.';
/** The error notice above the footer after a failed invite. */
export function shareFailureMessage(reason: string): string {
  return `Couldn't share the ${containerNoun()}. ${reason}`;
}
/** The success toast after an invite, naming who now has access. */
export function invitedToastMessage(recipient: string): string {
  return `Invited ${recipient}`;
}
export const MEMBER_SEARCH_PLACEHOLDER = 'Search teammates by name';
export const MEMBER_LOADING_LABEL = 'Loading teammates…';
export const MEMBER_ERROR_LABEL = 'Could not load teammates.';
export const REVOKE_LABEL = 'Remove';
export const NO_RECIPIENTS_LABEL = 'No one has been invited yet.';
export const RECIPIENTS_ERROR_LABEL = 'Could not load who has access.';
export const RECIPIENTS_PARTIAL_ERROR_LABEL =
  'Could not load the complete access list.';
/** The low-profile toggle over everything the owner may opt out of. */
export const ADVANCED_LABEL = 'Advanced';
export const SCOPE_SAVE_ERROR_LABEL =
  'Could not save the approved share scope.';
/**
 * Shown in place of the scope summary when the preview request failed.
 *
 * Informational, not destructive: inviting still works, and the share still
 * publishes. What the owner has lost is the review, so the sentence says that
 * and stops — promising a retry the panel does not offer would be worse than
 * saying nothing.
 */
export const PREVIEW_UNAVAILABLE_LABEL =
  'Could not check what will be shared. Inviting still works.';
/** The preview blocker once the revision would exceed its item budget. */
export function artifactBudgetExceededLabel(
  used: number,
  limit: number,
): string {
  return `${String(used)} of ${String(limit)} shareable items used. Publishing refuses over the limit. Untick some files under ${ADVANCED_LABEL}, or push to GitHub so less has to be sent.`;
}
export const REVOKE_ERROR_LABEL = 'Could not remove that teammate.';
export const MANAGE_EXISTING_LABEL = 'Manage existing access';
export const TRY_AGAIN_LABEL = 'Try again';
export const ACCOUNT_UNAVAILABLE_TITLE = 'Could not check your cloud account';
export const ACCOUNT_UNAVAILABLE_BODY =
  'Your saved account could not be read. Try again before inviting a teammate.';

/**
 * Audience copy (external sharing). Public overrides the link meaning other
 * share surfaces give it: here it reaches the people the owner invites by
 * email, not anyone holding a link or anyone with an account. That meaning is
 * carried by {@link EMAIL_DESCRIPTION} on the Email field, so Public has no
 * description of its own. See docs/ux-writing.md "Share dialog".
 */
export const AUDIENCE_LEGEND = 'Sharing scope';
export const AUDIENCE_DESCRIPTIONS = {
  team: 'People on one of your teams.',
  organization: 'People in your organization.',
} as const;
export const PUBLIC_EXTERNAL_SHARING_OFF_HINT =
  'Public is off for this organization. An organization admin can allow sharing outside the organization.';
export const PUBLIC_UNAVAILABLE_HINT = 'Sharing by email is not available yet.';
export const TEAM_UNAVAILABLE_HINT = 'Join a team to share with it.';
export const TEAM_LABEL = 'Team';
export const EMAIL_LABEL = 'Email';
/** Describes the Email field, between its label and the input. */
export const EMAIL_DESCRIPTION =
  "Choose who to share with, and we'll email them an invite.";
export const EMAIL_ALREADY_INVITED_LABEL = 'That address already has access.';
export const INVITED_LABEL = 'Invited';
/** Shown on Public for an organization-owned share. */
export function externalAudienceNotice(organizationName: string): string {
  return `People outside ${organizationName} will be able to view this ${containerNoun()}.`;
}

export const SEARCH_DEBOUNCE_MS = 250;
export const MAX_CURSOR_PAGES = 50;

/**
 * What a share is called, in every sentence the owner reads.
 *
 * One word for both container types on purpose. "Work Entry" and "worktree"
 * are the internal names for the two things that can be shared, and neither
 * is a term the recipient of an invite has to learn to understand what they
 * are being given. "Project" also matches the common frame's `Share project`
 * title and the surrounding project vocabulary.
 *
 * Takes no argument on purpose. It used to branch on the container type, and
 * leaving a parameter it ignores would invite a caller to believe the word can
 * still differ. Where the *sentence* genuinely has to differ - a Cowork
 * workspace carries no code - the caller branches on the container type
 * itself, as `shareSummarySentence` does.
 *
 * Lowercase because every call site uses it mid-sentence ("this ${noun}").
 * Capitalize at the call site if a sentence ever has to start with it.
 */
export function containerNoun(): string {
  return 'project';
}

/**
 * A "What is shared" entry, or null when the count is zero. The summary answers
 * "what leaves my machine"; a kind the share carries none of is not an answer,
 * it is a row the owner has to read past to find the ones that matter.
 */
export function countEntry(
  count: number,
  singular: string,
  plural: string,
): string | null {
  if (count <= 0) return null;
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/**
 * An approved-of-available entry. Unlike {@link countEntry} this survives a zero
 * *approved* count, because "0 of 2 notes" is the owner's outstanding decision
 * rather than an empty row. It disappears only when nothing is available.
 */
export function scopeEntry(
  approved: number,
  available: number,
  singular: string,
  plural: string,
): string | null {
  if (available <= 0) return null;
  return `${String(approved)} of ${String(available)} ${
    available === 1 ? singular : plural
  }`;
}

/** Join one line's entries, dropping the line entirely when all are absent. */
export function summaryLine(entries: Array<string | null>): string | null {
  const present = entries.filter((entry): entry is string => entry !== null);
  return present.length > 0 ? present.join(', ') : null;
}

/**
 * The "no search results" sentence. Shared by the empty state and the picker's
 * `emptyLabel` fallback so the two can never drift apart.
 */
/** The copy around the echoed query in {@link noQueryMatchLabel}. */
export const NO_QUERY_MATCH_PREFIX = 'No teammates match \u201C';
export const NO_QUERY_MATCH_SUFFIX = '\u201D.';

export function noQueryMatchLabel(query: string): string {
  return `${NO_QUERY_MATCH_PREFIX}${query}${NO_QUERY_MATCH_SUFFIX}`;
}

export interface ShareSummaryCounts {
  approvedFileCount: number;
  /** Every file offered for this share, before the owner opted any out. */
  candidateFileCount: number;
  /**
   * Whether the approved files were added one by one rather than left in.
   * Only a Cowork scope narrowed under the old allowlist semantics; it still
   * reads as an additive decision until the owner changes it.
   */
  fileScopeIsAllowlist: boolean;
  approvedNoteCount: number;
  approvedPromptCount: number;
}

/**
 * The bulleted "what is shared" lines, one kind per line group.
 *
 * Only the kinds this share actually carries. A summary padded with zeroes
 * reads as a form rather than an answer, and buries the counts that matter.
 */
export function buildShareSummaryLines(
  preview: SharedContainerSharePreview | null,
  isCoworkContainer: boolean,
  counts: ShareSummaryCounts,
): string[] {
  if (!preview) return [];
  return [
    summaryLine([countEntry(preview.chatCount, 'chat', 'chats')]),
    // Cowork has no plan mode, so `plans/` is always empty there.
    summaryLine([
      ...(isCoworkContainer
        ? []
        : [countEntry(preview.planCount, 'plan', 'plans')]),
      countEntry(preview.attachmentCount, 'attachment', 'attachments'),
    ]),
    summaryLine([
      scopeEntry(counts.approvedNoteCount, preview.noteCount, 'note', 'notes'),
      scopeEntry(
        counts.approvedPromptCount,
        preview.promptCount,
        'prompt',
        'prompts',
      ),
    ]),
    summaryLine([
      // Every share carries its files by default, so this is a decision the
      // owner still holds rather than a list they built: it reads as
      // "12 of 14 files" and survives a zero, exactly as notes and prompts do.
      // Only a legacy Cowork allowlist, narrowed by hand before files became
      // opt-out, stays a plain count that disappears when empty.
      counts.fileScopeIsAllowlist
        ? countEntry(
            counts.approvedFileCount,
            'approved file',
            'approved files',
          )
        : scopeEntry(
            counts.approvedFileCount,
            counts.candidateFileCount,
            isCoworkContainer ? 'file' : 'file not in git',
            isCoworkContainer ? 'files' : 'files not in git',
          ),
      ...(isCoworkContainer
        ? []
        : [
            countEntry(
              preview.dirtyFileCount,
              'uncommitted change',
              'uncommitted changes',
            ),
            // Informational, never a gate: the share is based on what GitHub
            // already has and carries these commits in its overlay. Named so
            // the owner knows work GitHub has not seen still travels.
            countEntry(
              preview.unpushedCommitCount ?? 0,
              'commit not on GitHub yet',
              'commits not on GitHub yet',
            ),
          ]),
    ]),
  ].filter((line): line is string => line !== null);
}

/**
 * The summary sentence that opens the Advanced expander.
 *
 * It answers the owner's actual question ("what leaves my machine?") from the
 * same entries that used to be a bulleted block, so nothing is hidden that was
 * not also summarized.
 */
export function shareSummarySentence(
  lines: readonly string[],
  containerType: SharedContainerType,
): string {
  const noun = containerNoun();
  const parts = lines.join(', ');
  // Comma-joined, not "a, b and c": each entry in `lines` is itself already a
  // comma-joined group ("1 plan, 2 attachments"), so a conjunction between
  // groups would land in the middle of a list rather than before its last
  // item. Flattening to one entry list is not worth losing the grouping.
  //
  // Only a code worktree leads with its code. A Cowork workspace is a plain
  // folder with no git behind it, so naming code first promised something the
  // share does not carry - and now that both types share one noun, the claim
  // would no longer even be distinguishable by the reader.
  if (containerType === 'COWORK_WORK_ENTRY') {
    return parts
      ? `Sharing this workspace: ${parts}.`
      : 'Sharing this workspace.';
  }
  if (!parts) return `Sharing this ${noun}.`;
  return `Sharing this ${noun}'s code, ${parts}.`;
}

/**
 * Disclosure for repositories whose code travels through the cloud rather than
 * being cloned from GitHub. Informational, not a gate: the owner is told where
 * the code goes, and nothing asks them to confirm it.
 */
export function snapshotRepositoryDisclosure(
  count: number,
  names: readonly string[] = [],
): string | null {
  if (count <= 0) return null;
  if (names.length > 0) {
    const repositories =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    return `Code for ${repositories} is sent through ${CLOUD_ACCOUNT_NAME} because ${names.length === 1 ? "it isn't" : "they aren't"} on GitHub.`;
  }
  return count === 1
    ? `Code for 1 repository is sent through ${CLOUD_ACCOUNT_NAME} because it isn't on GitHub.`
    : `Code for ${String(count)} repositories is sent through ${CLOUD_ACCOUNT_NAME} because they aren't on GitHub.`;
}

/**
 * How often, and how many times, the modal re-checks a project that the cloud
 * is still registering before it gives up and offers Try again. About twelve
 * seconds in total, on top of the retries eligibility already makes itself.
 */
export const REGISTRATION_RECHECK_INTERVAL_MS = 3000;
export const REGISTRATION_RECHECK_LIMIT = 4;

/**
 * Copy for the refusals that replace the whole modal body.
 *
 * `sync-disabled` and `sync-blocked-by-org` are deliberately absent: they route
 * to `ShareSetupCta`, which offers an action instead of a dead end.
 * `github-not-ready` is absent for the same reason: it routes to
 * {@link githubRecoveryCopy}, which classifies the Git state and offers the
 * one-click push when a safe push is all that is missing.
 */
export function accountRefusal(
  reason: SharedContainerBlockedReason,
  organizationNames: string[],
): {
  title: string;
  description: string;
} | null {
  const noun = containerNoun();
  const orgNames = formatOrgNameList(organizationNames);
  switch (reason) {
    case 'no-organization':
      return {
        title: 'Join an organization to invite teammates',
        description: `Inviting a teammate shares this ${noun} inside an organization, and this account does not belong to one yet.`,
      };
    case 'account-unavailable':
      return {
        title: ACCOUNT_UNAVAILABLE_TITLE,
        description: ACCOUNT_UNAVAILABLE_BODY,
      };
    case 'unsupported-capability':
      return {
        title: 'This feature is not available yet',
        description: `The connected ${CLOUD_ACCOUNT_NAME} server does not support shared ${noun}s yet. It becomes available once the server is updated.`,
      };
    // Rendered as an in-place progress state that re-checks on its own; see
    // `InviteTeammateModal`. Not a dead end, so the copy says what is
    // happening and how long it usually takes rather than asking for a retry.
    case 'not-yet-synced':
      return {
        title: `Getting this ${noun} ready to share`,
        description: `${CLOUD_ACCOUNT_NAME} needs to set up this ${noun} before a teammate can open it. This usually takes a few seconds.`,
      };
    // Registration threw, or the automatic re-checks ran out. Paired with a
    // Try again button in the modal.
    case 'registration-failed':
      return {
        title: `Couldn't get this ${noun} ready`,
        description: 'Check your connection, then try again.',
      };
    case 'anchored-to-other-organization':
      return {
        title: 'This project is already shared elsewhere',
        description: orgNames
          ? `This ${noun} is already shared through ${orgNames}. Access must be managed from that organization.`
          : `This ${noun} is already shared through another organization. Access must be managed from that organization.`,
      };
    case 'insufficient-role':
      return {
        title: 'You do not have permission to share this',
        description: `Your role in this organization does not allow sharing a ${noun}. An organization admin can change that.`,
      };
    case 'external-sharing-disabled':
      return {
        title: 'Sharing outside the organization is off',
        description: orgNames
          ? `${orgNames} only allows sharing with its members. An organization admin can allow sharing outside the organization.`
          : 'This organization only allows sharing with its members. An organization admin can allow sharing outside the organization.',
      };
    case 'blocked-by-org-billing':
      return {
        title: 'Your organization plan does not include teammate sharing',
        description: orgNames
          ? `${orgNames} does not currently include shared projects. An organization admin can update the plan to re-enable it.`
          : 'Your organization does not currently include shared projects. An organization admin can update the plan to re-enable it.',
      };
    default:
      return null;
  }
}

/**
 * What the recovery state offers the owner, once the Git state is classified.
 *
 * `push` is the only value that puts a mutating button on screen, and it is
 * reachable only from `push-required` - the one classification a normal,
 * non-force push actually repairs. `recheck` re-runs the probe and mutates
 * nothing. `none` is guidance the app cannot safely carry out for the user.
 */
export type GithubRecoveryAction = 'push' | 'recheck' | 'none';

export const PUSH_TO_GITHUB_LABEL = 'Push to GitHub';
export const PUSHING_LABEL = 'Pushing…';
export const GITHUB_PUSH_ERROR_LABEL =
  'Could not push to GitHub. Check your connection and repository access, then try again.';
/**
 * The budget remedy's push reached a branch a plain push cannot update (it
 * diverged, or has no upstream to push to). Point at the other remedy the
 * same refusal already names instead of explaining Git.
 */
export const GITHUB_PUSH_BLOCKED_LABEL = `Couldn't push this branch to GitHub. Untick some files under ${ADVANCED_LABEL} instead.`;

/**
 * Copy for the classified GitHub readiness refusal.
 *
 * Sharing no longer waits on push state: the share is based on the newest
 * commit already on GitHub, so current main processes only raise
 * `github-not-ready` when GitHub could not be checked at all (`unavailable`).
 * The other branches stay as a defensive fallback for an older main process.
 *
 * One short sentence per state, because the owner reading this is blocked and
 * wants the next step rather than an explanation of Git. The old version of
 * this state printed a paragraph and a shell command; anything the app can do
 * itself now belongs on the button instead.
 */
export function githubRecoveryCopy(readiness: SharedContainerGithubReadiness): {
  title: string;
  description: string;
  action: GithubRecoveryAction;
} {
  const noun = containerNoun();
  if (readiness.status === 'push-required') {
    return {
      title: 'Push to GitHub to continue',
      description: `This ${noun}'s current branch needs to be on GitHub before you can share it.`,
      action: 'push',
    };
  }
  // A `ready` readiness should never reach this refusal. If one does, the
  // renderer's own view of eligibility disagrees with the probe, so offer the
  // re-check rather than a push nothing asked for.
  const reason: SharedContainerGithubBlockedReason =
    readiness.status === 'blocked' ? readiness.reason : 'unavailable';
  switch (reason) {
    case 'missing-origin':
      return {
        title: 'Connect this project to GitHub',
        description: `Add a GitHub origin to each repository before sharing this ${noun}.`,
        action: 'none',
      };
    case 'non-github-origin':
      return {
        title: 'A GitHub repository is required',
        description: `Each repository's origin must point to GitHub before this ${noun} can be shared.`,
        action: 'none',
      };
    case 'no-branch':
    case 'no-head':
      return {
        title: 'Switch to a branch to continue',
        description: `This ${noun} needs a named branch with a commit before it can be shared.`,
        action: 'none',
      };
    case 'diverged':
      return {
        title: 'Sync this branch with GitHub',
        description:
          'The local and GitHub branches have different commits. Resolve the branch history, then try again.',
        action: 'none',
      };
    case 'no-repositories':
      return {
        title: 'No Git repository found',
        description: `Add a Git repository to this ${noun} before sharing it.`,
        action: 'none',
      };
    case 'unavailable':
      return {
        title: 'Could not check GitHub',
        description: 'Check your connection and GitHub access, then try again.',
        action: 'recheck',
      };
  }
}

/**
 * The single upgrade state shown when the account belongs only to
 * organizations whose plan no longer includes teammate sharing.
 *
 * Honesty rule, the same one `ShareSetupCta` follows: name the organizations,
 * point at who can fix it, and do not promise an action this user can perform.
 * The entry point deliberately stays visible - hiding it would leave the owner
 * with no way to discover why sharing disappeared.
 */
export function allOrganizationsIneligibleCopy(organizationNames: string[]): {
  title: string;
  description: string;
} {
  const noun = containerNoun();
  const orgNames = formatOrgNameList(organizationNames);
  return {
    title: 'Teammate sharing is not on your plan',
    description: orgNames
      ? `Sharing a ${noun} with a teammate is not included in ${orgNames} right now. An organization admin can update the plan to turn it back on.`
      : `Sharing a ${noun} with a teammate is not included in your organization's plan right now. An organization admin can update the plan to turn it back on.`,
  };
}

/**
 * Owner-actionable remedy for a classified publish refusal.
 *
 * The raw `error` string on the publication record is a publisher exception
 * message: a diagnostic, not an instruction. Every reason the publisher
 * classifies has exactly one thing the owner can do about it, so render that
 * and keep the exception string for the unclassified fallback.
 */
export function publicationErrorRemedy(
  reason: SharedContainerPublicationErrorReason,
  noun: string,
  detail?: string,
): string {
  switch (reason) {
    // Legacy only. Sharing now bases on the newest commit already on GitHub,
    // so the publisher no longer raises this; a persisted state still can.
    case 'unpushed-head':
      return `The commit this ${noun} is based on is not on GitHub yet. Push that branch, and the next change publishes.`;
    case 'git-lfs':
      return `This repository stores files with Git LFS, which ${brandText.appName} cannot publish yet. Recipients keep any revision published before this.`;
    // Legacy only. A repository with no GitHub remote now travels through the
    // cloud as a snapshot instead of refusing the revision.
    case 'undisclosable-repository':
      return `A repository here has no pushed GitHub remote, so its contents cannot be shared. Push it to GitHub, or remove it from this ${noun}.`;
    case 'artifact-budget':
      return `This ${noun} holds more than one revision can carry. Untick some files under ${ADVANCED_LABEL}, or push to GitHub so less has to be sent.`;
    case 'submodule':
      // The one refusal whose publisher message is itself actionable: it names
      // the offending submodule paths (bounded), and finding them is most of
      // the work. Prefer that over the generic sentence when it is present.
      return detail
        ? `${detail} ${brandText.appName} cannot publish submodules yet.`
        : `This repository contains a git submodule, which ${brandText.appName} cannot publish yet.`;
    case 'symlink':
      // Legacy only. In-repo committed symlinks now publish, and escaping ones
      // are withheld rather than refused, so the publisher no longer raises
      // this. A publication state persisted before that change still can.
      return `This repository contains a committed symbolic link, which ${brandText.appName} cannot publish yet.`;
  }
}

// ---------------------------------------------------------------------------
// Share with a link. "Public" is reserved for the invite-by-email audience; every
// string here talks about "the link" instead.
// ---------------------------------------------------------------------------

export const LINK_SHARING_LABEL = 'Share with a link';
export const LINK_OFF_LABEL = 'Off';
export const LINK_OFF_DESCRIPTION = 'Only people you invite can open it';
export const LINK_ANYONE_LABEL = 'Anyone with the link';
export const RESET_LINK_LABEL = 'Reset link';
export const LINK_MORE_OPTIONS_LABEL = 'More link options';
export const JOINED_WITH_LINK_LABEL = 'Joined with link';
/** A recipient who removed the share; revoking the row stops a restore. */
export const REMOVED_BY_RECIPIENT_LABEL = 'Removed by recipient';
export const LINK_LOAD_FAILURE_LABEL = "Couldn't load the link setting.";
export const LINK_UPDATE_FAILURE_LABEL = "Couldn't update the link. Try again.";
export function linkOrganizationLabel(organizationName: string): string {
  return `Anyone in ${organizationName} with the link`;
}

export function linkOrganizationDescription(organizationName: string): string {
  return `People in ${organizationName} who have the link can view it`;
}

/** Personal containers have no organization to be outside of. */
export function linkAnyoneDescription(organizationName: string | null): string {
  return organizationName
    ? `Anyone signed in who has the link can view it, including people outside ${organizationName}`
    : 'Anyone signed in who has the link can view it';
}

export function linkExternalSharingOffHint(organizationName: string): string {
  return `Links for people outside ${organizationName} are off for this organization. An organization admin can turn them on.`;
}
