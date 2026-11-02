import {
  applyOnboardingTipsUpdate,
  normalizeOnboardingTipDismissals,
  parseOnboardingTipsUpdate,
  type OnboardingTipDismissals,
} from '@canopy/protocol/onboarding-tips';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { broadcastCommittedPreferences } from '../../ipc/preferences';
import {
  readPreferencesFileDetailed,
  updatePreferencesFile,
} from '../../lib/preferences-store';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

/**
 * Onboarding tips on the Portal (CAN-4904): the browser reads and writes the
 * dismissals this desktop keeps in its preferences, so a tip set aside on
 * either surface stays gone on both. Payloads arrive unchecked from the
 * browser, so both handlers validate them here.
 */
export async function handlePortalOnboardingTipsGet(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Onboarding tips get requires an object payload.',
    );
    return;
  }
  try {
    const { preferences, authority } = await readPreferencesFileDetailed();
    // An unreadable file must not report "nothing dismissed": every tip would
    // come back in the browser.
    if (authority === 'unreadable') {
      context.fail(
        command,
        'execution_failed',
        'Preferences could not be read.',
      );
      return;
    }
    context.complete(command, {
      dismissed: normalizeOnboardingTipDismissals(
        preferences.onboardingTipsDismissed,
      ),
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalOnboardingTipsUpdate(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const update = parseOnboardingTipsUpdate(command.payload);
  if (update === null) {
    context.fail(command, 'invalid_payload', 'Invalid onboarding tip update.');
    return;
  }
  try {
    let dismissed: OnboardingTipDismissals = {};
    // Applied to the latest stored record inside the serialized write, so a
    // tip the desktop dismissed meanwhile is kept.
    const saved = await updatePreferencesFile((latest) => {
      dismissed = applyOnboardingTipsUpdate(
        normalizeOnboardingTipDismissals(latest.onboardingTipsDismissed),
        update,
        new Date(),
      );
      return { onboardingTipsDismissed: dismissed };
    });
    // Desktop windows refresh their tips from the synced preferences. The
    // shared save generation advances, so an older renderer save that is
    // still waiting on profile sync can't broadcast over this dismissal.
    broadcastCommittedPreferences(saved);
    context.complete(command, { dismissed });
  } catch (error) {
    failServiceError(command, context, error);
  }
}
