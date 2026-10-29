import type { CanopyApi } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const mockSavePreferences = jest.fn().mockResolvedValue(undefined);

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        savePreferences: mockSavePreferences,
      },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('projectsStore hiddenWorkspaceIds', () => {
  beforeEach(() => {
    mockSavePreferences.mockClear();
    useProjectsStore.setState({ hiddenWorkspaceIds: [] });
  });

  it('defaults to an empty hidden set', () => {
    expect(useProjectsStore.getState().hiddenWorkspaceIds).toEqual([]);
  });

  it('setHiddenWorkspaceIds updates state and persists the preference', () => {
    useProjectsStore.getState().setHiddenWorkspaceIds(['a', 'b']);

    expect(useProjectsStore.getState().hiddenWorkspaceIds).toEqual(['a', 'b']);
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    expect(mockSavePreferences).toHaveBeenCalledWith({
      worktreeFilterHiddenWorkspaceIds: ['a', 'b'],
    });
  });

  it('hydrateHiddenWorkspaceIds updates state without persisting', () => {
    useProjectsStore.getState().hydrateHiddenWorkspaceIds(['x']);

    expect(useProjectsStore.getState().hiddenWorkspaceIds).toEqual(['x']);
    expect(mockSavePreferences).not.toHaveBeenCalled();
  });

  it('setHiddenWorkspaceIds can clear the filter', () => {
    useProjectsStore.getState().setHiddenWorkspaceIds(['a']);
    mockSavePreferences.mockClear();

    useProjectsStore.getState().setHiddenWorkspaceIds([]);

    expect(useProjectsStore.getState().hiddenWorkspaceIds).toEqual([]);
    expect(mockSavePreferences).toHaveBeenCalledWith({
      worktreeFilterHiddenWorkspaceIds: [],
    });
  });
});
