import type {
  GitHubCloudTargetDto,
  GitHubCloudTargetState,
} from '@canopy/protocol/settings/account-github';
import type { GitHubCloudConnectionController } from './use-github-cloud-connection';

// ---------------------------------------------------------------------------
// When is GitHub "ready" for cloud projects (REG-3020)?
//
// Ready means adopted readiness after a fresh verification, not "the user's
// GitHub authorization is ACTIVE":
//
// - `verified`: the live check answered (or a Connect collected fresh
//   evidence) and nothing newer has failed since;
// - `ACTIVE` with `readyForProjects`: at least one account is eligible AND
//   Core adopted it for the current evidence generation. A Connect that
//   answers `next: "done"` can still leave `readyForProjects` false while Core
//   adoption is pending, so readiness never reads `next` or the state alone;
// - with a selected account (below), that one account is ACTIVE as well:
//   another usable organization never enables an unavailable selected one.
//
// Neither is a repository write grant. Callers re-verify the selected
// repository and the operation's permission immediately before issuing one.
// ---------------------------------------------------------------------------

/** How the selected account stands, when the consumer needs one. */
export type GitHubCloudSelectionStatus =
  /** The consumer needs no specific account. */
  | 'unselected'
  | 'active'
  /** Installed, awaiting Core adoption. */
  | 'pending'
  /** Installed but blocked on GitHub: permissions to approve, or suspended. */
  | 'blocked'
  /** Not installed for this GitHub user (or removed): the app is needed. */
  | 'unavailable';

export interface GitHubCloudSelection {
  readonly status: GitHubCloudSelectionStatus;
  /** The selected account's row; null when it is not installed at all. */
  readonly target: GitHubCloudTargetDto | null;
}

const UNSELECTED: GitHubCloudSelection = {
  status: 'unselected',
  target: null,
};

/**
 * Which account a consumer needs, if it needs a specific one: by GitHub
 * installation id OR by owner login, never both (a type error; at runtime the
 * installation id wins). Neither means any usable account will do. A blank
 * value (empty or only whitespace) reads as "nothing selected yet", the same
 * for both forms, so the owner of a half-filled form never blocks readiness
 * or reads as an unavailable account.
 *
 * Use the login when the consumer knows an owner but not an installation:
 * an owner with no installation is exactly the account another usable
 * organization must not stand in for.
 */
export type GitHubCloudSelectedAccount =
  | {
      /**
       * `GitHubCloudTargetDto.installationId`: a decimal string, trimmed and
       * then matched exactly (never a login, never a prefix).
       */
      readonly selectedInstallationId?: string;
      readonly selectedAccountLogin?: undefined;
    }
  | {
      readonly selectedInstallationId?: undefined;
      /**
       * The owner's GitHub login, matched against `accountLogin` as a whole
       * and case-insensitively (GitHub logins are case-insensitive). When it
       * names several rows (a removed installation beside a reinstall), the
       * best-ranked row decides. An owner with no matching account is not
       * installed.
       */
      readonly selectedAccountLogin?: string;
    };

/** A selection value, trimmed; undefined when absent or blank. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * How usable a row is, best first. Several rows can share a login: a removed
 * installation stays listed as REMOVED, and a reinstall adds a newer row, which
 * the server sorts after the old one (installation id ascending). The
 * selected owner stands as its best row, so the reinstall is the recovery and
 * never hides behind the removed row listed before it.
 */
const STATE_RANK: Readonly<Record<GitHubCloudTargetState, number>> = {
  ACTIVE: 0,
  PENDING_ADOPTION: 1,
  NEEDS_APPROVAL: 2,
  SUSPENDED: 2,
  REMOVED: 3,
};

/** The best-ranked of `rows`; the first one on a tie. */
function bestRanked(
  rows: readonly GitHubCloudTargetDto[],
): GitHubCloudTargetDto | null {
  let best: GitHubCloudTargetDto | null = null;
  for (const row of rows) {
    if (best === null || STATE_RANK[row.state] < STATE_RANK[best.state]) {
      best = row;
    }
  }
  return best;
}

/**
 * Finds the selected account among the connection's accounts and says how it
 * stands. A login can name several rows (see `STATE_RANK`): the best-ranked
 * one decides. No match (not installed for this GitHub user) is `unavailable`
 * with a null `target`, never a fallback to some other account.
 */
export function classifySelection(
  targets: readonly GitHubCloudTargetDto[],
  selected: GitHubCloudSelectedAccount = {},
): GitHubCloudSelection {
  const installationId = nonBlank(selected.selectedInstallationId);
  const login = nonBlank(selected.selectedAccountLogin)?.toLowerCase();
  if (installationId === undefined && login === undefined) return UNSELECTED;
  const target = bestRanked(
    targets.filter((entry) =>
      installationId !== undefined
        ? entry.installationId === installationId
        : entry.accountLogin.toLowerCase() === login,
    ),
  );
  switch (target?.state) {
    case 'ACTIVE':
      return { status: 'active', target };
    case 'PENDING_ADOPTION':
      return { status: 'pending', target };
    case 'NEEDS_APPROVAL':
    case 'SUSPENDED':
      return { status: 'blocked', target };
    case 'REMOVED':
    case undefined:
      return { status: 'unavailable', target };
  }
}

/**
 * Adopted readiness after fresh verification, plus the selected account when
 * given. Pure: the Connect step, and a consumer that gates on the controller
 * directly, read the same answer.
 */
export function isGitHubCloudReady(
  controller: GitHubCloudConnectionController,
  selected: GitHubCloudSelectedAccount = {},
): boolean {
  const ready =
    controller.verified &&
    controller.connection?.state === 'ACTIVE' &&
    controller.connection.readyForProjects;
  // `verified` is already false after a failed check; a presentation caller
  // that sets both must still never read as ready.
  if (!ready || controller.stale) return false;
  const selection = classifySelection(
    controller.connection?.targets ?? [],
    selected,
  );
  return selection.status === 'unselected' || selection.status === 'active';
}
