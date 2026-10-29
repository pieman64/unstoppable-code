import type * as CommitStore from '../main/lib/w5-commit-log-file-store';
import type * as DirectStore from '../main/lib/w5-file-store';

// Production getters have an explicit injected direct store in Jest. Tests
// exercising the worker create their own store/host against a temporary root.
jest.mock('../main/lib/w5-commit-log-file-store', () => {
  const store = jest.requireActual<typeof CommitStore>(
    '../main/lib/w5-commit-log-file-store',
  );
  const { nodeW5FileStore } = jest.requireActual<typeof DirectStore>(
    '../main/lib/w5-file-store',
  );
  store.__setDesktopW5FileStoreForTests(nodeW5FileStore);
  return store;
});
