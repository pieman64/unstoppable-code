import type {
  AgentProviderType,
  ChatModel,
} from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
  isOrgGatewayRoute,
} from '@canopy/desktop-shared/lib/gateway-model-availability';
import {
  resolveModelPickerRowCue,
  type ModelPickerRowCue,
  type ModelPickerRowFact,
} from '@canopy/ui-shared';
import type { BillingFramework } from '@/lib/chatBillingFramework';
import { getProviderLabel } from '@/lib/providerLabels';
import type { LockedModelLibraryAccess } from '@/lib/modelLibraryAccess';
import {
  isGuestAllowedSelection,
  type VisibleModelRowGate,
} from '@/lib/modelPickerRowGate';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';

/**
 * CAN-5213 — the desktop adapter for the shared picker row cue.
 *
 * Translates a row's gate and the provider, credit, and daily-credit reads
 * into the portable facts `resolveModelPickerRowCue` decides on. It reads the
 * gate; it never changes it, so selection and recovery stay exactly where
 * `resolveModelRowGate` puts them.
 */
export interface DesktopModelRowCueInput {
  /** The model the row runs, after any harness mapping. */
  readonly model: ChatModel;
  readonly provider: AgentProviderType;
  readonly agent: boolean;
  readonly gate: VisibleModelRowGate;
  /** `resolveModelLibraryLock(isGuest, libraryAccess)` for the work owner. */
  readonly viewerLock: LockedModelLibraryAccess | undefined;
  /** Undefined on config surfaces, which get no live cues. */
  readonly availability: ProviderModelAvailability | undefined;
  readonly billingValue: BillingFramework | undefined;
  /** The row is the credits route of a native model (harness credits rows). */
  readonly requireCredits: boolean;
}

export type DesktopModelRowCue =
  | ModelPickerRowCue
  /**
   * A model the library does not admit, on a credits route the viewer cannot
   * fund yet. The gate asks for a billing source; the row names the library
   * step instead, because credits alone would never unlock it.
   */
  | {
      readonly kind: 'library-lock';
      readonly access: LockedModelLibraryAccess;
    };

function fact(value: boolean): ModelPickerRowFact {
  return value ? 'yes' : 'no';
}

export function resolveDesktopModelRowCue(
  input: DesktopModelRowCueInput,
): DesktopModelRowCue | undefined {
  const {
    model,
    provider,
    agent,
    gate,
    viewerLock,
    availability,
    billingValue,
    requireCredits,
  } = input;
  if (agent || availability === undefined || viewerLock === undefined)
    return undefined;
  // Organization gateway traffic is billed under the organization's contract.
  if (isOrgGatewayRoute(model)) return undefined;
  const creditsOnly = isGatewayOnlyModel(model) || requireCredits;
  // Only routes these reads describe: local and account-managed harnesses
  // carry no credits or library facts.
  if (!creditsOnly && provider !== 'claude' && provider !== 'codex')
    return undefined;

  const creditsSettled =
    !(availability.creditsLoading ?? availability.loading) &&
    availability.creditsInconclusive !== true;
  const routeSettled = creditsOnly
    ? creditsSettled
    : !availability.loading && creditsSettled;
  const routable = isGatewayRoutableModel(model);
  const nativeRoute =
    !creditsOnly && billingValue !== 'ai-credits' && availability.nativeAuth;
  const creditsRoute: ModelPickerRowFact = !routeSettled
    ? 'unknown'
    : fact(!nativeRoute && routable);
  const creditsSufficient: ModelPickerRowFact = creditsSettled
    ? fact(availability.creditsEligible)
    : 'unknown';
  const admitted = isGuestAllowedSelection(model);

  if (
    gate.kind === 'recoverable' &&
    gate.recovery.kind === 'needs-billing-source' &&
    creditsRoute === 'yes' &&
    !admitted
  )
    return { kind: 'library-lock', access: viewerLock };

  const usableNow: ModelPickerRowFact = !routeSettled
    ? 'unknown'
    : fact(
        gate.kind === 'available' &&
          (nativeRoute ||
            (creditsRoute === 'yes' &&
              creditsSufficient === 'yes' &&
              admitted)),
      );
  const dailyCreditsOn: ModelPickerRowFact =
    !creditsSettled || availability.dailyCreditsEnabled === undefined
      ? 'unknown'
      : fact(availability.dailyCreditsEnabled);
  const dailyCreditsRecoverySupported =
    admitted &&
    gate.kind === 'recoverable' &&
    (gate.recovery.kind === 'needs-credits' ||
      (gate.recovery.kind === 'needs-billing-source' && routable));

  // The modal's sign-in, offered whenever the gate asks for a billing source.
  const providerSignInLabel =
    gate.kind === 'recoverable' && gate.recovery.kind === 'needs-billing-source'
      ? getProviderLabel(gate.recovery.provider)
      : undefined;

  return resolveModelPickerRowCue({
    rowKind: 'model',
    viewerAccess: viewerLock,
    hardDisabled: gate.kind === 'hard-disabled',
    libraryLocked:
      gate.kind === 'recoverable' &&
      (gate.recovery.kind === 'needs-account' ||
        gate.recovery.kind === 'needs-purchase'),
    usableNow,
    creditsRoute,
    creditsSufficient,
    dailyCreditsOn,
    dailyCreditsRecoverySupported,
    providerSignInLabel,
  });
}
