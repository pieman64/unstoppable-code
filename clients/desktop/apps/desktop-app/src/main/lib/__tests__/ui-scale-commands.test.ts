import type { PreferencesData } from '@canopy/desktop-shared/types';
import type * as PreferencesStore from '../preferences-store';
import {
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type UiScaleAdjustment,
} from '@canopy/desktop-shared/lib/ui-scale';

jest.mock('../preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStore>(
    '../preferences-store',
  );
  return {
    ...actual,
    updatePreferencesFileWithPrevious: jest.fn(),
  };
});
jest.mock('../preferences-broadcast', () => ({
  broadcastPreferencesSynced: jest.fn(),
}));
jest.mock('../ui-zoom', () => ({
  applyUiZoomToAllWindows: jest.fn(),
  uiScaleToZoomFactor: jest.fn((scale: number) => scale / 100),
}));

import {
  DEFAULT_PREFERENCES,
  updatePreferencesFileWithPrevious,
} from '../preferences-store';
import { broadcastPreferencesSynced } from '../preferences-broadcast';
import { applyUiZoomToAllWindows } from '../ui-zoom';
import { applyUiScaleCommand } from '../ui-scale-commands';

const updateMock = jest.mocked(updatePreferencesFileWithPrevious);
const broadcastMock = jest.mocked(broadcastPreferencesSynced);
const applyZoomMock = jest.mocked(applyUiZoomToAllWindows);

function preferencesAt(uiScale: number): PreferencesData {
  return { ...DEFAULT_PREFERENCES, uiScale };
}

/**
 * Runs one command against a store sitting at `uiScale`, committing whatever
 * the updater asks for, and reports what the updater returned.
 */
async function runCommand(
  uiScale: number,
  adjustment: UiScaleAdjustment,
): Promise<{ patch: Partial<PreferencesData> | null; committed: number }> {
  const current = preferencesAt(uiScale);
  let patch: Partial<PreferencesData> | null = null;
  updateMock.mockImplementation((updater) => {
    patch = updater(current);
    return Promise.resolve({
      previous: current,
      next: preferencesAt(patch?.uiScale ?? uiScale),
    });
  });
  const committed = await applyUiScaleCommand(adjustment);
  return { patch, committed };
}

describe('applyUiScaleCommand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('commits, zooms and broadcasts when the scale moves', async () => {
    const { patch, committed } = await runCommand(100, 'in');

    expect(patch).toEqual({ uiScale: 105 });
    expect(committed).toBe(105);
    expect(applyZoomMock).toHaveBeenCalledWith(1.05);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zoom in at the ceiling', UI_SCALE_MAX, 'in'],
    ['zoom out at the floor', UI_SCALE_MIN, 'out'],
    ['actual size at 100%', 100, 'actual-size'],
  ] as const)('writes nothing for %s', async (_label, uiScale, adjustment) => {
    const { patch, committed } = await runCommand(uiScale, adjustment);

    // Returning null is what skips the durable preferences write and its
    // last-good backup. A guard applied only after the write lands would
    // still cost a file write per keypress, and a held shortcut at the end
    // of the range would queue those ahead of unrelated preference saves.
    expect(patch).toBeNull();
    expect(committed).toBe(uiScale);
    expect(applyZoomMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
