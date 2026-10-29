import { CanopyAppDriver } from '../canopyApp.mjs';
import { launchCanopy, closeCanopy } from '../launchCanopy.mjs';
import { seedWelcomeChecklist } from './seedWelcomeChecklist.mjs';
import { connectMockCloudAccount } from './connectMockCloudAccount.mjs';

/**
 * Real mobile eligibility bridge backed by the suite's account/device fixtures.
 * @param {{ activated?: boolean, pendingEntry?: string }} [options]
 */
export async function launchMobileOnboarding({
  activated = false,
  pendingEntry,
} = {}) {
  const launch = await launchCanopy({
    userDataDir: seedWelcomeChecklist({ pendingEntry }),
  });
  try {
    const window = await launch.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await connectMockCloudAccount(
      window,
      activated ? 'csk_mobile_activation_e2e' : 'csk_mobile_promo_eligible_e2e',
    );
    await window.getByTestId('sidebar-create-task').click();
    return { ...launch, window, app };
  } catch (error) {
    await closeCanopy(launch.electronApp, launch.userDataDir);
    throw error;
  }
}
