import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { openLegacyPublicOwnerShare } from './legacy-public-owner-fixture.mjs';

test('an explicit Public update normalizes a legacy scoped Agent owner', async () => {
  const { electronApp, modal, userDataDir } =
    await openLegacyPublicOwnerShare();
  try {
    await modal.getByTestId('share-agent-submit').click();
    await expect(modal).toHaveCount(0);
    const requests = await electronApp.evaluate(
      () => globalThis.__legacyPublicOwnerRequests,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ shareScope: 'private' });
    expect(requests[0].revokePublicShare).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
