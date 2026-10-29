'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareAudience } from '@canopy/protocol/sharing';

/**
 * Fallback preference when nothing is selected or the selected audience
 * becomes unavailable. Public is deliberately absent: while Team or
 * Organization is usable, a public share takes an explicit click. It is
 * selected on the author's behalf only when it is the one usable audience.
 */
const FALLBACK_ORDER: readonly ShareAudience[] = ['team', 'organization'];

/** The audiences an author can pick; `private` is only a storage value. */
const SELECTABLE_AUDIENCES: readonly ShareAudience[] = [
  'team',
  'organization',
  'public',
];

export interface UseShareAudienceOptions {
  /** Audiences the resource offers. */
  offered: readonly ShareAudience[];
  /** `false` marks an offered audience the account cannot use right now. */
  availability: Partial<Record<ShareAudience, boolean>>;
  /**
   * Preselected audience, e.g. the audience of an existing share. `private`
   * is ignored like any audience that is not offered: it is a storage value,
   * not something an author can pick.
   */
  initial?: ShareAudience;
  /**
   * False while availability is not yet known (the account is still loading).
   * The fallback waits for it, so an existing Team share is not knocked off
   * its audience before the account's capabilities arrive.
   */
  ready?: boolean;
}

export interface UseShareAudienceResult {
  /** The selected audience, or `null` when no offered audience is usable. */
  audience: ShareAudience | null;
  setAudience: (next: ShareAudience) => void;
}

function isUsable(
  audience: ShareAudience | null,
  offered: readonly ShareAudience[],
  availability: Partial<Record<ShareAudience, boolean>>,
): audience is ShareAudience {
  return (
    audience !== null &&
    audience !== 'private' &&
    offered.includes(audience) &&
    availability[audience] !== false
  );
}

function acceptsInitial(
  offered: readonly ShareAudience[],
  initial: ShareAudience | undefined,
): initial is ShareAudience {
  return (
    initial !== undefined && initial !== 'private' && offered.includes(initial)
  );
}

/**
 * A resource that offers exactly one audience (a plugin: Public) shows no
 * selector, so that audience is the share itself, not a choice to make.
 */
function soleAudience(offered: readonly ShareAudience[]): ShareAudience | null {
  const selectable = offered.filter((audience) => audience !== 'private');
  return selectable.length === 1 ? (selectable[0] ?? null) : null;
}

/** The single offered audience the account can use, if exactly one. */
function onlyUsableAudience(
  offered: readonly ShareAudience[],
  availability: Partial<Record<ShareAudience, boolean>>,
): ShareAudience | null {
  const usable = SELECTABLE_AUDIENCES.filter((audience) =>
    isUsable(audience, offered, availability),
  );
  return usable.length === 1 ? (usable[0] ?? null) : null;
}

function pickInitial(
  offered: readonly ShareAudience[],
  initial: ShareAudience | undefined,
  availability: Partial<Record<ShareAudience, boolean>>,
  ready: boolean,
): ShareAudience | null {
  if (acceptsInitial(offered, initial)) return initial;
  const fallback = FALLBACK_ORDER.find((audience) =>
    isUsable(audience, offered, availability),
  );
  if (fallback) return fallback;
  // Before availability is known, a host may report Team and Organization as
  // unavailable only because the account has not loaded. Settling on the one
  // "usable" audience then would stick, since the fallback keeps any usable
  // selection, so that choice waits for `ready`.
  const only = ready ? onlyUsableAudience(offered, availability) : null;
  if (only) return only;
  return (
    FALLBACK_ORDER.find((audience) => offered.includes(audience)) ??
    soleAudience(offered)
  );
}

/**
 * Scope state for the share dialog: the selected audience, and the fallback
 * when a capability or membership disappears. The fallback prefers Team, then
 * Organization. When neither is usable and exactly one offered audience is
 * (typically Public for an account with no organization), that one is
 * selected: a selector with one enabled option and nothing picked leaves
 * Share disabled for a reason nobody can see. Otherwise the selection clears.
 */
export function useShareAudience({
  offered,
  availability,
  initial,
  ready = true,
}: UseShareAudienceOptions): UseShareAudienceResult {
  const [audience, setAudienceState] = useState<ShareAudience | null>(() =>
    pickInitial(offered, initial, availability, ready),
  );
  const previousInitial = useRef(initial);

  // One primitive per audience keeps the fallback effect's dependencies
  // stable across renders that pass fresh `offered`/`availability` objects.
  const offersTeam = offered.includes('team');
  const offersOrganization = offered.includes('organization');
  const offersPublic = offered.includes('public');
  const teamAvailable = availability.team;
  const organizationAvailable = availability.organization;
  const publicAvailable = availability.public;

  useEffect(() => {
    if (previousInitial.current === initial) return;
    previousInitial.current = initial;
    if (acceptsInitial(offered, initial)) {
      setAudienceState(initial);
    }
  }, [initial, offered]);

  useEffect(() => {
    if (!ready) return;
    const offeredList = SELECTABLE_AUDIENCES.filter(
      (candidate) =>
        (candidate === 'team' && offersTeam) ||
        (candidate === 'organization' && offersOrganization) ||
        (candidate === 'public' && offersPublic),
    );
    const current: Partial<Record<ShareAudience, boolean>> = {
      ...(teamAvailable !== undefined ? { team: teamAvailable } : {}),
      ...(organizationAvailable !== undefined
        ? { organization: organizationAvailable }
        : {}),
      ...(publicAvailable !== undefined ? { public: publicAvailable } : {}),
    };
    setAudienceState((selected) => {
      if (isUsable(selected, offeredList, current)) return selected;
      const sole = soleAudience(offeredList);
      return (
        FALLBACK_ORDER.find((candidate) =>
          isUsable(candidate, offeredList, current),
        ) ??
        (isUsable(sole, offeredList, current) ? sole : null) ??
        onlyUsableAudience(offeredList, current)
      );
    });
  }, [
    offersOrganization,
    offersPublic,
    offersTeam,
    organizationAvailable,
    publicAvailable,
    ready,
    teamAvailable,
  ]);

  const setAudience = useCallback((next: ShareAudience): void => {
    setAudienceState(next);
  }, []);

  return { audience, setAudience };
}
