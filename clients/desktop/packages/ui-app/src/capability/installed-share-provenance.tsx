'use client';

import type { JSX, MouseEvent, ReactNode } from 'react';
import type {
  SharedSkillInstallOrigin,
  SharedSkillSummary,
} from '@canopy/protocol';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { SHARE_ATTRIBUTION_SHARER_PREFIX } from '../sharing/share-install-copy';
import { normalizeShareContentHash } from './share-content-hash';

/** An installed shared skill never follows its source (CAN-5018). */
export const INSTALLED_SHARE_COPY_LABEL = 'One-time copy';
/** The source's content differs from the copy that was installed. */
export const INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL = 'Update available';
export const VIEW_SHARED_SKILL_LABEL = 'View shared skill';

/**
 * Where the installed page's `View shared skill` goes: a host route the
 * browser can follow, or a host navigation action. `onNavigate` lets a
 * client router take an ordinary click while the anchor keeps its href.
 */
export type InstalledShareSource =
  | {
      readonly kind: 'link';
      readonly href: string;
      readonly onNavigate?: () => void;
    }
  | { readonly kind: 'action'; readonly onSelect: () => void };

/** Display names for an installed share. Never grants access. */
export interface InstalledShareDisplayNames {
  /** Organization name, including the organization owning a team share. */
  readonly ownerName?: string;
  readonly teamName?: string;
  readonly sharedByName?: string;
}

export interface InstalledShareProvenanceOptions {
  /**
   * Current names from a successful authenticated read. They replace the
   * receipt's names entirely, so a removed team or sharer stays removed.
   */
  readonly names?: InstalledShareDisplayNames;
  /** Only when a live read established that the source's hash changed. */
  readonly updateAvailable?: boolean;
  readonly source?: InstalledShareSource;
}

export interface InstalledShareProvenance {
  /** From, Team, Shared by, One-time copy and Update available, in order. */
  readonly facts: readonly ReactNode[];
  /** Placed after the header's `Updated` date. */
  readonly sourceLink: ReactNode | null;
}

/**
 * Whether the source's SKILL.md hash differs from the one recorded at
 * install. Both are SHA-256 hex of the raw source, so case is not
 * significant. A missing or malformed hash is no evidence either way.
 */
export function shareSourceHashChanged(
  installedHash: string | undefined,
  sourceHash: string | undefined,
): boolean {
  const installed = normalizeShareContentHash(installedHash);
  const source = normalizeShareContentHash(sourceHash);
  if (!installed || !source) return false;
  return installed !== source;
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A shared skill's display names as the install receipt records them: the
 * owning organization (a team's organization for a team share), the team,
 * and the sharer. A personal owner is never named as an organization.
 */
export function sharedSkillDisplayNames(
  detail: Pick<SharedSkillSummary, 'owner' | 'createdBy'>,
): InstalledShareDisplayNames {
  const { owner } = detail;
  const ownerName = present(
    owner.type === 'team'
      ? owner.organization.name
      : owner.type === 'organization'
        ? owner.name
        : undefined,
  );
  const teamName = present(owner.type === 'team' ? owner.name : undefined);
  const sharedByName = present(detail.createdBy?.name);
  return {
    ...(ownerName ? { ownerName } : {}),
    ...(teamName ? { teamName } : {}),
    ...(sharedByName ? { sharedByName } : {}),
  };
}

function SourceLink({ source }: { source: InstalledShareSource }): JSX.Element {
  const className =
    'focus-ring rounded-sm fg-accent underline-offset-2 hover:underline';
  if (source.kind === 'action') {
    return (
      <button
        type="button"
        className={className}
        data-testid="installed-share-source-link"
        onClick={source.onSelect}
      >
        {VIEW_SHARED_SKILL_LABEL}
      </button>
    );
  }
  const { onNavigate } = source;
  return (
    <a
      href={source.href}
      className={className}
      data-testid="installed-share-source-link"
      onClick={
        onNavigate
          ? (event: MouseEvent<HTMLAnchorElement>): void => {
              // Modified clicks keep the browser's new-tab behavior.
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onNavigate();
            }
          : undefined
      }
    >
      {VIEW_SHARED_SKILL_LABEL}
    </a>
  );
}

/**
 * Where a receipted shared install came from and how it relates to its
 * source (CAN-5018), on every host: `From {organization}`, `Team: {team}`,
 * `Shared by {person}`, `One-time copy` and, when a live check found a
 * changed source, `Update available`. Unknown names are left out. Names are
 * session-replay blocked.
 */
export function installedShareProvenance(
  origin: SharedSkillInstallOrigin,
  options: InstalledShareProvenanceOptions = {},
): InstalledShareProvenance {
  const names = options.names ?? origin;
  const ownerName = present(names.ownerName);
  const teamName = present(names.teamName);
  const sharedByName = present(names.sharedByName);
  const name = (text: string): JSX.Element => (
    <span className={REPLAY_BLOCK_CLASS}>{text}</span>
  );
  const facts: ReactNode[] = [];
  if (ownerName)
    facts.push(
      <span key="owner" data-testid="installed-share-owner">
        From {name(ownerName)}
      </span>,
    );
  if (teamName)
    facts.push(
      <span key="team" data-testid="installed-share-team">
        Team: {name(teamName)}
      </span>,
    );
  if (sharedByName)
    facts.push(
      <span key="sharer" data-testid="installed-share-sharer">
        {SHARE_ATTRIBUTION_SHARER_PREFIX}
        {name(sharedByName)}
      </span>,
    );
  facts.push(
    <span key="copy" data-testid="installed-share-copy">
      {INSTALLED_SHARE_COPY_LABEL}
    </span>,
  );
  if (options.updateAvailable)
    facts.push(
      <span key="update" data-testid="installed-share-update-available">
        {INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL}
      </span>,
    );
  return {
    facts,
    sourceLink: options.source ? (
      <SourceLink key="source" source={options.source} />
    ) : null,
  };
}
