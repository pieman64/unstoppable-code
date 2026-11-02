import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
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

/**
 * For suites that never take the scoped `file:read-content` branch, resolve
 * a `file-reference:resolve` link or save text through `file:save-content`.
 */
export const unusedFileContentDispatcher: Pick<
  DesktopCanopyDispatcher,
  | 'queryFileContentForLegacyIpc'
  | 'queryLinkResolveForLegacyIpc'
  | 'saveTextFileForLegacyIpc'
> = {
  queryFileContentForLegacyIpc: () =>
    Promise.reject(new Error('This suite reads no scoped file content.')),
  queryLinkResolveForLegacyIpc: () =>
    Promise.reject(new Error('This suite resolves no file links.')),
  saveTextFileForLegacyIpc: () =>
    Promise.reject(new Error('This suite saves no text files.')),
};

export function unusedCallerResolver(): never {
  throw new Error('This suite resolves no IPC caller.');
}

/**
 * For suites that pin `file:save-content`'s checks with a mocked filesystem:
 * every text save is answered `unrouted`, so the handler keeps its direct
 * write, and each projection input is recorded. The routed path is pinned on
 * real filesystems by `ipc/__tests__/file-save-content-golden.test.ts`.
 */
export function createDirectTextSaveDispatcher(): Pick<
  DesktopCanopyDispatcher,
  | 'queryFileContentForLegacyIpc'
  | 'queryLinkResolveForLegacyIpc'
  | 'saveTextFileForLegacyIpc'
> & {
  saves: Parameters<DesktopCanopyDispatcher['saveTextFileForLegacyIpc']>[];
} {
  const saves: Parameters<
    DesktopCanopyDispatcher['saveTextFileForLegacyIpc']
  >[] = [];
  return {
    ...unusedFileContentDispatcher,
    saveTextFileForLegacyIpc: (...args) => {
      saves.push(args);
      return Promise.resolve('unrouted');
    },
    saves,
  };
}

/** A tracked main-window caller, for suites whose events carry no sender. */
export function trustedSaveCaller(): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  };
}
