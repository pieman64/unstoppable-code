/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  OsNotificationPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { NotificationsTab } from '../NotificationsTab';

jest.mock('../CloudDigestSettings', () => ({
  CloudDigestSettings: (): null => null,
}));

const MACOS_SOUNDS = [
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
];

const WINDOWS_SOUNDS = ['System', 'None', 'Mail', 'Message', 'Reminder', 'SMS'];

function osPreferences(
  overrides: Partial<OsNotificationPreferences> = {},
): OsNotificationPreferences {
  return {
    enabled: true,
    skipWhenFocused: true,
    defaultSound: 'System',
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
      runComment: true,
      activation: true,
    },
    categorySounds: {
      chat: 'Default',
      script: 'Default',
      hook: 'Default',
      gitCommit: 'Default',
      gitPush: 'Default',
      prCreate: 'Default',
      pipeline: 'Default',
      terminal: 'Default',
      runComment: 'Default',
      activation: 'Default',
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function renderTab(
  platform: NodeJS.Platform,
  os: OsNotificationPreferences,
  localPlatform?: NodeJS.Platform,
): Promise<jest.Mock> {
  const savePreferences = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
  // Set only for a window that shows another computer.
  Object.defineProperty(window, 'localPlatform', {
    configurable: true,
    value: localPlatform,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest
        .fn()
        .mockResolvedValue({ osNotifications: os } as PreferencesData),
      savePreferences,
    },
  });
  await act(async () => {
    root.render(createElement(NotificationsTab));
    await Promise.resolve();
  });
  return savePreferences;
}

function optionValues(testId: string): string[] {
  const select = container.querySelector(`[data-testid="${testId}"]`);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Missing select ${testId}`);
  }
  return Array.from(select.options).map((option) => option.value);
}

function selectedValue(testId: string): string {
  const select = container.querySelector(`[data-testid="${testId}"]`);
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Missing select ${testId}`);
  }
  return select.value;
}

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

describe('NotificationsTab sound choices (CAN-3946)', () => {
  it('lists the Windows sounds and no macOS names on Windows', async () => {
    await renderTab('win32', osPreferences());

    expect(optionValues('notifications-default-sound')).toEqual(WINDOWS_SOUNDS);
    expect(optionValues('notifications-sound-chat')).toEqual([
      'Default',
      ...WINDOWS_SOUNDS,
    ]);
    for (const name of MACOS_SOUNDS) {
      expect(optionValues('notifications-default-sound')).not.toContain(name);
      expect(optionValues('notifications-sound-chat')).not.toContain(name);
    }
  });

  it('keeps the full macOS list on macOS', async () => {
    await renderTab('darwin', osPreferences());

    expect(optionValues('notifications-default-sound')).toEqual([
      'System',
      'None',
      ...MACOS_SOUNDS,
    ]);
    expect(optionValues('notifications-sound-chat')).toEqual([
      'Default',
      'System',
      'None',
      ...MACOS_SOUNDS,
    ]);
  });

  it('shows a macOS sound saved on Windows as System', async () => {
    const savePreferences = await renderTab(
      'win32',
      osPreferences({
        defaultSound: 'Bottle',
        categorySounds: { ...osPreferences().categorySounds, chat: 'Glass' },
      }),
    );

    expect(selectedValue('notifications-default-sound')).toBe('System');
    expect(selectedValue('notifications-sound-chat')).toBe('System');
    // Only the display falls back; the saved choice is left as it was.
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it("offers this computer's sounds in a window that shows another computer", async () => {
    await renderTab('win32', osPreferences({ defaultSound: 'Mail' }), 'darwin');

    expect(optionValues('notifications-default-sound')).toEqual([
      'System',
      'None',
      ...MACOS_SOUNDS,
    ]);
    expect(selectedValue('notifications-default-sound')).toBe('System');
  });

  it('shows a saved Windows sound as chosen on Windows', async () => {
    await renderTab('win32', osPreferences({ defaultSound: 'Mail' }));

    expect(selectedValue('notifications-default-sound')).toBe('Mail');
  });
});
