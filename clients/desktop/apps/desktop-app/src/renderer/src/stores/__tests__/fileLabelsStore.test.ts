import type { CanopyApi } from '@canopy/desktop-shared/types';
import {
  BUILTIN_FILE_LABELS,
  mergeFileLabelsWithBuiltins,
} from '@canopy/desktop-shared/file-labels';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const mockSavePreferences = jest.fn().mockResolvedValue(undefined);
const mockLoadPreferences = jest.fn();

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        savePreferences: mockSavePreferences,
        loadPreferences: mockLoadPreferences,
      },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('fileLabelsStore', () => {
  beforeEach(() => {
    mockSavePreferences.mockClear();
    mockLoadPreferences.mockReset();
    useFileLabelsStore.setState({
      labels: mergeFileLabelsWithBuiltins([]),
      labelsVersion: useFileLabelsStore.getState().labelsVersion + 1,
      hiddenLabelIds: [],
      labelsSectionExpandRequest: 0,
      labelsSectionExpandConsumed: 0,
    });
  });

  it('seeds the merged builtin buckets before any load', () => {
    expect(useFileLabelsStore.getState().labels.map((b) => b.id)).toEqual(
      BUILTIN_FILE_LABELS.map((b) => b.id),
    );
  });

  it('classifyPath classifies with the current labels and caches per version', () => {
    const { classifyPath } = useFileLabelsStore.getState();
    expect(classifyPath('docs/guide.md')).toEqual(['documentation']);
    // Cached identity for repeat lookups.
    expect(classifyPath('docs/guide.md')).toBe(classifyPath('docs/guide.md'));
  });

  it('setLabels re-merges with builtins and invalidates classification', () => {
    const disabledDocs = mergeFileLabelsWithBuiltins([]).map((b) =>
      b.id === 'documentation' ? { ...b, enabled: false } : b,
    );
    useFileLabelsStore.getState().setLabels(disabledDocs);
    expect(useFileLabelsStore.getState().classifyPath('docs/guide.md')).toEqual(
      [],
    );
    const docs = useFileLabelsStore
      .getState()
      .labels.find((b) => b.id === 'documentation');
    expect(docs?.enabled).toBe(false);
    // Seeded name survives the round-trip merge.
    expect(docs?.name).toBe('Documentation');
  });

  it('setHiddenLabelIds updates state and persists the preference', () => {
    useFileLabelsStore.getState().setHiddenLabelIds(['tests', 'other']);
    expect(useFileLabelsStore.getState().hiddenLabelIds).toEqual([
      'tests',
      'other',
    ]);
    expect(mockSavePreferences).toHaveBeenCalledWith({
      changedFilesHiddenLabelIds: ['tests', 'other'],
    });
  });

  it('consumes each Labels-section expansion request once', () => {
    const store = useFileLabelsStore.getState();
    expect(store.consumeLabelsSectionExpandRequest()).toBe(false);

    store.requestLabelsSectionExpand();
    expect(
      useFileLabelsStore.getState().consumeLabelsSectionExpandRequest(),
    ).toBe(true);
    expect(
      useFileLabelsStore.getState().consumeLabelsSectionExpandRequest(),
    ).toBe(false);

    useFileLabelsStore.getState().requestLabelsSectionExpand();
    expect(
      useFileLabelsStore.getState().consumeLabelsSectionExpandRequest(),
    ).toBe(true);
  });

  it('loadFileLabels hydrates labels and hidden ids from preferences', async () => {
    mockLoadPreferences.mockResolvedValue({
      fileLabels: mergeFileLabelsWithBuiltins([]).map((b) =>
        b.id === 'tests' ? { ...b, enabled: false } : b,
      ),
      changedFilesHiddenLabelIds: ['assets'],
    });
    await useFileLabelsStore.getState().loadFileLabels();
    expect(
      useFileLabelsStore.getState().labels.find((b) => b.id === 'tests')
        ?.enabled,
    ).toBe(false);
    expect(useFileLabelsStore.getState().hiddenLabelIds).toEqual(['assets']);
  });

  it('loadFileLabels keeps defaults when preferences are unavailable', async () => {
    mockLoadPreferences.mockRejectedValue(new Error('nope'));
    await useFileLabelsStore.getState().loadFileLabels();
    expect(useFileLabelsStore.getState().labels.map((b) => b.id)).toEqual(
      BUILTIN_FILE_LABELS.map((b) => b.id),
    );
  });
});
