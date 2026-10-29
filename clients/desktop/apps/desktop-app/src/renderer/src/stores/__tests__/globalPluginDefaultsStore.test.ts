/**
 * @jest-environment jsdom
 */
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { emptyPluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { makeTestPreferences } from '../../test-utils/preferences';
import { useGlobalPluginDefaultsStore } from '../globalPluginDefaultsStore';

const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();

beforeEach(() => {
  loadPreferencesMock.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: loadPreferencesMock,
    },
  });
  useGlobalPluginDefaultsStore.setState({
    selections: emptyPluginSelections(),
    hydrated: false,
    loadInFlight: false,
  });
});

describe('globalPluginDefaultsStore', () => {
  it('hydrates from an existing startup snapshot without loading preferences again', async () => {
    const globalPluginSelections = {
      collectionIds: ['startup-global'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    await expect(
      useGlobalPluginDefaultsStore
        .getState()
        .hydrate(makeTestPreferences({ globalPluginSelections })),
    ).resolves.toBe(true);

    expect(loadPreferencesMock).not.toHaveBeenCalled();
    expect(useGlobalPluginDefaultsStore.getState()).toEqual(
      expect.objectContaining({
        selections: globalPluginSelections,
        hydrated: true,
        loadInFlight: false,
      }),
    );
  });

  it('returns failure and allows the next hydration attempt to retry', async () => {
    const globalPluginSelections = {
      collectionIds: ['global'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    loadPreferencesMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        globalPluginSelections,
      } as PreferencesData);

    await expect(
      useGlobalPluginDefaultsStore.getState().hydrate(),
    ).resolves.toBe(false);
    expect(useGlobalPluginDefaultsStore.getState().hydrated).toBe(false);

    await expect(
      useGlobalPluginDefaultsStore.getState().hydrate(),
    ).resolves.toBe(true);
    expect(loadPreferencesMock).toHaveBeenCalledTimes(2);
    expect(useGlobalPluginDefaultsStore.getState()).toEqual(
      expect.objectContaining({
        selections: globalPluginSelections,
        hydrated: true,
        loadInFlight: false,
      }),
    );
  });

  it('shares an in-flight hydration request between callers', async () => {
    let resolvePreferences!: (preferences: PreferencesData) => void;
    loadPreferencesMock.mockReturnValue(
      new Promise<PreferencesData>((resolve) => {
        resolvePreferences = resolve;
      }),
    );

    const first = useGlobalPluginDefaultsStore.getState().hydrate();
    const second = useGlobalPluginDefaultsStore.getState().hydrate();

    expect(second).toBe(first);
    expect(loadPreferencesMock).toHaveBeenCalledTimes(1);
    resolvePreferences({} as PreferencesData);
    await expect(first).resolves.toBe(true);
  });
});
