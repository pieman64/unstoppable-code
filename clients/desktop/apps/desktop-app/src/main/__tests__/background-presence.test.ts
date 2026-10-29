jest.mock('electron', () => ({
  Menu: { buildFromTemplate: jest.fn() },
  Tray: jest.fn(),
}));

import type { BackgroundPresenceDecision } from '../lifecycle/background-presence';
import {
  shouldCreateTray,
  shouldDiscloseCloseToTray,
  shouldQuitOnAllWindowsClosed,
} from '../lifecycle/background-presence';

describe('shouldQuitOnAllWindowsClosed', () => {
  it('never quits on macOS, whatever the preference says', () => {
    // Existing platform-convention behavior must not change.
    expect(
      shouldQuitOnAllWindowsClosed({ platform: 'darwin', closeToTray: false }),
    ).toBe(false);
    expect(
      shouldQuitOnAllWindowsClosed({ platform: 'darwin', closeToTray: true }),
    ).toBe(false);
  });

  it('quits on Windows when close-to-tray is off', () => {
    expect(
      shouldQuitOnAllWindowsClosed({ platform: 'win32', closeToTray: false }),
    ).toBe(true);
  });

  it('stays resident on Windows when close-to-tray is on', () => {
    expect(
      shouldQuitOnAllWindowsClosed({ platform: 'win32', closeToTray: true }),
    ).toBe(false);
  });

  it('keeps quitting on Linux regardless of the preference', () => {
    // Linux is deliberately excluded: the Settings toggle is Windows-gated,
    // so honouring the preference here would leave a Linux user resident with
    // no way to turn it off, and tray support varies by desktop environment.
    expect(
      shouldQuitOnAllWindowsClosed({ platform: 'linux', closeToTray: false }),
    ).toBe(true);
    expect(
      shouldQuitOnAllWindowsClosed({ platform: 'linux', closeToTray: true }),
    ).toBe(true);
  });

  it('does not create a tray on Linux', () => {
    expect(shouldCreateTray({ platform: 'linux', closeToTray: true })).toBe(
      false,
    );
  });
});

describe('shouldCreateTray', () => {
  it('does not create a tray on macOS, which reaches the app via the Dock', () => {
    expect(shouldCreateTray({ platform: 'darwin', closeToTray: true })).toBe(
      false,
    );
  });

  it('creates a tray on Windows only when close-to-tray is on', () => {
    expect(shouldCreateTray({ platform: 'win32', closeToTray: true })).toBe(
      true,
    );
    expect(shouldCreateTray({ platform: 'win32', closeToTray: false })).toBe(
      false,
    );
  });

  it('never leaves a resident Windows app without a way back to it', () => {
    // The invariant: if the app survives window close, a tray must exist.
    for (const closeToTray of [true, false]) {
      const decision: BackgroundPresenceDecision = {
        platform: 'win32',
        closeToTray,
      };
      if (!shouldQuitOnAllWindowsClosed(decision)) {
        expect(shouldCreateTray(decision)).toBe(true);
      }
    }
  });
});

describe('shouldDiscloseCloseToTray', () => {
  it('discloses once per install', () => {
    expect(shouldDiscloseCloseToTray({ disclosedAt: undefined })).toBe(true);
    expect(
      shouldDiscloseCloseToTray({ disclosedAt: '2026-01-01T00:00:00.000Z' }),
    ).toBe(false);
  });
});
