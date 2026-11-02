import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import {
  compatibleRemoteVersions,
  currentRemoteVersion,
  describeHostVersionMismatch,
  describeLegacyControllerRefusal,
} from '../protocol-version';
import { REMOTE_PROTOCOL_VERSION } from '../remote-protocol';
import { TEST_VERSION } from './host-fakes';

const NEXT_PROTOCOL = {
  protocolVersion: TEST_VERSION.protocolVersion + 1,
  appVersion: '1.2.0',
};

describe('remote protocol version', () => {
  it('is compatible on the same protocol, whatever the app version', () => {
    expect(
      compatibleRemoteVersions(TEST_VERSION, {
        ...TEST_VERSION,
        appVersion: '9.9.9',
      }),
    ).toBe(true);
    expect(compatibleRemoteVersions(TEST_VERSION, NEXT_PROTOCOL)).toBe(false);
  });

  it('names the computer to update', () => {
    expect(
      describeHostVersionMismatch(
        'Studio',
        '1.2.0',
        NEXT_PROTOCOL,
        TEST_VERSION,
      ),
    ).toBe(
      "Studio runs version 1.2.0, which this computer (version 1.0.0) can't control. Update this computer to connect.",
    );
    expect(
      describeHostVersionMismatch(
        'Studio',
        '1.0.0',
        TEST_VERSION,
        NEXT_PROTOCOL,
      ),
    ).toBe(
      "Studio runs version 1.0.0, which this computer (version 1.2.0) can't control. Update Studio to connect.",
    );
    expect(
      describeHostVersionMismatch('Studio', '0.9.0', null, TEST_VERSION),
    ).toBe(
      "Studio runs version 0.9.0, which this computer (version 1.0.0) can't control. Update Studio to connect.",
    );
    expect(describeLegacyControllerRefusal('Studio', TEST_VERSION)).toBe(
      "Studio runs version 1.0.0, which this computer can't control. Update this computer to connect.",
    );
  });

  it('takes the E2E protocol override only in E2E builds', () => {
    const env = { CANOPY_E2E_REMOTE_PROTOCOL_VERSION: ' 7 ' };
    expect(currentRemoteVersion('1.0.0', env, false)).toEqual({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      appVersion: '1.0.0',
    });
    expect(currentRemoteVersion('1.0.0', env, true).protocolVersion).toBe(7);
    for (const value of ['', '0', '-1', '1.5', 'abc']) {
      expect(
        currentRemoteVersion(
          '1.0.0',
          { CANOPY_E2E_REMOTE_PROTOCOL_VERSION: value },
          true,
        ).protocolVersion,
      ).toBe(REMOTE_PROTOCOL_VERSION);
    }
  });
});

it.each([
  'get-state',
  'dismiss',
  'snooze',
  'restore',
  'set-provider-not-used',
  'mark-item-complete',
  'changed',
])('blocks the retired checklist %s channel', (suffix) => {
  expect(getRemoteChannelDisposition(`onboarding-checklist:${suffix}`)).toBe(
    'blocked',
  );
});
