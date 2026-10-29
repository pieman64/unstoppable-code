/** @jest-environment jsdom */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsOperationName } from '@canopy/protocol/settings';
import {
  DigestDetailHeader,
  type DigestDetailHeaderProps,
} from '../digest-detail-header';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(
  props: DigestDetailHeaderProps,
  client: FakeSettingsClient = createFakeSettingsClient(),
): Promise<void> {
  const { host } = createTestSettingsHost({ client });
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <DigestDetailHeader {...props} />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
}

function queryTrigger(): Element | null {
  return container.querySelector('[data-testid="digest-share-trigger"]');
}

const PERSONAL_SHARE: DigestDetailHeaderProps['share'] = {
  owner: { kind: 'account' },
  digestId: 'digest-1',
  initialSharePath: '/share/digests/slug',
  initialSharingEnabled: false,
};

const ORG_SHARE: DigestDetailHeaderProps['share'] = {
  owner: { kind: 'organization', organizationId: 'org-1' },
  digestId: 'digest-1',
  initialSharePath: '/share/digests/slug',
  initialSharingEnabled: false,
};

describe('DigestDetailHeader', () => {
  it('links back to the digest list', async () => {
    await render({ backHref: '/account/digests', share: PERSONAL_SHARE });

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/account/digests');
    expect(link?.textContent).toContain('All digests');
  });

  // A member who cannot manage sharing sees no trigger at all, exactly as they
  // saw no card before.
  it('omits the share trigger when the viewer cannot manage sharing', async () => {
    await render({
      backHref: '/organization/org-1/digests',
      share: null,
    });

    expect(queryTrigger()).toBeNull();
    expect(
      container.querySelector('[data-testid="digest-share-controls"]'),
    ).toBeNull();
  });

  // The header hands the owner straight to the share control, so the personal
  // and org surfaces cannot drift apart. Assert the wiring that actually
  // distinguishes them: each owner reaches its own settings operation.
  it.each<
    [string, DigestDetailHeaderProps['share'], SettingsOperationName, unknown]
  >([
    [
      'personal',
      PERSONAL_SHARE,
      'account.digests.share.update',
      { digestId: 'digest-1', action: 'set-sharing', sharingEnabled: true },
    ],
    [
      'org',
      ORG_SHARE,
      'organization.digests.sharing.update',
      {
        organizationId: 'org-1',
        digestId: 'digest-1',
        action: 'set-sharing',
        sharingEnabled: true,
      },
    ],
  ])(
    'routes the %s share control at its own operation',
    async (_label, share, operation, input) => {
      const result = { sharePath: '/share/digests/slug', sharingEnabled: true };
      const client = createFakeSettingsClient({
        'account.digests.share.update': () => result,
        'organization.digests.sharing.update': () => result,
      });
      await render({ backHref: '/account/digests', share }, client);

      const toggle = container.querySelector(
        '[data-testid="digest-share-trigger"]',
      );
      if (!(toggle instanceof HTMLButtonElement))
        throw new Error('Missing digest-share-trigger');
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      const switchControl = document.body.querySelector(
        '[data-testid="digest-sharing-toggle"]',
      );
      if (!(switchControl instanceof HTMLButtonElement))
        throw new Error('Missing digest-sharing-toggle');
      // Sharing starts off in both fixtures, so this is the additive
      // transition and goes straight through without a confirmation.
      await act(async () => {
        switchControl.click();
        await Promise.resolve();
      });

      expect(client.calls).toEqual([{ operation, input }]);
    },
  );
});
