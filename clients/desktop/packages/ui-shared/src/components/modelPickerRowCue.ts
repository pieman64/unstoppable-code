import type { ModelLibraryAccess } from '@canopy/protocol/models';

/**
 * CAN-5213 — what a picker row tells a library-locked viewer before they pick
 * it: usable now, usable once free daily credits are on, or usable only after
 * a provider sign-in.
 *
 * One policy for desktop, the Portal, and cloud chats. Hosts translate their
 * own gate, provider, and credit state into these portable facts; none of
 * them interprets "Available" separately. A cue only describes existing
 * state: it never authorizes a pick, and recovery stays with the host.
 */
export const MODEL_PICKER_ROW_CUE_COPY = {
  available: 'Available',
  needsDailyCredits: 'Needs free daily credits',
  needsDailyCreditsHint: 'Turn on free daily credits to use this model.',
  needsProviderSignIn: (provider: string): string =>
    `Needs ${provider} sign-in`,
  needsProviderSignInHint: (provider: string): string =>
    `Sign in to ${provider} to use this model.`,
} as const;

/** A settled yes or no, or `unknown` while loading, after a failure, or unread. */
export type ModelPickerRowFact = 'yes' | 'no' | 'unknown';

export interface ModelPickerRowCueInput {
  /** Agent and Auto rows never carry a cue. */
  readonly rowKind: 'model' | 'agent' | 'auto';
  /**
   * The work owner's library access as the host folds it (a guest is always
   * locked). Only a locked viewer gets a cue; `unlocked` and unknown get none.
   */
  readonly viewerAccess: ModelLibraryAccess | undefined;
  /** A policy or provider restriction keeps its own disabled presentation. */
  readonly hardDisabled: boolean;
  /** The row already shows a library lock; that lock wins. */
  readonly libraryLocked: boolean;
  /**
   * Whether the row can run a new turn on its effective route right now, from
   * settled evidence. A gate's optimistic answer while a probe loads, or its
   * keep-the-current-model shortcut, is `unknown`, never `yes`.
   */
  readonly usableNow: ModelPickerRowFact;
  /** The effective route bills AI Credits (`no` for a native or org route). */
  readonly creditsRoute: ModelPickerRowFact;
  /** Spendable credits cover the row's credits route. */
  readonly creditsSufficient: ModelPickerRowFact;
  /** The viewer's free daily credits preference; only `no` offers opt-in. */
  readonly dailyCreditsOn: ModelPickerRowFact;
  /** The host's existing recovery for this row can turn daily credits on. */
  readonly dailyCreditsRecoverySupported: boolean;
  /**
   * The provider, by display name, whose sign-in the host's existing recovery
   * for this row offers. Absent when the host has no sign-in recovery.
   */
  readonly providerSignInLabel?: string;
}

export type ModelPickerRowCue =
  | { readonly kind: 'available' }
  | { readonly kind: 'needs-daily-credits' }
  /** Credits cannot run the row; only a provider sign-in can. */
  | { readonly kind: 'needs-provider-sign-in'; readonly providerLabel: string };

/**
 * The cue a row shows, or `undefined` for no new availability claim. Daily
 * credits that are on but spent, and every unknown, deliberately fall through
 * to the row's existing presentation.
 */
export function resolveModelPickerRowCue(
  input: ModelPickerRowCueInput,
): ModelPickerRowCue | undefined {
  if (input.rowKind !== 'model') return undefined;
  if (input.hardDisabled || input.libraryLocked) return undefined;
  if (input.viewerAccess === undefined || input.viewerAccess === 'unlocked')
    return undefined;
  if (input.usableNow === 'yes') return { kind: 'available' };
  if (
    input.usableNow === 'no' &&
    input.creditsRoute === 'yes' &&
    input.creditsSufficient === 'no' &&
    input.dailyCreditsOn === 'no' &&
    input.dailyCreditsRecoverySupported
  )
    return { kind: 'needs-daily-credits' };
  if (
    input.usableNow === 'no' &&
    input.creditsRoute === 'no' &&
    input.providerSignInLabel !== undefined
  )
    return {
      kind: 'needs-provider-sign-in',
      providerLabel: input.providerSignInLabel,
    };
  return undefined;
}
