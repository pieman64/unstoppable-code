/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';
import type { InstalledItemSnapshot } from '@canopy/protocol/installed-items';
import { useDesktopInstalledItemStatuses } from '../useDesktopInstalledItemStatuses';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): JSX.Element {
  useDesktopInstalledItemStatuses();
  return <></>;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

test('rereads status when a preferences save syncs, not only on change events', async () => {
  const snapshot: InstalledItemSnapshot = { items: [] };
  const listStatus = jest.fn().mockResolvedValue(snapshot);
  let synced: ((preferences: PreferencesSaveResult) => void) | undefined;
  Object.defineProperty(window, 'installedItems', {
    configurable: true,
    value: {
      listStatus,
      setStatus: jest.fn(),
      uninstall: jest.fn(),
      onChanged: (): (() => void) => (): void => undefined,
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onPreferencesChanged: (): (() => void) => (): void => undefined,
      onPreferencesSynced: (
        callback: (preferences: PreferencesSaveResult) => void,
      ): (() => void) => {
        synced = callback;
        return (): void => undefined;
      },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  await flush();
  expect(listStatus).toHaveBeenCalledTimes(1);

  // A plain savePreferences (for example, new global selections) only
  // broadcasts the synced preferences.
  act(() => synced?.({} as PreferencesSaveResult));
  await flush();
  expect(listStatus).toHaveBeenCalledTimes(2);

  act(() => root.unmount());
  Reflect.deleteProperty(window, 'api');
  Reflect.deleteProperty(window, 'installedItems');
});
