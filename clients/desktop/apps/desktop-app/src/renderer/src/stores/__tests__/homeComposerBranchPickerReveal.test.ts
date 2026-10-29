/**
 * @jest-environment jsdom
 */
import { useHomeComposerStore } from '../homeComposerStore';

describe('homeComposerStore branch picker reveal (CAN-1817)', () => {
  beforeEach(() => {
    useHomeComposerStore.getState().setBranchPickerRevealed(false);
  });

  it('is shared state that toggles idempotently', () => {
    const store = useHomeComposerStore.getState();
    expect(store.branchPickerRevealed).toBe(false);
    store.setBranchPickerRevealed(true);
    expect(useHomeComposerStore.getState().branchPickerRevealed).toBe(true);
    store.setBranchPickerRevealed(true);
    expect(useHomeComposerStore.getState().branchPickerRevealed).toBe(true);
  });

  it('collapses again when the project selection changes', () => {
    useHomeComposerStore.getState().setBranchPickerRevealed(true);
    useHomeComposerStore.getState().selectWorkspace(null);
    expect(useHomeComposerStore.getState().branchPickerRevealed).toBe(false);
    expect(useHomeComposerStore.getState().branchTarget).toEqual({
      kind: 'new-worktree',
    });
  });
});
