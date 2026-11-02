import {
  IPC_CHANNELS,
  type CloudDailyCreditDripState,
} from '@canopy/desktop-shared/types';
import {
  parseDailyCreditDripPreferenceInput,
  type DailyCreditDripPreferenceSaveResult,
} from '@canopy/protocol/billing';
import { clearAiCreditsRoutingContextCache } from '../agents/ai-credits-routing';
import {
  loadDailyCreditDrip,
  saveDailyCreditDrip,
} from '../canopy-cloud/daily-credit-drip';
import { loadCanopyCloudAccount } from '../lib/canopy-cloud-account-store';
import {
  captureDailyCreditGrantAccount,
  recordDailyCreditGrantFromSave,
} from '../lib/daily-credit-grant-telemetry';
import { registerIpcHandler } from './register';

/**
 * Save the daily-drip choice from a renderer-supplied payload. The payload type
 * is erased at runtime, so it is re-validated with the shared strict parser and
 * anything other than exactly `{ enabled: boolean }` is rejected before an
 * authenticated PUT goes out.
 *
 * The main-process AI-credits routing cache is cleared on every save attempt,
 * both directions: its 30-second cache would otherwise keep routing as if the
 * balance had not changed (e.g. as if a freshly opted-in user had no credits).
 * Clearing after a failed save is harmless and covers a PUT that committed but
 * whose response was lost. A confirmed save also reports its grant outcome
 * (CAN-4633); every save surface reaches this handler.
 */
export async function handleSaveDailyCreditDrip(
  payload: unknown,
): Promise<DailyCreditDripPreferenceSaveResult> {
  const input = parseDailyCreditDripPreferenceInput(payload);
  if (!input) {
    throw new Error('Invalid daily free credits payload: expected { enabled }');
  }
  try {
    await loadCanopyCloudAccount();
    const grantAccount = captureDailyCreditGrantAccount();
    const result = await saveDailyCreditDrip(input);
    recordDailyCreditGrantFromSave(result, undefined, grantAccount);
    return result;
  } finally {
    clearAiCreditsRoutingContextCache();
  }
}

/**
 * Daily free-credit drip opt-in IPC. Kept out of `ipc/settings.ts` because
 * `agents/ai-credits-routing` imports that module; importing the routing cache
 * there would close a module cycle.
 */
export function registerDailyCreditDripHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.settingsLoadDailyCreditDrip,
    async (): Promise<CloudDailyCreditDripState> => loadDailyCreditDrip(),
  );

  registerIpcHandler(
    IPC_CHANNELS.settingsSaveDailyCreditDrip,
    async (
      _event,
      payload: unknown,
    ): Promise<DailyCreditDripPreferenceSaveResult> =>
      handleSaveDailyCreditDrip(payload),
  );
}
