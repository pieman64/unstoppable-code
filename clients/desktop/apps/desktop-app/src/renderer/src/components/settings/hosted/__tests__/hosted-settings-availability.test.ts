/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { createFakeSettingsClient } from '@canopy/ui-app/settings/__tests__/helpers/test-settings-host';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  hostedSettingsOpenable,
  useHostedSettingsAvailable,
  useHostedSettingsClient,
} from '../hosted-settings-availability';

let mockClient: AccountOrganizationSettingsClient | null = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient:
    (): AccountOrganizationSettingsClient | null => mockClient,
}));

let mockFlagOn = true;
jest.mock('@/stores/featureFlagsStore', () => {
  const state = {
    isEnabled: (key: string): boolean =>
      mockFlagOn && key === 'canopy-desktop-hosted-settings',
  };
  return {
    useFeatureFlagsStore: Object.assign(
      (selector: (current: typeof state) => boolean): boolean =>
        selector(state),
      { getState: (): typeof state => state },
    ),
  };
});

interface Signals {
  readonly client: AccountOrganizationSettingsClient | null;
  readonly available: boolean;
  readonly openable: boolean;
}

/** The three signals the overlay, tabs and destination helpers read. */
function readSignals(): Signals {
  const seen: { current: Omit<Signals, 'openable'> | null } = {
    current: null,
  };
  function Probe(): JSX.Element | null {
    seen.current = {
      client: useHostedSettingsClient(),
      available: useHostedSettingsAvailable(),
    };
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  if (seen.current === null) throw new Error('Probe did not render');
  return { ...seen.current, openable: hostedSettingsOpenable() };
}

const fakeClient = createFakeSettingsClient();

beforeEach(() => {
  mockFlagOn = true;
  mockClient = fakeClient;
  useRemoteControlStore.setState({ context: { mode: 'local' } });
});

describe('hosted settings availability', () => {
  it('is available with the flag on, a registered client and a local window', () => {
    expect(readSignals()).toEqual({
      client: fakeClient,
      available: true,
      openable: true,
    });
  });

  it('is unavailable with the flag on but no registered client', () => {
    mockClient = null;
    expect(readSignals()).toEqual({
      client: null,
      available: false,
      openable: false,
    });
  });

  it('is unavailable in a remote-control window', () => {
    useRemoteControlStore.setState({
      context: {
        mode: 'remote',
        deviceId: 'device-1',
        name: 'Studio desktop',
        platform: 'linux',
      },
    });
    expect(readSignals()).toEqual({
      client: null,
      available: false,
      openable: false,
    });
  });

  it('is unavailable with the flag off', () => {
    mockFlagOn = false;
    expect(readSignals()).toEqual({
      client: null,
      available: false,
      openable: false,
    });
  });
});
