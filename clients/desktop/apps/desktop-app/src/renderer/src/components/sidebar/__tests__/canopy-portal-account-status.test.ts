import type { CanopyPortalState } from '@canopy/desktop-shared/types';
import { resolveCanopyPortalAccountStatus } from '../canopy-portal-account-status';

function defaultState(): CanopyPortalState {
  return {
    status: 'disabled',
    connectionStatus: 'inactive',
    sessionId: null,
    pairingCode: null,
    pairingCodeExpiresAt: null,
    machineName: null,
    hostCode: null,
    activatedAt: null,
    lastSeenAt: null,
    lastErrorAt: null,
    error: null,
  };
}

function state(partial: Partial<CanopyPortalState>): CanopyPortalState {
  return { ...defaultState(), ...partial };
}

// Field values shared with the CAN-3659 Electron spec's PORTAL_STATES.
const ACTIVE = state({
  status: 'active',
  connectionStatus: 'active',
  sessionId: 'portal-session-can-3659',
  machineName: 'Test Mac',
  activatedAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-01T10:05:00.000Z',
});
const RECONNECTING = state({
  status: 'reconnecting',
  connectionStatus: 'reconnecting',
  sessionId: 'portal-session-can-3659',
  machineName: 'Test Mac',
  activatedAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-01T10:05:00.000Z',
});
// The worker's server-ended teardown clears the timestamps but keeps
// `status: 'inactive'` so the user learns the session is gone.
const DISCONNECTED = state({
  status: 'inactive',
  connectionStatus: 'inactive',
  machineName: 'Test Mac',
  lastErrorAt: '2026-10-01T10:06:00.000Z',
  error: 'Remote Control session ended on the server.',
});

describe('resolveCanopyPortalAccountStatus', () => {
  it('reports an active session', () => {
    expect(resolveCanopyPortalAccountStatus(ACTIVE, true)).toBe('active');
  });

  it('reports a reconnecting session', () => {
    expect(resolveCanopyPortalAccountStatus(RECONNECTING, true)).toBe(
      'reconnecting',
    );
  });

  it('reports a session that connected and then failed', () => {
    expect(
      resolveCanopyPortalAccountStatus(
        state({
          status: 'error',
          connectionStatus: 'ended',
          activatedAt: '2026-10-01T10:00:00.000Z',
          lastSeenAt: '2026-10-01T10:05:00.000Z',
        }),
        true,
      ),
    ).toBe('disconnected');
  });

  it('reads the never-paired default state as off', () => {
    // The store and the main-process worker both start here, and the worker
    // stays here until the user starts Remote Control.
    expect(resolveCanopyPortalAccountStatus(defaultState(), true)).toBeNull();
  });

  it('reports a session the server ended as disconnected', () => {
    expect(resolveCanopyPortalAccountStatus(DISCONNECTED, true)).toBe(
      'disconnected',
    );
  });

  it('reads a pending pairing as off', () => {
    expect(
      resolveCanopyPortalAccountStatus(
        state({ status: 'pending_auth', connectionStatus: 'pending' }),
        true,
      ),
    ).toBeNull();
  });

  it('reads a start that never connected and then failed as off', () => {
    expect(
      resolveCanopyPortalAccountStatus(
        state({ status: 'error', connectionStatus: 'ended' }),
        true,
      ),
    ).toBeNull();
  });

  it('ignores a stale snapshot once the flag is off', () => {
    expect(resolveCanopyPortalAccountStatus(ACTIVE, false)).toBeNull();
    expect(resolveCanopyPortalAccountStatus(DISCONNECTED, false)).toBeNull();
  });
});
