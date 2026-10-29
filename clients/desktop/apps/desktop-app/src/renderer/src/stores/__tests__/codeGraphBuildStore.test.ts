import { useCodeGraphBuildStore } from '../codeGraphBuildStore';

describe('codeGraphBuildStore', () => {
  beforeEach(() => {
    useCodeGraphBuildStore.setState({ building: {} });
  });

  it('setBuilding(true) adds the key', () => {
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', true);
    expect(useCodeGraphBuildStore.getState().building).toEqual({
      'proj-1/wt-1': true,
    });
  });

  it('setBuilding(false) deletes the key rather than leaving it false', () => {
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', true);
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', false);
    expect(useCodeGraphBuildStore.getState().building).toEqual({});
    expect('proj-1/wt-1' in useCodeGraphBuildStore.getState().building).toBe(
      false,
    );
  });

  it('setBuilding(false) on a key that was never set is a no-op', () => {
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', false);
    expect(useCodeGraphBuildStore.getState().building).toEqual({});
  });

  it('keys for different worktrees are independent', () => {
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', true);
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-2', true);
    expect(useCodeGraphBuildStore.getState().building).toEqual({
      'proj-1/wt-1': true,
      'proj-1/wt-2': true,
    });

    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', false);
    expect(useCodeGraphBuildStore.getState().building).toEqual({
      'proj-1/wt-2': true,
    });
  });

  it('keys for the same worktree id under different projects are independent', () => {
    useCodeGraphBuildStore.getState().setBuilding('proj-1', 'wt-1', true);
    useCodeGraphBuildStore.getState().setBuilding('proj-2', 'wt-1', true);
    expect(useCodeGraphBuildStore.getState().building).toEqual({
      'proj-1/wt-1': true,
      'proj-2/wt-1': true,
    });
  });
});
