import type { IpcMainInvokeEvent } from 'electron';
import type {
  FileBrowserRoot,
  FileBrowserRootsResult,
} from '../lib/file-browser-roots';

export function documentRoots(absolutePath: string): FileBrowserRootsResult {
  const root: FileBrowserRoot = {
    repoId: 'repo-1',
    repoName: 'repo',
    absolutePath,
    rootKind: 'standalone',
    gitAware: false,
    excludedDescendantRoots: [],
  };
  return { roots: [root], rootMap: new Map([[root.repoId, root]]) };
}

// These handlers do not access the sender. Fail explicitly if that changes.
export const documentInvokeEvent: IpcMainInvokeEvent = {
  type: 'frame',
  frameId: 1,
  processId: 1,
  senderFrame: null,
  defaultPrevented: false,
  preventDefault: (): void => {},
  get sender(): never {
    throw new Error('Document byte tests have no renderer sender');
  },
};
