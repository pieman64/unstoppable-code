import * as TypeActions from '../browser/actions/type';
import * as CheckActions from '../browser/actions/set-checked';
import * as SelectActions from '../browser/actions/select-option';
import * as FillActions from '../browser/actions/fill';
import {
  FormActionError,
  type FormActionOptions,
  type FormActionResult,
} from '../browser/actions/form-action';
import { PageModelHost } from '../browser/frames/page-model-host';
import {
  NATIVE_PRINT_EXPRESSION,
  NATIVE_PRINT_WORLD,
} from '../browser/actions/print-bridge';
import { denyPermission } from '../browser/permission-denials';
import { buildPageModel } from '../browser/frames/page-model';
import {
  loadRecording,
  recordedDeps,
} from '../browser/frames/__tests__/fixtures/recorded-cdp';
import { isCDPRecord } from '../browser/frames/cdp-decode';
import {
  CONNECTED_FUNCTION,
  type ResolvedActionTarget,
} from '../browser/frames/action-targets';
import { LocatorRequestError } from '../browser/frames/locator-requests';
import { BrowserReadTargetError } from '@canopy/desktop-shared/browser/read-target-error';
import { browserHandoffs } from '../browser/browser-handoffs';
import type {
  BrowserClearPreview,
  BrowserTaskSlot,
} from '@canopy/protocol/browser-profiles';
import type { BrowserScratchOwner } from '@canopy/desktop-shared/node/browser-profiles/owned-scratch';
import type * as BrowserProfileSwitchModule from '../browser/browser-profile-switch';
import type { BrowserSwitchRecord } from '../browser/browser-profile-switch';
import type {
  BrowserProfileAuthority,
  BrowserProfileResolution,
} from '../browser/browser-profile-service';
import type * as ElectronTypes from 'electron';
import type * as OpenExternalModule from '../lib/open-external';
import type * as ReadOnlyScopeModule from '../lib/read-only-scope';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { WebContentsView, session, shell, type WebContents } from 'electron';
import {
  BrowserService,
  type BrowserServiceOptions,
} from '../browser/browser-service';
import {
  BrowserTaskFiles,
  type BrowserTaskFilesDeps,
} from '../browser/files/task-files';
import {
  prepareChosenDestination,
  prepareWorkspaceDestination,
  type CopyDestination,
} from '../browser/files/workspace-copy';
import { requestChatApproval } from '../approvals/approval-session-registry';
import {
  attachmentUploadSource,
  workspaceUploadSource,
  type UploadSource,
} from '../browser/files/uploads';
import type {
  BrowserAutomationCommand,
  BrowserCopyTransfer,
  BrowserDownloadTransfer,
  BrowserFileChooser,
  BrowserPrintRequest,
  BrowserAuthRequest,
  BrowserRecordingStep,
  BrowserUploadTransfer,
} from '@canopy/desktop-shared/types/browser';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionLane } from '../browser/actions/action-lane';
import { getBrowserProfileService } from '../browser/browser-profile-service';
import { registerBrowserHandlers } from '../ipc/browser';
import { setBrowserService } from '../browser/browser-service-registry';
import { dispatchScopedBrowserAction } from '../canopy-tools/worktree-actions';
import {
  loadAndMigrateWorktreeBrowserState,
  loadWorktreeBrowserState,
  saveWorktreeBrowserState,
} from '../browser/browser-persistence';
import { sendToWindow } from '../lib/window-send';
import { hostRendererInView } from '../lib/renderer-surface';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type {
  BrowserActionTargetState,
  BrowserAutomationResponse,
  BrowserElementSnapshot,
  BrowserPostDispatchUnknown,
  BrowserWaitForResult,
} from '@canopy/desktop-shared/types/browser';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type BrowserEvent,
  type BrowserSessionSnapshot,
  type LoadWorktreeBrowserStateResponse,
  type SaveWorktreeBrowserStateRequest,
} from '@canopy/desktop-shared/types';
import type { ResourceProcessRegistration } from '../resource-monitor';

const ipcListeners = new Map<string, (...args: unknown[]) => void>();
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockProfileTaskSlots = jest.fn<Promise<BrowserTaskSlot[]>, []>();
const mockPendingSwitchRecords = jest.fn<
  Promise<BrowserSwitchRecord[]>,
  [string, string]
>();
const mockSwitchJournalUpdate = jest.fn();
const mockSwitchJournalFind = jest.fn();
const mockSwitchJournalBegin = jest.fn();
const mockResolveViewerRoots = jest.fn<Promise<unknown[]>, [string]>();
const mockAssertViewerFile = jest.fn<Promise<unknown>, [string, string]>();

function persistedSnapshot(
  id: string,
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: `http://localhost/${id}`,
    title: id,
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

/**
 * Waits out saves an earlier test's service still has in flight (such as its
 * real `SNAPSHOT_PERSISTENCE_DELAY_MS` timer), so a test counting saves sees
 * only its own. On a slow CI runner one otherwise lands mid-test.
 */
async function settleLeftoverSnapshotSaves(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  await new Promise<void>((resolve) => setImmediate(resolve));
  jest.mocked(saveWorktreeBrowserState).mockClear();
}

function lastSavedBrowserState(): Parameters<
  typeof saveWorktreeBrowserState
>[0]['state'] {
  const calls = jest.mocked(saveWorktreeBrowserState).mock.calls;
  const request = calls[calls.length - 1]?.[0];
  if (!request) throw new Error('Expected browser state to be saved.');
  return request.state;
}

function savedBrowserStateFor(
  projectId: string,
  worktreeId: string,
): Parameters<typeof saveWorktreeBrowserState>[0]['state'] {
  const calls = jest.mocked(saveWorktreeBrowserState).mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const request = calls[index]?.[0];
    if (request?.projectId === projectId && request.worktreeId === worktreeId) {
      return request.state;
    }
  }
  throw new Error(
    `Expected browser state to be saved for ${projectId}/${worktreeId}.`,
  );
}
const mockResourceRegistrationUpdate = jest.fn(
  (update: Partial<ResourceProcessRegistration>): void => {
    void update;
  },
);
const mockResourceRegistrationUnregister = jest.fn((): void => undefined);
const mockRegisterResourceProcess = jest.fn(
  (
    registration: ResourceProcessRegistration,
  ): {
    update: typeof mockResourceRegistrationUpdate;
    unregister: typeof mockResourceRegistrationUnregister;
  } => {
    void registration;
    return {
      update: mockResourceRegistrationUpdate,
      unregister: mockResourceRegistrationUnregister,
    };
  },
);

class MockWebContents extends EventEmitter {
  id: number;
  osProcessId = 4242;
  currentUrl = 'about:blank';
  userAgent =
    'Mozilla/5.0 Test Chrome/148.0.7778.180 Electron/42.3.0 Safari/537.36';
  destroyed = false;
  debugger = {
    isAttached: jest.fn(() => true),
    attach: jest.fn(),
    detach: jest.fn(),
    sendCommand: jest
      .fn<
        Promise<unknown>,
        [method: string, params?: Record<string, unknown>, sessionId?: string]
      >()
      .mockImplementation((method) => {
        if (method === 'Runtime.enable') {
          queueMicrotask(() => {
            const debugMessage = this.debugger.on.mock.calls.find(
              ([eventName]) => eventName === 'message',
            )?.[1];
            debugMessage?.({}, 'Runtime.executionContextCreated', {
              context: {
                id: 999,
                name: 'Electron Isolated Context',
                origin: 'http://localhost',
                auxData: {
                  frameId: 'main-frame',
                  type: 'isolated',
                },
              },
            });
          });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: { objectId: 'isolated-click-target' },
          });
        }
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.requestNode') {
          return Promise.resolve({ nodeId: 2 });
        }
        if (method === 'DOM.describeNode') {
          return Promise.resolve({ node: { backendNodeId: 22 } });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'click-target' } });
        }
        return Promise.resolve(undefined);
      }),
    on: jest.fn<void, [string, DebuggerMessageHandler]>(),
    removeListener: jest.fn<void, [string, DebuggerMessageHandler]>(),
  };
  _setOwnerWindow = jest.fn();
  navigationHistory = {
    canGoBack: jest.fn(() => false),
    canGoForward: jest.fn(() => false),
    goBack: jest.fn(),
    goForward: jest.fn(),
  };

  constructor(id = 42) {
    super();
    this.id = id;
  }

  setWindowOpenHandler = jest.fn(
    (
      handler: (details: { url: string; referrer?: { url: string } }) => {
        action: string;
      },
    ): void => {
      void handler;
    },
  );
  loadURL = jest.fn((url: string): Promise<void> => {
    this.currentUrl = url;
    this.emit('did-navigate', {}, url);
    return Promise.resolve();
  });
  reload = jest.fn();
  goBack = jest.fn();
  goForward = jest.fn();
  stop = jest.fn();
  findInPage = jest.fn<
    number,
    [string, { forward?: boolean; findNext?: boolean }?]
  >(() => 7);
  stopFindInPage = jest.fn<
    void,
    ['clearSelection' | 'keepSelection' | 'activateSelection']
  >();
  getURL = jest.fn(() => this.currentUrl);
  getUserAgent = jest.fn(() => this.userAgent);
  setUserAgent = jest.fn((userAgent: string) => {
    this.userAgent = userAgent;
  });
  getTitle = jest.fn(() => 'Test page');
  printToPDF = jest
    .fn<Promise<Buffer>, [Record<string, unknown>]>()
    .mockResolvedValue(Buffer.from('%PDF-1.7 test'));
  print = jest.fn<
    void,
    [Record<string, unknown>, ((success: boolean) => void) | undefined]
  >();
  getOSProcessId = jest.fn(() => this.osProcessId);
  canGoBack = jest.fn(() => false);
  canGoForward = jest.fn(() => false);
  isLoading = jest.fn(() => false);
  isDestroyed = jest.fn(() => this.destroyed);
  capturePage = jest.fn().mockResolvedValue({
    isEmpty: () => false,
    toDataURL: () => 'data:image/png;base64,abc',
    toPNG: () => Buffer.from('png'),
  });
  invalidate = jest.fn();
  focus = jest.fn();
  isFocused = jest.fn(() => false);
  sendInputEvent = jest.fn();
  close = jest.fn(() => {
    this.destroyed = true;
  });
  send = jest.fn(
    (channel: string, command: { requestId: string; type?: string }): void => {
      ipcListeners.get('canopy-browser-view:result')?.(
        { sender: { id: this.id } },
        { requestId: command.requestId, ok: true, result: {} },
      );
    },
  );
}

type DebuggerMessageHandler = (
  event: unknown,
  method: string,
  params: unknown,
  sessionId?: string,
) => void;

function isBrowserEvent(value: unknown): value is BrowserEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

function sentBrowserEvents(): BrowserEvent[] {
  return jest
    .mocked(sendToWindow)
    .mock.calls.map((call) => call[2])
    .filter(isBrowserEvent);
}

/**
 * A recording's JSON without its random step IDs and clock times, which can
 * spell a digit-only secret such as `4111` by chance.
 */
function recordingText(recording: unknown): string {
  return JSON.stringify(recording, (key, value: unknown) =>
    key === 'id' || key === 'timestamp' || key === 'chooserOpenedAt'
      ? undefined
      : value,
  );
}

async function withScreenshotObservationGlobals<T>(
  enabled: boolean,
  callback: (observation: Record<string, unknown>) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const e2eDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    '__CANOPY_E2E__',
  );
  const callbackKey = '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__';
  const callbackDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    callbackKey,
  );
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value: enabled,
  });
  Object.defineProperty(globalThis, callbackKey, {
    configurable: true,
    value: callback,
  });
  try {
    return await operation();
  } finally {
    if (callbackDescriptor) {
      Object.defineProperty(globalThis, callbackKey, callbackDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, callbackKey);
    }
    if (e2eDescriptor) {
      Object.defineProperty(globalThis, '__CANOPY_E2E__', e2eDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
    }
  }
}

const webContents = new MockWebContents();

/**
 * The prompt bridge's registration, found by its source: the page model's
 * trackers are registered on the same session, and earlier.
 */
function appPromptBridgeCall():
  | Parameters<typeof webContents.debugger.sendCommand>
  | undefined {
  return webContents.debugger.sendCommand.mock.calls.find(
    ([method, params]) =>
      method === 'Page.addScriptToEvaluateOnNewDocument' &&
      String(params?.source).includes('canopyAppOwnedPrompt'),
  );
}

function appPromptBridgeSourceUrl(): string {
  const source = appPromptBridgeCall()?.[1]?.source;
  if (typeof source !== 'string') {
    throw new Error('Expected the app prompt bridge source to be installed.');
  }
  const sourceUrl = /\/\/# sourceURL=(.+)$/.exec(source)?.[1];
  if (!sourceUrl) {
    throw new Error('Expected the app prompt bridge source URL.');
  }
  return sourceUrl;
}

function trustedTargetDebuggerResult(
  method: string,
  objectId: string,
  params?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    method === 'Runtime.callFunctionOn' &&
    String(params?.functionDeclaration).includes('const element = this') &&
    String(params?.functionDeclaration).includes('autocompleteWarning:')
  )
    return {
      result: {
        value: {
          connected: true,
          tagName: 'input',
          role: '',
          inputType: 'text',
          disabled: false,
          readOnly: false,
          editable: true,
          editor: false,
          kind: 'text',
          autocompleteWarning: false,
          settleMs: 0,
        },
      },
    };
  if (
    method === 'Runtime.callFunctionOn' &&
    String(params?.functionDeclaration).includes('retainedAppend:')
  )
    return { result: { value: { matches: true, retainedAppend: false } } };
  if (
    method === 'Runtime.callFunctionOn' &&
    String(params?.functionDeclaration).includes("kind: 'select'")
  )
    return { result: { value: { kind: 'other' } } };
  if (
    method === 'Runtime.callFunctionOn' &&
    String(params?.functionDeclaration).includes('root.activeElement !== node')
  )
    return { result: { value: false } };
  if (
    method === 'Runtime.callFunctionOn' &&
    String(params?.functionDeclaration).includes('const el = this')
  ) {
    return {
      result: {
        value: {
          attached: true,
          visible: true,
          enabled: true,
          editable: true,
          focusable: false,
          rect: { x: 10, y: 20, width: 40, height: 20 },
          viewport: { width: 800, height: 600 },
          receivesEvents: false,
          cover: 'div.cover',
        },
      },
    };
  }
  if (method === 'Page.getFrameTree')
    return {
      frameTree: { frame: { url: 'http://localhost:3000', loaderId: 'first' } },
    };
  if (method === 'Runtime.evaluate' && params?.contextId === undefined)
    return { result: { value: 'body:0' } };
  if (method === 'Runtime.evaluate') {
    return { result: { objectId: 'isolated-click-target' } };
  }
  if (method === 'DOM.getDocument') {
    return { root: { nodeId: 1 } };
  }
  if (method === 'DOM.requestNode') {
    return { nodeId: 2 };
  }
  if (method === 'DOM.describeNode') {
    return { node: { backendNodeId: 22 } };
  }
  if (method === 'DOM.resolveNode') {
    return { object: { objectId } };
  }
  return undefined;
}

function installNativePipeline(
  options: {
    sample?: Record<string, unknown>;
    prepared?: { found: false; code: 'target_not_found' | 'target_stale' };
    reportInput?: boolean;
    waitForProbe?: {
      matchCount: number;
      visibleCount: number;
      readyState: 'loading' | 'interactive' | 'complete';
    };
    viewport?: () => { width: number; height: number };
    input?: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
  } = {},
  contents: MockWebContents = webContents,
): void {
  const prepared = options.prepared;
  modelSeam.resolveActionTarget.mockImplementation(() =>
    Promise.resolve(
      prepared
        ? { status: prepared.code, message: 'No element matched the target.' }
        : { status: 'found', target: seamTarget('native-target') },
    ),
  );
  modelSeam.describeActionTarget.mockResolvedValue(DESCRIBED_TARGET);
  modelSeam.fillActionTarget.mockResolvedValue('filled');
  modelSeam.waitProbe.mockResolvedValue(
    options.waitForProbe ?? {
      matchCount: 1,
      visibleCount: 1,
      readyState: 'complete',
    },
  );
  contents.debugger.sendCommand.mockImplementation((method, params) => {
    if (
      method === 'Runtime.callFunctionOn' &&
      String(params?.functionDeclaration).includes('autocompleteWarning:')
    ) {
      const defaultRead = trustedTargetDebuggerResult(
        method,
        'native-target',
        params,
      );
      const result = defaultRead?.result;
      const read =
        typeof result === 'object' && result !== null && 'value' in result
          ? result.value
          : undefined;
      return Promise.resolve({
        result: {
          value: {
            ...(typeof read === 'object' && read !== null ? read : {}),
            disabled: options.sample?.enabled === false,
            editable: options.sample?.editable !== false,
            readOnly: options.sample?.editable === false,
          },
        },
      });
    }

    if (method === 'Page.getFrameTree')
      return Promise.resolve({
        frameTree: {
          frame: {
            id: 'main-frame',
            url: contents.getURL(),
            loaderId: 'initial-document',
          },
        },
      });
    if (
      method === 'Runtime.callFunctionOn' &&
      String(params?.functionDeclaration).includes('const el = this')
    )
      return Promise.resolve({
        result: {
          value: {
            attached: true,
            visible: true,
            enabled: true,
            editable: true,
            focusable: true,
            rect: { x: 10, y: 20, width: 40, height: 20 },
            viewport: { width: 800, height: 600 },
            receivesEvents: true,
            ...options.sample,
          },
        },
      });
    if (
      method === 'Runtime.callFunctionOn' &&
      String(params?.functionDeclaration).includes(
        'root.activeElement !== node',
      )
    )
      return Promise.resolve({ result: { value: true } });
    if (
      method === 'Runtime.evaluate' &&
      String(params?.expression).includes('innerWidth')
    )
      return Promise.resolve({
        result: { value: options.viewport?.() ?? { width: 800, height: 600 } },
      });
    if (method.startsWith('Input.')) {
      const result =
        options.input?.(method, params ?? {}) ?? Promise.resolve({});
      if (
        options.reportInput !== false &&
        (params?.type === 'mousePressed' ||
          params?.type === 'keyDown' ||
          params?.type === 'rawKeyDown')
      ) {
        ipcListeners.get('canopy-browser-view:event')?.(
          { sender: { id: contents.id } },
          {
            type: 'user-interaction',
            interaction: {
              type: params.type === 'mousePressed' ? 'pointerdown' : 'keydown',
              button: 0,
              clientX: params.x,
              clientY: params.y,
              key: params.key,
              timestamp: Date.now(),
            },
          },
        );
      }
      return result;
    }
    return Promise.resolve(
      trustedTargetDebuggerResult(method, 'native-target', params) ?? {},
    );
  });
}

const createdViews: Array<{
  webContents: MockWebContents;
  setBounds: jest.Mock;
  setVisible: jest.Mock;
  setBorderRadius: jest.Mock;
}> = [];
let setupNextCreatedView: ((contents: MockWebContents) => void) | undefined;
interface MockNativeView {
  setBounds: jest.Mock;
  setVisible: jest.Mock;
  setBorderRadius: jest.Mock;
  addChildView: jest.Mock;
  children: unknown[];
}
/** Plain views (a page's frame and rounded clip), in creation order. */
const createdNativeViews: MockNativeView[] = [];
function nativeParentOf(child: unknown): MockNativeView | undefined {
  return createdNativeViews.find((view) => view.children.includes(child));
}
/** The rounded clip and the window-placed frame around a page view. */
function pageFrameOf(page: unknown): {
  clip: MockNativeView;
  frame: MockNativeView;
} {
  const clip = nativeParentOf(page);
  const frame = clip ? nativeParentOf(clip) : undefined;
  if (!clip || !frame) throw new Error('page view has no frame');
  return { clip, frame };
}
const addChildView = jest.fn();
const removeChildView = jest.fn();
const mockSetBounds = jest.fn();
const mockSetVisible = jest.fn<void, [boolean]>();

const mockHostWebContentsFocus = jest.fn();
/** The host renderer's interface-scale zoom; tests override it locally. */
let mockHostZoomFactor = 1;
type PermissionRequestHandler = (
  contents: MockWebContents,
  permission: string,
  callback: (allowed: boolean) => void,
  details: Record<string, unknown>,
) => void;
type PermissionCheckHandler = (
  contents: MockWebContents,
  permission: string,
  requestingOrigin: string,
  details: Record<string, unknown>,
) => boolean;
const mockSetPermissionRequestHandler = jest.fn<
  void,
  [PermissionRequestHandler]
>();
const mockSetPermissionCheckHandler = jest.fn<void, [PermissionCheckHandler]>();
type MockBeforeRequestListener = (
  details: { url: string; resourceType: string },
  callback: (response: { cancel?: boolean }) => void,
) => void;
const mockOnBeforeRequest = jest.fn<
  void,
  [filter: unknown, listener: MockBeforeRequestListener]
>();

function mockWindow(): never {
  return {
    isDestroyed: () => false,
    contentView: { addChildView, removeChildView },
    once: jest.fn(),
    removeListener: jest.fn(),
    webContents: {
      focus: mockHostWebContentsFocus,
      getZoomFactor: (): number => mockHostZoomFactor,
      isDestroyed: (): boolean => false,
    },
  } as never;
}

jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: jest.fn(() => null) },
  View: jest.fn().mockImplementation(() => {
    const view: MockNativeView = {
      setBounds: jest.fn(),
      setVisible: jest.fn(),
      setBorderRadius: jest.fn(),
      addChildView: jest.fn((child: unknown) => {
        view.children.push(child);
      }),
      children: [],
    };
    createdNativeViews.push(view);
    return view;
  }),
  WebContentsView: jest.fn().mockImplementation(() => {
    const contents =
      createdViews.length === 0
        ? webContents
        : new MockWebContents(42 + createdViews.length);
    const view = {
      webContents: contents,
      setBounds: createdViews.length === 0 ? mockSetBounds : jest.fn(),
      setVisible: createdViews.length === 0 ? mockSetVisible : jest.fn(),
      setBorderRadius: jest.fn(),
    };
    createdViews.push(view);
    const setup = setupNextCreatedView;
    setupNextCreatedView = undefined;
    setup?.(contents);
    return view;
  }),
  ipcMain: {
    on: jest.fn((channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, listener);
    }),
    removeListener: jest.fn(
      (channel: string, listener: (...args: unknown[]) => void) => {
        if (ipcListeners.get(channel) === listener) {
          ipcListeners.delete(channel);
        }
      },
    ),
    removeHandler: jest.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
    handle: jest.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler);
      },
    ),
  },
  session: {
    fromPartition: jest.fn(() => ({
      on: jest.fn(),
      removeListener: jest.fn(),
      clearStorageData: jest.fn().mockResolvedValue(undefined),
      setPermissionRequestHandler: mockSetPermissionRequestHandler,
      setPermissionCheckHandler: mockSetPermissionCheckHandler,
      webRequest: { onBeforeRequest: mockOnBeforeRequest },
    })),
  },
  shell: { openExternal: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../shared-containers/read/viewer-root', () => ({
  resolveSharedContainerViewerReadRoots: (
    containerId: string,
  ): Promise<unknown[]> => mockResolveViewerRoots(containerId),
  assertSharedContainerViewerFileForRead: (
    containerId: string,
    absolutePath: string,
  ): Promise<unknown> => mockAssertViewerFile(containerId, absolutePath),
}));

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn().mockResolvedValue([]),
  rm: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

let mockTaskFilesDeps: BrowserTaskFilesDeps | undefined;
const mockDownloadDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): object => ({
    recordSessionDiagnostic: mockDownloadDiagnostic,
  }),
}));
jest.mock('../browser/files/task-files', () => ({
  BrowserTaskFiles: jest
    .fn()
    .mockImplementation((deps: BrowserTaskFilesDeps): object => {
      mockTaskFilesDeps = deps;
      return {
        bind: jest.fn().mockResolvedValue(undefined),
        fence: jest.fn(),
        drain: jest.fn().mockResolvedValue(undefined),
        removeTask: jest.fn().mockResolvedValue(undefined),
        setAttribution: jest.fn(),
        attributionFor: jest.fn(),
        onDownloadFailed: jest.fn(() => (): void => undefined),
        admitDownload: jest
          .fn()
          .mockReturnValue({ ok: false, reason: 'unavailable' }),
        forAction: jest.fn().mockReturnValue([]),
        get: jest.fn(),
        list: jest
          .fn()
          .mockReturnValue({ transfers: [], total: 0, offset: 0, limit: 25 }),
        allowMore: jest.fn(),
        resolveLocalPath: jest.fn().mockResolvedValue(undefined),
        waitForDownload: jest.fn().mockResolvedValue(undefined),
        startCopy: jest.fn(),
        cancelCopy: jest.fn().mockReturnValue(false),
        waitForTransfer: jest.fn().mockResolvedValue(undefined),
        startUpload: jest.fn(),
        downloadUploadSource: jest.fn(),
        beginAttach: jest.fn().mockReturnValue(true),
        endUpload: jest.fn(),
        stagedUploadPaths: jest.fn(),
        stagedUploadMatches: jest.fn().mockResolvedValue(true),
        updateDownload: jest.fn(),
        completeDownload: jest.fn().mockResolvedValue(undefined),
        discardDownload: jest.fn().mockResolvedValue(undefined),
        cancelUpload: jest.fn().mockReturnValue(false),
        releaseUploads: jest.fn().mockResolvedValue(undefined),
      };
    }),
}));
jest.mock('../browser/files/workspace-copy', () => ({
  prepareWorkspaceDestination: jest.fn(),
  prepareChosenDestination: jest.fn(),
}));
jest.mock('../approvals/approval-session-registry', () => ({
  requestChatApproval: jest.fn(),
}));
jest.mock('../browser/files/uploads', () => ({
  workspaceUploadSource: jest.fn(),
  attachmentUploadSource: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeAttachmentsDir: jest.fn(() => '/attachments'),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../browser/browser-persistence', () => ({
  BrowserStateHydrationError: class BrowserStateHydrationError extends Error {},
  loadAndMigrateWorktreeBrowserState: jest.fn(() =>
    Promise.resolve({ status: 'missing', state: null }),
  ),
  loadWorktreeBrowserState: jest.fn(() => ({ status: 'missing', state: null })),
  saveWorktreeBrowserState: jest.fn().mockResolvedValue(undefined),
}));

// Keep view/automation tests independent of on-disk owner registries. The
// profile service and repository have separate real-filesystem coverage.
// Journal recovery itself has real-filesystem coverage in browser-profile-switch.
jest.mock('../browser/browser-profile-switch', () => ({
  ...jest.requireActual<typeof BrowserProfileSwitchModule>(
    '../browser/browser-profile-switch',
  ),
  BrowserSwitchJournal: jest.fn(() => ({
    pending: mockPendingSwitchRecords,
    update: mockSwitchJournalUpdate,
    find: mockSwitchJournalFind,
    begin: mockSwitchJournalBegin,
  })),
}));
// View tests inject the data subsystem; its filesystem, jobs, quota and recovery
// behavior is exercised by the repository suites and real Electron flows.
jest.mock('../browser/browser-profile-data', () => ({
  BrowserProfileData: class {
    ensureReady = jest.fn((): Promise<void> => {
      return Promise.resolve();
    });
    observations = { record: jest.fn() };
    shutdown = jest.fn((): Promise<void> => Promise.resolve());
    readonly scratch;
    constructor(browser: BrowserService) {
      let serial = 0;
      const files = new Map<string, BrowserScratchOwner>();
      const fs = jest.requireMock<{ writeFile: jest.Mock; rm: jest.Mock }>(
        'node:fs/promises',
      );
      this.scratch = {
        write: async (
          owner: BrowserScratchOwner,
          extension: string,
          buffer: Buffer,
        ): Promise<string> => {
          if (!browser.matchesScratchOwner(owner))
            throw new Error('Stale browser scratch owner');
          const path = `/browser-owned-scratch/${owner.browserId}-${++serial}.${extension}`;
          await fs.writeFile(path, buffer);
          if (!browser.matchesScratchOwner(owner)) {
            await fs.rm(path, { force: true });
            throw new Error('Stale browser scratch owner');
          }
          files.set(path, owner);
          return path;
        },
        cleanup: async (
          match: (owner: BrowserScratchOwner) => boolean,
        ): Promise<void> => {
          for (const [path, owner] of Array.from(files))
            if (match(owner)) {
              await fs.rm(path, { force: true });
              files.delete(path);
            }
        },
      };
    }
  },
}));

jest.mock('../browser/browser-profile-service', () => ({
  getBrowserProfileService: (): BrowserProfileAuthority & {
    dataRoot: string;
    repository: { listTaskSlots: typeof mockProfileTaskSlots };
    taskContext: (
      projectId: string,
      worktreeId: string,
    ) => Promise<BrowserTaskSlot>;
  } => ({
    dataRoot: '/virtual/browser-service-fixture',
    repository: { listTaskSlots: mockProfileTaskSlots },
    resolve: (
      projectId: string,
      worktreeId: string,
      persisted?: BrowserSessionSnapshot,
    ): Promise<BrowserProfileResolution> => {
      const scope = { kind: 'worktree' as const, projectId, worktreeId };
      const profileId = `profile-${projectId}-${worktreeId}`;
      return Promise.resolve({
        owner: { scope, projectId, worktreeId, createdAt: 'fixture' },
        profile: {
          schemaVersion: 1,
          profileId,
          kind: 'task',
          owner: {
            kind: 'task',
            taskScope: scope,
            taskIncarnationId: 'fixture-incarnation',
          },
          metadataRevision: 0,
          displayName: 'Task',
          agentPermissions: { allowEnable: true, allowClear: false },
          lifecycle: 'active',
          storageGeneration: 1,
          createdAt: 0,
          updatedAt: 0,
        },
        partition: `persist:canopy-browser-${projectId}-${worktreeId}`,
        binding: {
          selection: { kind: 'task' },
          resolvedProfileId: profileId,
          storageGeneration: 1,
          runtimeGeneration: (persisted?.profile?.runtimeGeneration ?? 0) + 1,
          taskIncarnationId: 'fixture-incarnation',
        },
      });
    },
    assertActive: (): Promise<void> => Promise.resolve(),
    taskContext: (
      projectId: string,
      worktreeId: string,
    ): Promise<BrowserTaskSlot> =>
      Promise.resolve({
        schemaVersion: 1,
        scope: { kind: 'worktree', projectId, worktreeId },
        ownerCreatedAt: 'fixture-owner',
        incarnationId: 'fixture-incarnation',
        metadataRevision: 0,
        defaultSelection: { kind: 'task' },
        nextStorageGeneration: 1,
        agentClearAllowed: false,
        lifecycle: 'active',
      }),
    acquireSession: (
      resolution: BrowserProfileResolution,
    ): Promise<ElectronTypes.Session> => {
      const native = jest
        .requireMock<typeof ElectronTypes>('electron')
        .session.fromPartition(resolution.partition);
      native.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      native.setPermissionCheckHandler(() => false);
      return Promise.resolve(native);
    },
  }),
}));

const mockOpenFileInDefaultWebBrowser = jest.fn<Promise<void>, [string]>();
const mockAssertPathOutsideReplicas = jest.fn<Promise<void>, [string]>();

jest.mock('../lib/open-external', () => ({
  ...jest.requireActual<typeof OpenExternalModule>('../lib/open-external'),
  openFileInDefaultWebBrowser: (fileUrl: string): Promise<void> =>
    mockOpenFileInDefaultWebBrowser(fileUrl),
}));

jest.mock('../lib/read-only-scope', () => ({
  ...jest.requireActual<typeof ReadOnlyScopeModule>('../lib/read-only-scope'),
  assertPathOutsideSharedContainerReplicas: (
    absolutePath: string,
  ): Promise<void> => mockAssertPathOutsideReplicas(absolutePath),
}));

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): {
    registerProcess: typeof mockRegisterResourceProcess;
  } => ({
    registerProcess: mockRegisterResourceProcess,
  }),
}));

interface CapturedSyntheticMouseEventInit {
  bubbles: boolean;
  cancelable: boolean;
  button: number;
  detail: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

class CapturedSyntheticMouseEvent {
  constructor(
    readonly type: string,
    readonly init: CapturedSyntheticMouseEventInit,
  ) {}
}

class CapturedSyntheticHTMLElement {
  clickCalls = 0;
  readonly events: CapturedSyntheticMouseEvent[] = [];

  click(): void {
    this.clickCalls += 1;
  }

  dispatchEvent(event: CapturedSyntheticMouseEvent): boolean {
    this.events.push(event);
    return true;
  }
}

interface SyntheticMouseEventExpectation extends CapturedSyntheticMouseEventInit {
  type: string;
}

interface SyntheticClickPolicy {
  readonly button: 'left' | 'right' | 'middle';
  readonly clickCount: number;
  readonly modifiers: readonly ('Alt' | 'Control' | 'Meta' | 'Shift')[];
  readonly clickCalls: number;
  readonly events: readonly SyntheticMouseEventExpectation[];
}

function syntheticEventExpectation(
  type: string,
  button: number,
  detail: number,
  modifiers: readonly ('Alt' | 'Control' | 'Meta' | 'Shift')[],
): SyntheticMouseEventExpectation {
  return {
    type,
    bubbles: true,
    cancelable: true,
    button,
    detail,
    altKey: modifiers.includes('Alt'),
    ctrlKey: modifiers.includes('Control'),
    metaKey: modifiers.includes('Meta'),
    shiftKey: modifiers.includes('Shift'),
  };
}

function executeCapturedSyntheticAction(
  declaration: string,
): CapturedSyntheticHTMLElement {
  const element = new CapturedSyntheticHTMLElement();
  runInNewContext(`(${declaration}).call(element)`, {
    HTMLElement: CapturedSyntheticHTMLElement,
    MouseEvent: CapturedSyntheticMouseEvent,
    element,
  });
  return element;
}

const syntheticClickPolicies: readonly SyntheticClickPolicy[] = [
  {
    button: 'right',
    clickCount: 1,
    modifiers: [],
    clickCalls: 0,
    events: [syntheticEventExpectation('contextmenu', 2, 1, [])],
  },
  {
    button: 'right',
    clickCount: 1,
    modifiers: ['Shift'],
    clickCalls: 0,
    events: [syntheticEventExpectation('contextmenu', 2, 1, ['Shift'])],
  },
  {
    button: 'middle',
    clickCount: 1,
    modifiers: [],
    clickCalls: 0,
    events: [syntheticEventExpectation('auxclick', 1, 1, [])],
  },
  {
    button: 'middle',
    clickCount: 1,
    modifiers: ['Alt'],
    clickCalls: 0,
    events: [syntheticEventExpectation('auxclick', 1, 1, ['Alt'])],
  },
  {
    button: 'left',
    clickCount: 1,
    modifiers: [],
    clickCalls: 1,
    events: [],
  },
  {
    button: 'left',
    clickCount: 2,
    modifiers: [],
    clickCalls: 0,
    events: [
      syntheticEventExpectation('click', 0, 1, []),
      syntheticEventExpectation('click', 0, 2, []),
      syntheticEventExpectation('dblclick', 0, 2, []),
    ],
  },
  {
    button: 'left',
    clickCount: 3,
    modifiers: [],
    clickCalls: 0,
    events: [
      syntheticEventExpectation('click', 0, 1, []),
      syntheticEventExpectation('click', 0, 2, []),
      syntheticEventExpectation('dblclick', 0, 2, []),
      syntheticEventExpectation('click', 0, 3, []),
    ],
  },
  {
    button: 'left',
    clickCount: 1,
    modifiers: ['Control', 'Meta', 'Shift'],
    clickCalls: 0,
    events: [
      syntheticEventExpectation('click', 0, 1, ['Control', 'Meta', 'Shift']),
    ],
  },
];

/**
 * The page model seam (phase 04b S2). Actions, waits, inspect and input
 * snapshots run on PageModelHost, whose CDP work has its own suites under
 * `browser/frames/__tests__`. Here its methods answer as the preload's
 * prepared-target commands did, so the service's ordering, dialog,
 * delivery and receipt rules are tested unchanged. Every test gets the
 * defaults; `installNativePipeline` switches to a describable, fillable
 * target the way it switched the preload mock.
 */
const DESCRIBED_TARGET: BrowserActionTargetState = {
  tagName: 'input',
  name: 'Safe target',
  inputType: 'text',
  disabled: false,
  focused: true,
  inViewport: true,
  bounds: { x: 10, y: 20, width: 40, height: 20 },
};

const MODEL_ELEMENT: BrowserElementSnapshot = {
  browserId: 'model',
  url: 'http://localhost/',
  title: 'Model',
  capturedAt: '2026-01-01T00:00:00.000Z',
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  themeMode: 'light',
  tagName: 'body',
  attributes: {},
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  locatorCandidates: [],
  domPath: ['body'],
  outerHtml: '<body></body>',
};

function seamTarget(
  objectId: string,
  identity: Partial<ResolvedActionTarget['identity']> = {},
): ResolvedActionTarget {
  const resolved = {
    sessionId: '',
    frameId: 'main-frame',
    loaderId: 'initial-document',
    backendNodeId: 22,
    ...identity,
  };
  return {
    identity: resolved,
    frameRef: 'f-00000000-0000-0000-0000-000000000000-1',
    objectId,
    objectGroup: `group-${objectId}`,
    outOfProcess: resolved.sessionId !== '',
  };
}

interface ModelSeam {
  resolveActionTarget: jest.SpiedFunction<PageModelHost['resolveActionTarget']>;
  releaseActionTarget: jest.SpiedFunction<PageModelHost['releaseActionTarget']>;
  describeActionTarget: jest.SpiedFunction<
    PageModelHost['describeActionTarget']
  >;
  hostActionTarget: jest.SpiedFunction<PageModelHost['hostActionTarget']>;
  isActionTargetSecret: jest.SpiedFunction<
    PageModelHost['isActionTargetSecret']
  >;
  fillActionTarget: jest.SpiedFunction<PageModelHost['fillActionTarget']>;
  establishTracking: jest.SpiedFunction<PageModelHost['establishTracking']>;
  beginActivity: jest.SpiedFunction<PageModelHost['beginActivity']>;
  documentMapping: jest.SpiedFunction<PageModelHost['documentMapping']>;
  outerHitTest: jest.SpiedFunction<PageModelHost['outerHitTest']>;
  armInputRecorder: jest.SpiedFunction<PageModelHost['armInputRecorder']>;
  isTargetDocumentCurrent: jest.SpiedFunction<
    PageModelHost['isTargetDocumentCurrent']
  >;
  waitProbe: jest.SpiedFunction<PageModelHost['waitProbe']>;
  inspect: jest.SpiedFunction<PageModelHost['inspect']>;
  snapshot: jest.SpiedFunction<PageModelHost['snapshot']>;
}

let modelSeam: ModelSeam;

/** Spies (again after any restore) and answers as the top-level preload mock did. */
function installModelSeam(): ModelSeam {
  const prototype = PageModelHost.prototype;
  const seam: ModelSeam = {
    resolveActionTarget: jest.spyOn(prototype, 'resolveActionTarget'),
    releaseActionTarget: jest.spyOn(prototype, 'releaseActionTarget'),
    describeActionTarget: jest.spyOn(prototype, 'describeActionTarget'),
    fillActionTarget: jest.spyOn(prototype, 'fillActionTarget'),
    hostActionTarget: jest.spyOn(prototype, 'hostActionTarget'),
    isActionTargetSecret: jest.spyOn(prototype, 'isActionTargetSecret'),
    establishTracking: jest.spyOn(prototype, 'establishTracking'),
    beginActivity: jest.spyOn(prototype, 'beginActivity'),
    documentMapping: jest.spyOn(prototype, 'documentMapping'),
    outerHitTest: jest.spyOn(prototype, 'outerHitTest'),
    armInputRecorder: jest.spyOn(prototype, 'armInputRecorder'),
    isTargetDocumentCurrent: jest.spyOn(prototype, 'isTargetDocumentCurrent'),
    waitProbe: jest.spyOn(prototype, 'waitProbe'),
    inspect: jest.spyOn(prototype, 'inspect'),
    snapshot: jest.spyOn(prototype, 'snapshot'),
  };
  seam.resolveActionTarget.mockImplementation(() =>
    Promise.resolve({ status: 'found', target: seamTarget('click-target') }),
  );
  seam.releaseActionTarget.mockResolvedValue(undefined);
  // The top-level preload mock answered describe and fill with `{}`.
  seam.describeActionTarget.mockResolvedValue(undefined);
  seam.fillActionTarget.mockResolvedValue('target_stale');
  seam.hostActionTarget.mockImplementation((target) => Promise.resolve(target));
  seam.isActionTargetSecret.mockResolvedValue(false);
  seam.establishTracking.mockResolvedValue(undefined);
  seam.beginActivity.mockImplementation(() => (): void => undefined);
  seam.documentMapping.mockResolvedValue({
    originX: 0,
    originY: 0,
    scaleX: 1,
    scaleY: 1,
  });
  seam.outerHitTest.mockResolvedValue({ receivesEvents: true });
  seam.armInputRecorder.mockResolvedValue(undefined);
  // Tests that resolve targets without registering their frames pass the
  // fence; the fence's own tests restore the real one.
  seam.isTargetDocumentCurrent.mockReturnValue(true);
  seam.waitProbe.mockRejectedValue(
    new Error('Browser wait probe returned no result.'),
  );
  seam.inspect.mockImplementation((request) =>
    Promise.resolve({ ...MODEL_ELEMENT, browserId: request.browserId }),
  );
  seam.snapshot.mockImplementation((request) =>
    Promise.resolve({
      browserId: request.browserId,
      url: 'http://localhost/',
      title: 'Model',
      capturedAt: '2026-01-01T00:00:00.000Z',
      filter: request.filter ?? {},
      offset: request.offset ?? 0,
      limit: request.limit ?? 50,
      total: 0,
      returned: 0,
      truncated: false,
      inputs: [],
    }),
  );
  return seam;
}

/** Reads a wait_for result; a post-dispatch unknown result has none. */
function waitForOf(
  result: BrowserAutomationResponse | BrowserPostDispatchUnknown,
): BrowserWaitForResult | undefined {
  return 'kind' in result ? undefined : result.waitFor;
}

describe('BrowserService', () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    modelSeam = installModelSeam();
    mockProfileTaskSlots.mockResolvedValue([]);
    mockPendingSwitchRecords.mockResolvedValue([]);
    mockSwitchJournalUpdate.mockResolvedValue(undefined);
    mockSwitchJournalFind.mockReset().mockResolvedValue(undefined);
    mockSwitchJournalBegin.mockReset();
    mockResolveViewerRoots.mockResolvedValue([]);
    mockOpenFileInDefaultWebBrowser.mockResolvedValue(undefined);
    mockAssertPathOutsideReplicas.mockResolvedValue(undefined);
    mockAssertViewerFile.mockRejectedValue(
      new Error('Cannot read file outside the shared-container replica'),
    );
    createdViews.length = 0;
    createdNativeViews.length = 0;
    setupNextCreatedView = undefined;
    ipcHandlers.clear();
    jest.mocked(loadWorktreeBrowserState).mockReset().mockReturnValue({
      status: 'missing',
      state: null,
    });
    jest
      .mocked(loadAndMigrateWorktreeBrowserState)
      .mockReset()
      .mockResolvedValue({ status: 'missing', state: null });
    jest
      .mocked(saveWorktreeBrowserState)
      .mockReset()
      .mockImplementation(async (_request, commit) => {
        if (commit) await commit(() => Promise.resolve());
      });
    webContents.removeAllListeners();
    webContents.osProcessId = 4242;
    webContents.currentUrl = 'about:blank';
    webContents.userAgent =
      'Mozilla/5.0 Test Chrome/148.0.7778.180 Electron/42.3.0 Safari/537.36';
    webContents.destroyed = false;
    webContents.loadURL.mockImplementation((url: string) => {
      webContents.currentUrl = url;
      webContents.emit('did-navigate', {}, url);
      return Promise.resolve();
    });
    webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,abc',
      toPNG: () => Buffer.from('png'),
    });
    webContents.invalidate.mockReset();
    // Reset, not just clear: an unconsumed mockImplementationOnce must not
    // answer a later test's command.
    webContents.send.mockReset();
    webContents.send.mockImplementation(
      (
        _channel: string,
        command: { requestId: string; type?: string },
      ): void => {
        ipcListeners.get('canopy-browser-view:result')?.(
          { sender: { id: webContents.id } },
          { requestId: command.requestId, ok: true, result: {} },
        );
      },
    );
    webContents.close.mockImplementation(() => {
      webContents.destroyed = true;
    });
    webContents.debugger.sendCommand.mockImplementation((method, params) => {
      if (method === 'Runtime.enable') {
        queueMicrotask(() => {
          const debugMessage = webContents.debugger.on.mock.calls.find(
            ([eventName]) => eventName === 'message',
          )?.[1];
          debugMessage?.({}, 'Runtime.executionContextCreated', {
            context: {
              id: 999,
              name: 'Electron Isolated Context',
              origin: 'http://localhost',
              auxData: {
                frameId: 'main-frame',
                type: 'isolated',
              },
            },
          });
        });
      }
      const trustedTarget = trustedTargetDebuggerResult(
        method,
        'click-target',
        params,
      );
      if (trustedTarget !== undefined) {
        return Promise.resolve(trustedTarget);
      }
      return Promise.resolve(undefined);
    });
    webContents.canGoBack.mockReturnValue(false);
    webContents.canGoForward.mockReturnValue(false);
    webContents.navigationHistory.canGoBack.mockReturnValue(false);
    webContents.navigationHistory.canGoForward.mockReturnValue(false);
  });

  it('validates handoffs, emits open before handoff, hydrates without replay, and releases on destruction', async () => {
    browserHandoffs.releaseWorktree('project-1', 'worktree-1');
    const service = new BrowserService({ getWindow: mockWindow });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'handoff-browser',
    });
    const origin = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatTabId: 'chat',
    };
    jest.mocked(sendToWindow).mockClear();
    expect(() =>
      service.requestHandoff(
        { ...browser, worktreeId: 'foreign' },
        origin,
        mockWindow(),
        false,
      ),
    ).toThrow('changed or closed');
    expect(
      browserHandoffs.snapshot('project-1', 'worktree-1').handoff,
    ).toBeNull();
    const handoff = service.requestHandoff(
      browser,
      origin,
      mockWindow(),
      false,
    );
    const events = jest.mocked(sendToWindow).mock.calls.map((call) => call[2]);
    expect(events).toMatchObject([
      { type: 'open-requested' },
      { type: 'handoff-requested', handoff: { handoffId: handoff.handoffId } },
    ]);
    service.requestHandoff(browser, origin, mockWindow(), false);
    expect(jest.mocked(sendToWindow)).toHaveBeenCalledTimes(2);
    expect(
      (await service.loadWorktreeState('project-1', 'worktree-1')).handoffState
        ?.handoff?.handoffId,
    ).toBe(handoff.handoffId);
    expect(jest.mocked(sendToWindow)).toHaveBeenCalledTimes(2);
    await service.destroy(browser.id);
    expect(
      browserHandoffs.snapshot('project-1', 'worktree-1').handoff,
    ).toBeNull();
    expect(() =>
      service.requestHandoff(browser, origin, mockWindow(), false),
    ).toThrow('changed or closed');
  });

  describe('phase 07 task files integration', () => {
    const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const transfer: BrowserDownloadTransfer = {
      kind: 'download',
      id: 'download-1',
      browserId: 'files-browser',
      source: 'agent',
      actionId: 'files-action',
      origin: 'https://example.test/report',
      fileName: 'report.csv',
      receivedBytes: 4,
      totalBytes: 10,
      status: 'in_progress',
      startedAt: 1,
    };
    const services: BrowserService[] = [];
    afterEach(async () => {
      // A create schedules a deferred state write. Shutting down writes it
      // now, so it cannot reach a later test's save mock.
      await Promise.all(
        services.splice(0).map((service) => service.shutdown()),
      );
    });
    function trackedService(
      options: Partial<BrowserServiceOptions> = {},
    ): BrowserService {
      const service = new BrowserService({ getWindow: mockWindow, ...options });
      services.push(service);
      return service;
    }
    async function filesService(
      options: Partial<BrowserServiceOptions> = {},
    ): Promise<BrowserService> {
      const service = trackedService({
        resolveWorkspaceRoot: () => '/workspace',
        ...options,
      });
      await service.create({ ...scope, browserId: transfer.browserId });
      return service;
    }
    it('owns one store, supplies it to downloads, binds before a view exists and emits safe diagnostics', async () => {
      const count = jest.mocked(BrowserTaskFiles).mock.calls.length;
      const service = trackedService();
      expect(service.taskFiles).toBeDefined();
      expect(jest.mocked(BrowserTaskFiles).mock.calls.length).toBe(count + 1);
      expect(Reflect.get(service.downloads, 'taskFiles')).toBe(
        service.taskFiles,
      );
      jest.mocked(service.taskFiles).bind.mockImplementation(() => {
        expect(createdViews).toHaveLength(0);
        return Promise.resolve();
      });
      await service.create({ ...scope, browserId: transfer.browserId });
      expect(jest.mocked(service.taskFiles).bind.mock.calls).toContainEqual([
        scope,
      ]);
      mockTaskFilesDeps?.emit({
        type: 'transfer',
        browserId: transfer.browserId,
        transfer,
      });
      expect(sendToWindow).toHaveBeenCalledWith(
        expect.anything(),
        IPC_CHANNELS.browserEvent,
        { type: 'transfer', browserId: transfer.browserId, transfer },
      );
      mockTaskFilesDeps?.recordEvent?.(scope, {
        kind: 'browser_download_started',
        origin: transfer.origin,
        fileName: transfer.fileName,
        source: transfer.source,
        totalBytes: 10,
      });
      expect(mockDownloadDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          ...scope,
          kind: 'browser_download_started',
          origin: transfer.origin,
          fileName: 'report.csv',
          providerType: 'unknown',
        }),
      );
    });
    it('recovers task files while hydrating cold browser state', async () => {
      const service = trackedService();
      await service.loadWorktreeState(scope.projectId, scope.worktreeId);
      expect(jest.mocked(service.taskFiles).bind.mock.calls).toContainEqual([
        scope,
      ]);
    });
    it('fences, cancels, drains both queues and removes files only on target deletion', async () => {
      const service = await filesService();
      const order: string[] = [];
      jest.mocked(service.taskFiles).fence.mockImplementation(() => {
        order.push('fence');
      });
      jest.spyOn(service.downloads, 'cancelTask').mockImplementation(() => {
        order.push('cancel');
      });
      jest.spyOn(service.downloads, 'drain').mockImplementation(() => {
        order.push('downloads');
        return Promise.resolve();
      });
      jest.mocked(service.taskFiles).drain.mockImplementation(() => {
        order.push('store');
        return Promise.resolve();
      });
      jest.mocked(service.taskFiles).removeTask.mockImplementation(() => {
        order.push('remove');
        return Promise.resolve();
      });
      await service.destroyWorktree(scope.projectId, scope.worktreeId, {
        deletingTarget: true,
      });
      expect(order).toEqual([
        'fence',
        'cancel',
        'downloads',
        'store',
        'remove',
      ]);
    });
    it('reports a swapped download directory without retaining live views or claiming removal', async () => {
      const service = await filesService();
      jest
        .mocked(service.taskFiles)
        .removeTask.mockRejectedValue(new Error('Download directory changed'));
      await expect(
        service.destroyWorktree(scope.projectId, scope.worktreeId, {
          deletingTarget: true,
        }),
      ).rejects.toThrow('Download directory changed');
      expect(service.getLifecycleStats().liveViews).toBe(0);
    });
    it('keeps downloaded files when destroying tabs without deleting the task', async () => {
      const service = await filesService();
      await service.destroyWorktree(scope.projectId, scope.worktreeId);
      expect(jest.mocked(service.taskFiles).removeTask.mock.calls).toHaveLength(
        0,
      );
      expect(jest.mocked(service.taskFiles).fence.mock.calls).toHaveLength(0);
    });
    it('lists only the authorized browser owner scope and delegates pagination', async () => {
      const service = await filesService();
      const request = {
        browserId: transfer.browserId,
        status: 'in_progress' as const,
        offset: 2,
        limit: 8,
      };
      service.listTransfers(request);
      expect(jest.mocked(service.taskFiles).list.mock.calls).toContainEqual([
        scope,
        transfer.browserId,
        request,
      ]);
      expect(() => service.listTransfers({ browserId: 'unknown' })).toThrow();
    });
    it('joins cancellation before reading the resulting transfer and handles finished downloads idempotently', async () => {
      const service = await filesService();
      jest.mocked(service.taskFiles).get.mockReturnValue(transfer);
      const cancel = jest
        .spyOn(service.downloads, 'cancelDownload')
        .mockReturnValue(true);
      const drain = jest
        .spyOn(service.downloads, 'drain')
        .mockImplementation(() => {
          jest
            .mocked(service.taskFiles)
            .get.mockReturnValue({ ...transfer, status: 'cancelled' });
          return Promise.resolve();
        });
      expect(
        await service.cancelTransfer({
          browserId: transfer.browserId,
          transferId: transfer.id,
        }),
      ).toMatchObject({ ok: true, transfer: { status: 'cancelled' } });
      expect(cancel).toHaveBeenCalledWith(scope, transfer.id);
      expect(drain).toHaveBeenCalled();
      cancel.mockClear();
      expect(
        await service.cancelTransfer({
          browserId: transfer.browserId,
          transferId: transfer.id,
        }),
      ).toMatchObject({ ok: true });
      expect(cancel).not.toHaveBeenCalled();
    });
    it('keeps cancellation idempotent when completion wins the live-control race', async () => {
      const service = await filesService();
      jest.mocked(service.taskFiles).get.mockReturnValue(transfer);
      jest.spyOn(service.downloads, 'cancelDownload').mockReturnValue(false);
      jest.spyOn(service.downloads, 'drain').mockImplementation(() => {
        jest
          .mocked(service.taskFiles)
          .get.mockReturnValue({ ...transfer, status: 'complete' });
        return Promise.resolve();
      });
      expect(
        await service.cancelTransfer({
          browserId: transfer.browserId,
          transferId: transfer.id,
        }),
      ).toMatchObject({ ok: true, transfer: { status: 'complete' } });
    });
    it('does not trust a queued cancellation that failed its asynchronous owner check', async () => {
      const service = await filesService();
      jest.mocked(service.taskFiles).get.mockReturnValue(transfer);
      jest.spyOn(service.downloads, 'cancelDownload').mockReturnValue(true);
      jest.spyOn(service.downloads, 'drain').mockResolvedValue(undefined);
      expect(
        await service.cancelTransfer({
          browserId: transfer.browserId,
          transferId: transfer.id,
        }),
      ).toMatchObject({ ok: false, error: { code: 'not_cancellable' } });
    });
    it('rejects an unknown or another browser transfer without invoking live controls', async () => {
      const service = await filesService();
      const cancel = jest.spyOn(service.downloads, 'cancelDownload');
      jest
        .mocked(service.taskFiles)
        .get.mockReturnValue({ ...transfer, browserId: 'another-browser' });
      expect(
        await service.cancelTransfer({
          browserId: transfer.browserId,
          transferId: transfer.id,
        }),
      ).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(cancel).not.toHaveBeenCalled();
    });
    it('captures attribution at dispatch, includes only that action downloads and clears its full runtime key', async () => {
      const service = await filesService();
      installNativePipeline();
      jest
        .spyOn(PageModelHost.prototype, 'hostActionTarget')
        .mockImplementation((target) =>
          Promise.resolve({ ...target, objectId: 'host-target' }),
        );
      jest
        .mocked(service.taskFiles)
        .forAction.mockReturnValue([{ ...transfer, status: 'complete' }]);
      const runtime = {
        browserId: transfer.browserId,
        runtimeGeneration: 1,
        taskIncarnationId: 'fixture-incarnation',
      };
      jest
        .spyOn(SelectActions, 'runSelectOption')
        .mockImplementation((options) => {
          expect(
            jest.mocked(service.taskFiles).setAttribution.mock.calls,
          ).toHaveLength(0);
          options.lane.beginDispatch();
          expect(
            jest.mocked(service.taskFiles).setAttribution.mock.calls,
          ).toContainEqual([runtime, transfer.actionId]);
          return Promise.resolve({
            inputMode: 'direct',
            readback: { code: 'state_unchanged' },
            warnings: [],
          });
        });
      try {
        const result = await service.automation({
          browserId: transfer.browserId,
          command: {
            kind: 'select_option',
            ref: 'r',
            values: ['amber'],
            actionId: transfer.actionId,
          },
        });
        expect(result.receipt?.effects?.downloads).toEqual([
          { ...transfer, status: 'complete' },
        ]);
        expect(
          jest.mocked(service.taskFiles).forAction.mock.calls,
        ).toContainEqual([runtime, transfer.actionId]);
        expect(
          jest.mocked(service.taskFiles).setAttribution.mock.calls,
        ).toEqual([
          [runtime, transfer.actionId],
          [runtime, undefined],
        ]);
      } finally {
        jest.restoreAllMocks();
      }
    });
    it('waits for downloads through the task store without a DOM probe', async () => {
      const service = await filesService();
      const final = { ...transfer, status: 'complete' as const };
      jest.mocked(service.taskFiles).waitForDownload.mockResolvedValue(final);
      const result = await service.automation({
        browserId: transfer.browserId,
        command: { kind: 'wait_for', download: { downloadId: transfer.id } },
      });
      expect(result).toMatchObject({
        waitFor: {
          satisfied: true,
          observed: { download: final },
        },
      });
      const call = jest.mocked(service.taskFiles).waitForDownload.mock.calls[0];
      expect(call?.slice(0, 2)).toEqual([scope, transfer.browserId]);
      const options = jest.mocked(service.taskFiles).waitForDownload.mock
        .calls[0]?.[2];
      expect(options?.downloadId).toBe(transfer.id);
      expect(typeof options?.since).toBe('number');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(modelSeam.waitProbe).not.toHaveBeenCalled();
    });
    it('uses host-only path resolution for show, and live controls for resume and allow_more', async () => {
      const service = await filesService();
      jest
        .mocked(service.taskFiles)
        .get.mockReturnValue({ ...transfer, status: 'complete' });
      jest
        .mocked(service.taskFiles)
        .resolveLocalPath.mockResolvedValue('/host-only/report.csv');
      const host = { revealInFolder: jest.fn() };
      expect(
        await service.transferCommand(
          {
            kind: 'show',
            browserId: transfer.browserId,
            transferId: transfer.id,
          },
          host,
        ),
      ).toMatchObject({ ok: true, transfer: { fileName: 'report.csv' } });
      expect(host.revealInFolder).toHaveBeenCalledWith('/host-only/report.csv');
      const resume = jest
        .spyOn(service.downloads, 'resumeDownload')
        .mockResolvedValue(true);
      jest.mocked(service.taskFiles).get.mockReturnValue({
        ...transfer,
        status: 'interrupted',
        canResume: true,
      });
      expect(
        await service.transferCommand(
          {
            kind: 'resume',
            browserId: transfer.browserId,
            transferId: transfer.id,
          },
          host,
        ),
      ).toMatchObject({ ok: true });
      expect(resume).toHaveBeenCalledWith(scope, transfer.id);
      expect(
        await service.transferCommand(
          { kind: 'allow_more', browserId: transfer.browserId },
          host,
        ),
      ).toEqual({ ok: true });
      expect(
        jest.mocked(service.taskFiles).allowMore.mock.calls,
      ).toContainEqual([transfer.browserId]);
    });
    describe('upload_files', () => {
      const chat = {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      };
      const source: UploadSource = {
        kind: 'workspace',
        name: 'report.csv',
        displayPath: 'exports/report.csv',
        path: '/workspace/exports/report.csv',
        identity: { dev: 1, ino: 2 },
        sizeBytes: 8,
      };
      const staging: BrowserUploadTransfer = {
        kind: 'upload',
        id: 'upload-1',
        browserId: transfer.browserId,
        actionId: 'upload-action',
        frameOrigin: 'https://app.example',
        topOrigin: 'https://app.example',
        files: [
          {
            name: 'report.csv',
            displayPath: 'exports/report.csv',
            sizeBytes: 8,
          },
        ],
        stagedBytes: 0,
        totalBytes: 8,
        status: 'staging',
        startedAt: 1,
      };
      const waiting: BrowserUploadTransfer = {
        ...staging,
        files: [{ ...(staging.files[0] ?? source), sha256: 'a'.repeat(64) }],
        stagedBytes: 8,
        status: 'awaiting_approval',
      };
      /** An iframe inside a drop target. */
      const FRAME_OWNER_NODE = 90;
      /** The upload's CDP calls on top of the native pipeline; origins in order. */
      /** The frame's origin and document, which a test may change between the steps. */
      const page = {
        origin: 'https://app.example',
        loaderId: 'initial-document',
        connected: true,
        /** What the browser's hit test finds at a drop point. */
        hit: { backendNodeId: 77, frameId: 'main-frame' },
      };
      function installUploadPage(
        options: {
          input?: { attributes: string[] } | null;
        } = {},
      ): void {
        page.origin = 'https://app.example';
        page.loaderId = 'initial-document';
        page.connected = true;
        page.hit = { backendNodeId: 77, frameId: 'main-frame' };
        installNativePipeline();
        const native = webContents.debugger.sendCommand.getMockImplementation();
        webContents.debugger.sendCommand.mockImplementation(
          (
            method: string,
            params?: Record<string, unknown>,
            sessionId?: string,
          ): Promise<unknown> => {
            if (
              method === 'Runtime.callFunctionOn' &&
              String(params?.functionDeclaration).includes('const isFile')
            )
              return Promise.resolve(
                options.input === null
                  ? { result: { type: 'object', subtype: 'null' } }
                  : { result: { objectId: 'file-input' } },
              );
            if (
              method === 'Runtime.callFunctionOn' &&
              params?.functionDeclaration === CONNECTED_FUNCTION
            )
              return Promise.resolve({
                result: { type: 'boolean', value: page.connected },
              });
            if (method === 'Page.getLayoutMetrics')
              return Promise.resolve({
                cssLayoutViewport: { pageX: 0, pageY: 600 },
              });
            if (method === 'DOM.getNodeForLocation')
              return Promise.resolve({ ...page.hit });
            if (
              method === 'DOM.describeNode' &&
              params?.backendNodeId === FRAME_OWNER_NODE
            )
              return Promise.resolve({
                node: { backendNodeId: FRAME_OWNER_NODE, nodeName: 'IFRAME' },
              });
            if (method === 'DOM.describeNode')
              return Promise.resolve({
                node: {
                  backendNodeId: 77,
                  nodeName: 'INPUT',
                  attributes: options.input?.attributes ?? ['type', 'file'],
                },
              });
            if (method === 'Page.getFrameTree') {
              const origin = page.origin;
              return Promise.resolve({
                frameTree: {
                  frame: {
                    id: 'main-frame',
                    url: 'https://app.example/form',
                    loaderId: page.loaderId,
                    securityOrigin: origin,
                  },
                },
              });
            }
            if (method === 'DOM.setFileInputFiles') return Promise.resolve({});
            return native
              ? native(method, params, sessionId)
              : Promise.resolve({});
          },
        );
      }
      async function uploading(
        options: Partial<BrowserServiceOptions> = {},
      ): Promise<BrowserService> {
        const service = await filesService(options);
        jest
          .mocked(workspaceUploadSource)
          .mockReturnValue({ ok: true, source });
        jest
          .mocked(service.taskFiles)
          .startUpload.mockReturnValue({ ok: true, transfer: staging });
        jest
          .mocked(service.taskFiles)
          .waitForTransfer.mockResolvedValue(waiting);
        jest
          .mocked(service.taskFiles)
          .stagedUploadPaths.mockReturnValue([
            '/task/browser-files/uploads/upload-1/0/report.csv',
          ]);
        jest
          .mocked(service.taskFiles)
          .endUpload.mockImplementation((_scope, _id, outcome) =>
            Promise.resolve({
              ...waiting,
              status: outcome.status,
              ...(outcome.error ? { error: outcome.error } : {}),
            }),
          );
        jest
          .mocked(requestChatApproval)
          .mockResolvedValue({ decision: 'allow' });
        return service;
      }
      const command = {
        kind: 'upload_files' as const,
        locator: '#drop',
        files: [{ path: 'exports/report.csv' }],
        actionId: 'upload-action',
      };
      function setFileCalls(): unknown[][] {
        return webContents.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === 'DOM.setFileInputFiles',
        );
      }

      it('stages, asks the calling chat about the frame’s origin, then attaches the staged copies', async () => {
        const service = await uploading();
        installUploadPage();
        const result = await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command,
        });

        expect(result.receipt?.error).toBeUndefined();
        expect(result).toMatchObject({
          ok: true,
          receipt: {
            kind: 'upload_files',
            status: 'executed',
            upload: { status: 'attached' },
          },
        });
        expect(jest.mocked(service.taskFiles).startUpload.mock.calls).toEqual([
          [
            scope,
            {
              browserId: transfer.browserId,
              actionId: 'upload-action',
              frameOrigin: 'https://app.example',
              topOrigin: 'https://app.example',
              sources: [source],
            },
          ],
        ]);
        expect(jest.mocked(requestChatApproval).mock.calls).toEqual([
          [
            'project-1',
            'worktree-1',
            'chat-1',
            {
              kind: 'browser-upload',
              origin: 'https://app.example',
              topOrigin: 'https://app.example',
              files: [{ displayPath: 'exports/report.csv', sizeBytes: 8 }],
            },
            expect.objectContaining({
              title: 'Upload report.csv to app.example?',
              suggestedTarget: {
                kind: 'browser-upload',
                origin: 'https://app.example',
              },
            }),
          ],
        ]);
        expect(setFileCalls()).toEqual([
          [
            'DOM.setFileInputFiles',
            {
              files: ['/task/browser-files/uploads/upload-1/0/report.csv'],
              backendNodeId: 77,
            },
          ],
        ]);
        expect(JSON.stringify(result)).not.toContain('/task/');
      });

      it('records an attached upload by file name only, and nothing for a denied one', async () => {
        const service = await uploading();
        installUploadPage();
        await service.startRecording(transfer.browserId);
        jest
          .mocked(requestChatApproval)
          .mockResolvedValueOnce({ decision: 'deny' });
        await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command: { ...command, actionId: 'denied-upload' },
        });
        expect(
          service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action === 'upload'),
        ).toEqual([]);
        await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command,
        });
        const recording = service.getRecording(transfer.browserId);
        expect(
          recording.steps.filter((step) => step.action === 'upload'),
        ).toEqual([
          expect.objectContaining({ action: 'upload', values: ['report.csv'] }),
        ]);
        expect(recording.playwrightScript).toContain('"report.csv"');
        const text = JSON.stringify(recording);
        expect(text).not.toContain('exports/');
        expect(text).not.toContain('/task/');
        expect(text).not.toContain('/workspace');
      });

      it('records the file input the upload attached to, not the button it was found from', async () => {
        const service = await uploading();
        installUploadPage();
        const locators = jest
          .spyOn(PageModelHost.prototype, 'recordingLocator')
          .mockImplementation((target) =>
            Promise.resolve(
              // 77 is the input describeFileInput finds; 22 the button.
              target.identity.backendNodeId === 77
                ? "page.getByLabel('Attachment')"
                : "page.getByRole('button', { name: 'Choose' })",
            ),
          );
        try {
          await service.startRecording(transfer.browserId);
          await service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          });
          const uploads = service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action === 'upload');
          expect(uploads.map((step) => step.locator)).toEqual([
            "page.getByLabel('Attachment')",
          ]);
          expect(uploads[0]?.playwright).toContain(
            'await page.getByLabel(\'Attachment\').setInputFiles(["report.csv"]);',
          );
        } finally {
          locators.mockRestore();
        }
      });

      it('records an upload before a download its attach started while the upload was being saved', async () => {
        const service = await uploading();
        installUploadPage();
        await service.startRecording(transfer.browserId);
        jest
          .mocked(service.taskFiles)
          .endUpload.mockImplementation(async (_scope, _id, outcome) => {
            // The page starts a download on the input's change while the
            // upload's record is still being written.
            mockTaskFilesDeps?.emit({
              type: 'transfer',
              browserId: transfer.browserId,
              transfer: {
                ...transfer,
                id: 'triggered',
                fileName: 'receipt.pdf',
                startedAt: Date.now(),
              },
            });
            await new Promise((resolveWrite) => setTimeout(resolveWrite, 5));
            return { ...waiting, status: outcome.status };
          });
        await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command,
        });
        expect(
          service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action !== 'goto')
            .map((step) => step.action),
        ).toEqual(['upload', 'download']);
      });

      it('records an upload before a download its attach started in the same millisecond', async () => {
        const service = await uploading();
        installUploadPage();
        await service.startRecording(transfer.browserId);
        const native = webContents.debugger.sendCommand.getMockImplementation();
        // One frozen millisecond for the attach and the download it starts.
        const clock = jest
          .spyOn(Date, 'now')
          .mockReturnValue(Date.now() + 1_000);
        try {
          webContents.debugger.sendCommand.mockImplementation(
            async (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> => {
              if (method === 'DOM.setFileInputFiles')
                mockTaskFilesDeps?.emit({
                  type: 'transfer',
                  browserId: transfer.browserId,
                  transfer: {
                    ...transfer,
                    id: 'same-ms',
                    fileName: 'receipt.pdf',
                    startedAt: Date.now(),
                  },
                });
              return native ? await native(method, params, sessionId) : {};
            },
          );
          await service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          });
        } finally {
          clock.mockRestore();
        }
        expect(
          service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action !== 'goto')
            .map((step) => step.action),
        ).toEqual(['upload', 'download']);
      });

      it('records an upload before a page step the user took while the upload was being saved', async () => {
        const service = await uploading();
        installUploadPage();
        await service.startRecording(transfer.browserId);
        jest
          .mocked(service.taskFiles)
          .endUpload.mockImplementation(async (_scope, _id, outcome) => {
            // The user submits the form while the upload's record is written.
            ipcListeners.get('canopy-browser-view:event')?.(
              { sender: { id: webContents.id } },
              {
                type: 'recording-step',
                step: {
                  id: 'submit-click',
                  action: 'click',
                  locator: "page.getByRole('button', { name: 'Submit' })",
                  playwright:
                    "await page.getByRole('button', { name: 'Submit' }).click();",
                  timestamp: Date.now(),
                },
              },
            );
            await new Promise((resolveWrite) => setTimeout(resolveWrite, 5));
            return { ...waiting, status: outcome.status };
          });
        await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command,
        });
        expect(
          service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action !== 'goto')
            .map((step) => step.action),
        ).toEqual(['upload', 'click']);
      });

      it('records an upload whose staging outlasts the action once it attaches', async () => {
        const service = await uploading();
        installUploadPage();
        await service.startRecording(transfer.browserId);
        let release = (): void => undefined;
        const staged = new Promise<void>((resolveStaged) => {
          release = resolveStaged;
        });
        jest
          .mocked(service.taskFiles)
          .waitForTransfer.mockImplementation((_scope, _id, options) =>
            Promise.race([
              staged.then(() => waiting),
              new Promise<undefined>((resolveAborted) => {
                options?.signal?.addEventListener('abort', () =>
                  resolveAborted(undefined),
                );
              }),
            ]),
          );
        const result = await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command: { ...command, timeoutMs: 1 },
        });
        expect(result.receipt?.warnings?.[0]).toContain('Staging continues.');
        const uploads = (): BrowserRecordingStep[] =>
          service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action === 'upload');
        expect(uploads()).toEqual([]);
        release();
        for (let tick = 0; tick < 50 && uploads().length === 0; tick++)
          await new Promise((resolveTick) => setImmediate(resolveTick));
        expect(uploads()).toEqual([
          expect.objectContaining({ values: ['report.csv'] }),
        ]);
      });

      it('puts the link an upload was asked for on the check, so deny rules can match it', async () => {
        const service = await uploading();
        installUploadPage();
        jest.mocked(workspaceUploadSource).mockReturnValue({
          ok: true,
          source: {
            ...source,
            name: 'k',
            displayPath: 'secrets/key.pem',
            requestedPath: 'public/k',
          },
        });
        await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command: { ...command, files: [{ path: 'public/k' }] },
        });
        expect(jest.mocked(requestChatApproval).mock.calls[0]?.[3]).toEqual({
          kind: 'browser-upload',
          origin: 'https://app.example',
          topOrigin: 'https://app.example',
          files: [
            {
              displayPath: 'exports/report.csv',
              requestedPath: 'public/k',
              sizeBytes: 8,
            },
          ],
        });
      });

      it('compares the frame’s document with the browser’s own record of it, not the page model’s', async () => {
        const service = await uploading();
        installUploadPage();
        // A cross-site frame's model identity can name another loader.
        page.loaderId = 'frame-tree-loader';
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          }),
        ).resolves.toMatchObject({
          ok: true,
          receipt: { upload: { status: 'attached' } },
        });
      });

      it('attaches nothing when the frame shows another document of the same site after approval', async () => {
        const service = await uploading();
        installUploadPage();
        jest.mocked(requestChatApproval).mockImplementation(() => {
          page.loaderId = 'next-document';
          return Promise.resolve({ decision: 'allow' });
        });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          }),
        ).resolves.toMatchObject({
          receipt: {
            error: { code: 'execution_failed' },
            upload: { status: 'failed' },
          },
        });
        expect(setFileCalls()).toEqual([]);
      });

      it('never stages or asks for a file that is not eligible, and refuses without a chat to ask', async () => {
        const service = await uploading();
        installUploadPage();
        jest.mocked(workspaceUploadSource).mockReturnValue({
          ok: false,
          error: {
            code: 'file_not_eligible',
            message: "Files in a .git folder can't be uploaded.",
          },
        });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: { ...command, files: [{ path: '.git/config' }] },
          }),
        ).resolves.toMatchObject({
          ok: false,
          receipt: {
            status: 'not_executed',
            error: { code: 'file_not_eligible' },
          },
        });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            command: { ...command, actionId: 'upload-no-chat' },
          }),
        ).resolves.toMatchObject({
          ok: false,
          receipt: { error: { code: 'approval_denied' } },
        });
        expect(jest.mocked(service.taskFiles).startUpload.mock.calls).toEqual(
          [],
        );
        expect(requestChatApproval).not.toHaveBeenCalled();
        expect(setFileCalls()).toEqual([]);
      });

      it('refuses several files for an input that takes one, and a target with no file input', async () => {
        const service = await uploading();
        installUploadPage();
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: {
              ...command,
              files: [{ path: 'a.csv' }, { path: 'b.csv' }],
            },
          }),
        ).resolves.toMatchObject({
          receipt: { error: { code: 'unsupported_control' } },
        });
        installUploadPage({ input: null });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: { ...command, actionId: 'upload-action-2' },
          }),
        ).resolves.toMatchObject({
          receipt: { error: { code: 'unsupported_control' } },
        });
        expect(jest.mocked(service.taskFiles).startUpload.mock.calls).toEqual(
          [],
        );
      });

      it('attaches nothing when the chat denies the upload', async () => {
        const service = await uploading();
        installUploadPage();
        jest
          .mocked(requestChatApproval)
          .mockResolvedValue({ decision: 'deny' });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          }),
        ).resolves.toMatchObject({
          ok: false,
          receipt: {
            error: { code: 'approval_denied' },
            upload: { status: 'denied' },
          },
        });
        expect(setFileCalls()).toEqual([]);
      });

      it('attaches nothing when the frame shows another site after approval', async () => {
        const service = await uploading();
        installUploadPage();
        // The page navigates to another site while the prompt is open.
        jest.mocked(requestChatApproval).mockImplementation(() => {
          page.origin = 'https://elsewhere.example';
          return Promise.resolve({ decision: 'allow' });
        });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          }),
        ).resolves.toMatchObject({
          receipt: { error: { code: 'origin_changed' } },
        });
        expect(setFileCalls()).toEqual([]);
      });

      it('attaches nothing when a staged copy changed after approval', async () => {
        const service = await uploading();
        installUploadPage();
        jest
          .mocked(service.taskFiles)
          .stagedUploadMatches.mockResolvedValue(false);
        await expect(
          service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command,
          }),
        ).resolves.toMatchObject({
          receipt: { error: { code: 'file_changed' } },
        });
        expect(setFileCalls()).toEqual([]);
      });

      it.each([
        ['attached', true],
        ['failed', false],
      ] as const)(
        'reports an attach that outlasts its time as unknown, keeps the copies, and ends %s when the browser answers',
        async (status, succeeds) => {
          const service = await uploading();
          installUploadPage();
          await service.startRecording(transfer.browserId);
          let answer = (): void => undefined;
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          webContents.debugger.sendCommand.mockImplementation(
            (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> =>
              method === 'DOM.setFileInputFiles'
                ? new Promise((resolvePromise, rejectPromise) => {
                    answer = (): void =>
                      succeeds
                        ? resolvePromise({})
                        : rejectPromise(new Error('Node is detached'));
                  })
                : native
                  ? native(method, params, sessionId)
                  : Promise.resolve({}),
          );
          jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
          try {
            const pending = service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command,
            });
            await jest.advanceTimersByTimeAsync(31_000);
            const result = await pending;
            expect(result).toMatchObject({
              ok: true,
              receipt: {
                kind: 'upload_files',
                status: 'outcome_unknown',
                outcomeReason: 'dispatch_timeout',
              },
            });
            expect(result.receipt?.warnings?.[0]).toContain(
              "browser.wait_for({ upload: { uploadId: 'upload-1' } })",
            );
            // The page may still read the copies: nothing ends the upload yet.
            expect(jest.mocked(service.taskFiles).endUpload.mock.calls).toEqual(
              [],
            );
            answer();
            await jest.advanceTimersByTimeAsync(0);
            expect(
              jest
                .mocked(service.taskFiles)
                .endUpload.mock.calls.map(([, , outcome]) => outcome.status),
            ).toEqual([status]);
            // A late attach is still a recorded step; a failed one is not.
            expect(
              service
                .getRecording(transfer.browserId)
                .steps.filter((step) => step.action === 'upload')
                .map((step) => step.values),
            ).toEqual(succeeds ? [['report.csv']] : []);
          } finally {
            jest.useRealTimers();
          }
        },
      );

      it('reports staging that outlasts the wait, and goes on to ask afterwards', async () => {
        const service = await uploading();
        installUploadPage();
        const waiters: Array<(upload: BrowserUploadTransfer) => void> = [];
        const release = (upload: BrowserUploadTransfer): void => {
          for (const waiter of waiters.splice(0)) waiter(upload);
        };
        jest.mocked(service.taskFiles).waitForTransfer.mockImplementation(
          (_scope, _id, options) =>
            new Promise((resolvePromise) => {
              waiters.push(resolvePromise);
              options.signal.addEventListener('abort', () =>
                resolvePromise(undefined),
              );
            }),
        );
        jest.mocked(service.taskFiles).get.mockReturnValue(staging);
        const result = await service.automation({
          browserId: transfer.browserId,
          approvalChat: chat,
          command: { ...command, timeoutMs: 20 },
        });
        expect(result).toMatchObject({
          ok: true,
          receipt: { status: 'executed', upload: { status: 'staging' } },
        });
        expect(result.receipt?.warnings?.[0]).toContain(
          "browser.wait_for({ upload: { uploadId: 'upload-1' } })",
        );
        release(waiting);
        await new Promise((done) => setTimeout(done, 50));
        expect(requestChatApproval).toHaveBeenCalledTimes(1);
      });

      it('waits for an upload to end, and cancels one only before it is attached', async () => {
        const service = await uploading();
        installUploadPage();
        jest.mocked(service.taskFiles).get.mockReturnValue(waiting);
        jest.mocked(service.taskFiles).waitForTransfer.mockResolvedValue({
          ...waiting,
          status: 'attached',
        });
        await expect(
          service.automation({
            browserId: transfer.browserId,
            command: { kind: 'wait_for', upload: { uploadId: 'upload-1' } },
          }),
        ).resolves.toMatchObject({
          ok: true,
          waitFor: {
            satisfied: true,
            observed: { upload: { status: 'attached' } },
          },
        });

        jest
          .mocked(service.taskFiles)
          .get.mockReturnValue({ ...waiting, status: 'attached' });
        await expect(
          service.cancelTransfer({
            browserId: transfer.browserId,
            transferId: 'upload-1',
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'not_cancellable' },
        });
        jest.mocked(service.taskFiles).get.mockReturnValue(waiting);
        jest.mocked(service.taskFiles).waitForTransfer.mockResolvedValue({
          ...waiting,
          status: 'cancelled',
        });
        await expect(
          service.cancelTransfer({
            browserId: transfer.browserId,
            transferId: 'upload-1',
          }),
        ).resolves.toMatchObject({
          ok: true,
          transfer: { status: 'cancelled' },
        });
        expect(jest.mocked(service.taskFiles).cancelUpload.mock.calls).toEqual([
          [scope, 'upload-1'],
        ]);
      });

      describe('phase 08c: chat attachments and drop_files', () => {
        const attached: UploadSource = {
          ...source,
          kind: 'attachment',
          name: 'photo.png',
          displayPath: 'photo.png (attached to this chat)',
          path: '/attachments/photo.png',
        };
        const attachmentCommand = {
          kind: 'upload_files',
          locator: '#drop',
          files: [{ attachmentId: 'photo.png' }],
          actionId: 'attach-1',
        } satisfies BrowserAutomationCommand;

        it('uploads a file the user attached to the calling chat, named by its file name', async () => {
          const chatAttachmentPaths = jest.fn(() =>
            Promise.resolve(['/attachments/photo.png']),
          );
          const service = await uploading({
            chatAttachmentPaths,
            resolveAttachmentsFolder: () => '/attachments',
          });
          installUploadPage();
          jest
            .mocked(attachmentUploadSource)
            .mockReturnValue({ ok: true, source: attached });
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: attachmentCommand,
            }),
          ).resolves.toMatchObject({
            ok: true,
            receipt: { status: 'executed', upload: { status: 'attached' } },
          });
          expect(chatAttachmentPaths.mock.calls).toEqual([[chat]]);
          expect(jest.mocked(attachmentUploadSource).mock.calls).toEqual([
            ['/attachments', 'photo.png', ['/attachments/photo.png']],
          ]);
          expect(
            jest.mocked(service.taskFiles).startUpload.mock.calls[0]?.[1]
              .sources,
          ).toEqual([attached]);
        });

        it('refuses an attachment the calling chat does not name, or whose chat cannot be read, before asking', async () => {
          const chatAttachmentPaths = jest.fn(() =>
            Promise.resolve(['/attachments/other.png']),
          );
          const service = await uploading({
            chatAttachmentPaths,
            resolveAttachmentsFolder: () => '/attachments',
          });
          installUploadPage();
          jest.mocked(attachmentUploadSource).mockReturnValue({
            ok: false,
            error: {
              code: 'file_not_eligible',
              message: "That isn't a file the user attached to this chat.",
            },
          });
          jest.mocked(requestChatApproval).mockClear();
          const refused = {
            receipt: {
              status: 'not_executed',
              error: { code: 'file_not_eligible' },
            },
          };
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: attachmentCommand,
            }),
          ).resolves.toMatchObject(refused);
          chatAttachmentPaths.mockRejectedValueOnce(new Error('damaged'));
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: { ...attachmentCommand, actionId: 'attach-2' },
            }),
          ).resolves.toMatchObject(refused);
          expect(jest.mocked(service.taskFiles).startUpload.mock.calls).toEqual(
            [],
          );
          expect(requestChatApproval).not.toHaveBeenCalled();
        });

        it.each([
          [
            'an iframe inside the target',
            { backendNodeId: 90, frameId: 'main-frame' },
          ],
          ['another frame', { backendNodeId: 12, frameId: 'child-frame' }],
        ])(
          'drops nothing when the drop point lands on %s',
          async (_case, hit) => {
            const service = await uploading();
            installUploadPage();
            page.hit = hit;
            await expect(
              service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command: {
                  kind: 'drop_files',
                  locator: '#drop',
                  files: [{ path: 'exports/report.csv' }],
                  actionId: 'framed-drop',
                },
              }),
            ).resolves.toMatchObject({
              receipt: {
                kind: 'drop_files',
                status: 'not_executed',
                error: {
                  code: 'execution_failed',
                  message:
                    'Another frame is at the drop point, so nothing was dropped.',
                },
              },
            });
            expect(
              webContents.debugger.sendCommand.mock.calls.filter(
                ([method]) => method === 'Input.dispatchDragEvent',
              ),
            ).toEqual([]);
            expect(
              jest
                .mocked(service.taskFiles)
                .endUpload.mock.calls.map(([, , outcome]) => outcome.status),
            ).toEqual(['failed']);
          },
        );

        it('drops the approved staged copies on the target with drag events, and sets no input files', async () => {
          const service = await uploading();
          installUploadPage();
          const result = await service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: {
              kind: 'drop_files',
              locator: '#drop',
              files: [{ path: 'exports/report.csv' }],
              actionId: 'drop-1',
            },
          });
          expect(result.receipt?.error).toBeUndefined();
          expect(result).toMatchObject({
            ok: true,
            receipt: {
              kind: 'drop_files',
              status: 'executed',
              upload: { status: 'attached' },
            },
          });
          const drags = webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === 'Input.dispatchDragEvent',
          );
          // The hit test takes document coordinates: the drop point plus the scroll.
          const [hitTest] = webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === 'DOM.getNodeForLocation',
          );
          expect(hitTest?.[1]?.y).toBe(
            Math.round(Number(drags[0]?.[1]?.y) + 600),
          );
          expect(drags.map(([, params]) => params?.type)).toEqual([
            'dragEnter',
            'dragOver',
            'drop',
          ]);
          for (const [, params] of drags) {
            expect(typeof params?.x).toBe('number');
            expect(typeof params?.y).toBe('number');
            expect(params).toMatchObject({
              data: {
                items: [],
                files: ['/task/browser-files/uploads/upload-1/0/report.csv'],
                dragOperationsMask: 1,
              },
            });
          }
          expect(setFileCalls()).toEqual([]);
          expect(JSON.stringify(result)).not.toContain('/task/');
        });
      });

      describe('HTTP sign-ins and action effects', () => {
        async function settle(): Promise<void> {
          for (let index = 0; index < 10; index++)
            await new Promise((resolveTick) => setImmediate(resolveTick));
        }
        function authEvents(): Array<BrowserAuthRequest | null> {
          return sentBrowserEvents().flatMap((event) =>
            event.type === 'auth-request' ? [event.request] : [],
          );
        }
        const challenge = {
          isProxy: false,
          scheme: 'basic',
          host: 'app.example',
          port: 443,
          realm: 'Staff',
        };
        function login(
          info: typeof challenge = challenge,
          url = 'https://app.example/protected',
        ): jest.Mock<void, [string?, string?]> {
          const callback = jest.fn<void, [string?, string?]>();
          const event = { preventDefault: jest.fn() };
          webContents.emit('login', event, { url }, info, callback);
          expect(event.preventDefault).toHaveBeenCalled();
          return callback;
        }

        it('names a pending sign-in when a screenshot is unavailable', async () => {
          const service = await filesService();
          webContents.capturePage.mockResolvedValue({
            isEmpty: () => true,
            toDataURL: () => 'data:image/png;base64,',
            toPNG: () => Buffer.alloc(0),
            toJPEG: () => Buffer.alloc(0),
          });
          login();
          await expect(
            service.screenshot({ browserId: transfer.browserId }),
          ).rejects.toThrow(
            'Browser screenshot is unavailable. The page is waiting for a sign-in to https://app.example; only the user can sign in. Ask them, or cancel it with browser.handle_dialog.',
          );
        });

        it('holds a sign-in for the user, joins a same-realm repeat, and passes only the user’s credentials on', async () => {
          const service = await filesService();
          const first = login();
          const repeat = login();
          const other = login({ ...challenge, realm: 'Other' });
          expect(other).toHaveBeenCalledWith();
          const [held] = authEvents();
          expect(held?.id).toMatch(/^auth-/);
          expect(held).toMatchObject({
            browserId: transfer.browserId,
            runtimeGeneration: 1,
            origin: 'https://app.example',
            realm: 'Staff',
            isProxy: false,
          });
          expect(Object.keys(held ?? {}).sort()).toEqual([
            'browserId',
            'expiresAt',
            'id',
            'isProxy',
            'openedAt',
            'origin',
            'realm',
            'runtimeGeneration',
          ]);
          expect(service.getAuthRequest(transfer.browserId)).toEqual(held);
          expect(
            service.answerAuthRequest({
              browserId: transfer.browserId,
              authRequestId: held?.id ?? '',
              answer: 'sign_in',
              username: 'ada',
              password: 'secret-7Q4M',
            }),
          ).toEqual({ ok: true });
          expect(first).toHaveBeenCalledWith('ada', 'secret-7Q4M');
          expect(repeat).toHaveBeenCalledWith('ada', 'secret-7Q4M');
          expect(authEvents().at(-1)).toBeNull();
          expect(service.getAuthRequest(transfer.browserId)).toBeNull();
          expect(JSON.stringify(sentBrowserEvents())).not.toContain(
            'secret-7Q4M',
          );
          expect(
            service.answerAuthRequest({
              browserId: transfer.browserId,
              authRequestId: held?.id ?? '',
              answer: 'cancel',
            }),
          ).toEqual({ ok: false });
        });

        it('cancels a sign-in on Cancel, after five minutes, and when the page navigates', async () => {
          jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
          try {
            const service = await filesService();
            const cancelled = login();
            const [held] = authEvents();
            service.answerAuthRequest({
              browserId: transfer.browserId,
              authRequestId: held?.id ?? '',
              answer: 'cancel',
            });
            expect(cancelled).toHaveBeenCalledWith();

            const expired = login();
            await jest.advanceTimersByTimeAsync(5 * 60_000);
            expect(expired).toHaveBeenCalledWith();
            expect(service.getAuthRequest(transfer.browserId)).toBeNull();

            const left = login();
            const message = webContents.debugger.on.mock.calls.find(
              ([event]) => event === 'message',
            )?.[1];
            message?.({}, 'Page.frameNavigated', {
              frame: {
                id: 'main-frame',
                loaderId: 'next',
                url: 'https://app.example/elsewhere',
              },
            });
            expect(left).toHaveBeenCalledWith();
            expect(authEvents().filter((event) => event === null)).toHaveLength(
              3,
            );
          } finally {
            jest.useRealTimers();
          }
        });

        it('ends a sign-in when the next page starts loading or the load is stopped, so a new challenge reaches the user', async () => {
          const service = await filesService();
          const stale = login();
          webContents.emit('did-start-navigation', {
            isMainFrame: true,
            isSameDocument: true,
            url: 'https://app.example/protected#top',
          });
          expect(stale).not.toHaveBeenCalled();
          webContents.emit('did-start-navigation', {
            isMainFrame: false,
            isSameDocument: false,
            url: 'https://frame.example/',
          });
          expect(stale).not.toHaveBeenCalled();
          webContents.emit('did-start-navigation', {
            isMainFrame: true,
            isSameDocument: false,
            url: 'https://app.example/other-protected',
          });
          expect(stale).toHaveBeenCalledWith();
          expect(authEvents().at(-1)).toBeNull();

          const next = login(
            { ...challenge, realm: 'Other' },
            'https://app.example/other-protected',
          );
          expect(next).not.toHaveBeenCalled();
          expect(service.getAuthRequest(transfer.browserId)).toMatchObject({
            realm: 'Other',
          });

          await service.stop(transfer.browserId);
          expect(next).toHaveBeenCalledWith();
          expect(service.getAuthRequest(transfer.browserId)).toBeNull();
        });

        it('reports a popup the external opener refuses or fails to open as blocked', async () => {
          const service = await filesService();
          const handler =
            webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0];
          const sessions: unknown = Reflect.get(service, 'sessions');
          if (!(sessions instanceof Map)) throw new Error('Missing sessions.');
          const state: unknown = sessions.get(transfer.browserId);
          if (!isCDPRecord(state)) throw new Error('Missing session.');
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValueOnce('mail-1')
            .mockReturnValueOnce('open-1')
            .mockReturnValueOnce('fail-1');
          handler?.({ url: 'mailto:someone@example.com' });
          jest.spyOn(service, 'isUrlAllowedInApp').mockReturnValue(false);
          const openExternal = jest
            .spyOn(service, 'openExternal')
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('No handler for this URL.'));
          handler?.({ url: 'https://elsewhere.example/a' });
          handler?.({ url: 'https://elsewhere.example/b' });
          await settle();
          expect(openExternal).toHaveBeenCalledTimes(2);
          expect(state.actionPopups).toEqual([
            {
              actionId: 'mail-1',
              // The scheme alone: the address stays out of the receipt.
              popup: { url: 'mailto:', handled: 'blocked' },
            },
            {
              actionId: 'open-1',
              popup: {
                url: 'https://elsewhere.example/a',
                handled: 'opened_externally',
              },
            },
            {
              actionId: 'fail-1',
              popup: { url: 'https://elsewhere.example/b', handled: 'blocked' },
            },
          ]);
        });

        it('records popups and denied permissions only during an agent action, without query strings', async () => {
          const service = await filesService();
          const handler =
            webContents.setWindowOpenHandler.mock.calls.at(-1)?.[0];
          const sessions: unknown = Reflect.get(service, 'sessions');
          if (!(sessions instanceof Map)) throw new Error('Missing sessions.');
          const state: unknown = sessions.get(transfer.browserId);
          if (!isCDPRecord(state)) throw new Error('Missing session.');
          handler?.({ url: 'https://elsewhere.example/a?token=1' });
          denyPermission(
            webContents as unknown as WebContents,
            'geolocation',
            () => undefined,
          );
          expect(state.actionPopups ?? []).toEqual([]);
          expect(state.actionPermissionsDenied ?? []).toEqual([]);
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          handler?.({ url: 'https://elsewhere.example/a?token=1' });
          denyPermission(
            webContents as unknown as WebContents,
            'geolocation',
            () => undefined,
          );
          await settle();
          // The receipt names the tab main asked the renderer to open.
          const newTab = jest
            .mocked(sendToWindow)
            .mock.calls.map((call) => call[2])
            .findLast(
              (event) =>
                isCDPRecord(event) && event.type === 'new-tab-requested',
            );
          if (!isCDPRecord(newTab)) throw new Error('Missing new tab.');
          expect(state.actionPopups).toEqual([
            {
              actionId: 'click-1',
              popup: {
                url: 'https://elsewhere.example/a',
                // A web URL the app allows opens in a new tab.
                handled: 'opened_in_tab',
                browserId: newTab.newBrowserId,
              },
            },
          ]);
          expect(state.actionPermissionsDenied).toEqual([
            { actionId: 'click-1', permission: 'geolocation' },
          ]);
        });
      });

      describe('print requests', () => {
        function cdp(
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): void {
          const message = webContents.debugger.on.mock.calls.find(
            ([event]) => event === 'message',
          )?.[1];
          message?.({}, method, params, sessionId);
        }
        async function settle(): Promise<void> {
          for (let index = 0; index < 10; index++)
            await new Promise((resolveTick) => setImmediate(resolveTick));
        }
        function printEvents(): Array<BrowserPrintRequest | null> {
          return sentBrowserEvents().flatMap((event) =>
            event.type === 'print-request' ? [event.request] : [],
          );
        }
        async function printService(): Promise<BrowserService> {
          const service = await filesService();
          installUploadPage();
          cdp('Page.frameNavigated', {
            frame: {
              id: 'main-frame',
              loaderId: 'initial-document',
              url: 'https://app.example/form',
            },
          });
          cdp('Runtime.executionContextCreated', {
            context: { id: 5, auxData: { frameId: 'main-frame' } },
          });
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          webContents.debugger.sendCommand.mockImplementation(
            (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> =>
              method === 'Page.createIsolatedWorld'
                ? Promise.resolve({ executionContextId: 77 })
                : native
                  ? native(method, params, sessionId)
                  : Promise.resolve({}),
          );
          return service;
        }
        /** Blink's own print() replayed in an isolated world of the frame. */
        function nativePrints(): unknown[][] {
          return webContents.debugger.sendCommand.mock.calls.filter(
            ([method, params]) =>
              method === 'Runtime.evaluate' &&
              params?.expression === NATIVE_PRINT_EXPRESSION,
          );
        }
        const printed = (): void =>
          cdp('Runtime.bindingCalled', {
            name: '__canopyPrintRequested',
            payload: '',
            executionContextId: 5,
          });

        it('installs the print binding and wrapper on the page and on each frame session', async () => {
          await printService();
          cdp('Target.attachedToTarget', {
            sessionId: 'child-1',
            targetInfo: { type: 'iframe', targetId: 'frame-target' },
          });
          await settle();
          const calls = webContents.debugger.sendCommand.mock.calls;
          expect(calls).toContainEqual([
            'Runtime.addBinding',
            { name: '__canopyPrintRequested' },
          ]);
          expect(calls).toContainEqual([
            'Runtime.addBinding',
            { name: '__canopyPrintRequested' },
            'child-1',
          ]);
          const wrappers = calls.filter(
            ([method, params]) =>
              method === 'Page.addScriptToEvaluateOnNewDocument' &&
              String(params?.source).includes('__canopyPrintRequested'),
          );
          expect(wrappers.map((call) => call[2])).toEqual([
            undefined,
            'child-1',
          ]);
        });

        it('replays Blink’s own print() in an isolated world of the calling frame for a print outside an agent action', async () => {
          await printService();
          printed();
          await settle();
          const calls = webContents.debugger.sendCommand.mock.calls;
          expect(calls).toContainEqual([
            'Page.createIsolatedWorld',
            { frameId: 'main-frame', worldName: NATIVE_PRINT_WORLD },
            undefined,
          ]);
          expect(nativePrints()).toEqual([
            [
              'Runtime.evaluate',
              // No forged activation: Blink judges the page's own call.
              { expression: NATIVE_PRINT_EXPRESSION, contextId: 77 },
              undefined,
            ],
          ]);
          expect(webContents.print).not.toHaveBeenCalled();
          expect(printEvents()).toEqual([]);
        });

        it('replays a print outside an action even before the page model has registered the frame', async () => {
          await filesService();
          installUploadPage();
          cdp('Runtime.executionContextCreated', {
            context: { id: 5, auxData: { frameId: 'main-frame' } },
          });
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          webContents.debugger.sendCommand.mockImplementation(
            (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> =>
              method === 'Page.createIsolatedWorld'
                ? Promise.resolve({ executionContextId: 77 })
                : native
                  ? native(method, params, sessionId)
                  : Promise.resolve({}),
          );
          printed();
          await settle();
          expect(nativePrints()).toHaveLength(1);
        });

        function holdIsolatedWorld(): () => void {
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          let holding = true;
          let release = (): void => undefined;
          webContents.debugger.sendCommand.mockImplementation(
            async (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> => {
              if (holding && method === 'Page.createIsolatedWorld') {
                holding = false;
                await new Promise<void>((released) => {
                  release = released;
                });
              }
              return native ? native(method, params, sessionId) : {};
            },
          );
          return (): void => release();
        }

        it('drops a native replay when a request opened while its world was created', async () => {
          const service = await printService();
          const release = holdIsolatedWorld();
          printed();
          await settle();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          printed();
          await settle();
          expect(printEvents()).toHaveLength(1);
          release();
          await settle();
          expect(nativePrints()).toEqual([]);
          expect(service.getPrintRequest(transfer.browserId)).not.toBeNull();
        });

        it('drops a native replay whose document went while its world was created', async () => {
          await printService();
          const release = holdIsolatedWorld();
          printed();
          await settle();
          cdp('Page.frameNavigated', {
            frame: {
              id: 'main-frame',
              loaderId: 'next-document',
              url: 'https://app.example/next',
            },
          });
          release();
          await settle();
          expect(nativePrints()).toEqual([]);
        });

        it('ignores a later print, even outside an action, while a request waits', async () => {
          const service = await printService();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          printed();
          await settle();
          const [held] = printEvents();
          expect(held).toBeDefined();
          // The action ended; its request still waits.
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          printed();
          await settle();
          expect(nativePrints()).toEqual([]);
          expect(webContents.print).not.toHaveBeenCalled();
          expect(service.getPrintRequest(transfer.browserId)).toEqual(held);
        });

        it('holds a print an agent action asked for until it expires, its page navigates, or it is answered', async () => {
          jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
          try {
            const service = await printService();
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            printed();
            await settle();
            expect(nativePrints()).toEqual([]);
            const [held] = printEvents();
            expect(held?.id).toMatch(/^print-/);
            expect(held).toMatchObject({
              browserId: transfer.browserId,
              frameOrigin: 'https://app.example',
              topOrigin: 'https://app.example',
            });
            expect(service.getPrintRequest(transfer.browserId)).toEqual(held);
            // A second print while one waits is ignored.
            printed();
            await settle();
            expect(printEvents()).toHaveLength(1);

            await jest.advanceTimersByTimeAsync(10 * 60_000);
            expect(printEvents()).toEqual([held, null]);
            expect(service.getPrintRequest(transfer.browserId)).toBeNull();

            printed();
            await settle();
            cdp('Page.frameNavigated', {
              frame: { id: 'main-frame', url: 'https://app.example/next' },
            });
            expect(printEvents().at(-1)).toBeNull();

            printed();
            await settle();
            const pending = printEvents().at(-1);
            if (!pending) throw new Error('missing print request');
            await expect(
              service.answerPrintRequest({
                browserId: transfer.browserId,
                printRequestId: pending.id,
                answer: 'dismiss',
              }),
            ).resolves.toEqual({ ok: true });
            expect(printEvents().at(-1)).toBeNull();
            await expect(
              service.answerPrintRequest({
                browserId: transfer.browserId,
                printRequestId: pending.id,
                answer: 'save_pdf',
              }),
            ).resolves.toMatchObject({
              ok: false,
              error: { code: 'not_found' },
            });
            expect(nativePrints()).toEqual([]);
          } finally {
            jest.useRealTimers();
          }
        });

        it('saves a PDF for save_pdf and opens the native dialog for the user’s print', async () => {
          const service = await printService();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          const saving = jest
            .spyOn(service, 'savePdf')
            .mockResolvedValue({ ok: true, transfer });
          printed();
          await settle();
          const [first] = printEvents();
          await expect(
            service.answerPrintRequest({
              browserId: transfer.browserId,
              printRequestId: first?.id ?? '',
              answer: 'save_pdf',
            }),
          ).resolves.toEqual({ ok: true, transfer });
          expect(saving).toHaveBeenCalledWith({
            browserId: transfer.browserId,
          });
          printed();
          await settle();
          const second = printEvents().at(-1);
          await expect(
            service.answerPrintRequest({
              browserId: transfer.browserId,
              printRequestId: second?.id ?? '',
              answer: 'print',
            }),
          ).resolves.toEqual({ ok: true });
          await settle();
          expect(nativePrints()).toHaveLength(1);
          expect(nativePrints()[0]?.[1]).not.toHaveProperty('userGesture');
          expect(webContents.print).not.toHaveBeenCalled();
        });

        it('drops a print whose page navigates while its frame is read', async () => {
          const service = await printService();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          let release = (): void => undefined;
          webContents.debugger.sendCommand.mockImplementation(
            async (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> => {
              if (method === 'Page.getFrameTree')
                await new Promise<void>((released) => {
                  release = released;
                });
              return native ? native(method, params, sessionId) : {};
            },
          );
          printed();
          await settle();
          cdp('Page.frameNavigated', {
            frame: {
              id: 'main-frame',
              loaderId: 'next-document',
              url: 'https://app.example/next',
            },
          });
          release();
          await settle();
          expect(printEvents()).toEqual([]);
          expect(service.getPrintRequest(transfer.browserId)).toBeNull();
        });

        it('holds no request for print() from a frame sandboxed without allow-modals, and leaves its native print to Blink', async () => {
          const service = await printService();
          cdp('Page.frameNavigated', {
            frame: {
              id: 'ad-frame',
              parentId: 'main-frame',
              loaderId: 'ad-document',
              url: 'https://ads.example/',
            },
          });
          cdp('Runtime.executionContextCreated', {
            context: { id: 9, auxData: { frameId: 'ad-frame' } },
          });
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          let sandbox = 'allow-scripts';
          webContents.debugger.sendCommand.mockImplementation(
            (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> => {
              if (method === 'DOM.getFrameOwner')
                return Promise.resolve({ backendNodeId: 501 });
              if (
                method === 'DOM.describeNode' &&
                params?.backendNodeId === 501
              )
                return Promise.resolve({
                  node: {
                    nodeName: 'IFRAME',
                    attributes: ['sandbox', sandbox],
                  },
                });
              return native
                ? native(method, params, sessionId)
                : Promise.resolve({});
            },
          );
          const framePrinted = (): void =>
            cdp('Runtime.bindingCalled', {
              name: '__canopyPrintRequested',
              payload: '',
              executionContextId: 9,
            });
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          framePrinted();
          await settle();
          expect(printEvents()).toEqual([]);
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          // Outside an action Blink's own print() decides, sandbox included.
          framePrinted();
          await settle();
          expect(nativePrints()).toHaveLength(1);
          expect(webContents.debugger.sendCommand.mock.calls).toContainEqual([
            'Page.createIsolatedWorld',
            { frameId: 'ad-frame', worldName: NATIVE_PRINT_WORLD },
            undefined,
          ]);
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          sandbox = 'allow-scripts allow-modals';
          framePrinted();
          await settle();
          expect(
            webContents.debugger.sendCommand.mock.calls.filter(
              ([method, params]) =>
                method === 'DOM.describeNode' && params?.backendNodeId === 501,
            ),
          ).toHaveLength(2);
        });

        it('keeps the asking action’s id out of what agents and the pane read', async () => {
          const service = await printService();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          printed();
          await settle();
          const [held] = printEvents();
          expect(held).toBeDefined();
          expect(
            Reflect.get(
              service.getPrintRequest(transfer.browserId) ?? {},
              'actionId',
            ),
          ).toBeUndefined();
        });
      });

      describe('file choosers and request_files', () => {
        const picker = jest.fn<Promise<string[]>, [unknown, unknown]>();
        let pickedDir = '';
        beforeEach(() => {
          picker.mockReset();
          picker.mockResolvedValue([]);
          pickedDir = mkdtempSync(join(tmpdir(), 'chooser-picks-'));
          writeFileSync(join(pickedDir, 'report.csv'), 'a,b\n1,2\n');
        });
        afterEach(() => {
          rmSync(pickedDir, { recursive: true, force: true });
        });
        async function chooserService(): Promise<BrowserService> {
          const service = trackedService({
            resolveWorkspaceRoot: () => '/workspace',
            showOpenDialog: picker,
          });
          await service.create({ ...scope, browserId: transfer.browserId });
          jest
            .mocked(requestChatApproval)
            .mockResolvedValue({ decision: 'allow' });
          return service;
        }
        function cdp(
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): void {
          const message = webContents.debugger.on.mock.calls.find(
            ([event]) => event === 'message',
          )?.[1];
          message?.({}, method, params, sessionId);
        }
        async function settle(): Promise<void> {
          for (let index = 0; index < 10; index++)
            await new Promise((resolveTick) => setImmediate(resolveTick));
        }
        function chooserEvents(): Array<BrowserFileChooser | null> {
          return sentBrowserEvents().flatMap((event) =>
            event.type === 'file-chooser' ? [event.chooser] : [],
          );
        }
        const opened = {
          frameId: 'main-frame',
          mode: 'selectSingle',
          backendNodeId: 77,
        };

        it('turns on chooser interception on the page and on each frame session', async () => {
          await chooserService();
          installUploadPage();
          await settle();
          cdp('Target.attachedToTarget', {
            sessionId: 'child-1',
            targetInfo: { type: 'iframe', targetId: 'frame-target' },
          });
          await settle();
          const intercepts = webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === 'Page.setInterceptFileChooserDialog',
          );
          expect(intercepts).toContainEqual([
            'Page.setInterceptFileChooserDialog',
            { enabled: true },
          ]);
          expect(intercepts).toContainEqual([
            'Page.setInterceptFileChooserDialog',
            { enabled: true },
            'child-1',
          ]);
        });

        it('opens the native picker for a chooser the user opened, and attaches only what they pick to the same document', async () => {
          await chooserService();
          installUploadPage();
          picker.mockResolvedValueOnce([join(pickedDir, 'report.csv')]);
          cdp('Page.fileChooserOpened', opened);
          await settle();
          expect(picker.mock.calls[0]?.[1]).toEqual({
            properties: ['openFile'],
          });
          expect(setFileCalls()).toEqual([
            [
              'DOM.setFileInputFiles',
              { files: [join(pickedDir, 'report.csv')], backendNodeId: 77 },
            ],
          ]);
          expect(chooserEvents()).toEqual([]);

          // Closing the picker attaches nothing.
          cdp('Page.fileChooserOpened', opened);
          await settle();
          expect(setFileCalls()).toHaveLength(1);

          // Neither does a pick that lands after the page navigated.
          let pick: (paths: string[]) => void = () => undefined;
          picker.mockImplementationOnce(
            () =>
              new Promise((resolvePick) => {
                pick = resolvePick;
              }),
          );
          cdp('Page.fileChooserOpened', opened);
          await settle();
          page.loaderId = 'next-document';
          pick([join(pickedDir, 'report.csv')]);
          await settle();
          expect(setFileCalls()).toHaveLength(1);
        });

        it('holds a chooser an agent action opened until it expires, its frame navigates, or the user dismisses it', async () => {
          jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
          try {
            const service = await chooserService();
            installUploadPage();
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            cdp('Page.fileChooserOpened', {
              ...opened,
              mode: 'selectMultiple',
            });
            await settle();
            expect(picker).not.toHaveBeenCalled();
            const [held] = chooserEvents();
            expect(held?.id).toMatch(/^chooser-/);
            expect(held).toMatchObject({
              browserId: transfer.browserId,
              frameOrigin: 'https://app.example',
              topOrigin: 'https://app.example',
              multiple: true,
            });
            // A second chooser while one waits is ignored.
            cdp('Page.fileChooserOpened', opened);
            await settle();
            expect(chooserEvents()).toHaveLength(1);

            await jest.advanceTimersByTimeAsync(10 * 60_000);
            expect(chooserEvents()).toEqual([held, null]);

            cdp('Page.fileChooserOpened', opened);
            await settle();
            cdp('Page.frameNavigated', {
              frame: { id: 'main-frame', url: 'https://app.example/next' },
            });
            expect(chooserEvents().at(-1)).toBeNull();
            expect(chooserEvents()).toHaveLength(4);

            cdp('Page.fileChooserOpened', opened);
            await settle();
            const last = chooserEvents().at(-1);
            if (!last) throw new Error('missing chooser');
            await expect(
              service.answerFileChooser({
                browserId: transfer.browserId,
                chooserId: last.id,
                answer: 'dismiss',
              }),
            ).resolves.toEqual({ ok: true });
            expect(chooserEvents().at(-1)).toBeNull();
            expect(setFileCalls()).toEqual([]);
          } finally {
            jest.useRealTimers();
          }
        });

        it('attaches the user’s picks from the banner and ends the chooser', async () => {
          const service = await chooserService();
          installUploadPage();
          await service.startRecording(transfer.browserId);
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          const [held] = chooserEvents();
          if (!held) throw new Error('missing chooser');
          picker.mockResolvedValueOnce([join(pickedDir, 'report.csv')]);
          await expect(
            service.answerFileChooser({
              browserId: transfer.browserId,
              chooserId: held.id,
              answer: 'choose',
            }),
          ).resolves.toEqual({ ok: true });
          expect(setFileCalls()).toEqual([
            [
              'DOM.setFileInputFiles',
              { files: [join(pickedDir, 'report.csv')], backendNodeId: 77 },
            ],
          ]);
          expect(chooserEvents()).toEqual([held, null]);
          // The page recorder sees only the click that opened the chooser;
          // the pick is a chooser upload by name, never the picked path.
          const uploads = service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action === 'upload');
          expect(uploads.map((step) => [step.values, step.value])).toEqual([
            [['report.csv'], 'filechooser'],
          ]);
          expect(JSON.stringify(uploads)).not.toContain(pickedDir);
          await expect(
            service.answerFileChooser({
              browserId: transfer.browserId,
              chooserId: held.id,
              answer: 'choose',
            }),
          ).resolves.toEqual({ ok: false });
        });

        it('records a chooser upload where its files landed, with when its chooser opened, so the wait wraps the click that opened it', async () => {
          const service = await uploading();
          installUploadPage();
          await service.startRecording(transfer.browserId);
          const pageStep = (
            id: string,
            action: 'click' | 'fill',
            locator: string,
          ): void =>
            ipcListeners.get('canopy-browser-view:event')?.(
              { sender: { id: webContents.id } },
              {
                type: 'recording-step',
                step: {
                  id,
                  action,
                  locator,
                  playwright:
                    action === 'click'
                      ? `await ${locator}.click();`
                      : `await ${locator}.fill('Ada');`,
                  timestamp: Date.now(),
                },
              },
            );
          const later = (): Promise<void> =>
            new Promise((resolveLater) => setTimeout(resolveLater, 3));
          pageStep(
            'choose',
            'click',
            "page.getByRole('button', { name: 'Choose file' })",
          );
          await later();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          const held = chooserEvents().at(-1);
          if (!held) throw new Error('missing chooser');
          await later();
          pageStep('name', 'fill', "page.getByLabel('Name')");
          await service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: {
              kind: 'upload_files',
              chooserId: held.id,
              files: [{ path: 'exports/report.csv' }],
              actionId: 'upload-after-fill',
            },
          });
          const recording = service.getRecording(transfer.browserId);
          // The upload stays where the files landed, after the fill.
          expect(
            recording.steps
              .filter((step) => step.action !== 'goto')
              .map((step) => step.action),
          ).toEqual(['click', 'fill', 'upload']);
          expect(
            recording.steps.find((step) => step.action === 'upload')
              ?.chooserOpenedAt,
          ).toBe(held.openedAt);
          const lines = recording.playwrightScript.split('\n');
          expect(
            lines.findIndex((line) =>
              line.includes("waitForEvent('filechooser')"),
            ),
          ).toBeLessThan(
            lines.findIndex((line) => line.includes('Choose file')),
          );
        });

        it('records no chooser wait for a chooser opened before recording started, whoever answers it', async () => {
          const service = await uploading({ showOpenDialog: picker });
          installUploadPage();
          const openBeforeRecording = async (): Promise<BrowserFileChooser> => {
            await service.stopRecording(transfer.browserId);
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            cdp('Page.fileChooserOpened', opened);
            await settle();
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue(undefined);
            const held = chooserEvents().at(-1);
            if (!held) throw new Error('missing chooser');
            // Recording starts after the chooser opened.
            await new Promise((resolveLater) => setTimeout(resolveLater, 2));
            await service.startRecording(transfer.browserId);
            return held;
          };
          const agentAnswered = await openBeforeRecording();
          await service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: {
              kind: 'upload_files',
              chooserId: agentAnswered.id,
              files: [{ path: 'exports/report.csv' }],
              actionId: 'upload-old-chooser',
            },
          });
          const userAnswered = await openBeforeRecording();
          picker.mockResolvedValueOnce([join(pickedDir, 'report.csv')]);
          await service.answerFileChooser({
            browserId: transfer.browserId,
            chooserId: userAnswered.id,
            answer: 'choose',
          });
          const recording = service.getRecording(transfer.browserId);
          const uploads = recording.steps.filter(
            (step) => step.action === 'upload',
          );
          // Both are steps, neither waits for a chooser nothing recorded opens.
          expect(uploads.map((step) => step.value)).toEqual([
            undefined,
            undefined,
          ]);
          expect(recording.playwrightScript).not.toContain('filechooser');
        });

        it('uploads to a chooser’s input by its id and ends it; an ended chooser is chooser_expired', async () => {
          const service = await uploading();
          installUploadPage();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          const [held] = chooserEvents();
          if (!held) throw new Error('missing chooser');
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                chooserId: held.id,
                files: [{ path: 'exports/report.csv' }],
                actionId: 'upload-chooser',
              },
            }),
          ).resolves.toMatchObject({
            ok: true,
            receipt: { status: 'executed', upload: { status: 'attached' } },
          });
          expect(setFileCalls()).toEqual([
            [
              'DOM.setFileInputFiles',
              {
                files: ['/task/browser-files/uploads/upload-1/0/report.csv'],
                backendNodeId: 77,
              },
            ],
          ]);
          expect(chooserEvents()).toEqual([held, null]);
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                chooserId: held.id,
                files: [{ path: 'exports/report.csv' }],
                actionId: 'upload-chooser-again',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'chooser_expired' },
            },
          });
        });

        it('asks the chat to choose files, opens the picker with the input’s rules, and reports names and sizes only', async () => {
          const service = await chooserService();
          installUploadPage({
            input: { attributes: ['type', 'file', 'accept', '.csv'] },
          });
          picker.mockResolvedValueOnce([join(pickedDir, 'report.csv')]);
          const result = await service.automation({
            browserId: transfer.browserId,
            approvalChat: chat,
            command: {
              kind: 'request_files',
              locator: '#drop',
              purpose: 'Your report',
              actionId: 'request-1',
            },
          });
          expect(result).toMatchObject({
            ok: true,
            receipt: {
              kind: 'request_files',
              status: 'executed',
              requestedFiles: [{ name: 'report.csv', sizeBytes: 8 }],
            },
          });
          expect(JSON.stringify(result)).not.toContain(pickedDir);
          expect(jest.mocked(requestChatApproval).mock.calls).toEqual([
            [
              'project-1',
              'worktree-1',
              'chat-1',
              {
                kind: 'browser-file-request',
                origin: 'https://app.example',
                topOrigin: 'https://app.example',
                multiple: false,
              },
              {
                title: 'Choose a file for app.example',
                details: {
                  kind: 'browser-file-request',
                  origin: 'https://app.example',
                  topOrigin: 'https://app.example',
                  purpose: 'Your report',
                  multiple: false,
                },
              },
            ],
          ]);
          expect(picker.mock.calls[0]?.[1]).toEqual({
            title: 'Choose a file for app.example',
            properties: ['openFile'],
            filters: [{ name: 'Files', extensions: ['csv'] }],
          });
          expect(setFileCalls()).toEqual([
            [
              'DOM.setFileInputFiles',
              { files: [join(pickedDir, 'report.csv')], backendNodeId: 77 },
            ],
          ]);
        });

        it('records no late request_files attach in a recording that started after it was sent', async () => {
          const service = await chooserService();
          installUploadPage();
          await service.startRecording(transfer.browserId);
          picker.mockResolvedValueOnce([join(pickedDir, 'report.csv')]);
          let answer = (): void => undefined;
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          webContents.debugger.sendCommand.mockImplementation(
            (
              method: string,
              params?: Record<string, unknown>,
              sessionId?: string,
            ): Promise<unknown> =>
              method === 'DOM.setFileInputFiles'
                ? new Promise((resolvePromise) => {
                    answer = (): void => resolvePromise({});
                  })
                : native
                  ? native(method, params, sessionId)
                  : Promise.resolve({}),
          );
          jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
          try {
            const pending = service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'request_files',
                locator: '#drop',
                actionId: 'late-request-new-recording',
              },
            });
            await jest.advanceTimersByTimeAsync(31_000);
            expect((await pending).receipt?.status).toBe('outcome_unknown');
            await service.stopRecording(transfer.browserId);
            service.clearRecording(transfer.browserId);
            await jest.advanceTimersByTimeAsync(5);
            await service.startRecording(transfer.browserId);
            answer();
            await jest.advanceTimersByTimeAsync(0);
            expect(
              service
                .getRecording(transfer.browserId)
                .steps.filter((step) => step.action === 'upload'),
            ).toEqual([]);
          } finally {
            jest.useRealTimers();
          }
        });

        it.each([
          ['records', true],
          ['records nothing for', false],
        ] as const)(
          '%s a request_files attach that outlasts its time, once the browser answers',
          async (_label, succeeds) => {
            const service = await chooserService();
            installUploadPage();
            await service.startRecording(transfer.browserId);
            picker.mockResolvedValueOnce([join(pickedDir, 'report.csv')]);
            let answer = (): void => undefined;
            const native =
              webContents.debugger.sendCommand.getMockImplementation();
            webContents.debugger.sendCommand.mockImplementation(
              (
                method: string,
                params?: Record<string, unknown>,
                sessionId?: string,
              ): Promise<unknown> =>
                method === 'DOM.setFileInputFiles'
                  ? new Promise((resolvePromise, rejectPromise) => {
                      answer = (): void =>
                        succeeds
                          ? resolvePromise({})
                          : rejectPromise(new Error('Node is detached'));
                    })
                  : native
                    ? native(method, params, sessionId)
                    : Promise.resolve({}),
            );
            const uploads = (): BrowserRecordingStep[] =>
              service
                .getRecording(transfer.browserId)
                .steps.filter((step) => step.action === 'upload');
            jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
            try {
              const pending = service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command: {
                  kind: 'request_files',
                  locator: '#drop',
                  actionId: 'late-request',
                },
              });
              await jest.advanceTimersByTimeAsync(31_000);
              expect((await pending).receipt?.status).toBe('outcome_unknown');
              expect(uploads()).toEqual([]);
              answer();
              await jest.advanceTimersByTimeAsync(0);
              expect(uploads().map((step) => step.values)).toEqual(
                succeeds ? [['report.csv']] : [],
              );
            } finally {
              jest.useRealTimers();
            }
          },
        );

        it('ends a pending chooser for the renderer when the live view is disposed', async () => {
          const service = await chooserService();
          installUploadPage();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          expect(chooserEvents()).toHaveLength(1);
          await service.disposeLiveView(transfer.browserId);
          expect(chooserEvents()).toEqual([expect.anything(), null]);
        });

        it('refuses a chooser from a frame with no web origin, before asking anything', async () => {
          const service = await uploading();
          installUploadPage();
          page.origin = 'null';
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          const [held] = chooserEvents();
          if (!held) throw new Error('missing chooser');
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          jest.mocked(requestChatApproval).mockClear();
          for (const command of [
            {
              kind: 'upload_files' as const,
              chooserId: held.id,
              files: [{ path: 'exports/report.csv' }],
              actionId: 'opaque-upload',
            },
            {
              kind: 'request_files' as const,
              chooserId: held.id,
              actionId: 'opaque-request',
            },
          ])
            await expect(
              service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command,
              }),
            ).resolves.toMatchObject({
              receipt: {
                status: 'not_executed',
                error: { code: 'unsupported_control' },
              },
            });
          expect(requestChatApproval).not.toHaveBeenCalled();
          expect(setFileCalls()).toEqual([]);
        });

        it('attaches nothing to a chooser that ended while the chat was asked', async () => {
          const service = await uploading();
          installUploadPage();
          picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
          const openHeld = async (): Promise<BrowserFileChooser> => {
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            cdp('Page.fileChooserOpened', opened);
            await settle();
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue(undefined);
            const held = chooserEvents().at(-1);
            if (!held) throw new Error('missing chooser');
            return held;
          };
          // The user dismisses the chooser from its banner while the prompt is open.
          const dismissWhileAsking = (held: BrowserFileChooser): void => {
            jest
              .mocked(requestChatApproval)
              .mockImplementationOnce(async () => {
                await service.answerFileChooser({
                  browserId: transfer.browserId,
                  chooserId: held.id,
                  answer: 'dismiss',
                });
                return { decision: 'allow' };
              });
          };
          const requested = await openHeld();
          dismissWhileAsking(requested);
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'request_files',
                chooserId: requested.id,
                actionId: 'ended-request',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'chooser_expired' },
            },
          });
          expect(picker).not.toHaveBeenCalled();

          const uploaded = await openHeld();
          dismissWhileAsking(uploaded);
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                chooserId: uploaded.id,
                files: [{ path: 'exports/report.csv' }],
                actionId: 'ended-upload',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'chooser_expired' },
            },
          });
          expect(
            jest
              .mocked(service.taskFiles)
              .endUpload.mock.calls.map(([, , outcome]) => outcome.status),
          ).toEqual(['failed']);
          expect(setFileCalls()).toEqual([]);
        });

        it('attaches nothing to a chooser the user dismissed while its staged copies were checked', async () => {
          const service = await uploading();
          installUploadPage();
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          const [held] = chooserEvents();
          if (!held) throw new Error('missing chooser');
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          jest
            .mocked(service.taskFiles)
            .stagedUploadMatches.mockImplementationOnce(async () => {
              await service.answerFileChooser({
                browserId: transfer.browserId,
                chooserId: held.id,
                answer: 'dismiss',
              });
              return true;
            });
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                chooserId: held.id,
                files: [{ path: 'exports/report.csv' }],
                actionId: 'dismissed-while-checked',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'chooser_expired' },
            },
          });
          expect(setFileCalls()).toEqual([]);
        });

        it('lets the user’s pick from the banner win over an agent’s upload checked at the same time', async () => {
          const service = await uploading({ showOpenDialog: picker });
          installUploadPage();
          picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          const [held] = chooserEvents();
          if (!held) throw new Error('missing chooser');
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          // The banner's frame read is held while the agent's upload goes on.
          const native =
            webContents.debugger.sendCommand.getMockImplementation();
          let holding = false;
          let release = (): void => undefined;
          const held$ = new Promise<void>((heldRead) => {
            webContents.debugger.sendCommand.mockImplementation(
              async (
                method: string,
                params?: Record<string, unknown>,
                sessionId?: string,
              ): Promise<unknown> => {
                if (holding && method === 'Page.getFrameTree') {
                  holding = false;
                  heldRead();
                  await new Promise<void>((released) => {
                    release = released;
                  });
                }
                return native ? native(method, params, sessionId) : {};
              },
            );
          });
          let answered: Promise<{ ok: boolean }> | undefined;
          jest
            .mocked(service.taskFiles)
            .stagedUploadMatches.mockImplementationOnce(async () => {
              holding = true;
              answered = service.answerFileChooser({
                browserId: transfer.browserId,
                chooserId: held.id,
                answer: 'choose',
              });
              await held$;
              return true;
            });
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                chooserId: held.id,
                files: [{ path: 'exports/report.csv' }],
                actionId: 'raced-upload',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'chooser_expired' },
            },
          });
          release();
          await expect(answered).resolves.toEqual({ ok: true });
          expect(setFileCalls()).toEqual([
            [
              'DOM.setFileInputFiles',
              { files: [join(pickedDir, 'report.csv')], backendNodeId: 77 },
            ],
          ]);
          expect(chooserEvents()).toEqual([held, null]);
        });

        it.each(['upload_files', 'request_files'] as const)(
          'ends the chooser when %s attaches after outlasting its time',
          async (kind) => {
            const service = await uploading({ showOpenDialog: picker });
            installUploadPage();
            picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            cdp('Page.fileChooserOpened', opened);
            await settle();
            const [held] = chooserEvents();
            if (!held) throw new Error('missing chooser');
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue(undefined);
            let answer = (): void => undefined;
            const native =
              webContents.debugger.sendCommand.getMockImplementation();
            webContents.debugger.sendCommand.mockImplementation(
              (
                method: string,
                params?: Record<string, unknown>,
                sessionId?: string,
              ): Promise<unknown> =>
                method === 'DOM.setFileInputFiles'
                  ? new Promise((resolvePromise) => {
                      answer = (): void => resolvePromise({});
                    })
                  : native
                    ? native(method, params, sessionId)
                    : Promise.resolve({}),
            );
            jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
            try {
              const pending = service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command:
                  kind === 'upload_files'
                    ? {
                        kind,
                        chooserId: held.id,
                        files: [{ path: 'exports/report.csv' }],
                        actionId: 'late-upload',
                      }
                    : { kind, chooserId: held.id, actionId: 'late-request' },
              });
              await jest.advanceTimersByTimeAsync(31_000);
              await expect(pending).resolves.toMatchObject({
                receipt: { status: 'outcome_unknown' },
              });
              expect(chooserEvents()).toEqual([held]);
              answer();
              await jest.advanceTimersByTimeAsync(0);
              expect(chooserEvents()).toEqual([held, null]);
            } finally {
              jest.useRealTimers();
            }
          },
        );

        it('ends a chooser whose input left the page, and attaches nothing to it from any route', async () => {
          const service = await uploading({ showOpenDialog: picker });
          installUploadPage();
          jest.mocked(requestChatApproval).mockClear();
          picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
          const openHeld = async (): Promise<BrowserFileChooser> => {
            page.connected = true;
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            cdp('Page.fileChooserOpened', opened);
            await settle();
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue(undefined);
            const held = chooserEvents().at(-1);
            if (!held) throw new Error('missing chooser');
            page.connected = false;
            return held;
          };
          const expired = {
            receipt: {
              status: 'not_executed',
              error: { code: 'chooser_expired' },
            },
          };
          const uploaded = await openHeld();
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                chooserId: uploaded.id,
                files: [{ path: 'exports/report.csv' }],
                actionId: 'removed-upload',
              },
            }),
          ).resolves.toMatchObject(expired);
          expect(chooserEvents()).toEqual([uploaded, null]);

          const requested = await openHeld();
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'request_files',
                chooserId: requested.id,
                actionId: 'removed-request',
              },
            }),
          ).resolves.toMatchObject(expired);
          expect(chooserEvents().at(-1)).toBeNull();

          const answered = await openHeld();
          await expect(
            service.answerFileChooser({
              browserId: transfer.browserId,
              chooserId: answered.id,
              answer: 'choose',
            }),
          ).resolves.toEqual({ ok: false });
          expect(chooserEvents().at(-1)).toBeNull();
          expect(picker).not.toHaveBeenCalled();
          expect(requestChatApproval).not.toHaveBeenCalled();
          expect(setFileCalls()).toEqual([]);
        });

        it('attaches nothing to an input that left the page while the chat was asked', async () => {
          const service = await uploading({ showOpenDialog: picker });
          installUploadPage();
          picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
          const removeWhileAsking = (): void => {
            jest.mocked(requestChatApproval).mockImplementationOnce(() => {
              page.connected = false;
              return Promise.resolve({ decision: 'allow' });
            });
          };
          const openHeld = async (): Promise<BrowserFileChooser> => {
            page.connected = true;
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue('click-1');
            cdp('Page.fileChooserOpened', opened);
            await settle();
            jest
              .mocked(service.taskFiles)
              .attributionFor.mockReturnValue(undefined);
            const held = chooserEvents().at(-1);
            if (!held) throw new Error('missing chooser');
            return held;
          };
          for (const command of [
            {
              kind: 'upload_files' as const,
              files: [{ path: 'exports/report.csv' }],
              actionId: 'left-upload',
            },
            { kind: 'request_files' as const, actionId: 'left-request' },
          ]) {
            const held = await openHeld();
            removeWhileAsking();
            await expect(
              service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command: { ...command, chooserId: held.id },
              }),
            ).resolves.toMatchObject({
              receipt: {
                status: 'not_executed',
                error: { code: 'chooser_expired' },
              },
            });
            expect(chooserEvents().at(-1)).toBeNull();
          }
          // An input found by locator that leaves the page is not attached to either.
          page.connected = true;
          removeWhileAsking();
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'upload_files',
                locator: '#drop',
                files: [{ path: 'exports/report.csv' }],
                actionId: 'left-locator',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: {
                code: 'execution_failed',
                message:
                  'The file input left the page before the files were attached, so nothing was attached.',
              },
            },
          });
          expect(setFileCalls()).toEqual([]);
        });

        it('ends an agent’s chooser when the user picks files for the same input through the page', async () => {
          const service = await uploading({ showOpenDialog: picker });
          installUploadPage();
          picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue('click-1');
          cdp('Page.fileChooserOpened', opened);
          await settle();
          const [held] = chooserEvents();
          if (!held) throw new Error('missing chooser');
          jest
            .mocked(service.taskFiles)
            .attributionFor.mockReturnValue(undefined);
          // The user's pick for another input leaves the agent's chooser waiting.
          cdp('Page.fileChooserOpened', { ...opened, backendNodeId: 78 });
          await settle();
          expect(chooserEvents()).toEqual([held]);
          cdp('Page.fileChooserOpened', opened);
          await settle();
          expect(chooserEvents()).toEqual([held, null]);
          expect(setFileCalls()).toHaveLength(2);
          jest.mocked(requestChatApproval).mockClear();
          for (const command of [
            {
              kind: 'upload_files' as const,
              files: [{ path: 'exports/report.csv' }],
              actionId: 'after-user-upload',
            },
            { kind: 'request_files' as const, actionId: 'after-user-request' },
          ])
            await expect(
              service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command: { ...command, chooserId: held.id },
              }),
            ).resolves.toMatchObject({
              receipt: {
                status: 'not_executed',
                error: { code: 'chooser_expired' },
              },
            });
          expect(requestChatApproval).not.toHaveBeenCalled();
          expect(setFileCalls()).toHaveLength(2);
        });

        it.each(['upload_files', 'request_files'] as const)(
          'ends an agent’s chooser when %s attaches to its input by locator',
          async (kind) => {
            const service = await uploading({ showOpenDialog: picker });
            installUploadPage();
            picker.mockResolvedValue([join(pickedDir, 'report.csv')]);
            const openHeld = async (): Promise<BrowserFileChooser> => {
              jest
                .mocked(service.taskFiles)
                .attributionFor.mockReturnValue('click-1');
              cdp('Page.fileChooserOpened', opened);
              await settle();
              jest
                .mocked(service.taskFiles)
                .attributionFor.mockReturnValue(undefined);
              const held = chooserEvents().at(-1);
              if (!held) throw new Error('missing chooser');
              return held;
            };
            const held = await openHeld();
            await expect(
              service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command:
                  kind === 'upload_files'
                    ? {
                        kind,
                        locator: '#drop',
                        files: [{ path: 'exports/report.csv' }],
                        actionId: 'by-locator',
                      }
                    : { kind, locator: '#drop', actionId: 'by-locator' },
              }),
            ).resolves.toMatchObject({ receipt: { status: 'executed' } });
            expect(chooserEvents()).toEqual([held, null]);
            expect(setFileCalls()).toHaveLength(1);
            await expect(
              service.automation({
                browserId: transfer.browserId,
                approvalChat: chat,
                command: {
                  kind: 'request_files',
                  chooserId: held.id,
                  actionId: 'old-chooser',
                },
              }),
            ).resolves.toMatchObject({
              receipt: {
                status: 'not_executed',
                error: { code: 'chooser_expired' },
              },
            });
            expect(setFileCalls()).toHaveLength(1);
            // A new agent chooser is held again.
            const next = await openHeld();
            expect(next.id).not.toBe(held.id);
          },
        );

        it('attaches nothing when the user declines, closes the picker, or there is no chat to ask', async () => {
          const service = await chooserService();
          installUploadPage();
          jest
            .mocked(requestChatApproval)
            .mockResolvedValueOnce({ decision: 'deny' });
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'request_files',
                locator: '#drop',
                actionId: 'r-1',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'approval_denied' },
            },
          });
          expect(picker).not.toHaveBeenCalled();
          await expect(
            service.automation({
              browserId: transfer.browserId,
              approvalChat: chat,
              command: {
                kind: 'request_files',
                locator: '#drop',
                actionId: 'r-2',
              },
            }),
          ).resolves.toMatchObject({
            receipt: { status: 'not_executed', error: { code: 'cancelled' } },
          });
          jest.mocked(requestChatApproval).mockClear();
          await expect(
            service.automation({
              browserId: transfer.browserId,
              command: {
                kind: 'request_files',
                locator: '#drop',
                actionId: 'r-3',
              },
            }),
          ).resolves.toMatchObject({
            receipt: {
              status: 'not_executed',
              error: { code: 'approval_denied' },
            },
          });
          expect(requestChatApproval).not.toHaveBeenCalled();
          expect(setFileCalls()).toEqual([]);
        });
      });
    });

    describe('copies of a finished download', () => {
      const chat = {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      };
      const destination: CopyDestination = {
        base: '/workspace',
        baseIdentity: { dev: 1, ino: 2 },
        missing: ['exports'],
        name: 'report.csv',
        containmentRoot: '/workspace',
        path: '/workspace/exports/report.csv',
        exists: false,
      };
      const copy: BrowserCopyTransfer = {
        kind: 'copy',
        id: 'copy-1',
        browserId: transfer.browserId,
        sourceId: transfer.id,
        source: 'agent',
        destinationName: 'exports/report.csv',
        copiedBytes: 10,
        totalBytes: 10,
        status: 'complete',
        startedAt: 2,
        endedAt: 3,
      };
      const finished: BrowserDownloadTransfer = {
        ...transfer,
        status: 'complete',
      };
      describe('save_pdf', () => {
        const printed: BrowserDownloadTransfer = {
          ...transfer,
          id: 'pdf-1',
          source: 'print',
          fileName: 'Test page.pdf',
          mimeType: 'application/pdf',
          receivedBytes: 13,
          totalBytes: 13,
          status: 'complete',
        };
        async function printing(): Promise<BrowserService> {
          const service = await filesService();
          jest.mocked(service.taskFiles).admitDownload.mockReturnValue({
            ok: true,
            stagingPath: '/task/browser-files/downloads/Test page.pdf.download',
            record: { ...printed, status: 'in_progress', receivedBytes: 0 },
          });
          jest.mocked(service.taskFiles).get.mockReturnValue(printed);
          return service;
        }

        it('prints the page to a PDF named from its title and saves it as a print download', async () => {
          const service = await printing();
          webContents.printToPDF.mockClear();
          const result = await service.savePdf({
            browserId: transfer.browserId,
            landscape: true,
            paperFormat: 'a4',
            pageRanges: '1-2',
            displayHeaderFooter: true,
          });
          expect(result).toEqual({ ok: true, transfer: printed });
          expect(
            jest.mocked(service.taskFiles).admitDownload.mock.calls[0]?.[0],
          ).toMatchObject({
            suggestedName: 'Test page.pdf',
            mimeType: 'application/pdf',
            source: 'print',
          });
          expect(webContents.printToPDF.mock.calls[0]?.[0]).toMatchObject({
            landscape: true,
            printBackground: true,
            scale: 1,
            pageSize: 'A4',
            pageRanges: '1-2',
            displayHeaderFooter: true,
            preferCSSPageSize: true,
          });
          expect(jest.mocked(writeFile).mock.calls.at(-1)?.slice(0, 2)).toEqual(
            [
              '/task/browser-files/downloads/Test page.pdf.download',
              Buffer.from('%PDF-1.7 test'),
            ],
          );
          const id = jest.mocked(service.taskFiles).admitDownload.mock
            .calls[0]?.[0].downloadId;
          expect(
            jest.mocked(service.taskFiles).updateDownload.mock.calls,
          ).toContainEqual([
            id,
            { receivedBytes: 13, totalBytes: 13, status: 'in_progress' },
          ]);
          expect(
            jest.mocked(service.taskFiles).completeDownload.mock.calls,
          ).toContainEqual([id]);
          expect(JSON.stringify(result)).not.toContain('/task/');
        });

        it('records a saved PDF as page.pdf() with the options it printed with, and nothing when saving fails', async () => {
          const failing = await filesService();
          await failing.startRecording(transfer.browserId);
          await failing.savePdf({ browserId: transfer.browserId });
          expect(
            failing
              .getRecording(transfer.browserId)
              .steps.filter((step) => step.action === 'print'),
          ).toEqual([]);
          await failing.shutdown();

          const service = await printing();
          await service.startRecording(transfer.browserId);
          await service.savePdf({
            browserId: transfer.browserId,
            landscape: true,
            paperFormat: 'a4',
            pageRanges: '1-2',
          });
          const steps = service
            .getRecording(transfer.browserId)
            .steps.filter((step) => step.action === 'print');
          expect(steps).toHaveLength(1);
          expect(steps[0]?.playwright).toContain(
            'await page.pdf({"landscape":true,"printBackground":true,"scale":1,"format":"A4","pageRanges":"1-2","displayHeaderFooter":false,"preferCSSPageSize":true});',
          );
        });

        it('records a download once, even when the recording is cleared while it runs', async () => {
          const service = await filesService();
          await service.startRecording(transfer.browserId);
          const started = Date.now();
          const emit = (download: BrowserDownloadTransfer): void =>
            mockTaskFilesDeps?.emit({
              type: 'transfer',
              browserId: transfer.browserId,
              transfer: download,
            });
          emit({ ...transfer, id: 'running', startedAt: started + 1 });
          service.clearRecording(transfer.browserId);
          emit({
            ...transfer,
            id: 'running',
            startedAt: started + 1,
            receivedBytes: 8,
          });
          emit({
            ...transfer,
            id: 'running',
            startedAt: started + 1,
            receivedBytes: 10,
            status: 'complete',
          });
          expect(
            service
              .getRecording(transfer.browserId)
              .steps.filter((step) => step.action === 'download'),
          ).toEqual([]);
        });

        it('keeps a download after the page step that started it, when that step reaches main later', async () => {
          const service = await filesService();
          await service.startRecording(transfer.browserId);
          const clickedAt = Date.now();
          mockTaskFilesDeps?.emit({
            type: 'transfer',
            browserId: transfer.browserId,
            transfer: {
              ...transfer,
              id: 'export',
              fileName: 'export.csv',
              startedAt: clickedAt + 5,
            },
          });
          ipcListeners.get('canopy-browser-view:event')?.(
            { sender: { id: webContents.id } },
            {
              type: 'recording-step',
              step: {
                id: 'export-click',
                action: 'click',
                locator: "page.getByRole('link', { name: 'Export' })",
                playwright:
                  "await page.getByRole('link', { name: 'Export' }).click();",
                timestamp: clickedAt,
              },
            },
          );
          const recording = service.getRecording(transfer.browserId);
          expect(
            recording.steps
              .filter((step) => step.action !== 'goto')
              .map((step) => step.action),
          ).toEqual(['click', 'download']);
          const lines = recording.playwrightScript.split('\n');
          expect(
            lines.findIndex((line) =>
              line.includes("page.waitForEvent('download')"),
            ),
          ).toBeLessThan(lines.findIndex((line) => line.includes('Export')));
        });

        it('records a saved PDF before a step taken while the page was being printed', async () => {
          const service = await printing();
          await service.startRecording(transfer.browserId);
          const native = webContents.printToPDF.getMockImplementation();
          webContents.printToPDF.mockImplementationOnce(async (options) => {
            ipcListeners.get('canopy-browser-view:event')?.(
              { sender: { id: webContents.id } },
              {
                type: 'recording-step',
                step: {
                  id: 'edit-during-print',
                  action: 'fill',
                  locator: "page.getByLabel('Notes')",
                  playwright: "await page.getByLabel('Notes').fill('Edited');",
                  timestamp: Date.now() + 1,
                },
              },
            );
            await new Promise((resolvePrint) => setTimeout(resolvePrint, 5));
            return native ? native(options) : Buffer.from('%PDF-1.7 test');
          });
          await service.savePdf({ browserId: transfer.browserId });
          expect(
            service
              .getRecording(transfer.browserId)
              .steps.filter((step) => step.action !== 'goto')
              .map((step) => step.action),
          ).toEqual(['print', 'fill']);
        });

        it('records a saved PDF where it was printed, before a step taken while it was being saved', async () => {
          const service = await printing();
          await service.startRecording(transfer.browserId);
          jest.mocked(writeFile).mockImplementationOnce(async () => {
            ipcListeners.get('canopy-browser-view:event')?.(
              { sender: { id: webContents.id } },
              {
                type: 'recording-step',
                step: {
                  id: 'next-page',
                  action: 'click',
                  locator: "page.getByRole('link', { name: 'Next page' })",
                  playwright:
                    "await page.getByRole('link', { name: 'Next page' }).click();",
                  timestamp: Date.now(),
                },
              },
            );
            await new Promise((resolveWrite) => setTimeout(resolveWrite, 5));
          });
          await service.savePdf({ browserId: transfer.browserId });
          expect(
            service
              .getRecording(transfer.browserId)
              .steps.filter((step) => step.action !== 'goto')
              .map((step) => step.action),
          ).toEqual(['print', 'click']);
        });

        it('records no print in a recording that started after the page was printed', async () => {
          const service = await printing();
          await service.startRecording(transfer.browserId);
          const native = webContents.printToPDF.getMockImplementation();
          webContents.printToPDF.mockImplementationOnce(async (options) => {
            // The user stops, clears, and starts a new recording meanwhile.
            await service.stopRecording(transfer.browserId);
            service.clearRecording(transfer.browserId);
            await new Promise((resolveLater) => setTimeout(resolveLater, 2));
            await service.startRecording(transfer.browserId);
            return native ? native(options) : Buffer.from('%PDF-1.7 test');
          });
          await service.savePdf({ browserId: transfer.browserId });
          expect(
            service
              .getRecording(transfer.browserId)
              .steps.filter((step) => step.action === 'print'),
          ).toEqual([]);
        });

        it('records a download that starts while recording, once, and not a print or one that started before', async () => {
          const service = await filesService();
          await service.startRecording(transfer.browserId);
          const started = Date.now();
          const emit = (download: BrowserDownloadTransfer): void =>
            mockTaskFilesDeps?.emit({
              type: 'transfer',
              browserId: transfer.browserId,
              transfer: download,
            });
          emit({ ...transfer, id: 'earlier', startedAt: started - 60_000 });
          emit({
            ...transfer,
            id: 'export',
            fileName: 'export.csv',
            startedAt: started + 1,
          });
          emit({
            ...transfer,
            id: 'export',
            fileName: 'export.csv',
            startedAt: started + 1,
            receivedBytes: 10,
            status: 'complete',
          });
          emit({ ...printed, id: 'printed', startedAt: started + 2 });
          expect(
            service
              .getRecording(transfer.browserId)
              .steps.filter((step) => step.action === 'download'),
          ).toEqual([
            expect.objectContaining({
              action: 'download',
              value: 'export.csv',
            }),
          ]);
        });

        it('records its actionId on the print transfer, as save_download does, rather than replaying', async () => {
          const service = await printing();
          await service.savePdf({
            browserId: transfer.browserId,
            actionId: 'action-1',
          });
          expect(
            jest.mocked(service.taskFiles).admitDownload.mock.calls[0]?.[0],
          ).toMatchObject({ actionId: 'action-1' });
        });

        it('cancel_transfer stops a print in progress: nothing is written and the transfer is cancelled', async () => {
          const service = await printing();
          const running = { ...printed, status: 'in_progress' as const };
          const cancelled = { ...printed, status: 'cancelled' as const };
          jest.mocked(service.taskFiles).get.mockReturnValue(running);
          jest
            .mocked(service.taskFiles)
            .discardDownload.mockImplementation(() => {
              jest.mocked(service.taskFiles).get.mockReturnValue(cancelled);
              return Promise.resolve();
            });
          let finish: (pdf: Buffer) => void = () => undefined;
          webContents.printToPDF.mockReturnValueOnce(
            new Promise<Buffer>((resolvePrint) => {
              finish = resolvePrint;
            }),
          );
          jest.mocked(writeFile).mockClear();
          const saving = service.savePdf({ browserId: transfer.browserId });
          await Promise.resolve();
          const id = jest.mocked(service.taskFiles).admitDownload.mock
            .calls[0]?.[0].downloadId;
          await expect(
            service.cancelTransfer({
              browserId: transfer.browserId,
              transferId: id ?? '',
            }),
          ).resolves.toEqual({ ok: true, transfer: cancelled });
          finish(Buffer.from('%PDF-1.7 late'));
          await expect(saving).resolves.toMatchObject({
            ok: false,
            transfer: cancelled,
          });
          expect(
            jest.mocked(service.taskFiles).discardDownload.mock.calls,
          ).toEqual([[id, 'cancelled']]);
          expect(jest.mocked(writeFile)).not.toHaveBeenCalled();
          expect(
            jest.mocked(service.taskFiles).completeDownload.mock.calls,
          ).toEqual([]);
        });

        it('names the file as asked, without doubling .pdf', async () => {
          const service = await printing();
          await service.savePdf({
            browserId: transfer.browserId,
            fileName: 'Report.PDF',
          });
          expect(
            jest.mocked(service.taskFiles).admitDownload.mock.calls[0]?.[0]
              .suggestedName,
          ).toBe('Report.PDF');
        });

        it('fails without a file when printing fails, and when downloads are held back', async () => {
          const service = await printing();
          webContents.printToPDF.mockRejectedValueOnce(
            new Error('Page range exceeds page count'),
          );
          await expect(
            service.savePdf({ browserId: transfer.browserId, pageRanges: '9' }),
          ).resolves.toMatchObject({
            ok: false,
            error: { code: 'download_failed' },
          });
          expect(
            jest.mocked(service.taskFiles).discardDownload.mock.calls[0]?.[1],
          ).toBe('failed');
          jest.mocked(service.taskFiles).admitDownload.mockReturnValueOnce({
            ok: false,
            reason: 'rate_limited',
          });
          await expect(
            service.savePdf({ browserId: transfer.browserId }),
          ).resolves.toMatchObject({
            ok: false,
            error: { code: 'download_rate_limited' },
          });
        });

        it('reports a pending file chooser, and none when there is none', async () => {
          const service = await printing();
          expect(service.getFileChooser(transfer.browserId)).toBeNull();
        });
      });

      async function saving(): Promise<BrowserService> {
        const service = await filesService();
        jest.mocked(service.taskFiles).get.mockReturnValue(finished);
        jest
          .mocked(prepareWorkspaceDestination)
          .mockResolvedValue({ ok: true, destination });
        jest
          .mocked(requestChatApproval)
          .mockResolvedValue({ decision: 'allow' });
        jest.mocked(service.taskFiles).startCopy.mockReturnValue({
          ok: true,
          transfer: { ...copy, status: 'in_progress', copiedBytes: 0 },
        });
        jest.mocked(service.taskFiles).waitForTransfer.mockResolvedValue(copy);
        return service;
      }

      it('asks the calling chat to approve the write, then copies and waits for the copy', async () => {
        const service = await saving();
        const result = await service.saveDownload({
          browserId: transfer.browserId,
          downloadId: transfer.id,
          path: 'exports/report.csv',
          approvalChat: chat,
          actionId: 'save-1',
        });

        expect(result).toEqual({ ok: true, transfer: copy });
        expect(prepareWorkspaceDestination).toHaveBeenCalledWith(
          '/workspace',
          'exports/report.csv',
        );
        expect(requestChatApproval).toHaveBeenCalledWith(
          'project-1',
          'worktree-1',
          'chat-1',
          { kind: 'file-write', path: '/workspace/exports/report.csv' },
          expect.objectContaining({
            title: 'Save report.csv to exports/report.csv?',
            details: {
              kind: 'file-write',
              path: '/workspace/exports/report.csv',
            },
          }),
        );
        const startCopy = jest.mocked(service.taskFiles).startCopy.mock;
        expect(startCopy.calls).toEqual([
          [
            scope,
            {
              browserId: transfer.browserId,
              downloadId: transfer.id,
              source: 'agent',
              actionId: 'save-1',
              destinationName: 'exports/report.csv',
              destination,
              overwrite: false,
            },
          ],
        ]);
        expect(
          jest.mocked(requestChatApproval).mock.invocationCallOrder[0],
        ).toBeLessThan(startCopy.invocationCallOrder[0] ?? 0);
      });

      it('refuses without asking for an unfinished download, a copy, a taken name, or no chat', async () => {
        const service = await saving();
        const save = (
          overrides: Partial<Parameters<BrowserService['saveDownload']>[0]>,
        ): ReturnType<BrowserService['saveDownload']> =>
          service.saveDownload({
            browserId: transfer.browserId,
            downloadId: transfer.id,
            path: 'exports/report.csv',
            approvalChat: chat,
            ...overrides,
          });
        jest.mocked(service.taskFiles).get.mockReturnValueOnce(transfer);
        expect(await save({})).toMatchObject({
          ok: false,
          error: { code: 'file_not_eligible' },
        });
        jest.mocked(service.taskFiles).get.mockReturnValueOnce(copy);
        expect(await save({})).toMatchObject({
          ok: false,
          error: { code: 'not_found' },
        });
        jest.mocked(prepareWorkspaceDestination).mockResolvedValueOnce({
          ok: true,
          destination: { ...destination, exists: true },
        });
        expect(await save({})).toMatchObject({
          ok: false,
          error: { code: 'destination_exists' },
        });
        jest.mocked(prepareWorkspaceDestination).mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'invalid_path',
            message: 'Use a path to a file inside the workspace.',
          },
        });
        expect(await save({ path: '../out.csv' })).toMatchObject({
          ok: false,
          error: { code: 'invalid_path' },
        });
        expect(await save({ approvalChat: undefined })).toMatchObject({
          ok: false,
          error: { code: 'approval_denied' },
        });
        expect(requestChatApproval).not.toHaveBeenCalled();
        expect(jest.mocked(service.taskFiles).startCopy.mock.calls).toEqual([]);
      });

      it('copies nothing when the chat denies the write', async () => {
        const service = await saving();
        jest
          .mocked(requestChatApproval)
          .mockResolvedValueOnce({ decision: 'deny', message: 'No.' });
        expect(
          await service.saveDownload({
            browserId: transfer.browserId,
            downloadId: transfer.id,
            path: 'exports/report.csv',
            overwrite: true,
            approvalChat: chat,
          }),
        ).toMatchObject({ ok: false, error: { code: 'approval_denied' } });
        expect(jest.mocked(service.taskFiles).startCopy.mock.calls).toEqual([]);
      });

      it("returns the copy's progress when timeoutMs passes first, and a failed copy's error", async () => {
        const service = await saving();
        const running = {
          ...copy,
          status: 'in_progress' as const,
          copiedBytes: 4,
        };
        jest
          .mocked(service.taskFiles)
          .waitForTransfer.mockImplementationOnce(
            (_scope, _id, options) =>
              new Promise((resolvePromise) =>
                options.signal.addEventListener('abort', () =>
                  resolvePromise(undefined),
                ),
              ),
          );
        jest
          .mocked(service.taskFiles)
          .get.mockImplementation((_scope, id) =>
            id === copy.id ? running : finished,
          );
        expect(
          await service.saveDownload({
            browserId: transfer.browserId,
            downloadId: transfer.id,
            path: 'exports/report.csv',
            approvalChat: chat,
            timeoutMs: 5,
          }),
        ).toEqual({ ok: true, transfer: running });

        const failed: BrowserCopyTransfer = {
          ...copy,
          status: 'failed',
          error: {
            code: 'destination_exists',
            message: 'A file with that name already exists.',
          },
        };
        jest
          .mocked(service.taskFiles)
          .waitForTransfer.mockResolvedValueOnce(failed);
        expect(
          await service.saveDownload({
            browserId: transfer.browserId,
            downloadId: transfer.id,
            path: 'exports/report.csv',
            approvalChat: chat,
          }),
        ).toEqual({ ok: false, transfer: failed, error: failed.error });
      });

      it('cancels a running copy through cancel_transfer', async () => {
        const service = await filesService();
        const cancelled = { ...copy, status: 'cancelled' as const };
        jest
          .mocked(service.taskFiles)
          .get.mockReturnValue({ ...copy, status: 'in_progress' });
        jest.mocked(service.taskFiles).cancelCopy.mockReturnValue(true);
        jest
          .mocked(service.taskFiles)
          .waitForTransfer.mockResolvedValue(cancelled);
        const cancelDownload = jest.spyOn(service.downloads, 'cancelDownload');

        expect(
          await service.cancelTransfer({
            browserId: transfer.browserId,
            transferId: copy.id,
          }),
        ).toEqual({ ok: true, transfer: cancelled });
        expect(jest.mocked(service.taskFiles).cancelCopy.mock.calls).toEqual([
          [scope, copy.id],
        ]);
        expect(cancelDownload).not.toHaveBeenCalled();
      });

      it('saves a copy where the user chooses, and reports a dismissed dialog', async () => {
        const service = await saving();
        const chosen: CopyDestination = {
          ...destination,
          base: '/Users/me/Desktop',
          missing: [],
          containmentRoot: undefined,
          path: '/Users/me/Desktop/report.csv',
          exists: true,
        };
        jest
          .mocked(prepareChosenDestination)
          .mockResolvedValue({ ok: true, destination: chosen });
        const chooseSavePath = jest
          .fn<Promise<string | undefined>, [string]>()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce('/Users/me/Desktop/report.csv');
        const host = { revealInFolder: jest.fn(), chooseSavePath };
        const command = {
          kind: 'save_copy' as const,
          browserId: transfer.browserId,
          transferId: transfer.id,
        };

        expect(await service.transferCommand(command, host)).toEqual({
          ok: true,
          dismissed: true,
        });
        expect(chooseSavePath).toHaveBeenCalledWith('report.csv');
        expect(await service.transferCommand(command, host)).toMatchObject({
          ok: true,
          transfer: { kind: 'copy' },
        });
        expect(prepareChosenDestination).toHaveBeenCalledWith(
          '/Users/me/Desktop/report.csv',
        );
        expect(jest.mocked(service.taskFiles).startCopy.mock.calls).toEqual([
          [
            scope,
            {
              browserId: transfer.browserId,
              downloadId: transfer.id,
              source: 'user',
              destinationName: 'report.csv',
              destination: chosen,
              overwrite: true,
            },
          ],
        ]);
        expect(requestChatApproval).not.toHaveBeenCalled();
      });

      it('resolves a finished download for attach, with the path only on the reply', async () => {
        const service = await saving();
        jest
          .mocked(service.taskFiles)
          .resolveLocalPath.mockResolvedValueOnce('/host-only/report.csv');
        const host = { revealInFolder: jest.fn() };
        const command = {
          kind: 'attach' as const,
          browserId: transfer.browserId,
          transferId: transfer.id,
        };
        expect(await service.transferCommand(command, host)).toEqual({
          ok: true,
          transfer: finished,
          attachPath: '/host-only/report.csv',
        });
        expect(await service.transferCommand(command, host)).toMatchObject({
          ok: false,
          error: { code: 'not_found' },
        });
      });
    });
    it('leaves no deferred state write to land in a later test', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      expect(saveWorktreeBrowserState).not.toHaveBeenCalled();
    });
  });

  it('uses the default user agent without the Electron product token', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-user-agent',
    });

    expect(webContents.getUserAgent).toHaveBeenCalled();
    expect(webContents.setUserAgent).toHaveBeenCalledWith(
      'Mozilla/5.0 Test Chrome/148.0.7778.180 Safari/537.36',
    );
    expect(webContents._setOwnerWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        contentView: { addChildView, removeChildView },
      }),
    );
    await service.destroyWorktree('project-1', 'worktree-1', {
      deletingTarget: true,
    });
  });

  it('acquires profile binding authority inside the queued workspace save', async () => {
    const authority = getBrowserProfileService();
    let savingWorkspace = false;
    authority.commitBinding = <T>(
      _resolution: BrowserProfileResolution,
      commit: () => Promise<T>,
    ): Promise<T> => {
      expect(savingWorkspace).toBe(true);
      return Promise.resolve(commit());
    };
    jest
      .mocked(saveWorktreeBrowserState)
      .mockImplementation(
        async (
          _request,
          commit?: (write: () => Promise<void>) => Promise<void>,
        ) => {
          savingWorkspace = true;
          try {
            if (commit) await commit(() => Promise.resolve());
          } finally {
            savingWorkspace = false;
          }
        },
      );
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    try {
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'ordered-binding',
      });
      expect(service.getLifecycleStats().liveViews).toBe(1);
    } finally {
      await service.shutdown();
    }
  });

  it('waits for prior browser mutations before acquiring profile binding authority', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'prior-binding',
    });
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest.mocked(saveWorktreeBrowserState).mockImplementationOnce(async () => {
      started();
      await gate;
    });
    const mutation = service.setActiveBrowser(
      'project-1',
      'worktree-1',
      'prior-binding',
    );
    await entered;
    let commits = 0;
    authority.commitBinding = <T>(
      _resolution: BrowserProfileResolution,
      commit: () => Promise<T>,
    ): Promise<T> => {
      commits += 1;
      return Promise.resolve(commit());
    };
    const creation = service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'queued-binding',
    });
    const settled = Promise.allSettled([mutation, creation]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(commits).toBe(0);
      jest
        .mocked(saveWorktreeBrowserState)
        .mockImplementation(
          async (
            _request,
            commit?: (write: () => Promise<void>) => Promise<void>,
          ) => {
            if (commit) await commit(() => Promise.resolve());
          },
        );
      release();
      await mutation;
      await creation;
      expect(commits).toBe(1);
    } finally {
      release();
      await settled;
      await service.shutdown();
    }
  });

  it('drains a retiring task while its binding save is waiting for the workspace lock', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest
      .mocked(saveWorktreeBrowserState)
      .mockImplementation(async (_request, commit, signal?: AbortSignal) => {
        started();
        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          signal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error('Queued operation cancelled.'),
              );
            },
            {
              once: true,
            },
          );
        });
        signal?.throwIfAborted();
        if (commit) await commit(() => Promise.resolve());
      });
    const creation = Promise.allSettled([
      service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'retiring-binding',
      }),
    ]);
    let drain: Promise<void> | undefined;
    try {
      await entered;
      drain = service.disposeWorktreeViews('project-1', 'worktree-1');
      let completed = false;
      void drain.then(() => {
        completed = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(completed).toBe(true);
      const outcomes = await creation;
      expect(outcomes).toMatchObject([{ status: 'rejected' }]);
      if (outcomes[0]?.status === 'rejected')
        expect(outcomes[0].reason).toMatchObject({ code: 'scope_retired' });
      expect(service.getLifecycleStats().liveViews).toBe(0);
      expect(createdViews.at(-1)?.webContents.close).toHaveBeenCalled();
    } finally {
      release();
      await creation;
      await drain;
      await service.shutdown();
    }
  });

  it('cancels a task open still acquiring its native session when retirement begins', async () => {
    const authority = getBrowserProfileService();
    const acquire = authority.acquireSession.bind(authority);
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    authority.acquireSession = async (
      resolution,
    ): Promise<ElectronTypes.Session> => {
      started();
      await gate;
      return acquire(resolution);
    };
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const creation = Promise.allSettled([
      service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'early-retiring-open',
      }),
    ]);
    let drain: Promise<void> | undefined;
    try {
      await entered;
      drain = service.disposeWorktreeViews('project-1', 'worktree-1');
      release();
      await drain;
      const outcomes = await creation;
      expect(outcomes).toMatchObject([{ status: 'rejected' }]);
      expect(service.getLifecycleStats().liveViews).toBe(0);
      expect(createdViews).toHaveLength(0);
    } finally {
      release();
      await creation;
      await drain;
      await service.shutdown();
    }
  });

  it.each(['open', 'load'])(
    'cancels %s recovery queued behind retirement workspace persistence',
    async (operation) => {
      const service = new BrowserService({ getWindow: mockWindow });
      const source = persistedSnapshot('retiring-recovery', {
        profile: {
          selection: { kind: 'task' },
          resolvedProfileId: 'task-profile',
          storageGeneration: 1,
          runtimeGeneration: 1,
          taskIncarnationId: 'fixture-incarnation',
        },
      });
      const record: BrowserSwitchRecord = {
        schemaVersion: 1,
        operationId: 'retiring-recovery-operation',
        digest: 'a'.repeat(64),
        createdAt: Date.now(),
        stage: 'close_intent',
        source,
        target: {
          ...source,
          profile: source.profile
            ? { ...source.profile, runtimeGeneration: 2 }
            : undefined,
        },
        mode: 'replace',
      };
      mockPendingSwitchRecords.mockResolvedValueOnce([record]);
      let release = (): void => {};
      let started = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let writes = 0;
      jest
        .mocked(saveWorktreeBrowserState)
        .mockImplementationOnce(async (_request, _commit, signal) => {
          started();
          await new Promise<void>((resolve, reject) => {
            void gate.then(resolve);
            signal?.addEventListener(
              'abort',
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Recovery cancelled'),
                ),
              { once: true },
            );
          });
          signal?.throwIfAborted();
          writes += 1;
        });
      const recovery = Promise.allSettled([
        operation === 'open'
          ? service.create({
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              browserId: 'retiring-recovery-open',
            })
          : service.loadWorktreeState('project-1', 'worktree-1'),
      ]);
      let drain: Promise<void> | undefined;
      try {
        await entered;
        drain = service.disposeWorktreeViews('project-1', 'worktree-1');
        let completed = false;
        void drain.then(() => {
          completed = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(completed).toBe(true);
        expect(writes).toBe(0);
        // The queued save must already have settled without releasing deletion's lock.
        let outcome: unknown;
        void recovery.then((value) => {
          outcome = value;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(outcome).toMatchObject([
          { status: 'rejected', reason: { code: 'scope_retired' } },
        ]);
        release();
        await recovery;
        expect(writes).toBe(0);
        expect(mockSwitchJournalUpdate).not.toHaveBeenCalled();
        expect(service.getLifecycleStats().liveViews).toBe(0);
      } finally {
        release();
        await recovery;
        await drain;
        await service.shutdown();
      }
    },
  );

  it('drains a journal scan already admitted before task retirement', async () => {
    await settleLeftoverSnapshotSaves();
    const service = new BrowserService({ getWindow: mockWindow });
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockPendingSwitchRecords.mockImplementationOnce(async () => {
      started();
      await gate;
      return [];
    });
    const creation = Promise.allSettled([
      service.create({ projectId: 'project-1', worktreeId: 'worktree-1' }),
    ]);
    let drain: Promise<void> | undefined;
    try {
      await entered;
      let completed = false;
      drain = service
        .disposeWorktreeViews('project-1', 'worktree-1')
        .then(() => {
          completed = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      release();
      await drain;
      expect(await creation).toMatchObject([
        { status: 'rejected', reason: { code: 'scope_retired' } },
      ]);
      expect(saveWorktreeBrowserState).not.toHaveBeenCalled();
      expect(createdViews).toHaveLength(0);
    } finally {
      release();
      await creation;
      await drain;
      await service.shutdown();
    }
  });

  it('keeps marketplace sign-in cookies in a nonpersistent browser partition', async () => {
    const fromPartition = jest.spyOn(session, 'fromPartition');
    const authority = getBrowserProfileService();
    const resolveProfile = jest.spyOn(authority, 'resolve');
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const browser = await service.create({
      projectId: 'app-oauth',
      worktreeId: 'mcp',
      url: 'https://auth.example.test/authorize',
    });
    expect(fromPartition).toHaveBeenCalledWith('mcp-oauth');
    expect(resolveProfile).not.toHaveBeenCalled();
    expect(browser.profile).toBeUndefined();
    expect(browser.profileInfo).toBeUndefined();
    expect(
      jest.mocked(WebContentsView).mock.calls.at(-1)?.[0]?.webPreferences,
    ).toMatchObject({ partition: 'mcp-oauth', preload: undefined });
    await service.destroy(browser.id);
  });

  it('opens recipient browsers without requiring an owned-worktree profile', async () => {
    const fromPartition = jest.spyOn(session, 'fromPartition');
    const authority = getBrowserProfileService();
    const resolveProfile = jest.spyOn(authority, 'resolve');
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });

    const browser = await service.create({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      browserId: 'browser-viewer',
    });

    expect(resolveProfile).not.toHaveBeenCalled();
    expect(fromPartition).toHaveBeenCalledWith(
      'persist:canopy-browser-shared-container-container-1',
    );
    expect(browser.profile).toBeUndefined();
    expect(browser.profileInfo).toBeUndefined();
    await service.destroy(browser.id);
  });

  it('blocks programmatic screenshots of a private OAuth sign-in surface', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const browser = await service.create({
      projectId: 'app-oauth',
      worktreeId: 'mcp',
      url: 'https://auth.example.test/authorize',
    });
    try {
      await expect(
        service.screenshot({ browserId: browser.id }),
      ).rejects.toThrow('Sign-in pages are private');
      await expect(
        service.inspect({ browserId: browser.id, locator: 'body' }),
      ).rejects.toThrow('Sign-in pages are private');
      await expect(
        service.inputSnapshot({ browserId: browser.id }),
      ).rejects.toThrow('Sign-in pages are private');
      await expect(service.startRecording(browser.id)).rejects.toThrow(
        'Sign-in pages are private',
      );
      expect(() => service.getRecording(browser.id)).toThrow(
        'Sign-in pages are private',
      );
      expect(() => service.getConsole({ browserId: browser.id })).toThrow(
        'Sign-in pages are private',
      );
      expect(() => service.getNetwork({ browserId: browser.id })).toThrow(
        'Sign-in pages are private',
      );
      expect(
        service.getConsole({ projectId: 'app-oauth', worktreeId: 'mcp' }),
      ).toEqual([]);
      expect(
        service.getNetwork({ projectId: 'app-oauth', worktreeId: 'mcp' }),
      ).toEqual([]);
    } finally {
      await service.destroy(browser.id);
    }
  });

  it('skips an older private sign-in session for unscoped automation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const oauth = await service.create({
      projectId: 'app-oauth',
      worktreeId: 'mcp',
    });
    const normal = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    try {
      const result = await service.automation({
        command: { kind: 'inspect', locator: 'body' },
      });
      expect(result).toMatchObject({ ok: true, browser: { id: normal.id } });
      await service.destroy(normal.id);
      await expect(
        service.automation({ command: { kind: 'inspect', locator: 'body' } }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_found', message: 'No browser is available.' },
      });
    } finally {
      await service.destroy(normal.id);
      await service.destroy(oauth.id);
    }
  });

  it('denies browser partition permissions by default', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-permissions',
    });

    const requestHandler = mockSetPermissionRequestHandler.mock.calls[0]?.[0];
    if (typeof requestHandler !== 'function') {
      throw new Error('Expected a browser permission request handler.');
    }
    const permissionCallback = jest.fn();
    requestHandler(webContents, 'clipboard-read', permissionCallback, {});
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const checkHandler = mockSetPermissionCheckHandler.mock.calls[0]?.[0];
    if (typeof checkHandler !== 'function') {
      throw new Error('Expected a browser permission check handler.');
    }
    expect(
      checkHandler(webContents, 'clipboard-read', 'https://example.com', {}),
    ).toBe(false);

    await service.destroyWorktree('project-1', 'worktree-1', {
      deletingTarget: true,
    });
  });

  it('recreates a persisted browser id and lists it for the worktree', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
      url: 'http://localhost:3000',
    });

    expect(snapshot.id).toBe('browser-1');
    expect(webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000');
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({ id: 'browser-1' }),
    ]);
  });

  describe('an agent tab that was never shown', () => {
    const agentTab = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'agent-tab',
      url: 'http://localhost:3000',
    };

    it('starts its first load once the pane shows it at a real size', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      const snapshot = await service.create(agentTab, 'agent');
      expect(snapshot).toMatchObject({
        url: 'http://localhost:3000',
        loading: false,
      });
      const started = service.waitForInitialLoad('agent-tab');

      // Hidden or empty reports do not reach the page, so they start nothing.
      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
      });
      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: false,
      });
      expect(webContents.loadURL).not.toHaveBeenCalled();

      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });
      await started;
      expect(webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000');
      // The view is shown at its size before the page starts loading.
      expect(mockSetVisible.mock.invocationCallOrder.at(-1)).toBeLessThan(
        webContents.loadURL.mock.invocationCallOrder[0] ?? 0,
      );
      await service.shutdown();
    });

    it('loads without a pane after a short wait', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create(agentTab, 'agent');
      expect(webContents.loadURL).not.toHaveBeenCalled();

      await service.waitForInitialLoad('agent-tab');
      expect(webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000');
      await service.shutdown();
    });

    it('keeps one load when the renderer asks for the same page again', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create(agentTab, 'agent');
      const started = service.waitForInitialLoad('agent-tab');

      // The renderer's create for the placed tab and the pane's idle backstop
      // navigation neither drop the held load nor restart it while it loads.
      await service.create(agentTab);
      const backstop = service.navigate({
        browserId: 'agent-tab',
        url: 'http://localhost:3000',
      });
      expect(webContents.loadURL).not.toHaveBeenCalled();
      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });
      await service.navigate({
        browserId: 'agent-tab',
        url: 'http://localhost:3000',
      });
      await service.create(agentTab);
      await Promise.all([started, backstop]);
      expect(webContents.loadURL.mock.calls).toEqual([
        ['http://localhost:3000'],
      ]);
      await service.shutdown();
    });

    it('lets a later request for the first page through once the held load is over', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create(agentTab, 'agent');
      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });
      await service.waitForInitialLoad('agent-tab');
      // The page starts another load (a link) while the first is in flight.
      webContents.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url: 'http://localhost:3000/next',
      });
      webContents.emit('did-start-loading');
      await service.navigate({
        browserId: 'agent-tab',
        url: 'http://localhost:3000',
      });
      // A finished held load does not hold back a later request either.
      webContents.emit('did-stop-loading');
      webContents.emit('did-start-loading');
      await service.navigate({
        browserId: 'agent-tab',
        url: 'http://localhost:3000',
      });
      expect(
        webContents.loadURL.mock.calls.length +
          webContents.reload.mock.calls.length,
      ).toBe(3);
      await service.shutdown();
    });

    it('is cancelled by stop, so neither the pane nor the wait loads it', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create(agentTab, 'agent');
      const started = service.waitForInitialLoad('agent-tab');

      const stopped = await service.stop('agent-tab');
      expect(stopped).toMatchObject({ loading: false });
      expect(stopped.status).not.toBe('loading');
      expect(stopped.url).not.toBe('http://localhost:3000');
      await started;
      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });
      expect(webContents.loadURL).not.toHaveBeenCalled();
      await service.shutdown();
    });

    it('loads at once when it opens behind a tab already on screen', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({ ...agentTab, browserId: 'shown-tab' });
      service.setBounds({
        browserId: 'shown-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });

      await service.create(
        {
          ...agentTab,
          browserId: 'background-tab',
          url: 'http://localhost:4000',
        },
        'agent',
      );
      expect(createdViews[1]?.webContents.loadURL).toHaveBeenCalledWith(
        'http://localhost:4000',
      );
      await service.shutdown();
    });

    it('drops the held load when a navigation comes first', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create(agentTab, 'agent');
      const started = service.waitForInitialLoad('agent-tab');

      await service.navigate({
        browserId: 'agent-tab',
        url: 'http://localhost:4000',
      });
      await started;
      service.setBounds({
        browserId: 'agent-tab',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });
      expect(webContents.loadURL.mock.calls).toEqual([
        ['http://localhost:4000'],
      ]);
      await service.shutdown();
    });
  });

  it('serializes concurrent creation against the latest worktree state', async () => {
    await settleLeftoverSnapshotSaves();
    const service = new BrowserService({ getWindow: mockWindow });
    let resolveFirstWrite: (() => void) | undefined;
    jest
      .mocked(saveWorktreeBrowserState)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const first = service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await Promise.resolve();
    const second = service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(saveWorktreeBrowserState).toHaveBeenCalledTimes(1);
    resolveFirstWrite?.();
    await Promise.all([first, second]);

    const persistedOrders = jest
      .mocked(saveWorktreeBrowserState)
      .mock.calls.map(([request]) => request.state.browserOrder);
    expect(persistedOrders[0]).toEqual(['browser-1']);
    expect(persistedOrders.slice(1)).toEqual(
      expect.arrayContaining([['browser-1', 'browser-2']]),
    );
    expect(
      persistedOrders.slice(1).every((order) => order.includes('browser-1')),
    ).toBe(true);
    expect(
      service
        .listWorktreeBrowsers('project-1', 'worktree-1')
        .map((snapshot) => snapshot.id),
    ).toEqual(['browser-1', 'browser-2']);
  });

  it('keeps the newer presentation hidden when an earlier authorization finishes last', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
      // Exercise the full authorization compatibility path explicitly.
      experimentalFeaturesEnabled: (): boolean => false,
    });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'presentation-ordering',
    });
    if (!browser.profile) throw new Error('Missing fixture profile');
    const view = createdViews[0];
    if (!view) throw new Error('Missing fixture browser view');

    service.setBounds({
      browserId: browser.id,
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      visible: true,
    });
    mockSetVisible.mockClear();

    const resolveProfile = authority.resolve.bind(authority);
    let releaseEarlier!: () => void;
    let earlierAuthorizationStarted!: () => void;
    const earlierAuthorizationGate = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    const earlierAuthorizationEntered = new Promise<void>((resolve) => {
      earlierAuthorizationStarted = resolve;
    });
    let resolveCalls = 0;
    authority.resolve = jest.fn(async (...args) => {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        earlierAuthorizationStarted();
        await earlierAuthorizationGate;
      }
      return resolveProfile(...args);
    });

    const target = {
      browserId: browser.id,
      expectedRuntimeGeneration: browser.profile.runtimeGeneration,
    };
    const earlierShow = service.withRuntimeTarget(
      target,
      () =>
        service.setBounds({
          browserId: browser.id,
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          visible: true,
        }),
      { presentation: true },
    );
    const earlierShowSettlement = Promise.allSettled([earlierShow]);
    let laterHide: Promise<void> | undefined;
    try {
      await earlierAuthorizationEntered;
      laterHide = service.withRuntimeTarget(
        target,
        () => service.setVisible(browser.id, false),
        { presentation: true },
      );
      await laterHide;
      const hideCalls = mockSetVisible.mock.calls;
      expect({
        nativeVisible: hideCalls[hideCalls.length - 1]?.[0],
        capturedVisible: service.captureProfileViews(
          browser.profile.resolvedProfileId,
        )[0]?.visible,
      }).toEqual({ nativeVisible: false, capturedVisible: false });

      releaseEarlier();
      const earlierSettlement = await earlierShowSettlement;
      const finalCalls = mockSetVisible.mock.calls;
      expect({
        nativeVisible: finalCalls[finalCalls.length - 1]?.[0],
        capturedVisible: service.captureProfileViews(
          browser.profile.resolvedProfileId,
        )[0]?.visible,
      }).toEqual({ nativeVisible: false, capturedVisible: false });
      expect(earlierSettlement).toHaveLength(1);
      expect(earlierSettlement[0]?.status).toBe('rejected');
      const earlierReason: unknown =
        earlierSettlement[0]?.status === 'rejected'
          ? earlierSettlement[0].reason
          : undefined;
      expect(earlierReason).toMatchObject({ code: 'operation_conflict' });
    } finally {
      releaseEarlier();
      await Promise.all([
        earlierShowSettlement,
        Promise.allSettled([laterHide ?? Promise.resolve()]),
      ]);
      await service.shutdown();
    }
  });

  it('keeps presentation ordering independent between live browsers', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
      // Exercise the full authorization compatibility path explicitly.
      experimentalFeaturesEnabled: (): boolean => false,
    });
    const first = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'presentation-independent-first',
    });
    const second = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'presentation-independent-second',
    });
    if (!first.profile || !second.profile)
      throw new Error('Missing fixture profile');

    const resolveProfile = authority.resolve.bind(authority);
    let releaseFirst!: () => void;
    let firstAuthorizationStarted!: () => void;
    const firstAuthorizationGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAuthorizationEntered = new Promise<void>((resolve) => {
      firstAuthorizationStarted = resolve;
    });
    authority.resolve = jest.fn(async (...args) => {
      const [, , snapshot] = args;
      if (snapshot?.id === first.id) {
        firstAuthorizationStarted();
        await firstAuthorizationGate;
      }
      return resolveProfile(...args);
    });

    const firstOperation = jest.fn(() => 'first');
    const secondOperation = jest.fn(() => 'second');
    const pendingFirst = service.withRuntimeTarget(
      {
        browserId: first.id,
        expectedRuntimeGeneration: first.profile.runtimeGeneration,
      },
      firstOperation,
      { presentation: true },
    );
    try {
      await firstAuthorizationEntered;
      await expect(
        service.withRuntimeTarget(
          {
            browserId: second.id,
            expectedRuntimeGeneration: second.profile.runtimeGeneration,
          },
          secondOperation,
          { presentation: true },
        ),
      ).resolves.toBe('second');
      releaseFirst();
      await expect(pendingFirst).resolves.toBe('first');
      expect(firstOperation).toHaveBeenCalledTimes(1);
      expect(secondOperation).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      await Promise.allSettled([pendingFirst]);
      await service.shutdown();
    }
  });

  it.each([
    { experimental: undefined, presentationResolves: 0 },
    { experimental: true, presentationResolves: 0 },
    { experimental: false, presentationResolves: 2 },
  ])(
    'skips presentation re-authorization by default; explicit compatibility path: $experimental',
    async ({ experimental, presentationResolves }): Promise<void> => {
      const authority = getBrowserProfileService();
      const service = new BrowserService({
        getWindow: mockWindow,
        profileAuthority: authority,
        experimentalFeaturesEnabled:
          experimental === undefined ? undefined : (): boolean => experimental,
      });
      const browser = await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: `presentation-fast-path-${String(experimental)}`,
      });
      if (!browser.profile) throw new Error('Missing fixture profile');
      const target = {
        browserId: browser.id,
        expectedRuntimeGeneration: browser.profile.runtimeGeneration,
      };
      const resolveProfile = authority.resolve.bind(authority);
      const resolveSpy = jest.fn(resolveProfile);
      authority.resolve = resolveSpy;
      mockSetVisible.mockClear();
      try {
        await service.withRuntimeTarget(
          target,
          () =>
            service.setBounds({
              browserId: browser.id,
              bounds: { x: 0, y: 0, width: 640, height: 480 },
              visible: true,
            }),
          { presentation: true },
        );
        await service.withRuntimeTarget(
          target,
          () => service.setVisible(browser.id, false),
          { presentation: true },
        );
        expect({
          resolves: resolveSpy.mock.calls.length,
          visibility: mockSetVisible.mock.calls.map(([visible]) => visible),
        }).toEqual({
          resolves: presentationResolves,
          visibility: [true, false],
        });

        // Commands that act on the page keep full profile authorization.
        await service.withRuntimeTarget(target, () => undefined);
        expect(resolveSpy).toHaveBeenCalledTimes(presentationResolves + 1);
      } finally {
        await service.shutdown();
      }
    },
  );

  it('does not supersede a pending presentation with a non-presentation command', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
      // Exercise the full authorization compatibility path explicitly.
      experimentalFeaturesEnabled: (): boolean => false,
    });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'presentation-non-presentation',
    });
    if (!browser.profile) throw new Error('Missing fixture profile');

    const resolveProfile = authority.resolve.bind(authority);
    let releasePresentation!: () => void;
    let presentationAuthorizationStarted!: () => void;
    const presentationAuthorizationGate = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const presentationAuthorizationEntered = new Promise<void>((resolve) => {
      presentationAuthorizationStarted = resolve;
    });
    let resolveCalls = 0;
    authority.resolve = jest.fn(async (...args) => {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        presentationAuthorizationStarted();
        await presentationAuthorizationGate;
      }
      return resolveProfile(...args);
    });

    const presentationOperation = jest.fn(() => 'presentation');
    const nonPresentationOperation = jest.fn(() => 'non-presentation');
    const target = {
      browserId: browser.id,
      expectedRuntimeGeneration: browser.profile.runtimeGeneration,
    };
    const pendingPresentation = service.withRuntimeTarget(
      target,
      presentationOperation,
      { presentation: true },
    );
    try {
      await presentationAuthorizationEntered;
      await expect(
        service.withRuntimeTarget(target, nonPresentationOperation),
      ).resolves.toBe('non-presentation');
      releasePresentation();
      await expect(pendingPresentation).resolves.toBe('presentation');
      expect(presentationOperation).toHaveBeenCalledTimes(1);
      expect(nonPresentationOperation).toHaveBeenCalledTimes(1);
    } finally {
      releasePresentation();
      await Promise.allSettled([pendingPresentation]);
      await service.shutdown();
    }
  });

  it('does not supersede a pending presentation with an immediately stale request', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
      // Exercise the full authorization compatibility path explicitly.
      experimentalFeaturesEnabled: (): boolean => false,
    });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'presentation-stale-request',
    });
    if (!browser.profile) throw new Error('Missing fixture profile');

    const resolveProfile = authority.resolve.bind(authority);
    let releasePresentation!: () => void;
    let presentationAuthorizationStarted!: () => void;
    const presentationAuthorizationGate = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const presentationAuthorizationEntered = new Promise<void>((resolve) => {
      presentationAuthorizationStarted = resolve;
    });
    let resolveCalls = 0;
    authority.resolve = jest.fn(async (...args) => {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        presentationAuthorizationStarted();
        await presentationAuthorizationGate;
      }
      return resolveProfile(...args);
    });

    const validOperation = jest.fn(() => 'valid');
    const staleOperation = jest.fn(() => 'stale');
    const pendingPresentation = service.withRuntimeTarget(
      {
        browserId: browser.id,
        expectedRuntimeGeneration: browser.profile.runtimeGeneration,
      },
      validOperation,
      { presentation: true },
    );
    try {
      await presentationAuthorizationEntered;
      await expect(
        service.withRuntimeTarget(
          {
            browserId: browser.id,
            expectedRuntimeGeneration: browser.profile.runtimeGeneration + 1,
          },
          staleOperation,
          { presentation: true },
        ),
      ).rejects.toMatchObject({ code: 'stale_runtime' });
      expect(staleOperation).not.toHaveBeenCalled();
      releasePresentation();
      await expect(pendingPresentation).resolves.toBe('valid');
      expect(validOperation).toHaveBeenCalledTimes(1);
    } finally {
      releasePresentation();
      await Promise.allSettled([pendingPresentation]);
      await service.shutdown();
    }
  });

  it('rejects missing/stale command generations and discards a result after rehydration', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const original = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'epoch-browser',
    });
    const action = jest.fn();
    // The first generation has never changed, so omitting it is not stale.
    expect(original.profile?.runtimeGeneration).toBe(1);
    await service.withRuntimeTarget({ browserId: original.id }, action);
    expect(action).toHaveBeenCalledTimes(1);
    action.mockClear();
    let complete: ((value: string) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = service.withRuntimeTarget(
      {
        browserId: original.id,
        expectedRuntimeGeneration: original.profile?.runtimeGeneration,
      },
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
          entered?.();
        }),
    );
    await started;
    await service.disposeLiveView(original.id);
    const next = await service.create({
      projectId: original.projectId,
      worktreeId: original.worktreeId,
      browserId: original.id,
    });
    if (!original.profile || !next.profile)
      throw new Error('Expected runtime profile bindings.');
    expect(next.profile.runtimeGeneration).toBeGreaterThan(
      original.profile.runtimeGeneration,
    );
    complete?.('old account data');
    await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
    // A missing generation names the field instead of reporting a change.
    await expect(
      service.withRuntimeTarget({ browserId: original.id }, action),
    ).rejects.toMatchObject({
      code: 'stale_runtime',
      message:
        'expectedRuntimeGeneration is required for this tab. Pass profile.runtimeGeneration from the browser.open or browser.list result.',
    });
    expect(action).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('rejects a queued command before it can navigate a replacement account', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const original = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'queued-browser',
    });
    let release!: () => void;
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = service.withRuntimeTarget(
      {
        browserId: original.id,
        expectedRuntimeGeneration: original.profile?.runtimeGeneration,
      },
      async () => {
        entered();
        await queued;
        return service.navigate({
          browserId: original.id,
          url: 'http://localhost/wrong-account-action',
        });
      },
    );
    await started;
    await service.disposeLiveView(original.id);
    await service.create({
      projectId: original.projectId,
      worktreeId: original.worktreeId,
      browserId: original.id,
    });
    const replacement = createdViews[createdViews.length - 1].webContents;
    replacement.loadURL.mockClear();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
    expect(replacement.loadURL).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('rejects queued automation before it can fill a replacement account', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const original = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'queued-automation',
    });
    let release!: () => void;
    let entered!: () => void;
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = service.withRuntimeTarget(
      {
        browserId: original.id,
        expectedRuntimeGeneration: original.profile?.runtimeGeneration,
      },
      async () => {
        entered();
        await queued;
        return service.automation({
          browserId: original.id,
          command: { kind: 'fill', locator: 'input', text: 'wrong account' },
        });
      },
    );
    await started;
    await service.disposeLiveView(original.id);
    await service.create({
      projectId: original.projectId,
      worktreeId: original.worktreeId,
      browserId: original.id,
    });
    const replacement = createdViews[createdViews.length - 1].webContents;
    replacement.send.mockClear();
    replacement.send.mockImplementation(
      (_channel: string, command: { requestId: string }) => {
        ipcListeners.get('canopy-browser-view:result')?.(
          { sender: { id: replacement.id } },
          { requestId: command.requestId, ok: true, result: {} },
        );
      },
    );
    release();
    await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
    expect(replacement.send).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('drains only the selected profile while another profile is opening', async () => {
    const authority = getBrowserProfileService();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    authority.acquireSession = (): Promise<ElectronTypes.Session> =>
      new Promise((resolve) => {
        release = (): void =>
          resolve(session.fromPartition('pending-other-profile'));
        entered();
      });
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const creation = service.create({
      projectId: 'project-1',
      worktreeId: 'other-worktree',
      browserId: 'pending-other-profile',
    });
    await started;
    let unrelatedFinished = false;
    let matchingFinished = false;
    const unrelated = service
      .drainProfileCreations('profile-project-1-worktree-1')
      .then(() => {
        unrelatedFinished = true;
      });
    const matching = service
      .drainProfileCreations('profile-project-1-other-worktree')
      .then(() => {
        matchingFinished = true;
      });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unrelatedFinished).toBe(true);
      expect(matchingFinished).toBe(false);
    } finally {
      release();
      await Promise.all([creation, unrelated, matching]);
      await service.shutdown();
    }
  });

  it('rejects reopening an existing tab while profile maintenance owns admission', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const original = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'fenced-existing',
      url: 'http://localhost/original',
    });
    if (!original.profile) throw new Error('Missing fixture profile');
    service.setMaintenanceFence(original.profile.resolvedProfileId, true);
    try {
      await expect(
        service.create({
          projectId: original.projectId,
          worktreeId: original.worktreeId,
          browserId: original.id,
          url: 'http://localhost/during-clear',
        }),
      ).rejects.toMatchObject({ code: 'operation_conflict' });
      expect(webContents.getURL()).toBe('http://localhost/original');
    } finally {
      service.setMaintenanceFence(original.profile.resolvedProfileId, false);
      await service.shutdown();
    }
  });

  it('drains pending task view creation before retirement disposal finishes', async () => {
    const authority: BrowserProfileAuthority = getBrowserProfileService();
    let releaseAcquisition: (() => void) | undefined;
    let acquisitionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      acquisitionStarted = resolve;
    });
    authority.acquireSession = (): Promise<ElectronTypes.Session> =>
      new Promise<ElectronTypes.Session>((resolve) => {
        releaseAcquisition = (): void =>
          resolve(session.fromPartition('fixture'));
        acquisitionStarted?.();
      });
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const creation = service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'pending-view',
    });
    const rejectedCreation = expect(creation).rejects.toMatchObject({
      code: 'stale_runtime',
    });
    await started;
    let disposed = false;
    const disposal = service
      .disposeWorktreeViews('project-1', 'worktree-1')
      .then(() => {
        disposed = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);
    releaseAcquisition?.();
    await Promise.all([rejectedCreation, disposal]);
    expect(service.getLifecycleStats().liveViews).toBe(0);
  });

  it('withdraws a saved agent binding when confirmation is refused', async () => {
    const authority = getBrowserProfileService();
    const resolveProfile = authority.resolve.bind(authority);
    // As the real authority decides it: only a tab that has no binding yet
    // needs the agent permission.
    authority.resolve = async (...args): Promise<BrowserProfileResolution> => ({
      ...(await resolveProfile(...args)),
      agentEnableRequired: !args[2]?.profile,
    });
    let revoked = false;
    authority.assertActive = (resolution): Promise<void> =>
      revoked && resolution.agentEnableRequired
        ? Promise.reject(new Error('agent_enable_denied'))
        : Promise.resolve();
    // The permission is revoked once the binding is written.
    jest.mocked(saveWorktreeBrowserState).mockImplementationOnce(() => {
      revoked = true;
      return Promise.resolve();
    });
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'agent-tab',
    };

    await expect(service.create(request, 'agent')).rejects.toThrow(
      'agent_enable_denied',
    );
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([]);
    expect(savedBrowserStateFor('project-1', 'worktree-1')).toMatchObject({
      browserOrder: [],
      browsers: [],
    });
    // A binding left behind would make the retry an existing tab, which skips
    // the permission.
    await expect(service.create(request, 'agent')).rejects.toThrow(
      'agent_enable_denied',
    );
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([]);
    await service.shutdown();
  });

  it('logs a withdrawal that cannot be saved and reports the refusal', async () => {
    const authority = getBrowserProfileService();
    let revoked = false;
    authority.assertActive = (): Promise<void> =>
      revoked
        ? Promise.reject(new Error('agent_enable_denied'))
        : Promise.resolve();
    jest
      .mocked(saveWorktreeBrowserState)
      .mockImplementationOnce(async (_request, commit) => {
        if (commit) await commit(() => Promise.resolve());
        revoked = true;
      })
      .mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('EIO: /Users/someone/browser-state.json'), {
            code: 'EIO',
          }),
        ),
      );
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });

    await expect(
      service.create(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'agent-tab',
        },
        'agent',
      ),
    ).rejects.toThrow('agent_enable_denied');

    // The code only: the message can name a local path.
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      'Browser binding withdrawal could not be saved',
      { operation: 'browser_binding_withdrawal', code: 'EIO' },
    );
    await service.shutdown();
  });

  it('does not save again when a new-tab switch fails before its target is written', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const source = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'source-tab',
    });
    mockSwitchJournalBegin.mockImplementation(
      (
        request: { operationId: string; mode: 'replace' | 'new-tab' },
        recordSource: BrowserSessionSnapshot,
        target: BrowserSessionSnapshot,
      ): Promise<BrowserSwitchRecord> =>
        Promise.resolve({
          schemaVersion: 1,
          operationId: request.operationId,
          digest: 'a'.repeat(64),
          createdAt: Date.now(),
          stage: 'prepared',
          source: recordSource,
          target,
          mode: request.mode,
        }),
    );
    // The two checks before the commit pass; the one inside it, before the
    // write, refuses.
    let checks = 0;
    authority.assertActive = (): Promise<void> =>
      ++checks === 3
        ? Promise.reject(new Error('scope_retired'))
        : Promise.resolve();
    const savesBefore = jest.mocked(saveWorktreeBrowserState).mock.calls.length;

    await expect(
      service.switchProfile({
        operationId: 'switch-operation',
        browserId: source.id,
        expectedRuntimeGeneration: source.profile?.runtimeGeneration ?? 0,
        selection: { kind: 'task' },
        mode: 'new-tab',
      }),
    ).rejects.toThrow('scope_retired');

    // Only the refused save itself: nothing was written, so there is nothing
    // to withdraw and no reason to take the operation lock again.
    expect(jest.mocked(saveWorktreeBrowserState).mock.calls.length).toBe(
      savesBefore + 1,
    );
    expect(
      service
        .listWorktreeBrowsers('project-1', 'worktree-1')
        .map((tab) => tab.id),
    ).toEqual(['source-tab']);
    await service.shutdown();
  });

  it('restores an unbound tab when its first binding is not confirmed', async () => {
    const authority = getBrowserProfileService();
    let checks = 0;
    authority.assertActive = (): Promise<void> =>
      ++checks === 2
        ? Promise.reject(new Error('scope_retired'))
        : Promise.resolve();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const unbound = persistedSnapshot('unbound-tab');
    await service.saveWorktreeState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state: {
        version: 1,
        browserOrder: [unbound.id],
        activeBrowserId: unbound.id,
        browsers: [unbound],
      },
    });

    await expect(
      service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: unbound.id,
      }),
    ).rejects.toThrow('scope_retired');

    // The tab is the one the user had, not one bound to a refused task.
    const [restored] = service.listWorktreeBrowsers('project-1', 'worktree-1');
    expect(restored).toMatchObject({ id: unbound.id, url: unbound.url });
    expect(restored?.profile).toBeUndefined();
    const persisted = savedBrowserStateFor('project-1', 'worktree-1');
    expect(persisted.browserOrder).toEqual([unbound.id]);
    expect(persisted.browsers[0]?.profile).toBeUndefined();
    await service.shutdown();
  });

  it('removes a saved new-tab switch target when the switch is not recorded', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const source = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'source-tab',
    });
    mockSwitchJournalBegin.mockImplementation(
      (
        request: { operationId: string; mode: 'replace' | 'new-tab' },
        recordSource: BrowserSessionSnapshot,
        target: BrowserSessionSnapshot,
      ): Promise<BrowserSwitchRecord> =>
        Promise.resolve({
          schemaVersion: 1,
          operationId: request.operationId,
          digest: 'a'.repeat(64),
          createdAt: Date.now(),
          stage: 'prepared',
          source: recordSource,
          target,
          mode: request.mode,
        }),
    );
    // The target's state file is written, then recording the decision fails.
    mockSwitchJournalUpdate.mockImplementation(
      (record: BrowserSwitchRecord, stage: BrowserSwitchRecord['stage']) =>
        stage === 'target_committed'
          ? Promise.reject(new Error('journal unavailable'))
          : Promise.resolve({ ...record, stage }),
    );

    await expect(
      service.switchProfile({
        operationId: 'switch-operation',
        browserId: source.id,
        expectedRuntimeGeneration: source.profile?.runtimeGeneration ?? 0,
        selection: { kind: 'task' },
        mode: 'new-tab',
      }),
    ).rejects.toThrow('journal unavailable');

    // The switch reports cancelled, so a saved target would restore as an
    // extra tab. A new tab has its own id, so nothing else removes it.
    expect(
      service
        .listWorktreeBrowsers('project-1', 'worktree-1')
        .map((tab) => tab.id),
    ).toEqual(['source-tab']);
    expect(
      savedBrowserStateFor('project-1', 'worktree-1').browserOrder,
    ).toEqual(['source-tab']);
    await service.shutdown();
  });

  it('registers browser renderer resources and updates labels from navigation state', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-resource',
      url: 'http://localhost:3000/path?token=secret#section',
    });

    const initialRegistration = mockRegisterResourceProcess.mock.calls[0]?.[0];
    expect(initialRegistration).toMatchObject({
      id: 'browser:browser-resource',
      groupId: 'browser',
      kind: 'in-app-browser',
      pid: 4242,
    });
    expect(initialRegistration?.metadata).toEqual({
      type: 'browser',
      browser: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-resource',
        visible: false,
        status: 'idle',
      },
    });

    const latestUpdate =
      mockResourceRegistrationUpdate.mock.calls[
        mockResourceRegistrationUpdate.mock.calls.length - 1
      ]?.[0];
    expect(latestUpdate).toMatchObject({
      label: 'Test page',
      pid: 4242,
    });
    expect(latestUpdate?.metadata).toEqual({
      type: 'browser',
      browser: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-resource',
        title: 'Test page',
        displayUrl: 'localhost:3000/path',
        visible: false,
        status: 'ready',
      },
    });

    await service.destroy('browser-resource');

    expect(mockResourceRegistrationUnregister).toHaveBeenCalledTimes(1);
  });

  it('initializes required CDP debugger domains', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-cdp',
      url: 'http://localhost:3000',
      themeMode: 'dark',
    });

    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.enable',
    );
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Debugger.enable',
    );
    expect(appPromptBridgeCall()?.[1]?.source).toContain(
      'canopyAppOwnedPrompt',
    );
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Network.enable',
    );
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Page.enable',
    );
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Log.enable');
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setEmulatedMedia',
      {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      },
    );
    // CAN-1993: automations keep running while the user works in another app,
    // so the page must believe it is focused without the view ever asking the
    // OS for focus.
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setFocusEmulationEnabled',
      { enabled: true },
    );
  });

  it('lets the page follow the app theme in System mode', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-theme-system',
    });
    webContents.debugger.sendCommand.mockClear();

    const snapshot = await service.setTheme('browser-theme-system', 'system');

    expect(snapshot.themeMode).toBe('system');
    // An empty value clears the override instead of forcing light or dark.
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: '' }] },
    );
  });

  it.each([
    { earlyAccess: true, shownAtOnce: true },
    { earlyAccess: false, shownAtOnce: false },
  ])(
    'shows a new page theme before a slow page applies it only with early access ($earlyAccess)',
    async ({ earlyAccess, shownAtOnce }) => {
      jest.useFakeTimers();
      const service = new BrowserService({
        getWindow: mockWindow,
        experimentalFeaturesEnabled: (): boolean => earlyAccess,
      });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-theme-instant',
      });
      jest.mocked(sendToWindow).mockClear();
      // The page never answers the emulation command.
      webContents.debugger.sendCommand.mockImplementationOnce(
        () => new Promise(() => undefined),
      );

      const pending = service.setTheme('browser-theme-instant', 'dark');
      await Promise.resolve();

      const darkSnapshotShown = (): boolean =>
        jest
          .mocked(sendToWindow)
          .mock.calls.map((call): unknown => call[2])
          .some(
            (event) =>
              typeof event === 'object' &&
              event !== null &&
              'type' in event &&
              event.type === 'snapshot' &&
              'snapshot' in event &&
              typeof event.snapshot === 'object' &&
              event.snapshot !== null &&
              'themeMode' in event.snapshot &&
              event.snapshot.themeMode === 'dark',
          );
      expect(darkSnapshotShown()).toBe(shownAtOnce);

      await jest.advanceTimersByTimeAsync(2000);
      await pending;
      // Either way the mode shows once the bounded emulation settles.
      expect(darkSnapshotShown()).toBe(true);
      jest.useRealTimers();
    },
  );

  it('captures late debugger command failures after a theme timeout', async () => {
    jest.useFakeTimers();
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-theme-timeout',
    });
    jest.mocked(sendToWindow).mockClear();

    let rejectLate!: (error: Error) => void;
    webContents.debugger.sendCommand.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    );

    const setThemePromise = service.setTheme('browser-theme-timeout', 'dark');
    await jest.advanceTimersByTimeAsync(2000);
    await expect(setThemePromise).resolves.toEqual(
      expect.objectContaining({ themeMode: 'dark' }),
    );

    rejectLate(new Error('CDP target closed'));
    await Promise.resolve();
    await Promise.resolve();

    const consoleEvent = jest
      .mocked(sendToWindow)
      .mock.calls.map((call): unknown => call[2])
      .find(
        (event): event is Extract<BrowserEvent, { type: 'console' }> =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'console',
      );
    expect(consoleEvent?.entry.level).toBe('warning');
    expect(consoleEvent?.entry.text).toContain('CDP target closed');
  });

  it('preserves non-Error CDP rejection details for the failing command', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-theme-cdp-error',
    });
    jest.mocked(sendToWindow).mockClear();
    webContents.debugger.sendCommand.mockRejectedValueOnce({
      code: -32_000,
      message: 'Target closed',
    });

    await service.setTheme('browser-theme-cdp-error', 'dark');

    const consoleText = jest
      .mocked(sendToWindow)
      .mock.calls.map((call): unknown => call[2])
      .filter(
        (event): event is Extract<BrowserEvent, { type: 'console' }> =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'console',
      )
      .map((event) => event.entry.text)
      .join('\n');
    expect(consoleText).toContain('Emulation.setEmulatedMedia');
    expect(consoleText).toContain('Target closed');
    expect(consoleText).not.toContain('profile switch');
  });

  it('creates an empty browser without loading about:blank', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-empty',
    });

    expect(snapshot).toMatchObject({
      id: 'browser-empty',
      url: '',
      status: 'idle',
      loading: false,
    });
    expect(webContents.loadURL).not.toHaveBeenCalledWith('about:blank');
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({ id: 'browser-empty', url: '' }),
    ]);
  });

  it('rejects an invalid automation payload before preparing a target', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'invalid-automation',
      url: 'http://localhost:3000',
    });

    const result = await service.automation({
      browserId: 'invalid-automation',
      command: { kind: 'click', locator: '#button', clickCount: 4 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(modelSeam.resolveActionTarget).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('rejects an old runtime generation before an action id reaches its lane', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'stale-action-generation',
      url: 'http://localhost:3000',
    });
    const generation = snapshot.profile?.runtimeGeneration;
    expect(generation).toBeDefined();
    installNativePipeline();

    await expect(
      service.withRuntimeTarget(
        {
          browserId: 'stale-action-generation',
          expectedRuntimeGeneration: (generation ?? 0) - 1,
        },
        () =>
          service.automation({
            browserId: 'stale-action-generation',
            command: {
              kind: 'click',
              actionId: 'old-runtime-action',
              locator: '#button',
            },
          }),
      ),
    ).rejects.toMatchObject({ code: 'stale_runtime' });
    expect(modelSeam.resolveActionTarget).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('replays a repeated action id and rejects conflicting reuse without dispatch', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'replayed-action',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const command = {
      kind: 'click' as const,
      actionId: 'stable-action',
      locator: '#button',
      dialogResponse: { accept: true, promptText: 'continue' },
    };

    const first = await service.automation({
      browserId: 'replayed-action',
      command,
    });
    const repeated = await service.automation({
      browserId: 'replayed-action',
      command: {
        ...command,
        timeoutMs: 5_000,
        button: 'left',
        clickCount: 1,
        dialogResponse: { promptText: 'continue', accept: true },
      },
    });
    const conflict = await service.automation({
      browserId: 'replayed-action',
      command: { ...command, locator: '#other' },
    });
    const forceConflict = await service.automation({
      browserId: 'replayed-action',
      command: { ...command, force: false },
    });
    const timeoutConflict = await service.automation({
      browserId: 'replayed-action',
      command: { ...command, timeoutMs: 5_001 },
    });

    expect(repeated).toMatchObject({
      ok: true,
      repeated: true,
      receipt: first.receipt,
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    // The conflict message names the reused action id.
    expect(JSON.stringify(conflict)).toContain('stable-action');
    expect(conflict.receipt).toBeUndefined();
    expect(forceConflict).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(timeoutConflict).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(
      webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Input.dispatchMouseEvent',
      ),
    ).toHaveLength(3);
    await service.shutdown();
  });

  it('retains wait idempotency entries beyond fifty and replays with the current browser', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'retained-wait-actions',
      url: 'http://localhost:3000/ready',
    });
    const first = await service.automation({
      browserId: 'retained-wait-actions',
      command: {
        kind: 'wait_for',
        actionId: 'retained-wait-0',
        url: '/ready',
        timeoutMs: 0,
      },
    });
    for (let index = 1; index <= 60; index += 1) {
      const result = await service.automation({
        browserId: 'retained-wait-actions',
        command: {
          kind: 'wait_for',
          actionId: `retained-wait-${index}`,
          url: '/ready',
          timeoutMs: 0,
        },
      });
      expect(waitForOf(result)?.satisfied).toBe(true);
    }
    webContents.currentUrl = 'http://localhost:3000/changed?token=secret';
    webContents.emit('did-navigate-in-page', {}, webContents.currentUrl, true);

    const repeated = await service.automation({
      browserId: 'retained-wait-actions',
      command: {
        kind: 'wait_for',
        actionId: 'retained-wait-0',
        url: '/ready',
        timeoutMs: 0,
      },
    });

    expect(first).toMatchObject({
      waitFor: {
        satisfied: true,
        observed: { url: 'http://localhost:3000/ready' },
      },
      receipt: { sequence: 1 },
    });
    expect(repeated).toMatchObject({
      repeated: true,
      browser: { url: 'http://localhost:3000/changed?token=secret' },
      waitFor: {
        satisfied: true,
        observed: { url: 'http://localhost:3000/ready' },
      },
      receipt: { sequence: 1 },
    });
    expect(modelSeam.waitProbe).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('shares one in-flight execution for duplicate action ids', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'inflight-replay',
      url: 'http://localhost:3000',
    });
    let enteredDispatch = (): void => {};
    const entered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    let finishDispatch = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    let pressed = 0;
    installNativePipeline({
      input: (method, params) => {
        if (
          method === 'Input.dispatchMouseEvent' &&
          params.type === 'mousePressed'
        ) {
          pressed += 1;
          enteredDispatch();
          return blocked;
        }
        return Promise.resolve({});
      },
    });
    const request = {
      browserId: 'inflight-replay',
      command: {
        kind: 'click' as const,
        actionId: 'inflight-stable-id',
        locator: '#button',
      },
    };
    const firstPending = service.automation(request);
    await entered;
    const duplicatePending = service.automation(request);
    finishDispatch();
    const [first, duplicate] = await Promise.all([
      firstPending,
      duplicatePending,
    ]);

    expect(first).not.toHaveProperty('repeated');
    expect(duplicate).toMatchObject({
      repeated: true,
      receipt: first.receipt,
    });
    expect(pressed).toBe(1);
    // One target resolution: the duplicate shares the first execution.
    expect(modelSeam.resolveActionTarget).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('starts a fresh idempotency store for a replacement runtime generation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const initial = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'replay-new-runtime',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const command = {
      kind: 'click' as const,
      actionId: 'same-id-next-runtime',
      locator: '#button',
    };
    const first = await service.automation({
      browserId: initial.id,
      command,
    });
    await service.disposeLiveView(initial.id);
    const replacement = await service.create({
      projectId: initial.projectId,
      worktreeId: initial.worktreeId,
      browserId: initial.id,
      url: 'http://localhost:3000',
    });
    const replacementContents =
      createdViews[createdViews.length - 1]?.webContents;
    if (!replacementContents)
      throw new Error('Expected replacement browser contents.');
    installNativePipeline({}, replacementContents);

    const next = await service.automation({
      browserId: replacement.id,
      command,
    });

    expect(replacement.profile?.runtimeGeneration).toBeGreaterThan(
      initial.profile?.runtimeGeneration ?? 0,
    );
    expect(next).not.toHaveProperty('repeated');
    expect(next.receipt?.sequence).toBe(1);
    expect(first.receipt?.sequence).toBe(1);
    expect(
      replacementContents.debugger.sendCommand.mock.calls.filter(
        ([method, params]) =>
          method === 'Input.dispatchMouseEvent' &&
          params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
    await service.shutdown();
  });

  it('marks an in-flight duplicate of an unknown result as repeated', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'unknown-replay',
      url: 'http://localhost:3000',
    });
    let enteredDispatch = (): void => {};
    const entered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    let finishDispatch = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    installNativePipeline({
      input: (method, params) => {
        if (
          method === 'Input.dispatchMouseEvent' &&
          params.type === 'mousePressed'
        ) {
          enteredDispatch();
          return blocked;
        }
        return Promise.resolve({});
      },
    });
    const request = {
      browserId: browser.id,
      command: {
        kind: 'click' as const,
        actionId: 'unknown-stable-id',
        locator: '#button',
      },
    };
    const firstPending = service.automation(request);
    await entered;
    const duplicatePending = service.automation(request);
    await service.disposeLiveView(browser.id);
    const [first, duplicate] = await Promise.all([
      firstPending,
      duplicatePending,
    ]);

    expect(first).toMatchObject({
      kind: 'post-dispatch-unknown',
      receipt: { status: 'outcome_unknown', outcomeReason: 'runtime_lost' },
    });
    expect(duplicate).toMatchObject({
      kind: 'post-dispatch-unknown',
      repeated: true,
      receipt: first.receipt,
    });
    finishDispatch();
    await service.shutdown();
  });

  it('passes click count and modifiers through trusted mouse dispatch', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'click-options',
      url: 'http://localhost:3000',
    });
    installNativePipeline();

    const result = await service.automation({
      browserId: 'click-options',
      command: {
        kind: 'click',
        locator: '#button',
        clickCount: 2,
        modifiers: ['Control'],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      receipt: { inputMode: 'trusted' },
    });
    const mouse = webContents.debugger.sendCommand.mock.calls
      .filter(([method]) => method === 'Input.dispatchMouseEvent')
      .map(([, params]) => params);
    expect(mouse.map((params) => params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mousePressed',
      'mouseReleased',
    ]);
    expect(mouse.slice(1).map((params) => params?.clickCount)).toEqual([
      1, 1, 2, 2,
    ]);
    expect(mouse.every((params) => params?.modifiers === 2)).toBe(true);
    await service.shutdown();
  });

  it('bounds action work by twice the action timeout without extending drain', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'action-lane-timeout',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const run = jest.spyOn(ActionLane.prototype, 'run');

    await service.automation({
      browserId: 'action-lane-timeout',
      command: { kind: 'click', locator: '#button', timeoutMs: 3_000 },
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 11_000 });
    expect(run.mock.calls[0]?.[1]?.drainTimeoutMs).toBeUndefined();
    await service.shutdown();
  });

  // Nothing reached the page, so the action id is free again: a retry runs,
  // and the id can carry a different command.
  it('reports pre-dispatch lane timeouts as retryable and frees their action id', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'pre-dispatch-timeout',
      url: 'http://localhost:3000',
    });
    const run = jest.spyOn(ActionLane.prototype, 'run');
    run.mockImplementation(() =>
      Promise.resolve({
        status: 'not_executed',
        sequence: 1,
        reason: 'timeout',
        code: 'timeout',
        message: 'The action timed out before dispatch.',
      }),
    );

    try {
      const request = {
        browserId: 'pre-dispatch-timeout',
        command: {
          kind: 'click' as const,
          locator: '#button',
          actionId: 'retained-pre-dispatch-timeout',
        },
      };
      const result = await service.automation(request);
      const retried = await service.automation(request);
      const reused = await service.automation({
        ...request,
        command: { ...request.command, locator: '#other' },
      });

      expect(retried).not.toHaveProperty('repeated');
      expect(retried).toMatchObject({ error: { code: 'timeout' } });
      expect(reused).toMatchObject({ error: { code: 'timeout' } });
      expect(run).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'timeout' },
        receipt: {
          status: 'not_executed',
          error: { code: 'timeout', retryable: true },
        },
      });
    } finally {
      run.mockRestore();
      await service.shutdown();
    }
  });

  it('enters actions into the lane in arrival order with or without an actionId', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'arrival-order',
      url: 'http://localhost:3000',
    });
    const order: string[] = [];
    const run = jest.spyOn(ActionLane.prototype, 'run');
    run.mockImplementation(() => {
      order.push(`run-${order.length + 1}`);
      return Promise.resolve({
        status: 'not_executed',
        sequence: order.length,
        reason: 'execution_failed',
        code: 'execution_failed',
        message: 'Not run in this test.',
      });
    });

    try {
      const fill = service.automation({
        browserId: 'arrival-order',
        command: {
          kind: 'fill',
          locator: '#name',
          text: 'Ada',
          actionId: 'fill-before-press',
        },
      });
      const press = service.automation({
        browserId: 'arrival-order',
        command: { kind: 'press', key: 'Enter' },
      });
      const [fillResult, pressResult] = await Promise.all([fill, press]);

      // The lane numbers actions in the order they enter it.
      expect(run).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(fillResult)).toContain('"kind":"fill"');
      expect(JSON.stringify(pressResult)).toContain('"kind":"press"');
      expect(JSON.stringify(fillResult)).toContain('"sequence":1');
      expect(JSON.stringify(pressResult)).toContain('"sequence":2');
    } finally {
      run.mockRestore();
      await service.shutdown();
    }
  });

  it('forces a direct click and records only the explicit force warning', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'forced-click',
      url: 'http://localhost:3000',
    });
    installNativePipeline({
      sample: { receivesEvents: false, cover: 'div.overlay' },
    });

    const result = await service.automation({
      browserId: 'forced-click',
      command: { kind: 'click', locator: '#button', force: true },
    });

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        inputMode: 'synthetic',
        warnings: ['Forced: clicked the element directly.'],
      },
    });
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Input.dispatchMouseEvent',
      ),
    ).toBe(false);
    const declaration = webContents.debugger.sendCommand.mock.calls.find(
      ([method, params]) =>
        method === 'Runtime.callFunctionOn' &&
        typeof params?.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('const action ='),
    )?.[1]?.functionDeclaration;
    expect(declaration).toContain('"button":"left"');
    expect(declaration).toContain('"clickCount":1');
    expect(declaration).toContain('this.click();');
    await service.shutdown();
  });

  it.each(syntheticClickPolicies)(
    'emits the exact synthetic mouse sequence without accidental click dispatch (%#)',
    async (policy) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: `synthetic-${policy.button}-${policy.clickCount}`,
        url: 'http://localhost:3000',
      });
      installNativePipeline({
        sample: { receivesEvents: false, cover: 'div.overlay' },
      });

      const result = await service.automation({
        browserId: `synthetic-${policy.button}-${policy.clickCount}`,
        command: {
          kind: 'click',
          locator: '#button',
          force: true,
          button: policy.button,
          clickCount: policy.clickCount,
          modifiers: [...policy.modifiers],
        },
      });
      const declaration = webContents.debugger.sendCommand.mock.calls.find(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          typeof params?.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('const action ='),
      )?.[1]?.functionDeclaration;
      if (typeof declaration !== 'string')
        throw new Error('Expected the synthetic action declaration.');
      const element = executeCapturedSyntheticAction(declaration);

      expect(result.receipt?.warnings).toEqual([
        'Forced: clicked the element directly.',
      ]);
      expect(element.clickCalls).toBe(policy.clickCalls);
      expect(
        element.events.map((event) => ({ type: event.type, ...event.init })),
      ).toEqual(policy.events);
      if (
        policy.button !== 'left' ||
        policy.clickCount > 1 ||
        policy.modifiers.length > 0
      )
        expect(element.clickCalls).toBe(0);
      await service.shutdown();
    },
  );

  it('prepares and dispatches focus, then reports the final target focus state', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'focus-action',
      url: 'http://localhost:3000',
    });
    installNativePipeline();

    const result = await service.automation({
      browserId: 'focus-action',
      command: { kind: 'focus', locator: '#input' },
    });

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        kind: 'focus',
        inputMode: 'trusted',
        target: { focused: true },
      },
    });
    expect(modelSeam.resolveActionTarget).toHaveBeenCalledWith({
      kind: 'locator',
      locator: '#input',
    });
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('DOM.focus', {
      objectId: 'native-target',
    });
    await service.shutdown();
  });

  it('runs wait_for outside the input queue and shares the action sequence', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'wait-for-action',
      url: 'http://localhost:3000',
    });
    installNativePipeline({
      waitForProbe: {
        matchCount: 1,
        visibleCount: 1,
        readyState: 'complete',
      },
    });

    const waited = await service.automation({
      browserId: 'wait-for-action',
      command: { kind: 'wait_for', locator: '#ready', timeoutMs: 1_000 },
    });
    const clicked = await service.automation({
      browserId: 'wait-for-action',
      command: { kind: 'click', locator: '#button' },
    });

    expect(waited).toMatchObject({
      ok: true,
      completed: true,
      waitFor: { satisfied: true },
      receipt: { kind: 'wait_for', sequence: 1, status: 'executed' },
    });
    expect(clicked.receipt?.sequence).toBe(2);
    expect(modelSeam.waitProbe).toHaveBeenCalledWith({ locator: '#ready' });
    await service.shutdown();
  });

  it('discovers an initially unknown root before the first load-state probe without building a model', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'first-load-wait',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const build = jest.spyOn(PageModelHost.prototype, 'build');
    modelSeam.waitProbe.mockImplementation(function (this: PageModelHost) {
      if (!this.hasNavigatedRoot())
        return Promise.reject(new Error('The page has no document yet.'));
      return Promise.resolve({
        matchCount: 0,
        visibleCount: 0,
        readyState: 'complete',
      });
    });
    try {
      for (let probe = 0; probe < 2; probe += 1) {
        const result = await service.automation({
          browserId: 'first-load-wait',
          command: { kind: 'wait_for', loadState: 'load', timeoutMs: 1_000 },
        });
        expect(result).toMatchObject({
          ok: true,
          waitFor: { satisfied: true },
        });
      }
      expect(
        webContents.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === 'Page.getFrameTree',
        ),
      ).toHaveLength(1);
      expect(modelSeam.waitProbe).toHaveBeenCalledTimes(2);
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
      await service.shutdown();
    }
  });

  it('re-pushes the new main document before a point action effect baseline', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'point-after-navigation',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    modelSeam.establishTracking.mockRestore();
    const hosts: PageModelHost[] = [];
    modelSeam.resolveActionTarget.mockImplementation(function (
      this: PageModelHost,
    ) {
      hosts.push(this);
      return Promise.resolve({
        status: 'found',
        target: seamTarget('native-target'),
      });
    });
    jest.useFakeTimers();
    try {
      const first = service.automation({
        browserId: 'point-after-navigation',
        command: { kind: 'click', x: 30, y: 30 },
      });
      await jest.advanceTimersByTimeAsync(2_500);
      expect(await first).toMatchObject({ ok: true, completed: true });
      const host = hosts[0];
      if (!host) throw new Error('Missing real host');
      host.noteEvent('Page.frameNavigated', {
        frame: {
          id: 'main-frame',
          loaderId: 'new-document',
          url: 'http://localhost:3000/next',
        },
      });
      webContents.debugger.sendCommand.mockClear();
      const second = service.automation({
        browserId: 'point-after-navigation',
        command: { kind: 'click', x: 30, y: 30 },
      });
      await jest.advanceTimersByTimeAsync(2_500);
      expect(await second).toMatchObject({ ok: true, completed: true });
      const methods = webContents.debugger.sendCommand.mock.calls.map(
        ([method]) => method,
      );
      // With the root already known, the first frame-tree read is the effect baseline.
      expect(methods.indexOf('DOM.getDocument')).toBeGreaterThanOrEqual(0);
      expect(methods.indexOf('DOM.getDocument')).toBeLessThan(
        methods.indexOf('Page.getFrameTree'),
      );
    } finally {
      jest.useRealTimers();
      await service.shutdown();
    }
  });

  it('satisfies domcontentloaded from an interactive probe while loading', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'wait-domcontentloaded-during-load',
      url: 'http://localhost:3000',
    });
    installNativePipeline({
      waitForProbe: {
        matchCount: 0,
        visibleCount: 0,
        readyState: 'interactive',
      },
    });
    webContents.emit('did-start-loading');

    const result = await service.automation({
      browserId: 'wait-domcontentloaded-during-load',
      command: {
        kind: 'wait_for',
        loadState: 'domcontentloaded',
        timeoutMs: 0,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      completed: true,
      waitFor: {
        satisfied: true,
        observed: { readyState: 'interactive' },
      },
    });
    // A load-state wait reads only readyState: the probe gets no locator.
    expect(modelSeam.waitProbe).toHaveBeenCalledWith({});
    await service.shutdown();
  });

  it('matches the full URL during loading but reports only its origin and path', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'wait-url-during-load',
      url: 'http://localhost:3000',
    });
    webContents.currentUrl = 'http://localhost:3000/next?token=secret#fragment';
    webContents.emit('did-start-loading');

    const queryMatch = await service.automation({
      browserId: 'wait-url-during-load',
      command: { kind: 'wait_for', url: 'token=secret', timeoutMs: 0 },
    });
    const globMatch = await service.automation({
      browserId: 'wait-url-during-load',
      command: {
        kind: 'wait_for',
        url: 'http://localhost:3000/next?token=*',
        timeoutMs: 0,
      },
    });
    const unanchoredGlob = await service.automation({
      browserId: 'wait-url-during-load',
      command: { kind: 'wait_for', url: '/next*', timeoutMs: 0 },
    });

    expect(queryMatch).toMatchObject({
      ok: true,
      waitFor: {
        satisfied: true,
        observed: { url: 'http://localhost:3000/next' },
      },
    });
    expect(waitForOf(globMatch)?.satisfied).toBe(true);
    expect(waitForOf(globMatch)?.observed.url).toBe(
      'http://localhost:3000/next',
    );
    expect(waitForOf(unanchoredGlob)?.satisfied).toBe(false);
    expect(modelSeam.waitProbe).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('maps malformed CSS probes to invalid_target and clears the pending read', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'wait-invalid-css',
      url: 'http://localhost:3000',
    });
    modelSeam.waitProbe.mockRejectedValue(
      new LocatorRequestError('invalid_css', 'Invalid CSS locator: "div["'),
    );

    const result = await service.automation({
      browserId: 'wait-invalid-css',
      command: { kind: 'wait_for', locator: 'div[', timeoutMs: 1_000 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
      receipt: { kind: 'wait_for', status: 'not_executed' },
    });
    expect(service.getLifecycleStats().pendingCommands).toBe(0);
    await service.shutdown();
  });

  it('cancels a pending probe on document replacement and caller abort', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'wait-navigation-cancel',
      url: 'http://localhost:3000',
    });
    // The model probe never answers; the document replacement cancels it
    // (the wait retries with a new probe) and the caller's abort ends it.
    const probes: Array<() => void> = [];
    let probeSent = (): void => {};
    let sent = new Promise<void>((resolve) => {
      probeSent = resolve;
    });
    modelSeam.waitProbe.mockImplementation(() => {
      probes.push(probeSent);
      probeSent();
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const pending = service.automation(
      {
        browserId: 'wait-navigation-cancel',
        command: { kind: 'wait_for', locator: '#ready', timeoutMs: 5_000 },
      },
      controller.signal,
    );
    await sent;
    sent = new Promise<void>((resolve) => {
      probeSent = resolve;
    });
    expect(modelSeam.waitProbe).toHaveBeenCalledTimes(1);

    webContents.emit('did-navigate', {}, 'http://localhost:3000/next');
    await sent;
    expect(modelSeam.waitProbe).toHaveBeenCalledTimes(2);
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      receipt: { kind: 'wait_for', status: 'not_executed' },
    });
    expect(service.getLifecycleStats().pendingCommands).toBe(0);
    await service.shutdown();
  });

  it('tracks network-idle request ids across redirects, finish, and failure', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'wait-network-events',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const debuggerMessage = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    expect(debuggerMessage).toBeDefined();
    debuggerMessage?.({}, 'Network.requestWillBeSent', {
      requestId: 'request-1',
      request: { method: 'GET', url: 'http://localhost/first' },
    });
    debuggerMessage?.({}, 'Network.requestWillBeSent', {
      requestId: 'request-1',
      redirectResponse: {
        url: 'http://localhost/first',
        status: 302,
        statusText: 'Found',
        mimeType: 'text/html',
      },
      request: { method: 'GET', url: 'http://localhost/second' },
    });
    const whileInFlight = await service.automation({
      browserId: 'wait-network-events',
      command: { kind: 'wait_for', loadState: 'network_idle', timeoutMs: 0 },
    });
    debuggerMessage?.({}, 'Network.loadingFinished', {
      requestId: 'request-1',
    });
    const afterFinish = await service.automation({
      browserId: 'wait-network-events',
      command: { kind: 'wait_for', loadState: 'network_idle', timeoutMs: 0 },
    });

    expect(waitForOf(whileInFlight)?.observed.inflightRequests).toBe(1);
    expect(waitForOf(afterFinish)?.observed.inflightRequests).toBe(0);
    debuggerMessage?.({}, 'Network.requestWillBeSent', {
      requestId: 'request-2',
      request: { method: 'GET', url: 'http://localhost/fail' },
    });
    debuggerMessage?.({}, 'Network.loadingFailed', {
      requestId: 'request-2',
      errorText: 'net::ERR_FAILED',
    });
    const afterFailure = await service.automation({
      browserId: 'wait-network-events',
      command: { kind: 'wait_for', loadState: 'network_idle', timeoutMs: 0 },
    });
    expect(waitForOf(afterFailure)?.observed.inflightRequests).toBe(0);
    await service.shutdown();
  });

  it('keeps network response details and duration after loading finishes', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'network-finished-details',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const debuggerMessage = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    expect(debuggerMessage).toBeDefined();

    debuggerMessage?.({}, 'Network.requestWillBeSent', {
      requestId: 'request-details',
      request: { method: 'POST', url: 'http://localhost/api/items' },
    });
    debuggerMessage?.({}, 'Network.responseReceived', {
      requestId: 'request-details',
      response: {
        url: 'http://localhost/api/items',
        status: 201,
        statusText: 'Created',
        mimeType: 'application/json',
      },
    });
    debuggerMessage?.({}, 'Network.loadingFinished', {
      requestId: 'request-details',
    });

    const entry = service
      .getNetwork({ browserId: 'network-finished-details' })
      .find((candidate) => candidate.requestId === 'request-details');
    const waitResult = await service.automation({
      browserId: 'network-finished-details',
      command: { kind: 'wait_for', loadState: 'network_idle', timeoutMs: 0 },
    });

    expect(entry).toMatchObject({
      requestId: 'request-details',
      method: 'POST',
      url: 'http://localhost/api/items',
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
    });
    expect(typeof entry?.durationMs).toBe('number');
    expect(waitForOf(waitResult)?.observed.inflightRequests).toBe(0);
    await service.shutdown();
  });

  it('does not erase network fields with undefined redirect metadata', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'network-redirect-metadata',
      url: 'http://localhost:3000',
    });
    const debuggerMessage = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    expect(debuggerMessage).toBeDefined();

    debuggerMessage?.({}, 'Network.requestWillBeSent', {
      requestId: 'request-redirect',
      request: { method: 'GET', url: 'http://localhost/first' },
    });
    debuggerMessage?.({}, 'Network.responseReceived', {
      requestId: 'request-redirect',
      response: {
        url: 'http://localhost/first',
        status: 302,
        statusText: 'Found',
        mimeType: 'text/html',
      },
    });
    debuggerMessage?.({}, 'Network.requestWillBeSent', {
      requestId: 'request-redirect',
      redirectResponse: { url: 'http://localhost/first' },
      request: { method: 'GET', url: 'http://localhost/second' },
    });

    const entry = service
      .getNetwork({ browserId: 'network-redirect-metadata' })
      .find((candidate) => candidate.requestId === 'request-redirect');
    expect(entry).toMatchObject({
      status: 302,
      statusText: 'Found',
      mimeType: 'text/html',
    });
    expect(typeof entry?.durationMs).toBe('number');
    await service.shutdown();
  });

  it('prepares once then delivers real click input, describes the exact handle, and releases it', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'native-click',
      url: 'http://localhost:3000',
    });
    installNativePipeline();
    const result = await service.automation({
      browserId: 'native-click',
      command: { kind: 'click', locator: '#pointer-widget' },
    });
    expect(result).toMatchObject({
      ok: true,
      completed: true,
      receipt: {
        kind: 'click',
        status: 'executed',
        inputMode: 'trusted',
        sequence: 1,
        target: {
          tagName: 'input',
          disabled: false,
          focused: true,
          inViewport: true,
        },
      },
    });
    const mouse = webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === 'Input.dispatchMouseEvent',
    );
    expect(mouse.map(([, params]) => params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
    // Resolved once, described from the same retained target, released
    // once in the lane cleanup; no preload command is involved.
    expect(modelSeam.resolveActionTarget).toHaveBeenCalledTimes(1);
    const resolution: unknown =
      modelSeam.resolveActionTarget.mock.results[0]?.value;
    const resolved: unknown =
      resolution instanceof Promise ? await resolution : undefined;
    const target =
      isCDPRecord(resolved) && resolved.status === 'found'
        ? resolved.target
        : undefined;
    expect(modelSeam.describeActionTarget.mock.calls).toEqual([
      [target, { secret: false }],
    ]);
    expect(modelSeam.releaseActionTarget.mock.calls).toEqual([[target]]);
    expect(webContents.send).not.toHaveBeenCalled();
    const second = await service.automation({
      browserId: 'native-click',
      command: { kind: 'press', key: 'Enter' },
    });
    expect(second.receipt?.actionId).not.toBe(result.receipt?.actionId);
    expect(second.receipt?.sequence).toBe(2);
    const keys = webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === 'Input.dispatchKeyEvent',
    );
    expect(keys.map(([, params]) => params?.type)).toEqual([
      'keyDown',
      'keyUp',
    ]);
    expect(keys[0]?.[1]?.text).toBe('\r');
    await service.shutdown();
  });

  it.each(['click', 'press'] as const)(
    'reports unconfirmed %s delivery without retry and ignores a late matching report',
    async (kind) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'unconfirmed',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      let timestamp = 0;
      let point: Record<string, unknown> = {};
      installNativePipeline({
        reportInput: false,
        input: (_method, params): Promise<unknown> => {
          if (params.type === 'mousePressed' || params.type === 'keyDown') {
            timestamp = Date.now();
            point = params;
          }
          return Promise.resolve({});
        },
      });
      const before = service.getUserInteractionGeneration();
      const pending = service.automation({
        browserId: 'unconfirmed',
        command:
          kind === 'click'
            ? { kind: 'click', locator: '#button' }
            : { kind: 'press', key: 'Enter' },
      });
      await jest.advanceTimersByTimeAsync(1_500);
      const result = await pending;
      expect(result).toMatchObject({
        ok: true,
        completed: false,
        receipt: {
          status: 'outcome_unknown',
          outcomeReason: 'dispatch_timeout',
          warnings: [
            'The page did not report receiving the input; it may not have been delivered.',
          ],
        },
      });
      expect(
        webContents.debugger.sendCommand.mock.calls.filter(
          ([method, params]) =>
            method.startsWith('Input.') &&
            (params?.type === 'mousePressed' || params?.type === 'keyDown'),
        ),
      ).toHaveLength(1);
      ipcListeners.get('canopy-browser-view:event')?.(
        { sender: { id: webContents.id } },
        {
          type: 'user-interaction',
          interaction: {
            type: kind === 'click' ? 'pointerdown' : 'keydown',
            button: 0,
            clientX: point.x,
            clientY: point.y,
            key: point.key,
            timestamp,
          },
        },
      );
      expect(service.getUserInteractionGeneration()).toBe(before);
      expect(result.receipt?.status).toBe('outcome_unknown');
      ipcListeners.get('canopy-browser-view:event')?.(
        { sender: { id: webContents.id } },
        {
          type: 'user-interaction',
          interaction: {
            type: kind === 'click' ? 'pointerdown' : 'keydown',
            button: 0,
            clientX: point.x,
            clientY: point.y,
            key: point.key,
            timestamp: timestamp + 501,
          },
        },
      );
      expect(service.getUserInteractionGeneration()).toBe(before + 1);
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it('waits for presentation quiescence before targeted focus and resets its quiet period on resize', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'presentation',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    let viewport = { width: 0, height: 0 };
    installNativePipeline({ viewport: () => viewport });
    service.setVisible('presentation', true);
    const pending = service.automation({
      browserId: 'presentation',
      command: { kind: 'press', locator: '#input', key: 'Enter' },
    });
    await jest.advanceTimersByTimeAsync(50);
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'DOM.focus' || method.startsWith('Input.'),
      ),
    ).toBe(false);
    viewport = { width: 800, height: 600 };
    service.setBounds({
      browserId: 'presentation',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
    });
    await jest.advanceTimersByTimeAsync(99);
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'DOM.focus',
      ),
    ).toBe(false);
    await jest.advanceTimersByTimeAsync(401);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      completed: true,
      receipt: { status: 'executed' },
    });
    jest.useRealTimers();
    await service.shutdown();
  });

  it.each(['bounded', 'aborted'] as const)(
    'presentation wait is %s for a visible empty viewport',
    async (mode) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'empty-visible',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      installNativePipeline({ viewport: () => ({ width: 0, height: 0 }) });
      service.setVisible('empty-visible', true);
      const controller = new AbortController();
      const pending = service.automation(
        {
          browserId: 'empty-visible',
          command: { kind: 'press', key: 'Enter' },
        },
        controller.signal,
      );
      await jest.advanceTimersByTimeAsync(mode === 'bounded' ? 999 : 50);
      expect(
        webContents.debugger.sendCommand.mock.calls.some(([method]) =>
          method.startsWith('Input.'),
        ),
      ).toBe(false);
      if (mode === 'aborted') controller.abort();
      await jest.advanceTimersByTimeAsync(mode === 'bounded' ? 301 : 0);
      await expect(pending).resolves.toMatchObject(
        mode === 'bounded'
          ? { ok: true, completed: true }
          : { ok: false, receipt: { status: 'not_executed' } },
      );
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it('does not wait or sample viewport for never-shown hidden press', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'hidden-stable',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline({ viewport: () => ({ width: 0, height: 0 }) });
    const pending = service.automation({
      browserId: 'hidden-stable',
      command: { kind: 'press', key: 'Enter' },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Input.dispatchKeyEvent',
      ),
    ).toBe(true);
    expect(
      webContents.debugger.sendCommand.mock.calls.some(([, params]) =>
        String(params?.expression).includes('innerWidth'),
      ),
    ).toBe(false);
    await jest.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({
      completed: true,
      receipt: { durationMs: 50 },
    });
    jest.useRealTimers();
    await service.shutdown();
  });

  it('extends settle from DOM mutation notifications and stops at the quiet deadline', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'mutation-settle',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline();
    const message = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    const pending = service.automation({
      browserId: 'mutation-settle',
      command: { kind: 'fill', locator: '#input', text: 'next' },
    });
    let settled = false;
    void pending.then((): void => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(20);
    message?.({}, 'DOM.attributeModified', {
      nodeId: 1,
      name: 'class',
      value: 'updated',
    });
    await jest.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      completed: true,
      receipt: { durationMs: 70, effects: { domChanged: true } },
    });
    jest.useRealTimers();
    await service.shutdown();
  });

  it('confirms a first key report delayed beyond the default settle window', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'delayed-report',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline({
      reportInput: false,
      input: (_method, params): Promise<unknown> => {
        if (params.type === 'keyDown') {
          const timestamp = Date.now();
          setTimeout(
            () =>
              ipcListeners.get('canopy-browser-view:event')?.(
                { sender: { id: webContents.id } },
                {
                  type: 'user-interaction',
                  interaction: { type: 'keydown', key: params.key, timestamp },
                },
              ),
            750,
          );
        }
        return Promise.resolve({});
      },
    });
    let settled = false;
    const pending = service.automation({
      browserId: 'delayed-report',
      command: { kind: 'press', key: 'Enter' },
    });
    void pending.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(749);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      completed: true,
      receipt: { status: 'executed', durationMs: 750 },
    });
    jest.useRealTimers();
    await service.shutdown();
  });

  it('requires the first keydown rather than a later chord key for confirmation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'first-key',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    let first = true;
    installNativePipeline({
      reportInput: false,
      input: (_method, params): Promise<unknown> => {
        if (params.type === 'rawKeyDown' || params.type === 'keyDown') {
          if (!first)
            ipcListeners.get('canopy-browser-view:event')?.(
              { sender: { id: webContents.id } },
              {
                type: 'user-interaction',
                interaction: {
                  type: 'keydown',
                  key: params.key,
                  timestamp: Date.now(),
                },
              },
            );
          first = false;
        }
        return Promise.resolve({});
      },
    });
    const pending = service.automation({
      browserId: 'first-key',
      command: { kind: 'press', key: 'Shift+Enter' },
    });
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      completed: false,
      receipt: { status: 'outcome_unknown', outcomeReason: 'dispatch_timeout' },
    });
    jest.useRealTimers();
    await service.shutdown();
  });

  it.each(['click', 'press'] as const)(
    'waits for layout on a recently shown view before %s',
    async (kind) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'recent-show',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      let viewport = { width: 0, height: 0 };
      installNativePipeline({ viewport: () => viewport });
      service.setVisible('recent-show', true);
      const pending = service.automation({
        browserId: 'recent-show',
        command:
          kind === 'click'
            ? { kind: 'click', locator: '#button' }
            : { kind: 'press', key: 'Enter' },
      });
      await jest.advanceTimersByTimeAsync(75);
      expect(
        webContents.debugger.sendCommand.mock.calls.some(([method]) =>
          method.startsWith('Input.'),
        ),
      ).toBe(false);
      viewport = { width: 800, height: 600 };
      await jest.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toMatchObject({
        completed: true,
        receipt: { status: 'executed', inputMode: 'trusted' },
      });
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it('uses no presentation wait timers on a settled visible view', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'stable-visible',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline();
    service.setVisible('stable-visible', true);
    await jest.advanceTimersByTimeAsync(300);
    const timers = jest.spyOn(global, 'setTimeout');
    const pending = service.automation({
      browserId: 'stable-visible',
      command: { kind: 'press', key: 'Enter' },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Input.dispatchKeyEvent',
      ),
    ).toBe(true);
    expect(
      timers.mock.calls.some(
        ([, delay]) => delay === 25 || delay === 100 || delay === 1_000,
      ),
    ).toBe(false);
    await jest.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({
      completed: true,
      receipt: { durationMs: 50 },
    });
    timers.mockRestore();
    jest.useRealTimers();
    await service.shutdown();
  });

  it('rejects readonly fill and explicit missing press before any state change', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'not-editable',
      url: 'http://localhost:3000',
    });
    installNativePipeline({ sample: { editable: false } });
    const filled = await service.automation({
      browserId: 'not-editable',
      command: { kind: 'fill', locator: '#readonly', text: 'private-value' },
    });
    expect(filled).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        details: { status: 'not_executed', error: { code: 'not_editable' } },
      },
    });
    expect(JSON.stringify(filled.receipt)).not.toContain('private-value');
    expect(modelSeam.fillActionTarget).not.toHaveBeenCalled();
    installNativePipeline({
      prepared: { found: false, code: 'target_not_found' },
    });
    const pressed = await service.automation({
      browserId: 'not-editable',
      command: { kind: 'press', locator: '#missing', key: 'Enter' },
    });
    expect(pressed).toMatchObject({
      ok: false,
      receipt: { error: { code: 'target_not_found' } },
    });
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'DOM.focus' || method.startsWith('Input.'),
      ),
    ).toBe(false);
    await service.shutdown();
  });

  it.each([
    { kind: 'fill', locator: '#field', text: 'a', timeoutMs: 300 },
    { kind: 'type', locator: '#field', text: 'a', timeoutMs: 300 },
    { kind: 'set_checked', locator: '#field', checked: true, timeoutMs: 300 },
    {
      kind: 'select_option',
      locator: '#field',
      values: ['a'],
      timeoutMs: 300,
    },
  ] as const)(
    'keeps rechecking a disabled $kind target until timeoutMs before refusing it',
    async (example) => {
      const service = new BrowserService({ getWindow: mockWindow });
      const browserId = `disabled-${example.kind}`;
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost:3000',
      });
      installNativePipeline({ sample: { enabled: false } });
      const command =
        example.kind === 'select_option'
          ? { ...example, values: [...example.values] }
          : example;
      const result = await service.automation({ browserId, command });
      const samples = webContents.debugger.sendCommand.mock.calls.filter(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' &&
          String(params?.functionDeclaration).includes('const el = this') &&
          JSON.stringify(params?.arguments) ===
            JSON.stringify([{ value: 'focus' }]),
      );
      expect(result.receipt).toMatchObject({
        status: 'not_executed',
        error: { code: 'target_disabled' },
      });
      expect(samples.length).toBeGreaterThan(1);
      await service.shutdown();
    },
  );

  it('fills visually hidden inputs with the prepared setter and a page-local verdict', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'hidden-fill',
      url: 'http://localhost:3000',
    });
    installNativePipeline({ sample: { visible: false } });
    const filled = await service.automation({
      browserId: 'hidden-fill',
      command: { kind: 'fill', locator: '#hidden', text: 'secret' },
    });
    expect(filled).toMatchObject({
      ok: true,
      completed: true,
      receipt: { status: 'executed', inputMode: 'direct' },
    });
    expect(JSON.stringify(filled.receipt)).not.toContain('secret');
    // The host's fill (the preload's setter and events, in the
    // target frame's isolated world) on the resolved target.
    expect(modelSeam.fillActionTarget.mock.calls).toEqual([
      [
        seamTarget('native-target'),
        'secret',
        expect.any(AbortSignal),
        expect.any(Function),
      ],
    ]);
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'DOM.scrollIntoViewIfNeeded',
      ),
    ).toBe(false);
    await service.shutdown();
  });

  it('attributes agent trusted input while preserving genuine simultaneous user intent', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'attribution',
      url: 'http://localhost:3000',
    });
    const before = service.getUserInteractionGeneration();
    installNativePipeline({
      reportInput: false,
      input: (method, params) => {
        if (
          method === 'Input.dispatchMouseEvent' &&
          params.type === 'mousePressed'
        ) {
          ipcListeners.get('canopy-browser-view:event')?.(
            { sender: { id: webContents.id } },
            {
              type: 'user-interaction',
              interaction: {
                type: 'pointerdown',
                button: 0,
                clientX: Number(params.x) + 1,
                clientY: Number(params.y) - 1,
                timestamp: Date.now(),
              },
            },
          );
          expect(service.getUserInteractionGeneration()).toBe(before);
          ipcListeners.get('canopy-browser-view:event')?.(
            { sender: { id: webContents.id } },
            {
              type: 'user-interaction',
              interaction: {
                type: 'pointerdown',
                button: 0,
                clientX: 400,
                clientY: 400,
                timestamp: Date.now(),
              },
            },
          );
        }
        return Promise.resolve({});
      },
    });
    await service.automation({
      browserId: 'attribution',
      command: { kind: 'click', locator: '#click' },
    });
    expect(service.getUserInteractionGeneration()).toBe(before + 1);
    await service.shutdown();
  });

  it.each(['cdp-first', 'private-first'])(
    'acknowledges a native prearmed dialog once (%s)',
    async (order) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'native-dialog',
        url: 'http://localhost:3000',
      });
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      const callback = jest.fn(() => {
        message?.({}, 'Page.javascriptDialogClosed', { result: true });
      });
      installNativePipeline({
        input: (_method, params) => {
          if (params.type === 'mousePressed') {
            const cdp = (): void => {
              message?.({}, 'Page.javascriptDialogOpening', {
                type: 'confirm',
                message: 'Continue?',
                url: 'http://localhost:3000',
                frameId: 'main-frame',
              });
            };
            const native = (): void => {
              webContents.emit(
                '-run-dialog',
                { dialogType: 'confirm', messageText: 'Continue?' },
                callback,
              );
            };
            if (order === 'cdp-first') {
              cdp();
              native();
            } else {
              native();
              cdp();
            }
          }
          return Promise.resolve({});
        },
      });
      // CDP-first may choose the CDP handler before the private callback arrives.
      const prior = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation((method, params) => {
        if (method === 'Page.handleJavaScriptDialog') {
          message?.({}, 'Page.javascriptDialogClosed', { result: true });
          return Promise.resolve({});
        }
        return prior?.(method, params) ?? Promise.resolve({});
      });
      const clicked = await service.automation({
        browserId: 'native-dialog',
        command: {
          kind: 'click',
          locator: '#confirm',
          dialogResponse: { accept: true },
        },
      });
      expect(clicked).toMatchObject({
        ok: true,
        completed: true,
        handledDialog: { accept: true, dialog: { type: 'confirm' } },
      });
      expect(
        callback.mock.calls.length +
          webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === 'Page.handleJavaScriptDialog',
          ).length,
      ).toBe(1);
      await service.shutdown();
    },
  );

  it.each([
    'private-before-answer',
    'private-after-close',
    'cdp-after-close',
  ] as const)(
    'correlates prearmed dialog sources without phantom pending state (%s)',
    async (order) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'correlated-dialog',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      const cdp = (): void => {
        message?.({}, 'Page.javascriptDialogOpening', {
          type: 'confirm',
          message: 'Continue?',
          url: 'http://localhost:3000',
          frameId: 'main-frame',
        });
      };
      const callback = jest.fn((): void => {
        message?.({}, 'Page.javascriptDialogClosed', { result: false });
      });
      const native = (): void => {
        webContents.emit(
          '-run-dialog',
          {
            dialogType: 'confirm',
            messageText: 'Continue?',
            frame: { url: 'http://localhost:3000' },
          },
          callback,
        );
      };
      installNativePipeline({
        input: (_method, params): Promise<unknown> => {
          if (params.type === 'mousePressed') {
            if (order === 'cdp-after-close') {
              native();
              setTimeout(cdp, 50);
            } else {
              cdp();
              setTimeout(native, order === 'private-before-answer' ? 50 : 300);
            }
          }
          return Promise.resolve({});
        },
      });
      const prior = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        (method, params): Promise<unknown> => {
          if (method === 'Page.handleJavaScriptDialog') {
            message?.({}, 'Page.javascriptDialogClosed', { result: false });
            return Promise.resolve({});
          }
          return prior?.(method, params) ?? Promise.resolve({});
        },
      );
      const pending = service.automation({
        browserId: 'correlated-dialog',
        command: {
          kind: 'click',
          locator: '#confirm',
          dialogResponse: { accept: false },
        },
      });
      let settled = false;
      void pending.then((): void => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(425);
      if (order === 'private-after-close') expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(375);
      await expect(pending).resolves.toMatchObject({
        ok: true,
        completed: true,
        handledDialog: { accept: false, dialog: { type: 'confirm' } },
        receipt: { status: 'executed', target: { tagName: 'input' } },
      });
      const result = await pending;
      if ('kind' in result)
        throw new Error('Expected an ordinary automation response.');
      expect(result.dialog).toBeUndefined();
      expect(service.getDialog('correlated-dialog')).toBeNull();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(false, '');
      const answers = webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Page.handleJavaScriptDialog',
      );
      expect(answers).toHaveLength(order === 'private-after-close' ? 1 : 0);
      // A repeated private notification must not invoke the already-used callback.
      native();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(service.getDialog('correlated-dialog')).toBeNull();
      const following = service.automation({
        browserId: 'correlated-dialog',
        command: { kind: 'fill', locator: '#input', text: 'next' },
      });
      await jest.advanceTimersByTimeAsync(300);
      await expect(following).resolves.toMatchObject({
        ok: true,
        completed: true,
      });
      // A genuine next confirm, even with identical content, has new source reports.
      const nextCallback = jest.fn();
      webContents.emit(
        '-run-dialog',
        {
          dialogType: 'confirm',
          messageText: 'Continue?',
          frame: { url: 'http://localhost:3000' },
        },
        nextCallback,
      );
      cdp();
      expect(service.getDialog('correlated-dialog')).toMatchObject({
        type: 'confirm',
        message: 'Continue?',
      });
      expect(service.getDialog('correlated-dialog')?.id).not.toBe(
        result.handledDialog?.dialog.id,
      );
      expect(nextCallback).not.toHaveBeenCalled();
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it.each(['another-frame', 'expired'] as const)(
    'does not correlate a new private dialog from %s',
    async (scenario) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'new-private',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      message?.({}, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Continue?',
        url: 'http://localhost:3000',
        frameId: 'main-frame',
      });
      const first = service.getDialog('new-private');
      if (!first) throw new Error('Missing initial dialog');
      webContents.debugger.sendCommand.mockImplementation(
        (method): Promise<unknown> => {
          if (method === 'Page.handleJavaScriptDialog')
            message?.({}, 'Page.javascriptDialogClosed', { result: false });
          return Promise.resolve({});
        },
      );
      await service.handleDialog({
        browserId: 'new-private',
        dialogId: first.id,
        accept: false,
      });
      if (scenario === 'expired') await jest.advanceTimersByTimeAsync(2_001);
      const callback = jest.fn();
      webContents.emit(
        '-run-dialog',
        {
          dialogType: 'confirm',
          messageText: 'Continue?',
          frame: {
            url:
              scenario === 'another-frame'
                ? 'http://localhost:3000/iframe'
                : 'http://localhost:3000',
          },
        },
        callback,
      );
      expect(service.getDialog('new-private')).toMatchObject({
        type: 'confirm',
        message: 'Continue?',
      });
      expect(service.getDialog('new-private')?.id).not.toBe(first.id);
      expect(callback).not.toHaveBeenCalled();
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it('observes errors when neutralizing a delayed closed-dialog callback', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'throwing-private',
      url: 'http://localhost:3000',
    });
    const message = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    message?.({}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue?',
      url: 'http://localhost:3000',
    });
    const first = service.getDialog('throwing-private');
    if (!first) throw new Error('Missing initial dialog');
    webContents.debugger.sendCommand.mockImplementation(
      (method): Promise<unknown> => {
        if (method === 'Page.handleJavaScriptDialog')
          message?.({}, 'Page.javascriptDialogClosed', { result: false });
        return Promise.resolve({});
      },
    );
    await service.handleDialog({
      browserId: 'throwing-private',
      dialogId: first.id,
      accept: false,
    });
    const callback = jest.fn((): void => {
      throw new Error('Closed callback failed');
    });
    expect(() =>
      webContents.emit(
        '-run-dialog',
        { dialogType: 'confirm', messageText: 'Continue?' },
        callback,
      ),
    ).not.toThrow();
    expect(() =>
      webContents.emit(
        '-run-dialog',
        { dialogType: 'confirm', messageText: 'Continue?' },
        callback,
      ),
    ).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(service.getDialog('throwing-private')).toBeNull();
    await service.shutdown();
  });

  it('clicks a never-shown view immediately through the direct path with no mouse input', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'empty-viewport',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline({
      sample: {
        viewport: { width: 0, height: 0 },
        visible: false,
        rect: { x: -44, y: -37, width: 50, height: 20 },
      },
    });
    const result = service.automation({
      browserId: 'empty-viewport',
      command: { kind: 'click', locator: '#background' },
    });
    await jest.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toMatchObject({
      ok: true,
      completed: true,
      receipt: {
        inputMode: 'synthetic',
        durationMs: 50,
        warnings: [
          'The browser view has not been shown, so it has no size; clicked the element directly.',
        ],
      },
    });
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) => method === 'Input.dispatchMouseEvent',
      ),
    ).toBe(false);
    jest.useRealTimers();
    await service.shutdown();
  });

  it('does not answer a late private callback after a CDP dialog answer has started', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'late-private-dialog',
      url: 'http://localhost:3000',
    });
    const message = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    message?.({}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Continue?',
      url: 'http://localhost:3000',
    });
    const dialog = service.getDialog('late-private-dialog');
    if (!dialog) throw new Error('Missing dialog');
    let finish = (): void => {};
    webContents.debugger.sendCommand.mockImplementation(
      (method): Promise<unknown> =>
        method === 'Page.handleJavaScriptDialog'
          ? new Promise<void>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({}),
    );
    const request = {
      browserId: 'late-private-dialog',
      dialogId: dialog.id,
      accept: false,
    };
    const first = service.handleDialog(request);
    const second = service.handleDialog(request);
    void second.catch(() => undefined);
    const callback = jest.fn();
    webContents.emit(
      '-run-dialog',
      { dialogType: 'confirm', messageText: 'Continue?' },
      callback,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(
      webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Page.handleJavaScriptDialog',
      ),
    ).toHaveLength(1);
    message?.({}, 'Page.javascriptDialogClosed', { result: false });
    finish();
    await expect(first).resolves.toMatchObject({ accept: false });
    await expect(second).resolves.toMatchObject({ accept: false });
    await expect(service.handleDialog(request)).resolves.toMatchObject({
      accept: false,
    });
    await service.shutdown();
  });

  it('observes a rejected pre-armed CDP dialog answer without an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const service = new BrowserService({ getWindow: mockWindow });
    try {
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'rejected-answer',
        url: 'http://localhost:3000',
      });
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      installNativePipeline({
        input: (_method, params): Promise<unknown> => {
          if (params.type === 'mousePressed')
            message?.({}, 'Page.javascriptDialogOpening', {
              type: 'confirm',
              message: 'Continue?',
              url: 'http://localhost:3000',
              frameId: 'main-frame',
            });
          return Promise.resolve({});
        },
      });
      const prior = webContents.debugger.sendCommand.getMockImplementation();
      let rejected = false;
      webContents.debugger.sendCommand.mockImplementation(
        (method, params): Promise<unknown> => {
          if (method === 'Page.handleJavaScriptDialog') {
            rejected = true;
            return Promise.reject(
              new Error(
                'Protocol error (Page.handleJavaScriptDialog): No dialog is showing',
              ),
            );
          }
          return prior?.(method, params) ?? Promise.resolve({});
        },
      );
      const result = await service.automation({
        browserId: 'rejected-answer',
        command: {
          kind: 'click',
          locator: '#confirm',
          dialogResponse: { accept: false },
        },
      });
      expect(rejected).toBe(true);
      expect(result).toMatchObject({ ok: true, completed: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      await service.shutdown();
    }
  });

  it.each([
    { tagName: 'select' },
    { tagName: 'option', insideSelect: true },
    { tagName: 'input', inputType: 'file' },
    { tagName: 'input', inputType: 'color' },
  ])(
    'preserves direct click for native picker $tagName $inputType',
    async (control) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'native-picker',
        url: 'http://localhost:3000',
      });
      installNativePipeline({
        sample: {
          ...control,
          nativePicker: true,
          receivesEvents: true,
          visible: false,
          enabled: false,
        },
      });
      webContents.debugger.sendCommand.mockClear();
      const result = await service.automation({
        browserId: 'native-picker',
        command: { kind: 'click', locator: '#picker' },
      });
      expect(result).toMatchObject({
        ok: true,
        completed: true,
        receipt: {
          inputMode: 'synthetic',
          warnings: [
            'Clicked directly because this control opens a native picker.',
          ],
        },
      });
      expect(
        webContents.debugger.sendCommand.mock.calls.some(
          ([method]) => method === 'Input.dispatchMouseEvent',
        ),
      ).toBe(false);
      expect(
        webContents.debugger.sendCommand.mock.calls.some(
          ([method]) => method === 'DOM.scrollIntoViewIfNeeded',
        ),
      ).toBe(false);
      const directClick = webContents.debugger.sendCommand.mock.calls.find(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' && params?.userGesture === true,
      );
      expect(directClick?.[1]?.functionDeclaration).toContain('this.click()');
      await service.shutdown();
    },
  );

  it.each([
    ['ipc', 'dispose'],
    ['mcp', 'dispose'],
    ['ipc', 'replace'],
    ['mcp', 'replace'],
  ] as const)(
    'delivers a branded post-dispatch unknown through the real %s runtime fence after %s',
    async (route, loss) => {
      const service = new BrowserService({ getWindow: mockWindow });
      const browser = await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'lost-input',
        url: 'http://localhost:3000',
      });
      jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue({
        status: 'loaded',
        state: lastSavedBrowserState(),
      });
      registerBrowserHandlers(mockWindow, service);
      let delivered = (): void => {};
      const delivery = new Promise<void>((resolve) => {
        delivered = resolve;
      });
      const realAutomation = service.automation.bind(service);
      jest.spyOn(service, 'automation').mockImplementation(async (...args) => {
        const value = await realAutomation(...args);
        await delivery;
        return value;
      });
      let started = (): void => {};
      let finish = (): void => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      installNativePipeline({
        input: (method, params) => {
          if (
            method === 'Input.dispatchMouseEvent' &&
            params.type === 'mousePressed'
          ) {
            started();
            return blocked;
          }
          return Promise.resolve({});
        },
      });
      setBrowserService(service);
      const pending =
        route === 'mcp'
          ? dispatchScopedBrowserAction(
              {
                action: {
                  type: 'browser.click',
                  browserId: browser.id,
                  expectedRuntimeGeneration: browser.profile?.runtimeGeneration,
                  locator: '#click',
                },
              },
              {
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                chatId: 'chat-1',
                cwd: '/virtual',
                getWindow: mockWindow,
              },
            )
          : ipcHandlers.get(IPC_CHANNELS.browserAutomation)?.(
              { sender: { isFocused: () => false, isDestroyed: () => false } },
              {
                browserId: browser.id,
                expectedRuntimeGeneration: browser.profile?.runtimeGeneration,
                command: { kind: 'click', locator: '#click' },
              },
            );
      await entered;
      if (loss === 'replace') {
        mockSwitchJournalBegin.mockImplementation(
          (
            request: { operationId: string; mode: 'replace' | 'new-tab' },
            source: BrowserSessionSnapshot,
            target: BrowserSessionSnapshot,
          ): Promise<BrowserSwitchRecord> =>
            Promise.resolve({
              schemaVersion: 1,
              operationId: request.operationId,
              digest: 'a'.repeat(64),
              createdAt: Date.now(),
              stage: 'prepared',
              source,
              target,
              mode: request.mode,
            }),
        );
        mockSwitchJournalUpdate.mockImplementation(
          (
            record: BrowserSwitchRecord,
            stage: BrowserSwitchRecord['stage'],
          ): Promise<BrowserSwitchRecord> =>
            Promise.resolve({ ...record, stage }),
        );
        webContents.close.mockImplementation(() => {
          webContents.destroyed = true;
          webContents.emit('destroyed');
        });
        const switched = await service.switchProfile({
          operationId: 'replace-lost-input',
          browserId: browser.id,
          expectedRuntimeGeneration: browser.profile?.runtimeGeneration ?? 0,
          selection: { kind: 'task' },
          mode: 'replace',
        });
        expect(switched).toMatchObject({
          status: 'complete',
          browser: {
            profile: {
              runtimeGeneration: (browser.profile?.runtimeGeneration ?? 0) + 1,
            },
          },
        });
      } else {
        await service.disposeLiveView(browser.id);
      }
      delivered();
      const result = await pending;
      const response =
        route === 'mcp' &&
        result &&
        typeof result === 'object' &&
        'result' in result
          ? result.result
          : result;
      expect(response).toMatchObject({
        ok: true,
        completed: false,
        receipt: { status: 'outcome_unknown', outcomeReason: 'runtime_lost' },
      });
      expect(response).not.toHaveProperty('browser');
      expect(result).not.toHaveProperty('error');
      setBrowserService(null);
      finish();
      await service.shutdown();
    },
  );

  it.each([false, true])(
    'drains surviving-runtime input before the next action (quarantine=%s)',
    async (quarantine) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'drain-input',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      let finish = (): void => {};
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let pressCount = 0;
      installNativePipeline({
        input: (method, params) => {
          if (
            method === 'Input.dispatchMouseEvent' &&
            params.type === 'mousePressed' &&
            ++pressCount === 1
          )
            return blocked;
          return Promise.resolve({});
        },
      });
      const controller = new AbortController();
      const first = service.automation(
        {
          browserId: 'drain-input',
          command: { kind: 'click', locator: '#first' },
        },
        controller.signal,
      );
      await jest.advanceTimersByTimeAsync(200);
      expect(pressCount).toBe(1);
      controller.abort();
      await expect(first).resolves.toMatchObject({
        ok: true,
        completed: false,
        receipt: {
          status: 'outcome_unknown',
          outcomeReason: 'stopped_after_dispatch',
        },
      });
      const preparations = (): number =>
        modelSeam.resolveActionTarget.mock.calls.length;
      expect(preparations()).toBe(1);
      const second = service.automation({
        browserId: 'drain-input',
        command: { kind: 'fill', locator: '#second', text: 'next' },
      });
      await jest.advanceTimersByTimeAsync(quarantine ? 10_001 : 200);
      expect(preparations()).toBe(1);
      expect(webContents.debugger.sendCommand.mock.calls).toContainEqual([
        'Input.dispatchMouseEvent',
        expect.objectContaining({ type: 'mouseReleased' }),
      ]);
      expect(modelSeam.releaseActionTarget).toHaveBeenCalled();
      if (quarantine) {
        await expect(second).resolves.toMatchObject({
          ok: false,
          receipt: {
            status: 'not_executed',
            error: {
              code: 'execution_failed',
              message: 'Browser input is recovering. Try again shortly.',
            },
          },
        });
        finish();
        await jest.advanceTimersByTimeAsync(100);
        const recovered = service.automation({
          browserId: 'drain-input',
          command: { kind: 'fill', locator: '#recovered', text: 'next' },
        });
        await jest.advanceTimersByTimeAsync(1_500);
        await expect(recovered).resolves.toMatchObject({
          ok: true,
          completed: true,
        });
      } else {
        finish();
        await jest.advanceTimersByTimeAsync(1_500);
        await expect(second).resolves.toMatchObject({
          ok: true,
          completed: true,
        });
      }
      expect(preparations()).toBe(2);
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it.each(['press', 'fill'] as const)(
    'returns a pending alert promptly for %s and admits the next action after answering',
    async (kind) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'modal-input',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      const open = (): void => {
        message?.({}, 'Page.javascriptDialogOpening', {
          type: 'alert',
          message: 'Pause',
          url: 'http://localhost:3000',
          frameId: 'main-frame',
        });
      };
      let rejectBlocked: (error: Error) => void = () => {};
      const blocked = new Promise<void>((_resolve, reject) => {
        rejectBlocked = reject;
      });
      installNativePipeline({
        input: (_method, params) => {
          if (kind === 'press' && params.type === 'keyDown') {
            open();
            return blocked;
          }
          return Promise.resolve({});
        },
      });
      let rejectFill: (error: Error) => void = () => {};
      if (kind === 'fill')
        modelSeam.fillActionTarget.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectFill = reject;
              open();
            }),
        );
      const pending = service.automation({
        browserId: 'modal-input',
        command:
          kind === 'press'
            ? { kind: 'press', key: 'Enter' }
            : { kind: 'fill', locator: '#input', text: 'next' },
      });
      let result: unknown;
      void pending.then((value): void => {
        result = value;
      });
      await jest.advanceTimersByTimeAsync(2_500);
      expect(result).toMatchObject({
        ok: true,
        completed: false,
        dialog: { type: 'alert' },
        receipt: {
          status: 'outcome_unknown',
          outcomeReason: 'dispatch_timeout',
        },
      });
      const dialog = service.getDialog('modal-input');
      if (!dialog) throw new Error('Expected pending alert.');
      const previous = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        (method, params): Promise<unknown> => {
          if (method === 'Page.handleJavaScriptDialog') {
            message?.({}, 'Page.javascriptDialogClosed', { result: true });
            return Promise.resolve({});
          }
          return previous?.(method, params) ?? Promise.resolve({});
        },
      );
      await service.handleDialog({
        browserId: 'modal-input',
        dialogId: dialog.id,
        accept: true,
      });
      // Deliberately keep the old CDP promise blocked past the drain bound.
      installNativePipeline();
      const next = service.automation({
        browserId: 'modal-input',
        command: { kind: 'fill', locator: '#next', text: 'next' },
      });
      await jest.advanceTimersByTimeAsync(11_000);
      await expect(next).resolves.toMatchObject({ ok: true, completed: true });
      if (kind === 'press') rejectBlocked(new Error('late protocol rejection'));
      else rejectFill(new Error('late fill rejection'));
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getLifecycleStats().pendingCommands).toBe(0);
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it.each(['main frame', 'child frame'] as const)(
    'discovers the initially unknown main frame from CDP and fences a %s dialog',
    async (source) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'discovered-frame',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      // No Page.frameNavigated event and no direct assignment seed the frame ID.
      // Its identity is available only from the helper's Page.getFrameTree reply.
      installNativePipeline({
        input: (_method, params): Promise<unknown> => {
          if (params.type === 'mousePressed')
            message?.({}, 'Page.javascriptDialogOpening', {
              type: source === 'main frame' ? 'confirm' : 'prompt',
              message: 'Continue?',
              url:
                source === 'main frame'
                  ? 'http://localhost:3000'
                  : 'https://child.example/prompt',
              frameId: source === 'main frame' ? 'main-frame' : 'child-frame',
            });
          return Promise.resolve({});
        },
      });
      const previous = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        (method, params): Promise<unknown> => {
          if (method === 'Page.handleJavaScriptDialog') {
            message?.({}, 'Page.javascriptDialogClosed', { result: true });
            return Promise.resolve({});
          }
          return previous?.(method, params) ?? Promise.resolve({});
        },
      );
      const pending = service.automation({
        browserId: 'discovered-frame',
        command: {
          kind: 'click',
          locator: '#button',
          dialogResponse: { accept: true, promptText: 'private answer' },
        },
      });
      await jest.advanceTimersByTimeAsync(2_500);
      const answers = webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === 'Page.handleJavaScriptDialog',
      );
      if (source === 'main frame') {
        await expect(pending).resolves.toMatchObject({
          ok: true,
          completed: true,
          handledDialog: { accept: true, dialog: { type: 'confirm' } },
        });
        expect(answers).toHaveLength(1);
        expect(service.getDialog('discovered-frame')).toBeNull();
      } else {
        await expect(pending).resolves.toMatchObject({
          ok: true,
          completed: false,
          dialog: { type: 'prompt', frameId: 'child-frame' },
        });
        expect(answers).toHaveLength(0);
        expect(
          webContents.debugger.sendCommand.mock.calls.some(
            ([, params]) => params?.promptText === 'private answer',
          ),
        ).toBe(false);
      }
      const discoveryIndex =
        webContents.debugger.sendCommand.mock.calls.findIndex(
          ([method]) => method === 'Page.getFrameTree',
        );
      const discoveryOrder =
        webContents.debugger.sendCommand.mock.invocationCallOrder[
          discoveryIndex
        ];
      const prepareOrder =
        modelSeam.resolveActionTarget.mock.invocationCallOrder[0];
      if (discoveryOrder === undefined || prepareOrder === undefined)
        throw new Error('Expected frame discovery and target preparation.');
      expect(discoveryOrder).toBeLessThan(prepareOrder);
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it.each([
    'child frame',
    'replaced document',
    'same-url replacement',
    'unidentified frame',
  ] as const)(
    'does not apply main-frame prearmed prompt text to a %s prompt',
    async (source) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'foreign-prompt',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      installNativePipeline({
        input: (_method, params): Promise<unknown> => {
          if (params.type === 'keyDown') {
            if (
              source === 'replaced document' ||
              source === 'same-url replacement'
            )
              message?.({}, 'Page.frameNavigated', {
                frame: {
                  id: 'main-frame',
                  url:
                    source === 'same-url replacement'
                      ? 'http://localhost:3000'
                      : 'https://other.example/new',
                  loaderId: 'replacement',
                },
              });
            message?.({}, 'Page.javascriptDialogOpening', {
              type: 'prompt',
              message: 'Secret?',
              url:
                source === 'child frame'
                  ? 'https://child.example/prompt'
                  : source === 'replaced document'
                    ? 'https://other.example/new'
                    : 'http://localhost:3000',
              ...(source !== 'unidentified frame'
                ? {
                    frameId:
                      source === 'child frame' ? 'child-frame' : 'main-frame',
                  }
                : {}),
            });
          }
          return Promise.resolve({});
        },
      });
      const pending = service.automation({
        browserId: 'foreign-prompt',
        command: {
          kind: 'press',
          key: 'Enter',
          dialogResponse: { accept: true, promptText: 'private answer' },
        },
      });
      await jest.advanceTimersByTimeAsync(2_500);
      expect(
        webContents.debugger.sendCommand.mock.calls.some(
          ([method, params]) =>
            method === 'Page.handleJavaScriptDialog' ||
            params?.promptText === 'private answer',
        ),
      ).toBe(false);
      await expect(pending).resolves.toMatchObject({
        ok: true,
        completed: false,
        dialog: { type: 'prompt' },
      });
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it('retries a rejected dialog answer with the same ID', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'retry-dialog',
    });
    const message = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    message?.({}, 'Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Retry?',
      url: 'http://localhost:3000',
    });
    const dialog = service.getDialog('retry-dialog');
    if (!dialog) throw new Error('Expected a pending dialog.');
    let attempts = 0;
    webContents.debugger.sendCommand.mockImplementation(
      (method): Promise<unknown> => {
        if (method === 'Page.handleJavaScriptDialog') {
          if (++attempts === 1)
            return Promise.reject(new Error('temporary protocol failure'));
          message?.({}, 'Page.javascriptDialogClosed', { result: true });
        }
        return Promise.resolve({});
      },
    );
    const request = {
      browserId: 'retry-dialog',
      dialogId: dialog.id,
      accept: true,
    };
    await expect(service.handleDialog(request)).rejects.toThrow(
      'temporary protocol failure',
    );
    await expect(service.handleDialog(request)).resolves.toMatchObject({
      accept: true,
    });
    expect(attempts).toBe(2);
    await service.shutdown();
  });

  it('does not arm a dialog answer during the final presentation wait', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'pre-dispatch-dialog',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline();
    const prior = webContents.debugger.sendCommand.getMockImplementation();
    webContents.debugger.sendCommand.mockImplementation(
      (method, params): Promise<unknown> => {
        if (method === 'Emulation.setFocusEmulationEnabled')
          service.setVisible('pre-dispatch-dialog', true);
        return prior?.(method, params) ?? Promise.resolve({});
      },
    );
    const pending = service.automation({
      browserId: 'pre-dispatch-dialog',
      command: {
        kind: 'press',
        key: 'Enter',
        dialogResponse: { accept: true },
      },
    });
    await jest.advanceTimersByTimeAsync(20);
    const message = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    const callback = jest.fn((): void => {
      message?.({}, 'Page.javascriptDialogClosed', { result: true });
    });
    webContents.emit(
      '-run-dialog',
      {
        dialogType: 'confirm',
        messageText: 'Human dialog',
        frame: { url: 'http://localhost:3000' },
      },
      callback,
    );
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toMatchObject({
      receipt: { status: 'not_executed', error: { code: 'dialog_pending' } },
    });
    expect(callback).not.toHaveBeenCalled();
    expect(
      webContents.debugger.sendCommand.mock.calls.some(
        ([method]) =>
          method === 'Page.handleJavaScriptDialog' ||
          method.startsWith('Input.'),
      ),
    ).toBe(false);
    jest.useRealTimers();
    await service.shutdown();
  });

  it.each([
    'renderer death',
    'main-frame navigation',
    'Electron main-frame navigation',
    'completion timeout',
  ] as const)(
    'recovers a quarantined completion-only fill after %s without pending-command leaks',
    async (loss) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'pending-fill',
        url: 'http://localhost:3000',
      });
      jest.useFakeTimers();
      installNativePipeline();
      // The host's fill never answers; it is bound to the document.
      modelSeam.fillActionTarget.mockImplementation(
        () => new Promise(() => undefined),
      );
      const controller = new AbortController();
      const pending = service.automation(
        {
          browserId: 'pending-fill',
          command: { kind: 'fill', locator: '#input', text: 'next' },
        },
        controller.signal,
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getLifecycleStats().pendingCommands).toBe(1);
      controller.abort();
      await expect(pending).resolves.toMatchObject({
        receipt: { status: 'outcome_unknown' },
      });
      await jest.advanceTimersByTimeAsync(10_001);
      if (loss === 'renderer death')
        webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      if (loss === 'main-frame navigation') {
        const message = webContents.debugger.on.mock.calls.find(
          ([event]) => event === 'message',
        )?.[1];
        message?.({}, 'Page.frameNavigated', {
          frame: {
            id: 'main-frame',
            url: 'http://localhost:3000/next',
            loaderId: 'new-document',
          },
        });
      }
      if (loss === 'Electron main-frame navigation')
        webContents.emit('did-navigate', {}, 'http://localhost:3000/next');
      await jest.advanceTimersByTimeAsync(
        loss === 'completion timeout' ? 5_000 : 0,
      );
      expect(service.getLifecycleStats().pendingCommands).toBe(0);
      installNativePipeline();
      const next = service.automation({
        browserId: 'pending-fill',
        command: { kind: 'fill', locator: '#input', text: 'recovered' },
      });
      await jest.advanceTimersByTimeAsync(300);
      await expect(next).resolves.toMatchObject({ ok: true, completed: true });
      expect(service.getLifecycleStats().pendingCommands).toBe(0);
      jest.useRealTimers();
      await service.shutdown();
    },
  );

  it('waits for a cancelled fill to stop before the next action, and the cancelled fill never writes', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'cancelled-fill',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline();
    // The host's fill, held before its setter as a slow world creation
    // would hold it; a write is recorded only if it was not cancelled.
    const writes: string[] = [];
    let releaseFirst: () => void = () => undefined;
    modelSeam.fillActionTarget.mockImplementation((_target, text, signal) => {
      const write = (): 'filled' => {
        signal?.throwIfAborted();
        writes.push(text);
        return 'filled';
      };
      if (text !== 'first') return Promise.resolve(write());
      return new Promise((resolve, reject) => {
        releaseFirst = (): void => {
          try {
            resolve(write());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
      });
    });
    const controller = new AbortController();
    const first = service.automation(
      {
        browserId: 'cancelled-fill',
        command: { kind: 'fill', locator: '#input', text: 'first' },
      },
      controller.signal,
    );
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(first).resolves.toMatchObject({
      receipt: { status: 'outcome_unknown' },
    });
    const second = service.automation({
      browserId: 'cancelled-fill',
      command: { kind: 'fill', locator: '#input', text: 'second' },
    });
    await jest.advanceTimersByTimeAsync(1_000);
    // The lane still waits for the cancelled fill.
    expect(modelSeam.fillActionTarget).toHaveBeenCalledTimes(1);
    releaseFirst();
    await jest.advanceTimersByTimeAsync(300);
    await expect(second).resolves.toMatchObject({ ok: true, completed: true });
    expect(writes).toEqual(['second']);
    jest.useRealTimers();
    await service.shutdown();
  });

  it('keeps completion-only commands across same-document and subframe navigation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'retained-fill',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    installNativePipeline();
    let completeFill: ((value: 'filled') => void) | undefined;
    modelSeam.fillActionTarget.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeFill = resolve;
        }),
    );
    const pending = service.automation({
      browserId: 'retained-fill',
      command: { kind: 'fill', locator: '#input', text: 'next' },
    });
    await jest.advanceTimersByTimeAsync(0);
    const message = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    message?.({}, 'Page.frameNavigated', {
      frame: {
        id: 'child-frame',
        parentId: 'main-frame',
        url: 'http://localhost:3000/child',
      },
    });
    message?.({}, 'Page.navigatedWithinDocument', {
      frameId: 'main-frame',
      url: 'http://localhost:3000/#section',
    });
    webContents.emit(
      'did-navigate-in-page',
      {},
      'http://localhost:3000/#section',
      true,
    );
    expect(service.getLifecycleStats().pendingCommands).toBe(1);
    if (!completeFill) throw new Error('Expected a pending fill command.');
    completeFill('filled');
    await jest.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({ ok: true, completed: true });
    expect(service.getLifecycleStats().pendingCommands).toBe(0);
    jest.useRealTimers();
    await service.shutdown();
  });

  it('delivers the admitted generation-5 unknown receipt after rehydration from inert generation 4 and disposal', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    let browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'rehydrate-unknown',
      url: 'http://localhost:3000',
    });
    jest
      .mocked(loadAndMigrateWorktreeBrowserState)
      .mockResolvedValue({ status: 'loaded', state: lastSavedBrowserState() });
    for (let generation = 1; generation < 4; generation++) {
      await service.disposeLiveView(browser.id);
      browser = await service.create({
        projectId: browser.projectId,
        worktreeId: browser.worktreeId,
        browserId: browser.id,
        url: 'http://localhost:3000',
      });
    }
    expect(browser.profile?.runtimeGeneration).toBe(4);
    await service.disposeLiveView(browser.id);
    let started = (): void => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let deliver = (): void => {};
    const delivery = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const pending = service.withRuntimeTarget(
      { browserId: browser.id, expectedRuntimeGeneration: 4 },
      async () => {
        const next = await service.create({
          projectId: browser.projectId,
          worktreeId: browser.worktreeId,
          browserId: browser.id,
          url: 'http://localhost:3000',
        });
        expect(next.profile?.runtimeGeneration).toBe(5);
        const contents = createdViews[createdViews.length - 1]?.webContents;
        if (!contents) throw new Error('Expected rehydrated contents.');
        installNativePipeline(
          {
            input: (_method, params) => {
              if (params.type === 'keyDown') {
                started();
                return blocked;
              }
              return Promise.resolve({});
            },
          },
          contents,
        );
        const value = await service.automation({
          browserId: browser.id,
          command: { kind: 'press', key: 'Enter' },
        });
        await delivery;
        return value;
      },
      { rehydrate: true },
    );
    // Observe the failing fence immediately, even while disposal completes.
    const observed = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await entered;
    await service.disposeLiveView(browser.id);
    finish();
    deliver();
    await expect(observed).resolves.toMatchObject({
      value: {
        kind: 'post-dispatch-unknown',
        capturedRuntimeGeneration: 5,
        receipt: { status: 'outcome_unknown', outcomeReason: 'runtime_lost' },
      },
    });
    await service.shutdown();
  });

  it('does not exempt an unissued unknown-shaped result from a stale runtime fence', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'forged-unknown',
    });
    let entered = (): void => {};
    let finish = (): void => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = service.withRuntimeTarget(
      {
        browserId: browser.id,
        expectedRuntimeGeneration: browser.profile?.runtimeGeneration,
      },
      async () => {
        entered();
        await gate;
        return {
          kind: 'post-dispatch-unknown',
          capturedRuntimeGeneration: browser.profile?.runtimeGeneration,
          receipt: { status: 'outcome_unknown' },
        };
      },
    );
    await started;
    await service.disposeLiveView(browser.id);
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
    await service.shutdown();
  });

  it('refuses paste chords before preparation or input with a policy receipt', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'policy-receipt',
      url: 'http://localhost:3000',
    });
    webContents.send.mockClear();
    webContents.debugger.sendCommand.mockClear();
    const result = await service.automation({
      browserId: 'policy-receipt',
      command: { kind: 'press', key: 'Control+V' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'authorization_conflict',
        details: {
          status: 'not_executed',
          error: { code: 'policy_denied', retryable: false },
        },
      },
    });
    expect(webContents.send).not.toHaveBeenCalled();
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('refuses click and press during picking before any input', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'pick-receipt',
      url: 'http://localhost:3000',
    });
    await service.setPickMode('pick-receipt', true);
    webContents.send.mockClear();
    webContents.debugger.sendCommand.mockClear();
    const result = await service.automation({
      browserId: 'pick-receipt',
      command: { kind: 'click', locator: '#pointer-widget' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', details: { status: 'not_executed' } },
    });
    if ('kind' in result) throw new Error('Unexpected internal unknown');
    expect(result.error?.message).toBe(
      'The user is picking an element. Try again after they finish.',
    );
    expect(webContents.send).not.toHaveBeenCalled();
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('does not fall back globally for partial worktree scope automation', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-partial-scope',
      url: 'http://localhost:3000',
    });
    webContents.send.mockClear();

    const result = await service.automation({
      projectId: 'project-1',
      command: { kind: 'click', x: 1, y: 1 },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'No browser is available.' },
    });
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it('returns an unanticipated JavaScript dialog without waiting for the blocked preload command', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-dialog',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    modelSeam.resolveActionTarget.mockResolvedValue({
      status: 'found',
      target: seamTarget('delete-target'),
    });
    webContents.debugger.sendCommand.mockImplementation(
      (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        const trustedTarget = trustedTargetDebuggerResult(
          method,
          'delete-target',
          params,
        );
        if (trustedTarget !== undefined) {
          return Promise.resolve(trustedTarget);
        }
        if (method === 'Runtime.callFunctionOn') {
          debugMessage?.({}, 'Page.javascriptDialogOpening', {
            type: 'confirm',
            message: 'Delete this item?',
            url: 'http://localhost:3000/items/1',
            frameId: 'frame-1',
          });
          return new Promise(() => undefined);
        }
        return Promise.resolve(undefined);
      },
    );

    const result = await service.automation({
      browserId: 'browser-dialog',
      command: { kind: 'click', locator: '#delete' },
    });

    expect(result).toMatchObject({
      ok: true,
      completed: false,
      dialog: {
        browserId: 'browser-dialog',
        type: 'confirm',
        message: 'Delete this item?',
        url: 'http://localhost:3000/items/1',
        frameId: 'frame-1',
      },
    });
    expect(service.getDialog('browser-dialog')).toEqual(result.dialog);
    const trustedClickCall = webContents.debugger.sendCommand.mock.calls.find(
      ([method, params]) =>
        method === 'Runtime.callFunctionOn' && params?.userGesture === true,
    );
    const trustedClickParams = trustedClickCall?.[1];
    if (!trustedClickParams)
      throw new Error('Expected the covered trusted-click call.');
    expect(trustedClickParams.userGesture).toBe(true);
    // The covered fallback runs on the action's retained target (D7); no
    // isolated-world token is resolved and nothing re-queries the page.
    expect(trustedClickParams.objectId).toBe('delete-target');
    expect(modelSeam.resolveActionTarget).toHaveBeenCalledTimes(1);
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'DOM.querySelectorAll',
      expect.anything(),
    );
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ userGesture: true }),
    );
    await expect(
      service.inspect({
        browserId: 'browser-dialog',
        locator: '#delete',
      }),
    ).rejects.toThrow('browser.handle_dialog');
    await expect(
      service.inputSnapshot({
        browserId: 'browser-dialog',
      }),
    ).rejects.toThrow('browser.handle_dialog');
  });

  it('labels an unarmed child-frame prompt with its initiating frame URL', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-unarmed-prompt',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    debugMessage?.({}, 'Runtime.executionContextCreated', {
      context: {
        id: 7,
        origin: 'https://child.example',
        auxData: { frameId: 'child-frame' },
      },
    });
    debugMessage?.({}, 'Debugger.scriptParsed', {
      executionContextId: 7,
      scriptId: 'trusted-prompt-script',
      url: appPromptBridgeSourceUrl(),
    });
    debugMessage?.({}, 'Page.frameNavigated', {
      frame: {
        id: 'child-frame',
        parentId: 'main-frame',
        url: 'https://child.example/prompt',
      },
    });
    webContents.debugger.sendCommand.mockImplementation(
      (method: string, params?: Record<string, unknown>) => {
        const trustedTarget = trustedTargetDebuggerResult(
          method,
          'prompt-target',
          params,
        );
        if (trustedTarget !== undefined) {
          return Promise.resolve(trustedTarget);
        }
        if (method === 'Runtime.callFunctionOn') {
          expect(params).toMatchObject({ userGesture: true });
          queueMicrotask(() => {
            debugMessage?.({}, 'Debugger.paused', {
              callFrames: [
                {
                  callFrameId: 'prompt-frame',
                  functionName: 'canopyAppOwnedPrompt',
                  location: { scriptId: 'trusted-prompt-script' },
                },
              ],
            });
          });
          return new Promise(() => undefined);
        }
        if (method === 'Debugger.evaluateOnCallFrame') {
          if (String(params?.expression).includes('bridge.result =')) {
            return Promise.resolve({ result: { value: true } });
          }
          return Promise.resolve({
            result: {
              value: {
                marker: 'canopy-browser-app-prompt-v1',
                message: 'Name',
                defaultPrompt: 'Initial',
                url: 'https://attacker.invalid/phishing',
              },
            },
          });
        }
        if (method === 'Debugger.resume') {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      },
    );

    const result = await service.automation({
      browserId: 'browser-unarmed-prompt',
      command: { kind: 'click', locator: '#prompt-button' },
    });

    expect(result).toMatchObject({
      ok: true,
      completed: false,
      dialog: {
        browserId: 'browser-unarmed-prompt',
        type: 'prompt',
        message: 'Name',
        defaultPrompt: 'Initial',
        url: 'https://child.example/prompt',
        frameId: 'child-frame',
      },
    });
    const dialog = service.getDialog('browser-unarmed-prompt');
    const handled = await service.handleDialog({
      browserId: 'browser-unarmed-prompt',
      dialogId: dialog?.id ?? '',
      accept: true,
      promptText: 'Agent response',
    });
    expect(handled).toMatchObject({
      accept: true,
      promptText: 'Agent response',
      dialog: { id: dialog?.id, type: 'prompt' },
    });
    expect(service.getDialog('browser-unarmed-prompt')).toBeNull();
    const promptAssignmentCall =
      webContents.debugger.sendCommand.mock.calls.find(([method, params]) => {
        const expression = params?.expression;
        return (
          method === 'Debugger.evaluateOnCallFrame' &&
          typeof expression === 'string' &&
          expression.includes('bridge.result =')
        );
      });
    const promptAssignment = promptAssignmentCall?.[1]?.expression;
    expect(promptAssignment).toContain('"Agent response"');
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Debugger.resume',
      undefined,
    );
  });

  it('rejects an app prompt from an opaque sandboxed frame', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-sandboxed-prompt',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    debugMessage?.({}, 'Runtime.executionContextCreated', {
      context: {
        id: 8,
        origin: '://',
        auxData: { frameId: 'sandboxed-frame' },
      },
    });
    debugMessage?.({}, 'Debugger.scriptParsed', {
      executionContextId: 8,
      scriptId: 'sandboxed-prompt-script',
      url: appPromptBridgeSourceUrl(),
    });
    debugMessage?.({}, 'Page.frameNavigated', {
      frame: {
        id: 'sandboxed-frame',
        parentId: 'main-frame',
        url: 'about:srcdoc',
      },
    });
    webContents.debugger.sendCommand.mockClear();
    webContents.debugger.sendCommand.mockResolvedValue({});

    debugMessage?.({}, 'Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'sandboxed-prompt-frame',
          functionName: 'canopyAppOwnedPrompt',
          location: { scriptId: 'sandboxed-prompt-script' },
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getDialog('browser-sandboxed-prompt')).toBeNull();
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Debugger.resume',
      undefined,
    );
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Debugger.evaluateOnCallFrame',
      expect.anything(),
    );
  });

  it('resumes a page-forged app prompt pause without opening a dialog', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-forged-prompt',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    const bridgeSourceUrl = appPromptBridgeSourceUrl();
    debugMessage?.({}, 'Debugger.scriptParsed', {
      executionContextId: 9,
      scriptId: 'trusted-prompt-script',
      url: bridgeSourceUrl,
    });
    debugMessage?.({}, 'Debugger.scriptParsed', {
      executionContextId: 9,
      scriptId: 'attacker-script',
      url: bridgeSourceUrl,
    });
    webContents.debugger.sendCommand.mockClear();
    webContents.debugger.sendCommand.mockResolvedValue({
      result: {
        value: {
          marker: 'canopy-browser-app-prompt-v1',
          message: 'Enter your password',
          defaultPrompt: '',
          url: 'https://trusted.example',
        },
      },
    });

    debugMessage?.({}, 'Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'forged-prompt-frame',
          functionName: 'canopyAppOwnedPrompt',
          location: { scriptId: 'attacker-script' },
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getDialog('browser-forged-prompt')).toBeNull();
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Debugger.resume',
      undefined,
    );
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Debugger.evaluateOnCallFrame',
      expect.anything(),
    );
  });

  it('trusts a service-owned prompt bridge reinstalled for the current document', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-restored-prompt',
      url: 'https://trusted.example',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    debugMessage?.({}, 'Runtime.executionContextCreated', {
      context: {
        id: 10,
        origin: 'https://trusted.example',
        auxData: { frameId: 'main-frame' },
      },
    });
    debugMessage?.({}, 'Debugger.scriptParsed', {
      executionContextId: 10,
      scriptId: 'initial-prompt-script',
      url: appPromptBridgeSourceUrl(),
    });
    debugMessage?.({}, 'Page.frameNavigated', {
      frame: {
        id: 'main-frame',
        url: 'https://trusted.example/settings',
      },
    });
    let restoredSourceUrl = '';
    webContents.debugger.sendCommand.mockImplementation(
      (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expression =
            typeof params?.expression === 'string' ? params.expression : '';
          restoredSourceUrl =
            /\/\/# sourceURL=(.+)$/.exec(expression)?.[1] ?? '';
          debugMessage?.({}, 'Debugger.scriptParsed', {
            executionContextId: 10,
            scriptId: 'restored-prompt-script',
            url: restoredSourceUrl,
          });
          return Promise.resolve({ result: { value: true } });
        }
        if (method === 'Debugger.evaluateOnCallFrame') {
          return Promise.resolve({
            result: {
              value: {
                marker: 'canopy-browser-app-prompt-v1',
                message: 'Restored prompt',
                defaultPrompt: '',
              },
            },
          });
        }
        return Promise.resolve({});
      },
    );

    webContents.emit('did-finish-load');
    await Promise.resolve();
    await Promise.resolve();
    expect(restoredSourceUrl).not.toBe('');
    expect(restoredSourceUrl).not.toBe(appPromptBridgeSourceUrl());

    debugMessage?.({}, 'Debugger.paused', {
      callFrames: [
        {
          callFrameId: 'restored-prompt-frame',
          functionName: 'canopyAppOwnedPrompt',
          location: { scriptId: 'restored-prompt-script' },
        },
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(service.getDialog('browser-restored-prompt')).toMatchObject({
      type: 'prompt',
      message: 'Restored prompt',
      url: 'https://trusted.example/settings',
      frameId: 'main-frame',
    });
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Debugger.resume',
      undefined,
    );
  });

  it('handles a pending JavaScript dialog through CDP and rejects stale ids', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-handle-dialog',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    const promptCallback = jest.fn((): void => {
      setImmediate(() => {
        debugMessage?.({}, 'Page.javascriptDialogClosed', {
          result: true,
          userInput: 'updated',
        });
      });
    });
    webContents.emit(
      '-run-dialog',
      { dialogType: 'prompt', messageText: 'Name' },
      promptCallback,
    );
    debugMessage?.({}, 'Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Name',
      defaultPrompt: 'initial',
      url: 'http://localhost:3000',
    });
    const dialog = service.getDialog('browser-handle-dialog');
    expect(dialog).toMatchObject({
      type: 'prompt',
      defaultPrompt: 'initial',
    });
    const openedEvents = sentBrowserEvents().filter(
      (event) => event.type === 'dialog-opened',
    );
    expect(openedEvents[openedEvents.length - 1]).toMatchObject({
      browserId: 'browser-handle-dialog',
      dialog: { id: dialog?.id, defaultPrompt: 'initial' },
    });

    await expect(
      service.handleDialog({
        browserId: 'browser-handle-dialog',
        dialogId: 'stale-dialog',
        accept: true,
      }),
    ).rejects.toThrow('stale');

    const handled = await service.handleDialog({
      browserId: 'browser-handle-dialog',
      dialogId: dialog?.id ?? '',
      accept: true,
      promptText: 'updated',
    });

    expect(promptCallback).toHaveBeenCalledWith(true, 'updated');
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Page.handleJavaScriptDialog',
      expect.anything(),
    );
    expect(handled).toMatchObject({
      accept: true,
      promptText: 'updated',
      dialog: { id: dialog?.id, type: 'prompt' },
    });
    expect(service.getDialog('browser-handle-dialog')).toBeNull();
    expect(sentBrowserEvents()).toContainEqual({
      type: 'dialog-closed',
      runtimeGeneration: 1,
      browserId: 'browser-handle-dialog',
      dialogId: dialog?.id,
    });
  });

  it('does not report a dialog handled until Chromium acknowledges its close', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-dialog-close-ack',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    const alertCallback = jest.fn();
    webContents.emit(
      '-run-dialog',
      { dialogType: 'alert', messageText: 'Wait for me' },
      alertCallback,
    );
    debugMessage?.({}, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Wait for me',
      url: 'http://localhost:3000',
    });
    const dialog = service.getDialog('browser-dialog-close-ack');
    expect(alertCallback).not.toHaveBeenCalled();
    let settled = false;
    const handling = service
      .handleDialog({
        browserId: 'browser-dialog-close-ack',
        dialogId: dialog?.id ?? '',
        accept: true,
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(service.getDialog('browser-dialog-close-ack')).toEqual(dialog);
    expect(alertCallback).toHaveBeenCalledWith(true, '');

    debugMessage?.({}, 'Page.javascriptDialogClosed', {
      result: true,
      userInput: '',
    });

    await expect(handling).resolves.toMatchObject({
      accept: true,
      dialog: { id: dialog?.id },
    });
    expect(service.getDialog('browser-dialog-close-ack')).toBeNull();
  });

  it('clears a pending dialog when Electron cancels it', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-dialog-cancelled',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    const alertCallback = jest.fn();
    webContents.emit(
      '-run-dialog',
      { dialogType: 'alert', messageText: 'Cancelled externally' },
      alertCallback,
    );
    debugMessage?.({}, 'Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Cancelled externally',
      url: 'http://localhost:3000',
    });
    const dialog = service.getDialog('browser-dialog-cancelled');
    const handling = service.handleDialog({
      browserId: 'browser-dialog-cancelled',
      dialogId: dialog?.id ?? '',
      accept: true,
    });

    await Promise.resolve();
    expect(alertCallback).toHaveBeenCalledWith(true, '');
    webContents.emit('-cancel-dialogs');

    await expect(handling).resolves.toMatchObject({
      accept: true,
      dialog: { id: dialog?.id },
    });
    expect(service.getDialog('browser-dialog-cancelled')).toBeNull();
    expect(sentBrowserEvents()).toContainEqual({
      type: 'dialog-closed',
      runtimeGeneration: 1,
      browserId: 'browser-dialog-cancelled',
      dialogId: dialog?.id,
    });
  });

  it('retains the app beforeunload choice when the native veto closes its CDP dialog', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'native-veto',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([name]) => name === 'message',
    )?.[1];
    if (!debugMessage) throw new Error('Missing debugger listener');
    debugMessage({}, 'Page.javascriptDialogOpening', {
      type: 'beforeunload',
      message: '',
      url: 'http://localhost/editor',
    });
    const original = service.getDialog('native-veto');
    if (!original) throw new Error('Missing beforeunload dialog');
    webContents.emit('will-prevent-unload', { preventDefault: jest.fn() });
    debugMessage({}, 'Page.javascriptDialogClosed', { result: false });
    expect(service.getDialog('native-veto')).toMatchObject({
      id: original.id,
      type: 'beforeunload',
    });
    await service.handleDialog({
      browserId: 'native-veto',
      dialogId: original.id,
      accept: false,
    });
    expect(service.getDialog('native-veto')).toBeNull();
    await service.shutdown();
  });

  it('does not publish the native confirmation for an already accepted beforeunload replay', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'accepted-native',
    });
    webContents.emit('will-prevent-unload', { preventDefault: jest.fn() });
    const dialog = service.getDialog('accepted-native');
    if (!dialog) throw new Error('Missing initial choice');
    await service.handleDialog({
      browserId: 'accepted-native',
      dialogId: dialog.id,
      accept: true,
    });
    const message = webContents.debugger.on.mock.calls.find(
      ([name]) => name === 'message',
    )?.[1];
    if (!message) throw new Error('Missing debugger listener');
    message({}, 'Page.javascriptDialogOpening', {
      type: 'beforeunload',
      message: '',
      url: 'http://localhost/editor',
    });
    expect(service.getDialog('accepted-native')).toBeNull();
    await service.shutdown();
  });

  it('replays a blocked reload only after the beforeunload dialog is accepted', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-beforeunload',
      url: 'http://localhost:3000/editor',
    });
    const preventedEvents: Array<{ preventDefault: jest.Mock }> = [];
    webContents.reload.mockImplementation(() => {
      const event = { preventDefault: jest.fn() };
      preventedEvents.push(event);
      webContents.emit('will-prevent-unload', event);
    });

    await service.reload('browser-beforeunload');

    const dialog = service.getDialog('browser-beforeunload');
    expect(dialog).toMatchObject({
      type: 'beforeunload',
      message: 'Changes you made may not be saved.',
      url: 'http://localhost:3000/editor',
    });
    expect(preventedEvents[0]?.preventDefault).not.toHaveBeenCalled();

    await expect(
      service.handleDialog({
        browserId: 'browser-beforeunload',
        dialogId: dialog?.id ?? '',
        accept: true,
      }),
    ).resolves.toMatchObject({
      accept: true,
      dialog: { id: dialog?.id, type: 'beforeunload' },
    });

    expect(webContents.reload).toHaveBeenCalledTimes(2);
    expect(preventedEvents[1]?.preventDefault).toHaveBeenCalledTimes(1);
    expect(service.getDialog('browser-beforeunload')).toBeNull();
    expect(sentBrowserEvents()).toContainEqual({
      type: 'dialog-closed',
      runtimeGeneration: 1,
      browserId: 'browser-beforeunload',
      dialogId: dialog?.id,
    });
  });

  it.each(['press', 'click'] as const)(
    'intercepts a JavaScript dialog atomically with the requested %s action',
    async (kind) => {
      const service = new BrowserService({
        getWindow: mockWindow,
      });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-prearmed-dialog',
        url: 'http://localhost:3000',
      });
      const actionOrder: string[] = [];
      webContents.debugger.sendCommand.mockImplementation(
        (command: string, params?: Record<string, unknown>) => {
          const trustedTarget = trustedTargetDebuggerResult(
            command,
            'press-target',
            params,
          );
          if (
            kind === 'click' &&
            command === 'Runtime.callFunctionOn' &&
            String(params?.functionDeclaration).includes('const el = this')
          ) {
            return Promise.resolve({
              result: {
                value: {
                  attached: true,
                  enabled: true,
                  viewport: { width: 0, height: 0 },
                },
              },
            });
          }
          if (trustedTarget !== undefined) {
            return Promise.resolve(trustedTarget);
          }
          if (command === 'Runtime.callFunctionOn') {
            actionOrder.push('action-executed');
            expect(params?.functionDeclaration).toContain(
              '"dialogResponse":{"accept":false}',
            );
            return Promise.resolve({
              result: {
                value: {
                  capture: {
                    type: 'confirm',
                    message: 'Continue?',
                    url: 'http://localhost:3000',
                    openedAt: 1234,
                  },
                },
              },
            });
          }
          return Promise.resolve(undefined);
        },
      );
      modelSeam.resolveActionTarget.mockImplementation(async () => {
        actionOrder.push('target-resolved');
        await new Promise((resolve) => setImmediate(resolve));
        return { status: 'found', target: seamTarget('press-target') };
      });

      const result = await service.automation({
        browserId: 'browser-prearmed-dialog',
        command:
          kind === 'press'
            ? {
                kind: 'press',
                locator: '#legacy-hidden-target',
                key: 'Enter',
                dialogResponse: { accept: false },
              }
            : {
                kind: 'click',
                locator: '#never-shown-target',
                dialogResponse: { accept: false },
              },
      });

      expect(result).toMatchObject({
        ok: true,
        completed: true,
        handledDialog: {
          accept: false,
          dialog: { type: 'confirm', message: 'Continue?' },
        },
      });
      expect(result.dialog).toBeUndefined();
      expect(actionOrder).toEqual(['target-resolved', 'action-executed']);
      expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
        'Page.handleJavaScriptDialog',
        expect.anything(),
      );
      expect(service.getDialog('browser-prearmed-dialog')).toBeNull();
    },
  );

  it('does not apply a dialog response before the requested action begins', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-unrelated-dialog',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    const unrelatedDialogCallback = jest.fn();
    // The dialog opens while the target (the focused element) resolves.
    modelSeam.resolveActionTarget.mockImplementation(() => {
      webContents.emit(
        '-run-dialog',
        { dialogType: 'confirm', messageText: 'Unrelated confirmation' },
        unrelatedDialogCallback,
      );
      debugMessage?.({}, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Unrelated confirmation',
        url: 'http://localhost:3000/background',
        frameId: 'main-frame',
      });
      return new Promise(() => undefined);
    });

    const result = await service.automation({
      browserId: 'browser-unrelated-dialog',
      command: {
        kind: 'press',
        key: 'Enter',
        dialogResponse: { accept: true },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      completed: false,
      dialog: {
        type: 'confirm',
        message: 'Unrelated confirmation',
      },
    });
    expect(unrelatedDialogCallback).not.toHaveBeenCalled();
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.anything(),
    );
  });

  it.each(['press', 'click'] as const)(
    'does not reuse a pre-armed response for a second synchronous dialog during %s',
    async (kind) => {
      const service = new BrowserService({
        getWindow: mockWindow,
      });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-two-dialogs',
        url: 'http://localhost:3000',
      });
      const debugMessage = webContents.debugger.on.mock.calls.find(
        ([eventName]) => eventName === 'message',
      )?.[1];
      const secondDialogCallback = jest.fn();
      let finishEvaluation = (): void => {};
      webContents.debugger.sendCommand.mockImplementation(
        (command: string, params?: Record<string, unknown>) => {
          const trustedTarget = trustedTargetDebuggerResult(
            command,
            'press-target',
            params,
          );
          if (
            kind === 'click' &&
            command === 'Runtime.callFunctionOn' &&
            String(params?.functionDeclaration).includes('const el = this')
          ) {
            return Promise.resolve({
              result: {
                value: {
                  attached: true,
                  enabled: true,
                  viewport: { width: 0, height: 0 },
                },
              },
            });
          }
          if (trustedTarget !== undefined) {
            return Promise.resolve(trustedTarget);
          }
          if (command === 'Runtime.callFunctionOn') {
            webContents.emit(
              '-run-dialog',
              { dialogType: 'confirm', messageText: 'Delete everything?' },
              secondDialogCallback,
            );
            debugMessage?.({}, 'Page.javascriptDialogOpening', {
              type: 'confirm',
              message: 'Delete everything?',
              url: 'http://localhost:3000/settings',
              frameId: 'main-frame',
            });
            return new Promise((resolve) => {
              finishEvaluation = (): void => resolve({});
            });
          }
          return Promise.resolve(undefined);
        },
      );
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: seamTarget('press-target'),
      });

      const result = await service.automation({
        browserId: 'browser-two-dialogs',
        command:
          kind === 'press'
            ? {
                kind: 'press',
                locator: '#legacy-hidden-target',
                key: 'Enter',
                dialogResponse: { accept: true },
              }
            : {
                kind: 'click',
                locator: '#never-shown-target',
                dialogResponse: { accept: true },
              },
      });

      expect(result).toMatchObject({
        ok: true,
        completed: false,
        dialog: {
          type: 'confirm',
          message: 'Delete everything?',
        },
      });
      expect(secondDialogCallback).not.toHaveBeenCalled();
      expect(
        webContents.debugger.sendCommand.mock.calls.some(
          ([method]) => method === 'Page.handleJavaScriptDialog',
        ),
      ).toBe(false);
      expect(service.getDialog('browser-two-dialogs')).toMatchObject({
        type: 'confirm',
        message: 'Delete everything?',
        url: 'http://localhost:3000/settings',
        frameId: 'main-frame',
      });
      finishEvaluation();
      await service.shutdown();
    },
  );

  it('navigates an existing browser when create receives the same id with a new URL', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-existing',
      url: 'http://localhost:3000',
    });
    webContents.loadURL.mockClear();

    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-existing',
      url: 'http://localhost:3001',
    });

    expect(webContents.loadURL).toHaveBeenCalledWith('http://localhost:3001');
    expect(snapshot).toMatchObject({
      id: 'browser-existing',
      url: 'http://localhost:3001',
    });
  });

  it('hides, detaches, and closes browser views on destroy', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-destroy',
      url: 'http://localhost:3000',
    });
    jest.mocked(sendToWindow).mockClear();

    await service.destroy('browser-destroy');

    expect(removeChildView).toHaveBeenCalled();
    expect(webContents._setOwnerWindow).toHaveBeenLastCalledWith(null);
    expect(webContents.debugger.detach).toHaveBeenCalled();
    expect(webContents.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([]);
    expect(sendToWindow).toHaveBeenCalledWith(
      expect.anything(),
      'browser:event',
      { type: 'destroyed', browserId: 'browser-destroy', runtimeGeneration: 1 },
    );
  });

  it('persists explicit activation and never changes it from bounds timing', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });

    await service.setActiveBrowser('project-1', 'worktree-1', 'browser-1');
    service.setBounds({
      browserId: 'browser-2',
      bounds: { x: 400, y: 0, width: 400, height: 600 },
      visible: true,
    });
    service.setVisible('browser-2', true);

    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-1',
    );
    expect(pageFrameOf(createdViews[1]).frame.setBounds).toHaveBeenCalledWith({
      x: 400,
      y: 0,
      width: 400,
      height: 600,
    });
    expect(pageFrameOf(createdViews[0]).frame.setBounds).not.toHaveBeenCalled();
    expect(lastSavedBrowserState().activeBrowserId).toBe('browser-1');
  });

  it('positions the native view in window DIPs under the interface-scale zoom', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-zoomed',
    });

    mockHostZoomFactor = 1.5;
    try {
      // The pane reports its client rect in the host renderer's CSS px.
      service.setBounds({
        browserId: 'browser-zoomed',
        bounds: { x: 280, y: 46, width: 600, height: 400 },
        visible: true,
      });
    } finally {
      mockHostZoomFactor = 1;
    }

    expect(
      pageFrameOf(createdViews[0]).frame.setBounds,
    ).toHaveBeenLastCalledWith({ x: 420, y: 69, width: 900, height: 600 });
    // A square page fills its frame, inside a clip reaching 1 past it.
    expect(createdViews[0]?.setBounds).toHaveBeenLastCalledWith({
      x: 1,
      y: 1,
      width: 900,
      height: 600,
    });
  });

  it('rounds only the page corners its area rounds, in window DIPs', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-rounded',
    });
    const page = createdViews[0];
    const { clip, frame } = pageFrameOf(page);
    const bounds = { x: 280, y: 46, width: 600, height: 400 };
    const bottomRounded = {
      topLeft: 0,
      topRight: 0,
      bottomRight: 9,
      bottomLeft: 9,
    };

    mockHostZoomFactor = 1.5;
    try {
      service.setBounds({
        browserId: 'browser-rounded',
        bounds,
        visible: true,
        cornerRadii: bottomRounded,
      });
      // The frame is cut to the page area; the rounded clip reaches above
      // it by the radius, so only the bottom corners show rounded.
      expect(frame.setBounds).toHaveBeenLastCalledWith({
        x: 420,
        y: 69,
        width: 900,
        height: 600,
      });
      expect(clip.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: -14,
        width: 900,
        height: 614,
      });
      expect(page?.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 14,
        width: 900,
        height: 600,
      });
      expect(clip.setBorderRadius).toHaveBeenLastCalledWith(14);
      expect(page?.setBorderRadius).not.toHaveBeenCalled();

      // A resend without radii keeps the ones the pane last sent.
      service.setBounds({
        browserId: 'browser-rounded',
        bounds,
        visible: true,
      });
      expect(clip.setBorderRadius).toHaveBeenLastCalledWith(14);
      expect(page?.setBounds).toHaveBeenLastCalledWith({
        x: 0,
        y: 14,
        width: 900,
        height: 600,
      });
    } finally {
      mockHostZoomFactor = 1;
    }

    // An open inspector squares the bottom-right too: the clip also reaches
    // past the page's right side.
    service.setBounds({
      browserId: 'browser-rounded',
      bounds,
      visible: true,
      cornerRadii: { ...bottomRounded, bottomRight: 0 },
    });
    expect(clip.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: -9,
      width: 609,
      height: 409,
    });
    expect(clip.setBorderRadius).toHaveBeenLastCalledWith(9);

    // A square page area squares the view again. The clip keeps a 1 radius
    // (a zero one would mask out the whole page) and reaches 1 past every
    // side, so no rounding reaches the page.
    service.setBounds({
      browserId: 'browser-rounded',
      bounds,
      visible: true,
      cornerRadii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    });
    expect(clip.setBorderRadius).toHaveBeenLastCalledWith(1);
    expect(clip.setBorderRadius).not.toHaveBeenCalledWith(0);
    expect(clip.setBounds).toHaveBeenLastCalledWith({
      x: -1,
      y: -1,
      width: 602,
      height: 402,
    });
    expect(page?.setBounds).toHaveBeenLastCalledWith({
      x: 1,
      y: 1,
      width: 600,
      height: 400,
    });
  });

  it('hides the page frame with the page, so it never takes input', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-frame-visibility',
    });
    const { frame } = pageFrameOf(createdViews[0]);
    expect(addChildView).toHaveBeenLastCalledWith(frame);

    service.setVisible('browser-frame-visibility', true);
    expect(frame.setVisible).toHaveBeenLastCalledWith(true);
    service.setVisible('browser-frame-visibility', false);
    expect(frame.setVisible).toHaveBeenLastCalledWith(false);
    expect(mockSetVisible).toHaveBeenLastCalledWith(false);
  });

  it('rejects cross-worktree activation without mutating the saved selection', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      browserId: 'browser-2',
    });
    await service.setActiveBrowser('project-1', 'worktree-1', 'browser-1');
    jest.mocked(saveWorktreeBrowserState).mockClear();

    await expect(
      service.setActiveBrowser('project-1', 'worktree-1', 'browser-2'),
    ).rejects.toThrow('does not belong');

    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-1',
    );
    expect(saveWorktreeBrowserState).not.toHaveBeenCalled();
  });

  it('persists valid set-active IPC through BrowserService and preserves state on rejected ownership', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
      expectedRuntimeGeneration: 1,
    });
    await service.create({
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      browserId: 'browser-foreign',
      expectedRuntimeGeneration: 1,
    });
    await service.setActiveBrowser('project-1', 'worktree-1', 'browser-1');
    registerBrowserHandlers(mockWindow, service);
    const setActiveHandler = ipcHandlers.get(IPC_CHANNELS.browserSetActive);
    jest.mocked(saveWorktreeBrowserState).mockClear();

    await setActiveHandler?.(
      {},
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-2',
        expectedRuntimeGeneration: 1,
      },
    );

    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-2',
    );
    expect(lastSavedBrowserState().activeBrowserId).toBe('browser-2');
    const saveCount = jest.mocked(saveWorktreeBrowserState).mock.calls.length;

    await expect(
      setActiveHandler?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'browser-foreign',
          expectedRuntimeGeneration: 1,
        },
      ),
    ).rejects.toThrow('does not belong');
    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-2',
    );
    expect(saveWorktreeBrowserState).toHaveBeenCalledTimes(saveCount);
  });

  it('serializes asynchronous activation writes without blocking later calls', async () => {
    await settleLeftoverSnapshotSaves();
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    jest.mocked(saveWorktreeBrowserState).mockClear();

    let resolveFirstWrite: (() => void) | undefined;
    jest
      .mocked(saveWorktreeBrowserState)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const first = service.setActiveBrowser(
      'project-1',
      'worktree-1',
      'browser-1',
    );
    await Promise.resolve();
    const second = service.setActiveBrowser(
      'project-1',
      'worktree-1',
      'browser-2',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(saveWorktreeBrowserState).toHaveBeenCalledTimes(1);
    expect(lastSavedBrowserState().activeBrowserId).toBe('browser-1');

    resolveFirstWrite?.();
    await first;
    await second;

    expect(saveWorktreeBrowserState).toHaveBeenCalledTimes(2);
    expect(
      jest
        .mocked(saveWorktreeBrowserState)
        .mock.calls.map(([request]) => request.state.activeBrowserId),
    ).toEqual(['browser-1', 'browser-2']);
    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-2',
    );
  });

  it('preserves live snapshots updated during an asynchronous mutation write', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    jest.mocked(saveWorktreeBrowserState).mockClear();

    let resolveWrite: (() => void) | undefined;
    let enteredWrite = (): void => {};
    const writeStarted = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    jest.mocked(saveWorktreeBrowserState).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
          enteredWrite();
        }),
    );

    const mutation = service.setActiveBrowser(
      'project-1',
      'worktree-1',
      'browser-1',
    );
    await writeStarted;
    webContents.emit('page-title-updated', {}, 'New live title');
    resolveWrite?.();
    await mutation;

    expect(
      service.listWorktreeBrowsers('project-1', 'worktree-1'),
    ).toContainEqual(
      expect.objectContaining({ id: 'browser-1', title: 'New live title' }),
    );
  });

  it('repairs stale active state to the first valid persisted order entry', async () => {
    await settleLeftoverSnapshotSaves();
    const service = new BrowserService({ getWindow: mockWindow });
    await service.saveWorktreeState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state: {
        version: 1,
        browserOrder: ['browser-2', 'browser-1'],
        activeBrowserId: 'missing-browser',
        browsers: [
          persistedSnapshot('browser-1'),
          persistedSnapshot('browser-2'),
        ],
      },
    });
    jest.mocked(saveWorktreeBrowserState).mockClear();

    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-2',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lastSavedBrowserState().activeBrowserId).toBe('browser-2');
  });

  it('chooses next, previous, and null active fallbacks while destroying', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    for (const browserId of ['browser-1', 'browser-2', 'browser-3']) {
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
      });
    }
    await service.setActiveBrowser('project-1', 'worktree-1', 'browser-2');

    await service.destroy('browser-2');
    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-3',
    );
    await service.destroy('browser-3');
    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-1',
    );
    await service.destroy('browser-1');
    expect(
      service.resolveActiveBrowserId('project-1', 'worktree-1'),
    ).toBeNull();
  });

  it('coalesces concurrent permanent destruction and emits destroyed once', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-once',
    });
    jest.mocked(sendToWindow).mockClear();

    await Promise.all([
      service.destroy('browser-once'),
      service.destroy('browser-once'),
      service.destroy('browser-once'),
    ]);
    await service.destroy('browser-once');

    const destroyedEvents = jest
      .mocked(sendToWindow)
      .mock.calls.map((call) => call[2] as BrowserEvent)
      .filter(
        (event) =>
          event.type === 'destroyed' && event.browserId === 'browser-once',
      );
    expect(destroyedEvents).toHaveLength(1);
  });

  it('keeps durable state and diagnostics while disposing and lazily recreating a live view', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-dispose',
      url: 'http://localhost/browser-dispose',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    debugMessage?.({}, 'Runtime.consoleAPICalled', {
      type: 'info',
      args: [{ value: 'preserved diagnostic' }],
    });
    await service.startRecording('browser-dispose');
    await service.screenshot({
      browserId: 'browser-dispose',
      saveToAttachments: true,
    });
    jest.mocked(sendToWindow).mockClear();

    await service.disposeLiveView('browser-dispose');

    expect(service.getLifecycleStats()).toMatchObject({
      liveViews: 0,
      persistedSessions: 1,
      trackedArtifacts: 1,
    });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({ id: 'browser-dispose' }),
    ]);
    expect(
      jest
        .mocked(sendToWindow)
        .mock.calls.some(
          (call) => (call[2] as BrowserEvent).type === 'destroyed',
        ),
    ).toBe(false);

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-dispose',
    });
    expect(
      service
        .getConsole({ browserId: 'browser-dispose' })
        .map((entry) => entry.text),
    ).toContain('preserved diagnostic');
    expect(
      service.getRecording('browser-dispose').steps.length,
    ).toBeGreaterThan(0);
  });

  it('keeps cleared recording history empty after recreating a live view', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-cleared-recording',
      url: 'http://localhost/recording',
    });
    await service.startRecording('browser-cleared-recording');
    expect(
      service.getRecording('browser-cleared-recording').steps,
    ).not.toHaveLength(0);

    service.clearRecording('browser-cleared-recording');
    await service.disposeLiveView('browser-cleared-recording');
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-cleared-recording',
    });

    expect(service.getRecording('browser-cleared-recording').steps).toEqual([]);
  });

  it('removes browser-owned attachments and in-memory artifacts on permanent destroy', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-artifacts',
    });
    const screenshot = await service.screenshot({
      browserId: 'browser-artifacts',
      saveToAttachments: true,
    });
    const mockedFs = jest.requireMock<{
      rm: jest.Mock;
      readdir: jest.Mock;
    }>('node:fs/promises');
    const chatOwnedCopy =
      '/attachments/browser-screenshot-browser-artifacts-chat-owned.png';
    mockedFs.readdir.mockResolvedValueOnce([
      {
        isFile: (): boolean => true,
        name: 'browser-screenshot-browser-artifacts-chat-owned.png',
      },
    ]);

    await service.destroy('browser-artifacts');

    expect(mockedFs.rm).toHaveBeenCalledWith(screenshot.attachmentPath, {
      force: true,
    });
    expect(mockedFs.rm).not.toHaveBeenCalledWith(chatOwnedCopy, {
      force: true,
    });
    expect(service.getLifecycleStats()).toMatchObject({
      liveViews: 0,
      persistedSessions: 0,
      trackedArtifacts: 0,
    });
  });

  it('shutdown disposes every live view without deleting state or emitting destroyed', async () => {
    const projectId = 'project-shutdown';
    const worktreeId = 'worktree-shutdown';
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId,
      worktreeId,
      browserId: 'browser-1',
    });
    await service.create({
      projectId,
      worktreeId,
      browserId: 'browser-2',
    });
    await service.setActiveBrowser(projectId, worktreeId, 'browser-2');
    jest.mocked(sendToWindow).mockClear();
    jest.mocked(saveWorktreeBrowserState).mockClear();

    await service.shutdown();

    expect((service.profileData.shutdown as jest.Mock).mock.calls).toHaveLength(
      1,
    );
    expect(createdViews[0]?.webContents.close).toHaveBeenCalled();
    expect(createdViews[1]?.webContents.close).toHaveBeenCalled();
    expect(service.getLifecycleStats()).toMatchObject({
      liveViews: 0,
      persistedSessions: 2,
    });
    expect(savedBrowserStateFor(projectId, worktreeId)).toMatchObject({
      browserOrder: ['browser-1', 'browser-2'],
      activeBrowserId: 'browser-2',
    });
    expect(
      jest
        .mocked(sendToWindow)
        .mock.calls.some(
          (call) => (call[2] as BrowserEvent).type === 'destroyed',
        ),
    ).toBe(false);
  });

  it('persists an empty browser list when stopping browsers for a split without deleting the target', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    jest.mocked(saveWorktreeBrowserState).mockClear();
    await service.destroyWorktree('project-1', 'worktree-1', {
      clearStorage: false,
    });
    expect(saveWorktreeBrowserState).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state: {
        version: 2,
        browserOrder: [],
        activeBrowserId: null,
        browsers: [],
      },
    });
  });

  it('destroys every browser without writing live state during target deletion', async () => {
    const projectId = 'project-deleting-target';
    const worktreeId = 'worktree-deleting-target';
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId,
      worktreeId,
      browserId: 'browser-1',
    });
    await service.create({
      projectId,
      worktreeId,
      browserId: 'browser-2',
    });
    jest
      .mocked(saveWorktreeBrowserState)
      .mockClear()
      .mockRejectedValue(new Error('Target is being automatically deleted'));
    jest.mocked(session).fromPartition.mockClear();

    await service.destroyWorktree(projectId, worktreeId, {
      deletingTarget: true,
    });

    expect(
      jest
        .mocked(saveWorktreeBrowserState)
        .mock.calls.filter(
          ([request]) =>
            request.projectId === projectId &&
            request.worktreeId === worktreeId,
        ),
    ).toHaveLength(0);
    // Profile-owned storage is retired by browser-profile-lifecycle; logical
    // tab teardown must not allocate or clear a legacy task partition.
    expect(jest.mocked(session).fromPartition.mock.calls).toHaveLength(0);
    expect(service.getLifecycleStats()).toMatchObject({
      liveViews: 0,
      persistedSessions: 0,
      trackedArtifacts: 0,
    });
  });

  it('keeps destroyWorktree permanent for persisted-inert sessions', async () => {
    jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue({
      status: 'loaded',
      state: {
        version: 1,
        browserOrder: ['browser-1', 'browser-2'],
        activeBrowserId: 'browser-1',
        browsers: [
          persistedSnapshot('browser-1'),
          persistedSnapshot('browser-2'),
        ],
      },
    });
    const service = new BrowserService({ getWindow: mockWindow });
    await service.loadWorktreeState('project-1', 'worktree-1');
    jest.mocked(sendToWindow).mockClear();

    await service.destroyWorktree('project-1', 'worktree-1');

    expect(WebContentsView).not.toHaveBeenCalled();
    expect(
      jest
        .mocked(sendToWindow)
        .mock.calls.map((call) => call[2])
        .filter(
          (event): event is Extract<BrowserEvent, { type: 'destroyed' }> =>
            (event as BrowserEvent).type === 'destroyed',
        )
        .map((event) => event.browserId),
    ).toEqual(['browser-1', 'browser-2']);
    const mockedSession = jest.mocked(session);
    expect(mockedSession.fromPartition).not.toHaveBeenCalled();
  });

  it('does not allocate or clear native storage when tab state hydration fails', async () => {
    const mockedSession = jest.mocked(session);
    jest.mocked(loadWorktreeBrowserState).mockImplementationOnce(() => {
      throw new Error('state hydration failed');
    });
    const service = new BrowserService({ getWindow: mockWindow });

    await expect(
      service.destroyWorktree('project-1', 'worktree-1'),
    ).resolves.toBeUndefined();

    expect(mockedSession.fromPartition).not.toHaveBeenCalled();
  });

  it('includes the live profile generation when fallback worktree destruction emits', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-fallback-destroy',
    });
    jest
      .spyOn(
        service as unknown as {
          ensureWorktreeState: () => never;
        },
        'ensureWorktreeState',
      )
      .mockImplementation(() => {
        throw new Error('state hydration failed');
      });
    jest.mocked(sendToWindow).mockClear();

    await service.destroyWorktree('project-1', 'worktree-1');

    expect(sendToWindow).toHaveBeenCalledWith(
      expect.any(Object),
      'browser:event',
      {
        type: 'destroyed',
        browserId: 'browser-fallback-destroy',
        runtimeGeneration: 1,
      },
    );
  });

  it('preserves fallback diagnostics while loading empty defaults', async () => {
    const fallback: LoadWorktreeBrowserStateResponse = {
      status: 'fallback',
      state: {
        version: 1,
        browserOrder: [],
        activeBrowserId: null,
        browsers: [],
      },
      error: 'Browser state contains invalid JSON.',
    };
    jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue(fallback);
    const service = new BrowserService({ getWindow: mockWindow });

    await expect(
      service.loadWorktreeState('project-1', 'worktree-1'),
    ).resolves.toEqual({
      ...fallback,
      handoffState: browserHandoffs.snapshot('project-1', 'worktree-1'),
    });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([]);
  });

  it('fails profile usage closed after rejected hydration installed an empty runtime state', async () => {
    mockProfileTaskSlots.mockResolvedValue([
      {
        schemaVersion: 1,
        scope: {
          kind: 'worktree',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
        ownerCreatedAt: 'fixture-owner',
        incarnationId: 'fixture-incarnation',
        metadataRevision: 0,
        defaultSelection: {
          kind: 'named',
          profileId: 'shared-profile',
        },
        nextStorageGeneration: 1,
        agentClearAllowed: false,
        lifecycle: 'active',
      },
    ]);
    const rejected: LoadWorktreeBrowserStateResponse = {
      status: 'rejected',
      state: null,
      error: 'Browser state has an unsupported version.',
    };
    jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue(rejected);
    const service = new BrowserService({ getWindow: mockWindow });

    await expect(
      service.loadWorktreeState('project-1', 'worktree-1'),
    ).resolves.toEqual({
      ...rejected,
      handoffState: browserHandoffs.snapshot('project-1', 'worktree-1'),
    });
    await expect(service.profileUsage('shared-profile')).rejects.toMatchObject({
      code: 'recovery_required',
      message: 'Browser state has an unsupported version.',
    });
  });

  it('preserves damaged bindings and rejects creation instead of selecting another account', async () => {
    jest.mocked(loadWorktreeBrowserState).mockReturnValue({
      status: 'fallback',
      state: {
        version: 1,
        browserOrder: [],
        activeBrowserId: null,
        browsers: [],
      },
      error: 'Browser state contains invalid JSON.',
    });
    const service = new BrowserService({ getWindow: mockWindow });

    await expect(
      service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-live',
      }),
    ).rejects.toThrow('Browser state contains invalid JSON.');

    expect(saveWorktreeBrowserState).not.toHaveBeenCalled();
    expect(WebContentsView).not.toHaveBeenCalled();
  });

  it('hydrates persisted sessions inertly and recreates only the requested id', async () => {
    jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue({
      status: 'loaded',
      state: {
        version: 1,
        browserOrder: ['browser-1', 'browser-2'],
        activeBrowserId: 'browser-2',
        browsers: [
          persistedSnapshot('browser-1'),
          persistedSnapshot('browser-2', {
            canGoBack: true,
            canGoForward: true,
          }),
        ],
      },
    });
    const service = new BrowserService({ getWindow: mockWindow });

    await service.loadWorktreeState('project-1', 'worktree-1');
    expect(WebContentsView).not.toHaveBeenCalled();
    expect(
      service.listWorktreeBrowsers('project-1', 'worktree-1'),
    ).toHaveLength(2);
    expect(
      service
        .listWorktreeBrowsers('project-1', 'worktree-1')
        .find((snapshot) => snapshot.id === 'browser-2'),
    ).toMatchObject({ canGoBack: false, canGoForward: false });

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });

    expect(WebContentsView).toHaveBeenCalledTimes(1);
    expect(webContents.loadURL).toHaveBeenCalledWith(
      'http://localhost/browser-2',
    );
    expect(service.getLifecycleStats()).toMatchObject({
      liveViews: 1,
      persistedSessions: 2,
    });
  });

  it('preserves newer live snapshots when reloading persisted worktree state', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-live',
      url: 'http://localhost/live',
    });
    webContents.emit('page-title-updated', {}, 'Live title');
    jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue({
      status: 'loaded',
      state: {
        version: 1,
        browserOrder: ['browser-live'],
        activeBrowserId: 'browser-live',
        browsers: [
          persistedSnapshot('browser-live', {
            url: 'http://localhost/stale',
            title: 'Stale title',
          }),
        ],
      },
    });

    const response = await service.loadWorktreeState('project-1', 'worktree-1');

    expect(response.state?.browsers).toEqual([
      expect.objectContaining({
        id: 'browser-live',
        url: 'http://localhost/live',
        title: 'Live title',
      }),
    ]);
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({
        id: 'browser-live',
        url: 'http://localhost/live',
        title: 'Live title',
      }),
    ]);
  });

  it('debounces live snapshot persistence and saves the latest metadata', async () => {
    const projectId = 'project-debounce';
    const worktreeId = 'worktree-debounce';
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId,
      worktreeId,
      browserId: 'browser-live',
    });
    jest.mocked(saveWorktreeBrowserState).mockClear();
    jest.useFakeTimers();

    webContents.emit('page-title-updated', {}, 'First title');
    webContents.emit('page-title-updated', {}, 'Latest title');

    const matchingSaves = (): SaveWorktreeBrowserStateRequest[] =>
      jest
        .mocked(saveWorktreeBrowserState)
        .mock.calls.map(([request]) => request)
        .filter(
          (request) =>
            request.projectId === projectId &&
            request.worktreeId === worktreeId,
        );

    expect(matchingSaves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(249);
    expect(matchingSaves()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);

    expect(matchingSaves()).toHaveLength(1);
    expect(matchingSaves()[0]?.state.browsers).toEqual([
      expect.objectContaining({
        id: 'browser-live',
        title: 'Latest title',
      }),
    ]);
  });

  it('keeps title, favicon, and loading updates independent per browser id', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });

    createdViews[0]?.webContents.emit('page-title-updated', {}, 'First title');
    createdViews[0]?.webContents.emit('page-favicon-updated', {}, [
      'first.ico',
    ]);
    createdViews[1]?.webContents.emit('page-title-updated', {}, 'Second title');
    createdViews[1]?.webContents.emit('did-start-loading');

    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({
        id: 'browser-1',
        title: 'First title',
        faviconUrl: 'first.ico',
        loading: false,
      }),
      expect.objectContaining({
        id: 'browser-2',
        title: 'Second title',
        loading: true,
      }),
    ]);
  });

  it('returns concurrent screenshots from the exact requested browser views', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    createdViews[0]?.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,one',
      toPNG: () => Buffer.from('one'),
    });
    createdViews[1]?.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,two',
      toPNG: () => Buffer.from('two'),
    });

    const [first, second] = await Promise.all([
      service.screenshot({ browserId: 'browser-1' }),
      service.screenshot({ browserId: 'browser-2' }),
    ]);

    expect(first.dataUrl).toBe('data:image/png;base64,one');
    expect(second.dataUrl).toBe('data:image/png;base64,two');
  });

  it('creates a tab without waiting on debugger domains that answer only after the first navigation', async () => {
    // A never-navigated view has no renderer, so Chromium holds these two
    // commands until the first navigation starts one.
    const release: Array<() => void> = [];
    const answered = webContents.debugger.sendCommand.getMockImplementation();
    webContents.debugger.sendCommand.mockImplementation(
      (method: string, params?: Record<string, unknown>) =>
        method === 'Debugger.enable' || method === 'Page.enable'
          ? new Promise<undefined>((resolve) => {
              release.push(() => resolve(undefined));
            })
          : (answered?.(method, params) ?? Promise.resolve(undefined)),
    );
    const service = new BrowserService({ getWindow: mockWindow });
    let blocked: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        service
          .create({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId: 'browser-1',
          })
          .then(() => 'created'),
        new Promise<string>((resolve) => {
          blocked = setTimeout(() => resolve('blocked'), 500);
        }),
      ]);
      expect(outcome).toBe('created');

      // Once the renderer exists the held commands answer, and the prompt
      // bridge still installs for the documents that follow.
      for (const answer of release) answer();
      await new Promise((resolve) => setImmediate(resolve));
      expect(appPromptBridgeCall()).toBeDefined();
    } finally {
      clearTimeout(blocked);
      for (const answer of release) answer();
      if (answered)
        webContents.debugger.sendCommand.mockImplementation(answered);
    }
  });

  it('registers the page-model trackers behind Page.enable without waiting for its answer', async () => {
    // Chromium holds renderer-bound commands until the first navigation
    // starts a renderer, then runs them in order. Trackers sent only after
    // Page.enable answered reached the renderer after that navigation's
    // same-process child documents had started, so those documents were
    // untracked and their ordinary inputs read as secret (H108).
    const release: Array<() => void> = [];
    const answered = webContents.debugger.sendCommand.getMockImplementation();
    webContents.debugger.sendCommand.mockImplementation(
      (method: string, params?: Record<string, unknown>) =>
        method === 'Debugger.enable' || method === 'Page.enable'
          ? new Promise<undefined>((resolve) => {
              release.push(() => resolve(undefined));
            })
          : (answered?.(method, params) ?? Promise.resolve(undefined)),
    );
    const service = new BrowserService({ getWindow: mockWindow });
    try {
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-1',
      });
      await new Promise((resolve) => setImmediate(resolve));
      // Debugger.enable and Page.enable are still unanswered here.
      expect(release).toHaveLength(2);
      const calls = webContents.debugger.sendCommand.mock.calls;
      const pageEnable = calls.findIndex(
        ([method]) => method === 'Page.enable',
      );
      const trackers = calls.flatMap(([method, params], index) =>
        method === 'Page.addScriptToEvaluateOnNewDocument' &&
        String(params?.source).includes('__canopyPageModelTracker_')
          ? [{ index, worldName: params?.worldName }]
          : [],
      );
      expect(pageEnable).toBeGreaterThanOrEqual(0);
      // The main-world tracker, then the isolated tracker's witness, both
      // queued after Page.enable on the root session.
      expect(trackers.map((tracker) => tracker.worldName)).toEqual([
        undefined,
        'CanopyPageModelTracker',
      ]);
      expect(trackers.every((tracker) => tracker.index > pageEnable)).toBe(
        true,
      );
    } finally {
      for (const answer of release) answer();
      if (answered)
        webContents.debugger.sendCommand.mockImplementation(answered);
    }
  });

  it('encodes a freeze frame as JPEG without the slow PNG encode', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    const toDataURL = jest.fn(() => 'data:image/png;base64,slow');
    const toPNG = jest.fn(() => Buffer.from('slow'));
    const toJPEG = jest.fn(() => Buffer.from('fast'));
    createdViews[0]?.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      toDataURL,
      toPNG,
      toJPEG,
    });

    const result = await service.screenshot({
      browserId: 'browser-1',
      purpose: 'freeze-frame',
    });

    expect(result).toEqual({
      dataUrl: `data:image/jpeg;base64,${Buffer.from('fast').toString('base64')}`,
    });
    expect(toJPEG).toHaveBeenCalledTimes(1);
    expect(toDataURL).not.toHaveBeenCalled();
    expect(toPNG).not.toHaveBeenCalled();
  });

  it('rejects an empty freeze frame so the pane falls back to hiding the view', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    const toJPEG = jest.fn(() => Buffer.alloc(0));
    createdViews[0]?.webContents.capturePage.mockResolvedValue({
      isEmpty: () => true,
      toDataURL: () => 'data:image/png;base64,',
      toPNG: () => Buffer.alloc(0),
      toJPEG,
    });

    await expect(
      service.screenshot({ browserId: 'browser-1', purpose: 'freeze-frame' }),
    ).rejects.toThrow('Browser screenshot is unavailable');
    expect(toJPEG).not.toHaveBeenCalled();
  });

  it('reports correlated attempts from concurrent screenshots through the E2E observation callback', async () => {
    const e2eDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__CANOPY_E2E__',
    );
    const callbackKey = '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__';
    const callbackDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      callbackKey,
    );
    const observations: Record<string, unknown>[] = [];
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(globalThis, callbackKey, {
      configurable: true,
      value: (observation: Record<string, unknown>): void => {
        observations.push(observation);
      },
    });
    try {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-1',
      });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-2',
      });
      const emptyImage = {
        isEmpty: (): boolean => true,
        toDataURL: (): string => 'data:image/png;base64,',
        toPNG: jest.fn((): Buffer => Buffer.alloc(0)),
      };
      createdViews[0]?.webContents.capturePage
        .mockResolvedValueOnce(emptyImage)
        .mockResolvedValue({
          isEmpty: () => false,
          toDataURL: () => 'data:image/png;base64,one',
          toPNG: () => Buffer.from('one'),
        });
      createdViews[1]?.webContents.capturePage
        .mockResolvedValueOnce(emptyImage)
        .mockResolvedValue({
          isEmpty: () => false,
          toDataURL: () => 'data:image/png;base64,two',
          toPNG: () => Buffer.from('two'),
        });

      const [first, second] = await Promise.all([
        service.screenshot({ browserId: 'browser-1' }),
        service.screenshot({ browserId: 'browser-2' }),
      ]);

      expect(first.dataUrl).toBe('data:image/png;base64,one');
      expect(second.dataUrl).toBe('data:image/png;base64,two');
      const entered = observations.filter(
        ({ phase }) => phase === 'capture-entered',
      );
      const validation = observations.filter(
        ({ phase }) => phase === 'validation',
      );
      expect(entered).toHaveLength(4);
      expect(validation).toHaveLength(4);
      const sequencesByBrowser = new Map<string, Set<unknown>>();
      for (const row of entered) {
        const browserId = String(row.requestedBrowserId);
        const sequences = sequencesByBrowser.get(browserId) ?? new Set();
        sequences.add(row.requestSequence);
        sequencesByBrowser.set(browserId, sequences);
      }
      expect(sequencesByBrowser.get('browser-1')?.size).toBe(1);
      expect(sequencesByBrowser.get('browser-2')?.size).toBe(1);
      const firstSequence = Array.from(
        sequencesByBrowser.get('browser-1') ?? [],
      )[0];
      const secondSequence = Array.from(
        sequencesByBrowser.get('browser-2') ?? [],
      )[0];
      expect(typeof firstSequence).toBe('number');
      expect(typeof secondSequence).toBe('number');
      expect(firstSequence).not.toBe(secondSequence);
      expect(
        entered.map(
          ({
            requestedBrowserId,
            resolvedBrowserId,
            webContentsId,
            requestSequence,
            attempt,
          }) => ({
            requestedBrowserId,
            resolvedBrowserId,
            webContentsId,
            requestSequence,
            attempt,
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          {
            requestedBrowserId: 'browser-1',
            resolvedBrowserId: 'browser-1',
            webContentsId: 42,
            requestSequence: firstSequence,
            attempt: 1,
          },
          {
            requestedBrowserId: 'browser-1',
            resolvedBrowserId: 'browser-1',
            webContentsId: 42,
            requestSequence: firstSequence,
            attempt: 2,
          },
          {
            requestedBrowserId: 'browser-2',
            resolvedBrowserId: 'browser-2',
            webContentsId: 43,
            requestSequence: secondSequence,
            attempt: 1,
          },
          {
            requestedBrowserId: 'browser-2',
            resolvedBrowserId: 'browser-2',
            webContentsId: 43,
            requestSequence: secondSequence,
            attempt: 2,
          },
        ]),
      );
      expect(
        validation.map(
          ({
            requestedBrowserId,
            webContentsId,
            requestSequence,
            attempt,
            imageEmpty,
            encodingPrefixValid,
            encodingNonempty,
            dataUrlLength,
          }) => ({
            requestedBrowserId,
            webContentsId,
            requestSequence,
            attempt,
            imageEmpty,
            encodingPrefixValid,
            encodingNonempty,
            dataUrlLength,
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          {
            requestedBrowserId: 'browser-1',
            webContentsId: 42,
            requestSequence: firstSequence,
            attempt: 1,
            imageEmpty: true,
            encodingPrefixValid: 'not-evaluated',
            encodingNonempty: 'not-evaluated',
            dataUrlLength: undefined,
          },
          {
            requestedBrowserId: 'browser-1',
            webContentsId: 42,
            requestSequence: firstSequence,
            attempt: 2,
            imageEmpty: false,
            encodingPrefixValid: true,
            encodingNonempty: true,
            dataUrlLength: 'data:image/png;base64,one'.length,
          },
          {
            requestedBrowserId: 'browser-2',
            webContentsId: 43,
            requestSequence: secondSequence,
            attempt: 1,
            imageEmpty: true,
            encodingPrefixValid: 'not-evaluated',
            encodingNonempty: 'not-evaluated',
            dataUrlLength: undefined,
          },
          {
            requestedBrowserId: 'browser-2',
            webContentsId: 43,
            requestSequence: secondSequence,
            attempt: 2,
            imageEmpty: false,
            encodingPrefixValid: true,
            encodingNonempty: true,
            dataUrlLength: 'data:image/png;base64,two'.length,
          },
        ]),
      );
      expect(
        observations.flatMap((row) =>
          Object.keys(row).filter((key) => key.toLowerCase().includes('png')),
        ),
      ).toEqual([]);
      for (const row of validation.filter(({ attempt }) => attempt === 1)) {
        expect(Object.prototype.hasOwnProperty.call(row, 'dataUrlLength')).toBe(
          false,
        );
      }
      expect(emptyImage.toPNG).not.toHaveBeenCalled();
    } finally {
      if (callbackDescriptor) {
        Object.defineProperty(globalThis, callbackKey, callbackDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, callbackKey);
      }
      if (e2eDescriptor) {
        Object.defineProperty(globalThis, '__CANOPY_E2E__', e2eDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      }
    }
  });

  it('samples passive native screenshot geometry independently at capture entry and return', async () => {
    const observations: Record<string, unknown>[] = [];
    await withScreenshotObservationGlobals(
      true,
      (observation) => observations.push(observation),
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const browserId = 'browser-native-geometry';
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId,
        });
        const state = (
          service as unknown as {
            sessions: Map<
              string,
              {
                view: Record<string, unknown> & {
                  webContents: MockWebContents;
                  setBounds: jest.Mock;
                  setVisible: jest.Mock;
                };
                hostWindow: unknown;
              }
            >;
          }
        ).sessions.get(browserId);
        if (!state) throw new Error('Expected a live browser session.');
        const contents = state.view.webContents;
        let viewBounds = { x: 10, y: 20, width: 300, height: 200 };
        let viewVisible = true;
        let hostBounds = { x: 100, y: 200, width: 900, height: 700 };
        let hostContentBounds = { x: 108, y: 231, width: 884, height: 661 };
        let contentViewBounds = { x: 0, y: 0, width: 884, height: 661 };
        let contentViewVisible = true;
        const viewGetBounds = jest.fn(() => viewBounds);
        const viewGetVisible = jest.fn(() => viewVisible);
        // The page's window placement is its frame's.
        const { frame } = pageFrameOf(state.view);
        Object.defineProperties(frame, {
          getBounds: { configurable: true, value: viewGetBounds },
        });
        Object.defineProperties(state.view, {
          getVisible: { configurable: true, value: viewGetVisible },
        });
        const children = [Object.freeze({ unrelated: true }), frame];
        const host = {
          id: 77,
          isDestroyed: jest.fn(() => false),
          isVisible: jest.fn(() => true),
          isMinimized: jest.fn(() => false),
          getBounds: jest.fn(() => hostBounds),
          getContentBounds: jest.fn(() => hostContentBounds),
          contentView: {
            getBounds: jest.fn(() => contentViewBounds),
            getVisible: jest.fn(() => contentViewVisible),
            get children(): unknown[] {
              return children;
            },
          },
          webContents: { focus: jest.fn() },
        };
        state.hostWindow = host;
        state.view.setBounds.mockClear();
        state.view.setVisible.mockClear();
        contents.invalidate.mockClear();
        const clock = jest.spyOn(process.hrtime, 'bigint');
        let resolveCapture!: (value: {
          isEmpty: () => boolean;
          toDataURL: () => string;
          toPNG: () => Buffer;
        }) => void;
        contents.capturePage.mockReturnValue(
          new Promise((resolve) => {
            resolveCapture = resolve;
          }),
        );

        try {
          const pending = service.screenshot({ browserId });
          const entered = observations.filter(
            ({ phase }) => phase === 'capture-entered',
          );
          expect(entered).toHaveLength(1);
          expect(entered[0]).toMatchObject({
            viewBounds,
            viewVisible: true,
            webContentsDestroyed: false,
            hostDestroyed: false,
            hostVisible: true,
            hostMinimized: false,
            hostBounds,
            hostContentBounds,
            contentViewBounds,
            contentViewVisible: true,
            directChildCount: 2,
            directChildInspectedCount: 2,
            directChildMembership: 'present',
            directChildOverflow: false,
          });
          expect(entered[0]).not.toHaveProperty('nativeGeometryUnavailable');

          viewBounds = { x: 15, y: 25, width: 280, height: 180 };
          viewVisible = false;
          hostBounds = { x: 110, y: 210, width: 880, height: 680 };
          hostContentBounds = { x: 118, y: 241, width: 864, height: 641 };
          contentViewBounds = { x: 0, y: 0, width: 864, height: 641 };
          contentViewVisible = false;
          resolveCapture({
            isEmpty: () => false,
            toDataURL: () => 'data:image/png;base64,native-geometry',
            toPNG: () => Buffer.from('native-geometry'),
          });
          await expect(pending).resolves.toEqual({
            dataUrl: 'data:image/png;base64,native-geometry',
          });
          const returned = observations.filter(
            ({ phase }) => phase === 'capture-returned',
          );
          expect(returned).toHaveLength(1);
          expect(returned[0]).toMatchObject({
            viewBounds,
            viewVisible: false,
            hostBounds,
            hostContentBounds,
            contentViewBounds,
            contentViewVisible: false,
            directChildMembership: 'present',
          });
          expect(viewGetBounds).toHaveBeenCalledTimes(2);
          expect(viewGetVisible).toHaveBeenCalledTimes(2);
          expect(contents.capturePage).toHaveBeenCalledTimes(1);
          expect(contents.invalidate).not.toHaveBeenCalled();
          expect(state.view.setBounds).not.toHaveBeenCalled();
          expect(state.view.setVisible).not.toHaveBeenCalled();
          expect(clock).toHaveBeenCalledTimes(3);
        } finally {
          clock.mockRestore();
        }
      },
    );
  });

  it('reports absent, overflow, and unavailable native screenshot geometry without changing capture results', async () => {
    const scenarios = [
      {
        name: 'absent',
        children: (): unknown[] => [],
        expected: {
          directChildCount: 0,
          directChildInspectedCount: 0,
          directChildMembership: 'absent',
          directChildOverflow: false,
        },
      },
      {
        name: 'overflow',
        children: (): unknown[] =>
          Array.from({ length: 33 }, (_, index) => ({ index })),
        expected: {
          directChildCount: 33,
          directChildInspectedCount: 32,
          directChildMembership: 'unknown-overflow',
          directChildOverflow: true,
        },
      },
    ];
    for (const scenario of scenarios) {
      const observations: Record<string, unknown>[] = [];
      await withScreenshotObservationGlobals(
        true,
        (observation) => observations.push(observation),
        async () => {
          const service = new BrowserService({ getWindow: mockWindow });
          const browserId = `browser-native-geometry-${scenario.name}`;
          await service.create({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId,
          });
          const state = (
            service as unknown as {
              sessions: Map<
                string,
                { view: Record<string, unknown>; hostWindow: unknown }
              >;
            }
          ).sessions.get(browserId);
          if (!state) throw new Error('Expected a live browser session.');
          Object.defineProperties(pageFrameOf(state.view).frame, {
            getBounds: {
              configurable: true,
              value: jest.fn(() => ({ x: 1, y: 2, width: 3, height: 4 })),
            },
          });
          Object.defineProperties(state.view, {
            getVisible: { configurable: true, value: jest.fn(() => true) },
          });
          state.hostWindow = {
            id: 88,
            isDestroyed: jest.fn(() => false),
            isVisible: jest.fn(() => true),
            isMinimized: jest.fn(() => false),
            getBounds: jest.fn(() => ({ x: 5, y: 6, width: 700, height: 500 })),
            getContentBounds: jest.fn(() => ({
              x: 10,
              y: 20,
              width: 680,
              height: 460,
            })),
            contentView: {
              getBounds: jest.fn(() => ({
                x: 0,
                y: 0,
                width: 680,
                height: 460,
              })),
              getVisible: jest.fn(() => true),
              get children(): unknown[] {
                return scenario.children();
              },
            },
          };
          await expect(service.screenshot({ browserId })).resolves.toEqual({
            dataUrl: 'data:image/png;base64,abc',
          });
          expect(
            observations.find(({ phase }) => phase === 'capture-entered'),
          ).toMatchObject(scenario.expected);
        },
      );
    }

    const observations: Record<string, unknown>[] = [];
    await withScreenshotObservationGlobals(
      true,
      (observation) => observations.push(observation),
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const browserId = 'browser-native-geometry-unavailable';
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId,
        });
        const state = (
          service as unknown as {
            sessions: Map<
              string,
              { view: Record<string, unknown>; hostWindow: unknown }
            >;
          }
        ).sessions.get(browserId);
        if (!state) throw new Error('Expected a live browser session.');
        const unavailable = (): never => {
          throw new Error('native getter unavailable');
        };
        Object.defineProperties(state.view, {
          getBounds: { configurable: true, value: jest.fn(unavailable) },
          getVisible: { configurable: true, value: jest.fn(() => 'yes') },
        });
        state.hostWindow = {
          id: 99,
          isDestroyed: jest.fn(unavailable),
          isVisible: jest.fn(unavailable),
          isMinimized: jest.fn(() => 'no'),
          getBounds: jest.fn(() => ({
            x: 0,
            y: 0,
            width: Number.NaN,
            height: 1,
          })),
          getContentBounds: jest.fn(unavailable),
          contentView: {
            getBounds: jest.fn(unavailable),
            getVisible: jest.fn(() => 1),
            get children(): never {
              return unavailable();
            },
          },
        };
        await expect(service.screenshot({ browserId })).resolves.toEqual({
          dataUrl: 'data:image/png;base64,abc',
        });
        const entered = observations.find(
          ({ phase }) => phase === 'capture-entered',
        );
        expect(entered).toMatchObject({
          viewBounds: null,
          viewVisible: null,
          hostDestroyed: null,
          hostVisible: null,
          hostMinimized: null,
          hostBounds: null,
          hostContentBounds: null,
          contentViewBounds: null,
          contentViewVisible: null,
          directChildCount: null,
          directChildInspectedCount: null,
          directChildMembership: 'unavailable',
          directChildOverflow: null,
        });
        expect(entered?.nativeGeometryUnavailable).toBe(
          'view-bounds,view-visible,host-destroyed,host-visible,host-minimized,host-bounds,host-content-bounds,content-view-bounds,content-view-visible,direct-children',
        );
      },
    );
  });

  it('skips readable host dependents when host destruction is true or unknown', async () => {
    const unavailable = (): never => {
      throw new Error('host destruction unavailable');
    };
    const scenarios = [
      {
        name: 'destroyed',
        readDestroyed: (): unknown => true,
        hostDestroyed: true,
        unavailable:
          'host-visible,host-minimized,host-bounds,host-content-bounds,content-view-bounds,content-view-visible,direct-children',
      },
      {
        name: 'thrown-destruction',
        readDestroyed: (): unknown => unavailable(),
        hostDestroyed: null,
        unavailable:
          'host-destroyed,host-visible,host-minimized,host-bounds,host-content-bounds,content-view-bounds,content-view-visible,direct-children',
      },
      {
        name: 'invalid-destruction',
        readDestroyed: (): unknown => 'no',
        hostDestroyed: null,
        unavailable:
          'host-destroyed,host-visible,host-minimized,host-bounds,host-content-bounds,content-view-bounds,content-view-visible,direct-children',
      },
    ];

    for (const scenario of scenarios) {
      const observations: Record<string, unknown>[] = [];
      await withScreenshotObservationGlobals(
        true,
        (observation) => observations.push(observation),
        async () => {
          const service = new BrowserService({ getWindow: mockWindow });
          const browserId = `browser-native-geometry-${scenario.name}`;
          await service.create({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId,
          });
          const state = (
            service as unknown as {
              sessions: Map<
                string,
                { view: Record<string, unknown>; hostWindow: unknown }
              >;
            }
          ).sessions.get(browserId);
          if (!state) throw new Error('Expected a live browser session.');
          Object.defineProperties(pageFrameOf(state.view).frame, {
            getBounds: {
              configurable: true,
              value: jest.fn(() => ({ x: 1, y: 2, width: 3, height: 4 })),
            },
          });
          Object.defineProperties(state.view, {
            getVisible: { configurable: true, value: jest.fn(() => true) },
          });
          const dependent = jest.fn(() => false);
          const contentView = {
            getBounds: jest.fn(() => ({ x: 0, y: 0, width: 680, height: 460 })),
            getVisible: jest.fn(() => true),
            get children(): unknown[] {
              dependent();
              return [state.view];
            },
          };
          const readContentView = jest.fn(() => contentView);
          const host = {
            id: 101,
            isDestroyed: jest.fn(scenario.readDestroyed),
            isVisible: dependent,
            isMinimized: dependent,
            getBounds: dependent,
            getContentBounds: dependent,
          };
          Object.defineProperty(host, 'contentView', {
            configurable: true,
            get: readContentView,
          });
          state.hostWindow = host;

          await expect(service.screenshot({ browserId })).resolves.toEqual({
            dataUrl: 'data:image/png;base64,abc',
          });
          for (const phase of ['capture-entered', 'capture-returned']) {
            expect(
              observations.find((row) => row.phase === phase),
            ).toMatchObject({
              hostDestroyed: scenario.hostDestroyed,
              hostVisible: null,
              hostMinimized: null,
              hostBounds: null,
              hostContentBounds: null,
              contentViewBounds: null,
              contentViewVisible: null,
              directChildCount: null,
              directChildInspectedCount: null,
              directChildMembership: 'unavailable',
              directChildOverflow: null,
              nativeGeometryUnavailable: scenario.unavailable,
            });
          }
          const browserContents = state.view.webContents;
          if (!(browserContents instanceof MockWebContents))
            throw new Error('Expected the browser view web contents.');
          expect(browserContents.capturePage).toHaveBeenCalledTimes(1);
          expect(host.isDestroyed).toHaveBeenCalledTimes(2);
          expect(dependent).not.toHaveBeenCalled();
          expect(readContentView).not.toHaveBeenCalled();
        },
      );
    }
  });

  it('keeps screenshot validation order and short circuits unchanged when the observer throws', async () => {
    const run = (enabled: boolean): Promise<string[]> => {
      const operations: string[] = [];
      return Promise.resolve(
        withScreenshotObservationGlobals(
          enabled,
          () => {
            throw new Error('observer failure');
          },
          async () => {
            const service = new BrowserService({ getWindow: mockWindow });
            const browserId = enabled ? 'browser-active' : 'browser-inactive';
            await service.create({
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              browserId,
            });
            const contents = createdViews[createdViews.length - 1]?.webContents;
            if (!contents) throw new Error('Expected a browser view.');
            const encoded = {
              startsWith: (): boolean => {
                operations.push('startsWith');
                return false;
              },
              get length(): number {
                operations.push('length');
                throw new Error('length must remain short-circuited');
              },
            } as unknown as string;
            contents.capturePage.mockImplementation(() => {
              operations.push('capturePage');
              return Promise.resolve({
                toDataURL: (): string => {
                  operations.push('toDataURL');
                  return encoded;
                },
                toPNG: (): Buffer => {
                  operations.push('toPNG');
                  throw new Error('no PNG on the no-attachment path');
                },
                isEmpty: (): boolean => {
                  operations.push('isEmpty');
                  return false;
                },
              });
            });
            contents.invalidate.mockImplementation((): void => {
              operations.push('invalidate');
            });
            await expect(service.screenshot({ browserId })).rejects.toThrow(
              'Browser screenshot is unavailable',
            );
            return operations;
          },
        ),
      );
    };

    const inactive = await run(false);
    const active = await run(true);
    const expected = [
      'capturePage',
      'toDataURL',
      'isEmpty',
      'startsWith',
      'invalidate',
      'capturePage',
      'toDataURL',
      'isEmpty',
      'startsWith',
      'invalidate',
      'capturePage',
      'toDataURL',
      'isEmpty',
      'startsWith',
    ];
    expect(inactive).toEqual(expected);
    expect(active).toEqual(expected);
    expect(active).not.toContain('length');
    expect(active).not.toContain('toPNG');

    const runCompletePath = (
      enabled: boolean,
      kind: 'empty' | 'success' | 'saved',
    ): Promise<string[]> => {
      const operations: string[] = [];
      return Promise.resolve(
        withScreenshotObservationGlobals(
          enabled,
          () => {
            throw new Error('observer failure');
          },
          async () => {
            const service = new BrowserService({ getWindow: mockWindow });
            const browserId = `browser-${kind}-${enabled}`;
            await service.create({
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              browserId,
            });
            const contents = createdViews[createdViews.length - 1]?.webContents;
            if (!contents) throw new Error('Expected a browser view.');
            const encoded = {
              startsWith: (prefix: string): boolean => {
                operations.push('startsWith');
                return prefix === 'data:image/png;base64,';
              },
              get length(): number {
                operations.push('length');
                return 'data:image/png;base64,valid'.length;
              },
            } as unknown as string;
            const png = {
              get byteLength(): number {
                operations.push('pngByteLength');
                return 3;
              },
            } as Buffer;
            contents.capturePage.mockImplementation(() => {
              operations.push('capturePage');
              return Promise.resolve({
                toDataURL: (): string => {
                  operations.push('toDataURL');
                  return encoded;
                },
                toPNG: (): Buffer => {
                  operations.push('toPNG');
                  return png;
                },
                isEmpty: (): boolean => {
                  operations.push('isEmpty');
                  return kind === 'empty';
                },
              });
            });
            contents.invalidate.mockImplementation((): void => {
              operations.push('invalidate');
            });
            const request = {
              browserId,
              ...(kind === 'saved' ? { saveToAttachments: true } : {}),
            };
            if (kind === 'empty') {
              await expect(service.screenshot(request)).rejects.toThrow(
                'Browser screenshot is unavailable',
              );
            } else {
              const result = await service.screenshot(request);
              expect(result.dataUrl).toBe(encoded);
              if (kind === 'saved') {
                expect(typeof result.attachmentPath).toBe('string');
              } else {
                expect(result).toEqual({ dataUrl: encoded });
              }
            }
            return operations;
          },
        ),
      );
    };

    const emptyExpected = [
      'capturePage',
      'toDataURL',
      'isEmpty',
      'invalidate',
      'capturePage',
      'toDataURL',
      'isEmpty',
      'invalidate',
      'capturePage',
      'toDataURL',
      'isEmpty',
    ];
    const successExpected = [
      'capturePage',
      'toDataURL',
      'isEmpty',
      'startsWith',
      'length',
    ];
    const savedExpected = [
      'capturePage',
      'toDataURL',
      'toPNG',
      'isEmpty',
      'startsWith',
      'length',
      'pngByteLength',
    ];
    for (const enabled of [false, true]) {
      expect(await runCompletePath(enabled, 'empty')).toEqual(emptyExpected);
      expect(await runCompletePath(enabled, 'success')).toEqual(
        successExpected,
      );
      expect(await runCompletePath(enabled, 'saved')).toEqual(savedExpected);
    }
  });

  it('preserves original thrown values at every observed screenshot operation', async () => {
    const scenarios: Array<{
      name: string;
      saveToAttachments?: boolean;
      configure: (contents: MockWebContents, sentinel: Error) => void;
    }> = [
      {
        name: 'capture-page',
        configure: (contents, sentinel): void => {
          contents.capturePage.mockRejectedValueOnce(sentinel);
        },
      },
      {
        name: 'to-data-url',
        configure: (contents, sentinel): void => {
          contents.capturePage.mockResolvedValueOnce({
            toDataURL: (): string => {
              throw sentinel;
            },
            toPNG: () => Buffer.from('png'),
            isEmpty: () => false,
          });
        },
      },
      {
        name: 'to-png',
        saveToAttachments: true,
        configure: (contents, sentinel): void => {
          contents.capturePage.mockResolvedValueOnce({
            toDataURL: () => 'data:image/png;base64,valid',
            toPNG: (): Buffer => {
              throw sentinel;
            },
            isEmpty: () => false,
          });
        },
      },
      {
        name: 'is-empty',
        configure: (contents, sentinel): void => {
          contents.capturePage.mockResolvedValueOnce({
            toDataURL: () => 'data:image/png;base64,valid',
            toPNG: () => Buffer.from('png'),
            isEmpty: (): boolean => {
              throw sentinel;
            },
          });
        },
      },
      {
        name: 'invalidate',
        configure: (contents, sentinel): void => {
          contents.capturePage.mockResolvedValue({
            toDataURL: () => 'invalid',
            toPNG: () => Buffer.from('png'),
            isEmpty: () => false,
          });
          contents.invalidate.mockImplementationOnce((): void => {
            throw sentinel;
          });
        },
      },
    ];

    await withScreenshotObservationGlobals(
      true,
      () => {
        throw new Error('observer failure');
      },
      async () => {
        for (const scenario of scenarios) {
          const service = new BrowserService({ getWindow: mockWindow });
          const browserId = `browser-${scenario.name}`;
          await service.create({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId,
          });
          const contents = createdViews[createdViews.length - 1]?.webContents;
          if (!contents) throw new Error('Expected a browser view.');
          const sentinel = new Error(scenario.name);
          scenario.configure(contents, sentinel);
          let caught: unknown;
          try {
            await service.screenshot({
              browserId,
              ...(scenario.saveToAttachments
                ? { saveToAttachments: true }
                : {}),
            });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(sentinel);
        }
      },
    );
  });

  it('never invokes a screenshot callback accessor or inactive clocks and descriptors', async () => {
    const callbackKey = '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__';
    const e2eDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__CANOPY_E2E__',
    );
    const callbackDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      callbackKey,
    );
    let callbackGetterCalls = 0;
    Object.defineProperty(globalThis, callbackKey, {
      configurable: true,
      get: () => {
        callbackGetterCalls++;
        throw new Error('callback accessor must not run');
      },
    });
    const descriptorSpy = jest.spyOn(Object, 'getOwnPropertyDescriptor');
    const clockSpy = jest.spyOn(process.hrtime, 'bigint');
    try {
      for (const enabled of [true, false]) {
        Object.defineProperty(globalThis, '__CANOPY_E2E__', {
          configurable: true,
          value: enabled,
        });
        descriptorSpy.mockClear();
        clockSpy.mockClear();
        const service = new BrowserService({ getWindow: mockWindow });
        const browserId = `browser-accessor-${enabled}`;
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId,
        });
        await expect(service.screenshot({ browserId })).resolves.toEqual({
          dataUrl: 'data:image/png;base64,abc',
        });
        expect(callbackGetterCalls).toBe(0);
        expect(clockSpy).not.toHaveBeenCalled();
        const callbackDescriptorReads = descriptorSpy.mock.calls.filter(
          ([target, key]) => target === globalThis && key === callbackKey,
        );
        expect(callbackDescriptorReads).toHaveLength(enabled ? 1 : 0);
      }
    } finally {
      descriptorSpy.mockRestore();
      clockSpy.mockRestore();
      if (callbackDescriptor) {
        Object.defineProperty(globalThis, callbackKey, callbackDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, callbackKey);
      }
      if (e2eDescriptor) {
        Object.defineProperty(globalThis, '__CANOPY_E2E__', e2eDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      }
    }
  });

  it('does not evaluate projection fields when the callback is absent or the E2E gate is false', async () => {
    const callbackKey = '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__';
    const e2eDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      '__CANOPY_E2E__',
    );
    const callbackDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      callbackKey,
    );
    let callbackCalls = 0;
    let idReads = 0;
    let boundsReads = 0;
    try {
      for (const callbackState of ['absent', 'false-gate'] as const) {
        Object.defineProperty(globalThis, '__CANOPY_E2E__', {
          configurable: true,
          value: callbackState === 'absent',
        });
        if (callbackState === 'absent') {
          Reflect.deleteProperty(globalThis, callbackKey);
        } else {
          Object.defineProperty(globalThis, callbackKey, {
            configurable: true,
            value: (): void => {
              callbackCalls++;
            },
          });
        }
        const service = new BrowserService({ getWindow: mockWindow });
        const browserId = `browser-projection-${callbackState}`;
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId,
        });
        const contents = createdViews[createdViews.length - 1]?.webContents;
        if (!contents) throw new Error('Expected a browser view.');
        const state = (
          service as unknown as {
            sessions: Map<
              string,
              {
                bounds: ElectronTypes.Rectangle;
                view: Record<string, unknown>;
                hostWindow: unknown;
              }
            >;
          }
        ).sessions.get(browserId);
        if (!state) throw new Error('Expected a live browser session.');
        const originalId = contents.id;
        const originalBounds = state.bounds;
        let nativeGeometryReads = 0;
        const forbiddenNativeRead = (): never => {
          nativeGeometryReads++;
          throw new Error('inactive native geometry getter must not run');
        };
        Object.defineProperties(state.view, {
          getBounds: { configurable: true, value: forbiddenNativeRead },
          getVisible: { configurable: true, value: forbiddenNativeRead },
        });
        state.hostWindow = {
          id: 100,
          isDestroyed: forbiddenNativeRead,
          isVisible: forbiddenNativeRead,
          isMinimized: forbiddenNativeRead,
          getBounds: forbiddenNativeRead,
          getContentBounds: forbiddenNativeRead,
          contentView: {
            getBounds: forbiddenNativeRead,
            getVisible: forbiddenNativeRead,
            get children(): never {
              return forbiddenNativeRead();
            },
          },
        };
        Object.defineProperty(contents, 'id', {
          configurable: true,
          get: () => {
            idReads++;
            throw new Error('projection-only ID must not be read');
          },
        });
        Object.defineProperty(state, 'bounds', {
          configurable: true,
          get: () => {
            boundsReads++;
            throw new Error('projection-only bounds must not be read');
          },
        });
        try {
          await expect(service.screenshot({ browserId })).resolves.toEqual({
            dataUrl: 'data:image/png;base64,abc',
          });
          expect(nativeGeometryReads).toBe(0);
        } finally {
          Object.defineProperty(contents, 'id', {
            configurable: true,
            writable: true,
            value: originalId,
          });
          Object.defineProperty(state, 'bounds', {
            configurable: true,
            writable: true,
            value: originalBounds,
          });
        }
      }
      expect(callbackCalls).toBe(0);
      expect(idReads).toBe(0);
      expect(boundsReads).toBe(0);
    } finally {
      if (callbackDescriptor) {
        Object.defineProperty(globalThis, callbackKey, callbackDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, callbackKey);
      }
      if (e2eDescriptor) {
        Object.defineProperty(globalThis, '__CANOPY_E2E__', e2eDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
      }
    }
  });

  it('contains throwing projection-only native IDs without changing capture', async () => {
    const observations: Record<string, unknown>[] = [];
    await withScreenshotObservationGlobals(
      true,
      (observation) => observations.push(observation),
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'browser-projection',
        });
        const contents = createdViews[createdViews.length - 1]?.webContents;
        if (!contents) throw new Error('Expected a browser view.');
        const originalId = contents.id;
        Object.defineProperty(contents, 'id', {
          configurable: true,
          get: () => {
            throw new Error('projection unavailable');
          },
        });
        try {
          await expect(
            service.screenshot({ browserId: 'browser-projection' }),
          ).resolves.toEqual({ dataUrl: 'data:image/png;base64,abc' });
        } finally {
          Object.defineProperty(contents, 'id', {
            configurable: true,
            writable: true,
            value: originalId,
          });
        }
      },
    );
    expect(observations.length).toBeGreaterThan(0);
    expect(
      observations.some(
        ({ webContentsId, projectionUnavailable }) =>
          webContentsId === null &&
          typeof projectionUnavailable === 'string' &&
          projectionUnavailable.includes('web-contents-id'),
      ),
    ).toBe(true);
  });

  it('repaints and retries transient empty screenshots on each exact requested browser view', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    const emptyImage = {
      isEmpty: (): boolean => true,
      toDataURL: (): string => 'data:image/png;base64,',
      toPNG: jest.fn((): Buffer => Buffer.alloc(0)),
    };
    const firstContents = createdViews[0]?.webContents;
    const secondContents = createdViews[1]?.webContents;
    if (!firstContents || !secondContents) {
      throw new Error('Expected two browser views.');
    }
    const firstPng = jest.fn(() => Buffer.from('one'));
    const secondPng = jest.fn(() => Buffer.from('two'));
    firstContents.capturePage
      .mockResolvedValueOnce(emptyImage)
      .mockResolvedValue({
        isEmpty: () => false,
        toDataURL: () => 'data:image/png;base64,one',
        toPNG: firstPng,
      });
    secondContents.capturePage
      .mockResolvedValueOnce(emptyImage)
      .mockResolvedValue({
        isEmpty: () => false,
        toDataURL: () => 'data:image/png;base64,two',
        toPNG: secondPng,
      });

    const [first, second] = await Promise.all([
      service.screenshot({ browserId: 'browser-1' }),
      service.screenshot({ browserId: 'browser-2' }),
    ]);

    expect(first.dataUrl).toBe('data:image/png;base64,one');
    expect(second.dataUrl).toBe('data:image/png;base64,two');
    expect(firstContents.capturePage).toHaveBeenCalledTimes(2);
    expect(secondContents.capturePage).toHaveBeenCalledTimes(2);
    expect(firstContents.capturePage.mock.calls).toEqual([[], []]);
    expect(secondContents.capturePage.mock.calls).toEqual([[], []]);
    expect(firstContents.invalidate).toHaveBeenCalledTimes(1);
    expect(secondContents.invalidate).toHaveBeenCalledTimes(1);
    expect(emptyImage.toPNG).not.toHaveBeenCalled();
    expect(firstPng).not.toHaveBeenCalled();
    expect(secondPng).not.toHaveBeenCalled();
  });

  it('rejects a persistently empty saved screenshot before writing an attachment', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-empty',
    });
    webContents.capturePage.mockResolvedValue({
      isEmpty: () => true,
      toDataURL: () => 'data:image/png;base64,',
      toPNG: () => Buffer.alloc(0),
    });
    const mockedFs = jest.requireMock<{ writeFile: jest.Mock }>(
      'node:fs/promises',
    );
    mockedFs.writeFile.mockClear();

    await expect(
      service.screenshot({
        browserId: 'browser-empty',
        saveToAttachments: true,
      }),
    ).rejects.toThrow('Browser screenshot is unavailable');
    expect(webContents.capturePage).toHaveBeenCalledTimes(3);
    expect(webContents.capturePage.mock.calls).toEqual([[], [], []]);
    expect(webContents.invalidate).toHaveBeenCalledTimes(2);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
  });

  it('fails a late screenshot closed when its exact browser is destroyed', async () => {
    const observations: Record<string, unknown>[] = [];
    const observerFailure = new Error('observer failure');
    await withScreenshotObservationGlobals(
      true,
      (observation) => {
        observations.push(observation);
        throw observerFailure;
      },
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'browser-race',
        });
        const assertionTarget = service as unknown as {
          assertCurrentLiveSession: (state: unknown) => void;
        };
        const originalAssertion =
          assertionTarget.assertCurrentLiveSession.bind(service);
        let originalRetirementError: unknown;
        jest
          .spyOn(assertionTarget, 'assertCurrentLiveSession')
          .mockImplementation((state) => {
            try {
              originalAssertion(state);
            } catch (error) {
              originalRetirementError = error;
              throw error;
            }
          });
        let resolveCapture!: (image: {
          isEmpty: () => boolean;
          toDataURL: () => string;
          toPNG: () => Buffer;
        }) => void;
        webContents.capturePage.mockReturnValueOnce(
          new Promise((resolve) => {
            resolveCapture = resolve;
          }),
        );
        const laterMethodFailure = new Error(
          'retired capture must not inspect the image',
        );
        const isEmpty = jest.fn((): boolean => {
          throw laterMethodFailure;
        });
        const toDataURL = jest.fn((): string => {
          throw laterMethodFailure;
        });
        const toPNG = jest.fn((): Buffer => {
          throw laterMethodFailure;
        });

        const capture = service.screenshot({ browserId: 'browser-race' });
        await service.destroy('browser-race');
        resolveCapture({ isEmpty, toDataURL, toPNG });
        let caught: unknown;
        try {
          await capture;
        } catch (error) {
          caught = error;
        }

        expect(caught).toBe(originalRetirementError);
        expect(caught).not.toBe(observerFailure);
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain('no longer available');
        expect(isEmpty).not.toHaveBeenCalled();
        expect(toDataURL).not.toHaveBeenCalled();
        expect(toPNG).not.toHaveBeenCalled();
      },
    );
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'operation-threw',
          operation: 'post-capture-live-session-assertion',
          outcome: 'threw',
        }),
      ]),
    );
  });

  it('fails a valid screenshot retired after helper validation before public return', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-post-helper-race',
    });
    let retirement: Promise<void> | undefined;
    webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false,
      toDataURL: () => {
        queueMicrotask(() => {
          retirement = service.destroy('browser-post-helper-race');
        });
        return 'data:image/png;base64,valid';
      },
      toPNG: () => Buffer.from('valid'),
    });

    await expect(
      service.screenshot({ browserId: 'browser-post-helper-race' }),
    ).rejects.toThrow('no longer available');
    await retirement;
  });

  it('opens window.open in a new tab and leaves every existing tab in place', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
    });
    const firstView = createdViews[0];
    const secondView = createdViews[1];
    if (!firstView || !secondView) {
      throw new Error('Expected two browser views.');
    }
    const firstContents = firstView.webContents;
    const secondContents = secondView.webContents;
    const handler = firstContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (!handler) throw new Error('Expected a window.open handler.');
    firstContents.loadURL.mockClear();
    secondContents.loadURL.mockClear();
    jest.mocked(sendToWindow).mockClear();

    // CAN-4831: a target="_blank" link must not replace the opener's page.
    expect(handler({ url: 'http://localhost/from-popup' })).toEqual({
      action: 'deny',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(firstContents.loadURL).not.toHaveBeenCalled();
    expect(secondContents.loadURL).not.toHaveBeenCalled();
    const requests = jest
      .mocked(sendToWindow)
      .mock.calls.map((call) => call[2])
      .filter(
        (event) => isCDPRecord(event) && event.type === 'new-tab-requested',
      );
    expect(requests).toMatchObject([
      {
        browserId: 'browser-1',
        url: 'http://localhost/from-popup',
        snapshot: { projectId: 'project-1', worktreeId: 'worktree-1' },
      },
    ]);
    const [request] = requests;
    if (!isCDPRecord(request)) throw new Error('Missing new tab request.');
    expect(typeof request.newBrowserId).toBe('string');
    expect(request.newBrowserId).not.toBe('browser-1');
  });

  it.each([
    ['a user', undefined, 'user'],
    ['an agent action', 'click-1', 'agent'],
  ] as const)(
    'creates a popup tab from %s in the opener profile, also on Retry, as its actor',
    async (_case, actionId, actor) => {
      const authority = getBrowserProfileService();
      const service = new BrowserService({
        getWindow: mockWindow,
        profileAuthority: authority,
      });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'popup-opener',
      });
      const handler =
        createdViews[0]?.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
      if (!handler) throw new Error('Expected a window.open handler.');
      jest.spyOn(service.taskFiles, 'attributionFor').mockReturnValue(actionId);
      jest.mocked(sendToWindow).mockClear();
      handler({ url: 'https://example.com/' });
      const request = jest
        .mocked(sendToWindow)
        .mock.calls.map((call) => call[2])
        .find(
          (event) => isCDPRecord(event) && event.type === 'new-tab-requested',
        );
      if (!isCDPRecord(request) || typeof request.newBrowserId !== 'string')
        throw new Error('Missing new tab request.');
      // An agent's popup opens behind the user's tab.
      expect(request.presentation).toBe(
        actor === 'agent' ? 'background' : undefined,
      );
      const opener = service
        .listWorktreeBrowsers('project-1', 'worktree-1')
        .find((browser) => browser.id === 'popup-opener');
      const resolve = jest
        .spyOn(authority, 'resolve')
        .mockRejectedValueOnce(new Error('first create failed'));
      const create = (): Promise<BrowserSessionSnapshot> =>
        service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId:
            typeof request.newBrowserId === 'string'
              ? request.newBrowserId
              : undefined,
          url: 'https://example.com/',
        });

      await expect(create()).rejects.toThrow('first create failed');
      await create();

      // Retry keeps the opener's profile, and an agent's tab must be allowed
      // by that profile (its allowEnable permission).
      expect(resolve.mock.calls.map((call) => call[3])).toEqual([
        { selection: opener?.profile?.selection, actor },
        { selection: opener?.profile?.selection, actor },
      ]);
      expect(opener?.profile?.selection).toEqual({ kind: 'task' });
      await service.shutdown();
    },
  );

  it('opens local window.open targets of a local-file browser in a new tab', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-file-popup',
      url: 'file:///tmp/site/index.html',
    });
    const view = createdViews[0];
    if (!view) throw new Error('Expected a browser view.');
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (!handler) throw new Error('Expected a window.open handler.');
    view.webContents.loadURL.mockClear();
    jest.mocked(sendToWindow).mockClear();

    expect(
      handler({
        url: 'file:///tmp/site/neighbour.html',
        referrer: { url: 'file:///tmp/site/index.html' },
      }),
    ).toEqual({ action: 'deny' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(view.webContents.loadURL).not.toHaveBeenCalled();
    expect(jest.mocked(sendToWindow).mock.calls.map((call) => call[2])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'new-tab-requested',
          url: 'file:///tmp/site/neighbour.html',
        }),
      ]),
    );
  });

  it('keeps window.open navigation in a sign-in view, which has no tabs', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'app-oauth',
      worktreeId: 'mcp',
      browserId: 'browser-sign-in-popup',
    });
    const view = createdViews[0];
    if (!view) throw new Error('Expected a browser view.');
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (!handler) throw new Error('Expected a window.open handler.');
    view.webContents.loadURL.mockClear();
    jest.mocked(sendToWindow).mockClear();

    expect(handler({ url: 'https://example.com/consent' })).toEqual({
      action: 'deny',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'https://example.com/consent',
    );
    expect(
      jest
        .mocked(sendToWindow)
        .mock.calls.some(
          (call) =>
            isCDPRecord(call[2]) && call[2].type === 'new-tab-requested',
        ),
    ).toBe(false);
  });

  it('blocks a remote iframe from driving its local-file top-level page', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-file-with-remote-frame',
      url: 'file:///tmp/site/index.html',
    });
    const view = createdViews[0];
    if (!view) throw new Error('Expected a browser view.');
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (!handler) throw new Error('Expected a window.open handler.');
    const targetUrl = 'file:///tmp/secret.html';
    view.webContents.loadURL.mockClear();

    const navigationPreventDefault = jest.fn();
    view.webContents.emit(
      'will-navigate',
      {
        preventDefault: navigationPreventDefault,
        initiator: { url: 'https://example.com/remote-frame.html' },
      },
      targetUrl,
    );
    expect(
      handler({
        url: targetUrl,
        referrer: { url: 'https://example.com/remote-frame.html' },
      }),
    ).toEqual({ action: 'deny' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(navigationPreventDefault).toHaveBeenCalled();
    expect(view.webContents.loadURL).not.toHaveBeenCalledWith(targetUrl);
  });

  it('blocks a remote page from opening a local file in a new window', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-remote-popup',
      url: 'https://example.com',
    });
    const view = createdViews[0];
    if (!view) throw new Error('Expected a browser view.');
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (!handler) throw new Error('Expected a window.open handler.');
    const shellMock = jest.mocked(shell);
    shellMock.openExternal.mockClear();
    view.webContents.loadURL.mockClear();

    expect(handler({ url: 'file:///tmp/secret.html' })).toEqual({
      action: 'deny',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(view.webContents.loadURL).not.toHaveBeenCalled();
    expect(shellMock.openExternal.mock.calls).toHaveLength(0);
    expect(service.getConsole({ browserId: 'browser-remote-popup' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warning',
          text: 'A web page cannot navigate directly to a local file.',
        }),
      ]),
    );
  });

  it('confines viewer file navigation to the current replica roots', async () => {
    const root = {
      repoId: 'repo-1',
      repoName: 'Repo',
      absolutePath: '/replica/repo',
      revisionRoot: '/replica',
      revisionId: 'revision-1',
    };
    mockResolveViewerRoots.mockResolvedValue([root]);
    mockAssertViewerFile.mockImplementation(
      (containerId, absolutePath): Promise<unknown> =>
        absolutePath === '/replica/repo/index.html'
          ? Promise.resolve({
              root,
              target: absolutePath,
              relativePath: 'index.html',
            })
          : Promise.reject(
              new Error(
                `Cannot read ${containerId} outside the shared-container replica`,
              ),
            ),
    );
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      browserId: 'browser-viewer-file',
    });
    const view = createdViews[0];
    if (!view) throw new Error('Expected a browser view.');

    await service.navigate({
      browserId: 'browser-viewer-file',
      url: 'file:///replica/repo/index.html',
    });
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'file:///replica/repo/index.html',
    );
    view.webContents.loadURL.mockClear();

    await expect(
      service.navigate({
        browserId: 'browser-viewer-file',
        url: 'file:///private/secret.html',
      }),
    ).rejects.toThrow('outside the shared-container replica');
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
  });

  it('restores a profile-less viewer browser and loads its page in one create', async () => {
    const root = {
      repoId: 'repo-1',
      repoName: 'Repo',
      absolutePath: '/replica/repo',
      revisionRoot: '/replica',
      revisionId: 'revision-1',
    };
    mockResolveViewerRoots.mockResolvedValue([root]);
    mockAssertViewerFile.mockResolvedValue({
      root,
      target: '/replica/repo/index.html',
      relativePath: 'index.html',
    });
    const service = new BrowserService({ getWindow: mockWindow });

    // The same wrapper the browserCreate IPC applies: a restore of a session
    // with no browser profile has no runtime generation to advance.
    const snapshot = await service.withRuntimeTarget(
      { browserId: 'browser-viewer-restore' },
      () =>
        service.create({
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container-1',
          browserId: 'browser-viewer-restore',
          url: 'file:///replica/repo/index.html',
        }),
      { rehydrate: true },
    );
    expect(snapshot).toMatchObject({ id: 'browser-viewer-restore' });
    expect(snapshot.status).not.toBe('failed');
    expect(snapshot.lastError).toBeUndefined();
    expect(createdViews[0]?.webContents.loadURL).toHaveBeenCalledWith(
      'file:///replica/repo/index.html',
    );
  });

  it('confines every viewer file subresource request to the current replica', async () => {
    const root = {
      repoId: 'repo-1',
      repoName: 'Repo',
      absolutePath: '/replica/repo',
      revisionRoot: '/replica',
      revisionId: 'revision-1',
    };
    mockResolveViewerRoots.mockResolvedValue([root]);
    mockAssertViewerFile.mockImplementation(
      (_containerId, absolutePath): Promise<unknown> =>
        absolutePath.startsWith('/replica/repo/')
          ? Promise.resolve({
              root,
              target: absolutePath,
              relativePath: absolutePath.slice('/replica/repo/'.length),
            })
          : Promise.reject(
              new Error(
                'Cannot read file outside the shared-container replica',
              ),
            ),
    );
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
      browserId: 'browser-viewer-subresources',
    });

    expect(mockOnBeforeRequest).toHaveBeenCalledTimes(1);
    const listener = mockOnBeforeRequest.mock.calls[0]?.[1];
    if (!listener) throw new Error('Expected a viewer request policy.');

    const allowed = jest.fn();
    listener(
      {
        url: 'file:///replica/repo/style.css',
        resourceType: 'stylesheet',
      },
      allowed,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(allowed).toHaveBeenCalledWith({ cancel: false });

    const blocked = jest.fn();
    listener(
      { url: 'file:///private/secret.png', resourceType: 'image' },
      blocked,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(blocked).toHaveBeenCalledWith({ cancel: true });
  });

  it('keeps blocking local-file actions after a remote page cancels a file navigation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-cancelled-file-navigation',
      url: 'https://example.com/editor',
    });
    const view = createdViews[0];
    if (!view) throw new Error('Expected a browser view.');
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
    if (!handler) throw new Error('Expected a window.open handler.');
    view.webContents.loadURL.mockImplementationOnce(() => {
      view.webContents.emit('will-prevent-unload', {
        preventDefault: jest.fn(),
      });
      return Promise.resolve();
    });

    const navigation = service.navigate({
      browserId: 'browser-cancelled-file-navigation',
      url: 'file:///tmp/attempted.html',
    });
    const dialog = service.getDialog('browser-cancelled-file-navigation');
    expect(dialog).toMatchObject({ type: 'beforeunload' });
    await service.handleDialog({
      browserId: 'browser-cancelled-file-navigation',
      dialogId: dialog?.id ?? '',
      accept: false,
    });
    await navigation;
    expect(view.webContents.getURL()).toBe('https://example.com/editor');
    view.webContents.loadURL.mockClear();

    view.webContents.loadURL.mockImplementationOnce(() => Promise.resolve());
    expect(handler({ url: 'file:///tmp/secret-from-popup.html' })).toEqual({
      action: 'deny',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const popupLoadCount = view.webContents.loadURL.mock.calls.length;

    const navigationPreventDefault = jest.fn();
    view.webContents.emit(
      'will-navigate',
      { preventDefault: navigationPreventDefault },
      'file:///tmp/secret-from-link.html',
    );
    expect({
      popupLoadCount,
      linkPrevented: navigationPreventDefault.mock.calls.length > 0,
    }).toEqual({
      popupLoadCount: 0,
      linkPrevented: true,
    });
  });

  it('hosts App Advisor views and events in the App Advisor window', async () => {
    const mainAdd = jest.fn();
    const advisorAdd = jest.fn();
    const advisorRemove = jest.fn();
    let advisorZoomFactor = 1;
    const mainWindow = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      contentView: { addChildView: mainAdd, removeChildView: jest.fn() },
      webContents: { getZoomFactor: () => 1.5, isDestroyed: () => false },
    });
    const advisorWindow = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      contentView: { addChildView: advisorAdd, removeChildView: advisorRemove },
      webContents: {
        getZoomFactor: () => advisorZoomFactor,
        isDestroyed: () => false,
      },
    });
    const service = new BrowserService({
      getWindow: (): never => mainWindow as never,
      resolveHostWindow: (projectId): never =>
        projectId === APP_ADVISOR_PROJECT_ID
          ? (advisorWindow as never)
          : (mainWindow as never),
    });

    await service.create({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      browserId: 'browser-advisor',
    });

    expect(advisorAdd).toHaveBeenCalledTimes(1);
    expect(mainAdd).not.toHaveBeenCalled();
    expect(sendToWindow).toHaveBeenCalledWith(
      advisorWindow,
      'browser:event',
      expect.objectContaining({ browserId: 'browser-advisor' }),
    );

    service.setBounds({
      browserId: 'browser-advisor',
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      visible: true,
    });
    const advisorFrame = pageFrameOf(createdViews[0]).frame;
    expect(advisorFrame.setBounds).toHaveBeenLastCalledWith({
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });

    // The rect is converted with the HOST window's zoom (the App Advisor
    // window here), not the main window's.
    advisorZoomFactor = 1.25;
    service.setBounds({
      browserId: 'browser-advisor',
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      visible: true,
    });
    expect(advisorFrame.setBounds).toHaveBeenLastCalledWith({
      x: 13,
      y: 25,
      width: 800,
      height: 600,
    });

    jest.mocked(sendToWindow).mockClear();
    await service.destroy('browser-advisor');
    expect(advisorRemove).toHaveBeenCalledTimes(1);
    expect(sendToWindow).toHaveBeenCalledWith(advisorWindow, 'browser:event', {
      type: 'destroyed',
      browserId: 'browser-advisor',
      runtimeGeneration: 1,
    });
  });

  it('disposes the live view without deleting the session when its host window closes', async () => {
    const hostWindow = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      contentView: {
        addChildView: jest.fn(),
        removeChildView: jest.fn(),
      },
    });
    const service = new BrowserService({
      getWindow: (): never => hostWindow as never,
      resolveHostWindow: (): never => hostWindow as never,
    });
    await service.create({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-one',
      browserId: 'browser-host-close',
    });
    jest.mocked(sendToWindow).mockClear();

    hostWindow.emit('closed');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      service.listWorktreeBrowsers(APP_ADVISOR_PROJECT_ID, 'entry-one'),
    ).toEqual([expect.objectContaining({ id: 'browser-host-close' })]);
    expect(service.getLifecycleStats()).toMatchObject({
      liveViews: 0,
      persistedSessions: 1,
    });
    expect(
      jest
        .mocked(sendToWindow)
        .mock.calls.some(
          (call) => (call[2] as BrowserEvent).type === 'destroyed',
        ),
    ).toBe(false);
    expect(webContents.close).toHaveBeenCalled();
  });

  it('removes preload IPC listeners on shutdown', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    await service.shutdown();
    expect(ipcListeners.has('canopy-browser-view:result')).toBe(false);
    expect(ipcListeners.has('canopy-browser-view:event')).toBe(false);
  });

  it('uses saved explicit state for active browser resolution', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const browser = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
      url: 'http://localhost:3000',
    });

    await service.saveWorktreeState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state: {
        version: 1,
        browserOrder: ['browser-1'],
        activeBrowserId: 'browser-1',
        browsers: [browser],
      },
    });

    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-1',
    );
  });

  it('keeps main-owned profile bindings when the renderer saves layout state', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const browser = persistedSnapshot('browser-authoritative-binding', {
      profile: {
        selection: { kind: 'task' },
        resolvedProfileId: 'task-profile',
        storageGeneration: 1,
        runtimeGeneration: 4,
        taskIncarnationId: 'fixture-incarnation',
      },
      taskScope: {
        kind: 'worktree',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    if (!browser.profile) throw new Error('Expected a profile binding.');
    jest.mocked(loadAndMigrateWorktreeBrowserState).mockResolvedValue({
      status: 'loaded',
      state: {
        version: 1,
        browserOrder: [browser.id],
        activeBrowserId: browser.id,
        browsers: [browser],
      },
    });
    await service.loadWorktreeState('project-1', 'worktree-1');

    await service.saveWorktreeState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state: {
        version: 1,
        browserOrder: [browser.id],
        activeBrowserId: browser.id,
        browsers: [
          {
            ...browser,
            profile: {
              ...browser.profile,
              resolvedProfileId: 'stale-renderer-profile',
              runtimeGeneration: 14,
            },
            taskScope: {
              kind: 'worktree',
              projectId: 'stale-project',
              worktreeId: 'stale-worktree',
            },
          },
        ],
      },
    });

    expect(
      service.listWorktreeBrowsers('project-1', 'worktree-1')[0],
    ).toMatchObject({
      profile: browser.profile,
      taskScope: browser.taskScope,
    });
  });

  it('re-scans switch journals created after initial task recovery', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.loadWorktreeState('project-1', 'worktree-1');
    const source = persistedSnapshot('browser-recovery-source', {
      profile: {
        selection: { kind: 'task' },
        resolvedProfileId: 'task-profile',
        storageGeneration: 1,
        runtimeGeneration: 1,
        taskIncarnationId: 'fixture-incarnation',
      },
    });
    const target = persistedSnapshot('browser-recovery-source', {
      profile: {
        selection: { kind: 'named', profileId: 'named-profile' },
        resolvedProfileId: 'named-profile',
        storageGeneration: 1,
        runtimeGeneration: 2,
        taskIncarnationId: 'fixture-incarnation',
      },
    });
    const record: BrowserSwitchRecord = {
      schemaVersion: 1,
      operationId: 'late-switch-operation',
      digest: 'a'.repeat(64),
      createdAt: Date.now(),
      stage: 'target_committed',
      source,
      target,
      mode: 'replace',
    };
    mockPendingSwitchRecords.mockResolvedValueOnce([record]);

    await service.loadWorktreeState('project-1', 'worktree-1');

    expect(mockSwitchJournalUpdate).toHaveBeenCalledWith(record, 'complete', {
      status: 'complete',
      browser: target,
    });
  });

  it('resolves saved active browser ids before a live view is recreated', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    await service.saveWorktreeState({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      state: {
        version: 1,
        browserOrder: ['browser-persisted'],
        activeBrowserId: 'browser-persisted',
        browsers: [
          {
            id: 'browser-persisted',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            createdAt: 1,
            updatedAt: 2,
            url: 'http://localhost:3000',
            title: 'Persisted',
            status: 'idle',
            canGoBack: false,
            canGoForward: false,
            loading: false,
            themeMode: 'light',
            pickMode: false,
            recording: false,
          },
        ],
      },
    });

    expect(service.resolveActiveBrowserId('project-1', 'worktree-1')).toBe(
      'browser-persisted',
    );
  });

  it('emits recording state and returns a Playwright script', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-2',
      url: 'http://localhost:3000',
    });

    await service.startRecording(snapshot.id);
    const result = await service.stopRecording(snapshot.id);

    expect(result.recording).toBe(false);
    expect(result.playwrightScript).toContain(
      "await page.goto('http://localhost:3000');",
    );
    expect(sendToWindow).toHaveBeenCalledWith(
      expect.anything(),
      'browser:event',
      expect.objectContaining({ type: 'recording-state' }),
    );
  });

  it('rejects invalid in-app navigation without loading the URL', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    service.setLocalServersOnly(true);
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-invalid-nav',
      url: 'http://localhost:3000',
    });
    webContents.loadURL.mockClear();

    await expect(
      service.navigate({
        browserId: snapshot.id,
        url: 'https://example.com',
      }),
    ).rejects.toThrow(
      "Couldn't open this page. Enter a local file path or a localhost, 127.0.0.1, or [::1] URL.",
    );

    expect(webContents.loadURL).not.toHaveBeenCalled();
    expect(
      service.listWorktreeBrowsers('project-1', 'worktree-1')[0]?.url,
    ).toBe('http://localhost:3000');
  });

  it('uses actionable failure copy when an external URL is refused', async () => {
    const service = new BrowserService({ getWindow: mockWindow });

    await expect(
      service.openExternal('file:///tmp/report.html'),
    ).rejects.toThrow(
      "Couldn't open this URL externally. Enter an http or https URL.",
    );
    expect(jest.mocked(shell).openExternal.mock.calls).toHaveLength(0);
  });

  describe('openFilePageExternally', () => {
    const FILE_PAGE = 'file:///tmp/site/index.html';

    async function fileSession(
      url = FILE_PAGE,
      browserId = 'browser-file-external',
    ): Promise<BrowserService> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
      });
      await service.navigate({ browserId, url });
      return service;
    }

    it('opens the current file page in the default web browser', async () => {
      const service = await fileSession();

      await service.openFilePageExternally('browser-file-external', FILE_PAGE);

      expect(mockAssertPathOutsideReplicas).toHaveBeenCalledWith(
        '/tmp/site/index.html',
      );
      expect(mockOpenFileInDefaultWebBrowser).toHaveBeenCalledWith(FILE_PAGE);
      expect(jest.mocked(shell).openExternal.mock.calls).toHaveLength(0);
    });

    it('accepts an equivalent spelling of the current file page', async () => {
      const service = await fileSession();

      await service.openFilePageExternally(
        'browser-file-external',
        'file:///tmp/site/./index.html',
      );

      expect(mockOpenFileInDefaultWebBrowser).toHaveBeenCalledWith(FILE_PAGE);
    });

    it('rejects a file URL that is not the current page', async () => {
      const service = await fileSession();

      await expect(
        service.openFilePageExternally(
          'browser-file-external',
          'file:///tmp/site/other.html',
        ),
      ).rejects.toThrow(
        "Couldn't open this file externally. Reload the page and try again.",
      );
      expect(mockOpenFileInDefaultWebBrowser).not.toHaveBeenCalled();
    });

    it('rejects an unknown browser tab', async () => {
      const service = new BrowserService({ getWindow: mockWindow });

      await expect(
        service.openFilePageExternally('browser-missing', FILE_PAGE),
      ).rejects.toThrow("Couldn't find that browser tab.");
      expect(mockOpenFileInDefaultWebBrowser).not.toHaveBeenCalled();
    });

    it.each(['https://example.com/', 'file://remote-host/share/index.html'])(
      'rejects %s, which is not a local file page',
      async (url) => {
        const service = await fileSession();

        await expect(
          service.openFilePageExternally('browser-file-external', url),
        ).rejects.toThrow(
          "Couldn't open this URL externally. Enter an http or https URL.",
        );
        expect(mockOpenFileInDefaultWebBrowser).not.toHaveBeenCalled();
        expect(jest.mocked(shell).openExternal.mock.calls).toHaveLength(0);
      },
    );

    it('rejects a file URL that cannot be converted to a path', async () => {
      const malformed = 'file:///tmp/site%2Findex.html';
      const service = await fileSession(malformed);

      await expect(
        service.openFilePageExternally('browser-file-external', malformed),
      ).rejects.toThrow(
        "Couldn't open this URL externally. Enter an http or https URL.",
      );
      expect(mockAssertPathOutsideReplicas).not.toHaveBeenCalled();
      expect(mockOpenFileInDefaultWebBrowser).not.toHaveBeenCalled();
    });

    it('refuses the shared-container viewer scope', async () => {
      const root = {
        repoId: 'repo-1',
        repoName: 'Repo',
        absolutePath: '/replica/repo',
        revisionRoot: '/replica',
        revisionId: 'revision-1',
      };
      mockResolveViewerRoots.mockResolvedValue([root]);
      mockAssertViewerFile.mockResolvedValue({
        root,
        target: '/replica/repo/index.html',
        relativePath: 'index.html',
      });
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
        browserId: 'browser-viewer-external',
      });
      await service.navigate({
        browserId: 'browser-viewer-external',
        url: 'file:///replica/repo/index.html',
      });

      await expect(
        service.openFilePageExternally(
          'browser-viewer-external',
          'file:///replica/repo/index.html',
        ),
      ).rejects.toThrow('Shared-container recipient workspaces are read-only');
      expect(mockOpenFileInDefaultWebBrowser).not.toHaveBeenCalled();
    });

    it('refuses a file page inside the sealed replica store', async () => {
      mockAssertPathOutsideReplicas.mockRejectedValue(
        new Error('Shared-container recipient workspaces are read-only'),
      );
      const service = await fileSession();

      await expect(
        service.openFilePageExternally('browser-file-external', FILE_PAGE),
      ).rejects.toThrow('Shared-container recipient workspaces are read-only');
      expect(mockOpenFileInDefaultWebBrowser).not.toHaveBeenCalled();
    });
  });

  it('allows local file navigation while local-only browsing is enabled', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    service.setLocalServersOnly(true);
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-local-file',
    });
    webContents.loadURL.mockClear();

    const navigated = await service.navigate({
      browserId: snapshot.id,
      url: '/tmp/My Report/index.html',
    });

    expect(navigated.url).toBe('file:///tmp/My%20Report/index.html');
    expect(webContents.loadURL).toHaveBeenCalledWith(
      'file:///tmp/My%20Report/index.html',
    );
  });

  it('reloads rather than double-loading an equivalent local file URL', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-file-reload',
      url: 'file:///tmp/My%20Report/index.html',
    });
    webContents.loadURL.mockClear();
    webContents.reload.mockClear();

    await service.navigate({
      browserId: snapshot.id,
      url: '/tmp/My Report/index.html',
    });

    expect(webContents.reload).toHaveBeenCalledTimes(1);
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });

  it('loads a matching snapshot URL when the native view is still blank', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-blank-native-view',
    });
    const targetUrl = 'http://localhost:5173/';

    webContents.loadURL.mockImplementation(() => Promise.resolve(undefined));
    await service.navigate({ browserId: snapshot.id, url: targetUrl });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')[0]).toEqual(
      expect.objectContaining({ url: targetUrl }),
    );
    expect(webContents.getURL()).toBe('about:blank');

    webContents.loadURL.mockClear();
    webContents.reload.mockClear();

    await service.navigate({ browserId: snapshot.id, url: targetUrl });

    expect(webContents.loadURL).toHaveBeenCalledWith(targetUrl);
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it('loads an existing browser create request when the native view is still blank', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const targetUrl = 'http://localhost:5173/';
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-existing-blank-native-view',
    });

    webContents.loadURL.mockImplementation(() => Promise.resolve(undefined));
    await service.navigate({
      browserId: 'browser-existing-blank-native-view',
      url: targetUrl,
    });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')[0]).toEqual(
      expect.objectContaining({ url: targetUrl }),
    );
    expect(webContents.getURL()).toBe('about:blank');

    webContents.loadURL.mockClear();
    webContents.reload.mockClear();

    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-existing-blank-native-view',
      url: targetUrl,
    });

    expect(webContents.loadURL).toHaveBeenCalledWith(targetUrl);
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it('blocks server-side redirects to external URLs', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    service.setLocalServersOnly(true);
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-redirect',
      url: 'http://localhost:3000',
    });
    const preventDefault = jest.fn();
    const shellMock = jest.mocked(shell);
    shellMock.openExternal.mockClear();

    webContents.emit(
      'will-redirect',
      { preventDefault },
      'https://example.com',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(preventDefault).toHaveBeenCalled();
    expect(shellMock.openExternal.mock.calls).toContainEqual([
      'https://example.com',
    ]);
  });

  it('blocks remote pages from navigating to local files without opening them externally', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-remote-file-drive-by',
      url: 'https://example.com',
    });
    const preventDefault = jest.fn();
    const shellMock = jest.mocked(shell);
    shellMock.openExternal.mockClear();

    webContents.emit(
      'will-navigate',
      { preventDefault },
      'file:///tmp/secret.html',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(preventDefault).toHaveBeenCalled();
    expect(shellMock.openExternal.mock.calls).toHaveLength(0);
  });

  it('does not replay a blocked remote-to-file navigation through beforeunload', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-blocked-file-beforeunload',
      url: 'https://example.com/editor',
    });
    const blockedUrl = 'file:///tmp/secret.html';
    webContents.loadURL.mockClear();

    webContents.emit(
      'will-navigate',
      { preventDefault: jest.fn() },
      blockedUrl,
    );
    webContents.emit('will-prevent-unload', { preventDefault: jest.fn() });
    const dialog = service.getDialog('browser-blocked-file-beforeunload');
    expect(dialog).toMatchObject({ type: 'beforeunload' });

    await service.handleDialog({
      browserId: 'browser-blocked-file-beforeunload',
      dialogId: dialog?.id ?? '',
      accept: true,
    });

    expect(webContents.loadURL).not.toHaveBeenCalledWith(blockedUrl);
  });

  it('blocks a local page redirect chain after it crosses into remote content', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-file-remote-file-redirect',
      url: 'file:///tmp/site/index.html',
    });
    const navigationPreventDefault = jest.fn();
    const redirectPreventDefault = jest.fn();
    const shellMock = jest.mocked(shell);
    shellMock.openExternal.mockClear();

    webContents.emit(
      'will-navigate',
      { preventDefault: navigationPreventDefault },
      'https://example.com/redirect',
    );
    webContents.emit(
      'will-redirect',
      { preventDefault: redirectPreventDefault },
      'file:///tmp/secret.html',
    );

    expect(navigationPreventDefault).not.toHaveBeenCalled();
    expect(redirectPreventDefault).toHaveBeenCalled();
    expect(shellMock.openExternal.mock.calls).toHaveLength(0);
  });

  it('blocks a remote history redirect to a local file after leaving a local page', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-file-remote-history-redirect',
      url: 'file:///tmp/site/index.html',
    });
    const redirectPreventDefault = jest.fn();
    const shellMock = jest.mocked(shell);
    shellMock.openExternal.mockClear();
    webContents.navigationHistory.canGoBack.mockReturnValue(true);
    webContents.navigationHistory.goBack.mockImplementation(() => {
      webContents.emit(
        'did-start-navigation',
        {
          url: 'https://example.com/redirect',
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        },
        'https://example.com/redirect',
        false,
        true,
        0,
        0,
      );
    });

    await service.back('browser-file-remote-history-redirect');
    webContents.emit(
      'will-redirect',
      { preventDefault: redirectPreventDefault },
      'file:///tmp/secret.html',
    );

    expect(webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(redirectPreventDefault).toHaveBeenCalled();
    expect(shellMock.openExternal.mock.calls).toHaveLength(0);
  });

  it('allows a local file page to navigate to a neighbouring local file', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-file-link',
      url: 'file:///tmp/site/index.html',
    });
    const preventDefault = jest.fn();

    webContents.emit(
      'will-navigate',
      {
        preventDefault,
        initiator: { url: 'file:///tmp/site/index.html' },
      },
      'file:///tmp/site/neighbour.html',
    );

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('allows remote navigation by default', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-remote',
      url: 'https://example.com',
    });

    expect(snapshot.url).toBe('https://example.com');
    expect(webContents.loadURL).toHaveBeenCalledWith('https://example.com');
  });

  it('uses navigationHistory for back and forward state/actions', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-history',
      url: 'http://localhost:3000/start',
    });
    webContents.canGoBack.mockReturnValue(false);
    webContents.canGoForward.mockReturnValue(false);
    webContents.navigationHistory.canGoBack.mockReturnValue(true);
    webContents.navigationHistory.canGoForward.mockReturnValue(true);

    webContents.currentUrl = 'http://localhost:3000/settings';
    webContents.emit(
      'did-navigate-in-page',
      {},
      'http://localhost:3000/settings',
      true,
    );

    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')[0]).toEqual(
      expect.objectContaining({
        url: 'http://localhost:3000/settings',
        canGoBack: true,
        canGoForward: true,
      }),
    );

    await service.back('browser-history');
    await service.forward('browser-history');

    expect(webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1);
    expect(webContents.goBack).not.toHaveBeenCalled();
    expect(webContents.goForward).not.toHaveBeenCalled();
  });

  describe('browser-page hotkeys via before-input-event (ECW-7984)', () => {
    // Chord inputs for the CURRENT process.platform, mirroring what
    // `resolveBrowserShortcutAction` expects: Cmd-based on macOS; Ctrl+T /
    // Alt+arrows on Windows/Linux.
    function chordInput(code: string): {
      type: 'keyDown';
      code: string;
      alt: boolean;
      control: boolean;
      meta: boolean;
      shift: boolean;
    } {
      const isMac = process.platform === 'darwin';
      const isHistoryArrow = code === 'ArrowLeft' || code === 'ArrowRight';
      return {
        type: 'keyDown',
        code,
        alt: !isMac && isHistoryArrow,
        control: !isMac && !isHistoryArrow,
        meta: isMac,
        shift: false,
      };
    }

    async function createShortcutSession(): Promise<BrowserService> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-keys',
        url: 'http://localhost:3000/start',
      });
      return service;
    }

    it('consumes the back chord and navigates the page history', async () => {
      await createShortcutSession();
      webContents.navigationHistory.canGoBack.mockReturnValue(true);

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit(
        'before-input-event',
        inputEvent,
        chordInput('ArrowLeft'),
      );

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    });

    it('consumes the chord but stays a safe no-op when history is unavailable', async () => {
      await createShortcutSession();
      webContents.navigationHistory.canGoBack.mockReturnValue(false);
      webContents.navigationHistory.canGoForward.mockReturnValue(false);

      const backEvent = { preventDefault: jest.fn() };
      webContents.emit(
        'before-input-event',
        backEvent,
        chordInput('ArrowLeft'),
      );
      const forwardEvent = { preventDefault: jest.fn() };
      webContents.emit(
        'before-input-event',
        forwardEvent,
        chordInput('ArrowRight'),
      );

      expect(backEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(forwardEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(webContents.navigationHistory.goBack).not.toHaveBeenCalled();
      expect(webContents.navigationHistory.goForward).not.toHaveBeenCalled();
    });

    it('forwards the new-tab chord to the renderer and refocuses the host window', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();
      mockHostWebContentsFocus.mockClear();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, chordInput('KeyT'));

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockHostWebContentsFocus).toHaveBeenCalledTimes(1);
      const shortcutEvents = sentBrowserEvents().filter(
        (event) => event.type === 'shortcut',
      );
      expect(shortcutEvents).toEqual([
        expect.objectContaining({
          type: 'shortcut',
          browserId: 'browser-keys',
          action: 'new-tab',
        }),
      ]);
    });

    it('focuses the hosted renderer, not the blank host page, when a view hosts it', async () => {
      // Early access App Advisor: the window's own page is blank and its
      // renderer lives in a view (`hostRendererInView`).
      const hostFocus = jest.fn();
      const rendererFocus = jest.fn();
      const hostContents = {
        focus: hostFocus,
        getZoomFactor: (): number => 1,
        isDestroyed: (): boolean => false,
      };
      const rendererContents = { focus: rendererFocus };
      const stopHosting = hostRendererInView(
        hostContents as never,
        () => rendererContents as never,
      );
      try {
        const service = new BrowserService({
          getWindow: (): never =>
            ({
              isDestroyed: () => false,
              contentView: { addChildView, removeChildView },
              once: jest.fn(),
              removeListener: jest.fn(),
              webContents: hostContents,
            }) as never,
        });
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'browser-keys',
          url: 'http://localhost:3000/start',
        });

        webContents.emit(
          'before-input-event',
          { preventDefault: jest.fn() },
          chordInput('KeyL'),
        );

        expect(rendererFocus).toHaveBeenCalledTimes(1);
        expect(hostFocus).not.toHaveBeenCalled();
      } finally {
        stopHosting();
      }
    });

    it('forwards the focus-address-bar chord to the renderer', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, chordInput('KeyL'));

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      const shortcutEvents = sentBrowserEvents().filter(
        (event) => event.type === 'shortcut',
      );
      expect(shortcutEvents).toEqual([
        expect.objectContaining({
          type: 'shortcut',
          browserId: 'browser-keys',
          action: 'focus-address-bar',
        }),
      ]);
    });

    it('forwards the sidebar toggle chord to the renderer', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();
      mockHostWebContentsFocus.mockClear();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, chordInput('KeyB'));

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockHostWebContentsFocus).not.toHaveBeenCalled();
      const shortcutEvents = sentBrowserEvents().filter(
        (event) => event.type === 'shortcut',
      );
      expect(shortcutEvents).toEqual([
        expect.objectContaining({
          type: 'shortcut',
          browserId: 'browser-keys',
          action: 'toggle-sidebar',
        }),
      ]);
    });

    // CAN-4616: the page keeps focus for the tab-cycle chords. A cycle that
    // selects another tab hides this view, and hiding hands focus to the
    // host; a single-tab group selects nothing and the page keeps typing.
    it('forwards the tab-cycle chord to the renderer and keeps focus in the page', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();
      mockHostWebContentsFocus.mockClear();

      const isMac = process.platform === 'darwin';
      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, {
        type: 'keyDown',
        code: isMac ? 'BracketRight' : 'Tab',
        alt: false,
        control: !isMac,
        meta: isMac,
        shift: isMac,
      });

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockHostWebContentsFocus).not.toHaveBeenCalled();
      const shortcutEvents = sentBrowserEvents().filter(
        (event) => event.type === 'shortcut',
      );
      expect(shortcutEvents).toEqual([
        expect.objectContaining({
          type: 'shortcut',
          browserId: 'browser-keys',
          action: 'select-next-tab',
        }),
      ]);
    });

    it('hands keyboard focus to the host when it hides the focused page', async () => {
      const service = await createShortcutSession();
      service.setVisible('browser-keys', true);
      mockHostWebContentsFocus.mockClear();

      // An unfocused page hides without moving focus.
      service.setVisible('browser-keys', false);
      expect(mockHostWebContentsFocus).not.toHaveBeenCalled();

      service.setVisible('browser-keys', true);
      webContents.isFocused.mockReturnValue(true);
      try {
        service.setVisible('browser-keys', false);
        expect(mockHostWebContentsFocus).toHaveBeenCalledTimes(1);

        // Showing it again leaves focus where it is.
        mockHostWebContentsFocus.mockClear();
        service.setVisible('browser-keys', true);
        expect(mockHostWebContentsFocus).not.toHaveBeenCalled();
      } finally {
        webContents.isFocused.mockReturnValue(false);
      }
    });

    it('hands focus to the host when the next visibility change after a tab-cycle chord hides the page', async () => {
      const service = await createShortcutSession();
      service.setVisible('browser-keys', true);
      const isMac = process.platform === 'darwin';
      const cycleChord = {
        type: 'keyDown',
        code: isMac ? 'BracketRight' : 'Tab',
        alt: false,
        control: !isMac,
        meta: isMac,
        shift: isMac,
      };

      // A cycle that selects another tab hides the page: focus goes home,
      // even though a window without OS focus reports the page unfocused.
      webContents.emit(
        'before-input-event',
        { preventDefault: jest.fn() },
        cycleChord,
      );
      mockHostWebContentsFocus.mockClear();
      service.setVisible('browser-keys', false);
      expect(mockHostWebContentsFocus).toHaveBeenCalledTimes(1);

      // A cycle with nothing to select leaves the page shown; the next
      // visibility change consumes the record, so a later hide stays put.
      service.setVisible('browser-keys', true);
      webContents.emit(
        'before-input-event',
        { preventDefault: jest.fn() },
        cycleChord,
      );
      service.setVisible('browser-keys', true);
      mockHostWebContentsFocus.mockClear();
      service.setVisible('browser-keys', false);
      expect(mockHostWebContentsFocus).not.toHaveBeenCalled();
    });

    it('forwards the find chord to the renderer and refocuses the host window (CAN-3048)', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();
      mockHostWebContentsFocus.mockClear();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, chordInput('KeyF'));

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(mockHostWebContentsFocus).toHaveBeenCalledTimes(1);
      expect(webContents.findInPage).not.toHaveBeenCalled();
      const shortcutEvents = sentBrowserEvents().filter(
        (event) => event.type === 'shortcut',
      );
      expect(shortcutEvents).toEqual([
        expect.objectContaining({
          type: 'shortcut',
          browserId: 'browser-keys',
          action: 'find-in-page',
        }),
      ]);
    });

    it('forwards the close-tab chord to the renderer and refocuses the host window', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();
      mockHostWebContentsFocus.mockClear();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, chordInput('KeyW'));

      expect(inputEvent.preventDefault).toHaveBeenCalledTimes(1);
      // The page is about to go away, so focus returns to the host renderer.
      expect(mockHostWebContentsFocus).toHaveBeenCalledTimes(1);
      const shortcutEvents = sentBrowserEvents().filter(
        (event) => event.type === 'shortcut',
      );
      expect(shortcutEvents).toEqual([
        expect.objectContaining({
          type: 'shortcut',
          browserId: 'browser-keys',
          action: 'close-tab',
        }),
      ]);
    });

    it('emits nothing for the close-tab chord keyUp', async () => {
      await createShortcutSession();
      jest.mocked(sendToWindow).mockClear();
      mockHostWebContentsFocus.mockClear();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, {
        ...chordInput('KeyW'),
        type: 'keyUp',
      });

      expect(inputEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockHostWebContentsFocus).not.toHaveBeenCalled();
      expect(
        sentBrowserEvents().filter((event) => event.type === 'shortcut'),
      ).toEqual([]);
    });

    it('leaves unrelated keys untouched for the page', async () => {
      await createShortcutSession();

      const inputEvent = { preventDefault: jest.fn() };
      webContents.emit('before-input-event', inputEvent, {
        type: 'keyDown',
        code: 'KeyA',
        alt: false,
        control: false,
        meta: false,
        shift: false,
      });

      expect(inputEvent.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('find in page (CAN-3048)', () => {
    async function createFindSession(
      browserId = 'browser-find',
    ): Promise<BrowserService> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost:3000/start',
      });
      return service;
    }

    // Electron's `findNext: true` begins a new find session and a fresh
    // query sent with `false` never reports `found-in-page`, so the contract's
    // `findNext` (follow-up request) is inverted on the way to Electron.
    it('starts a new find session and returns the Electron request id', async () => {
      const service = await createFindSession();
      webContents.findInPage.mockReturnValueOnce(11);

      await expect(
        service.findInPage('browser-find', 'needle', {}),
      ).resolves.toBe(11);

      expect(webContents.findInPage).toHaveBeenCalledWith('needle', {
        findNext: true,
        forward: true,
      });
    });

    it('sends next and previous as follow-up requests in the session', async () => {
      const service = await createFindSession();

      await service.findInPage('browser-find', 'needle', {
        findNext: true,
        forward: false,
      });

      expect(webContents.findInPage).toHaveBeenCalledWith('needle', {
        findNext: false,
        forward: false,
      });
    });

    it.each(['', '   ', '\n\t'])(
      'rejects empty or whitespace-only text %j without calling Electron',
      async (text) => {
        const service = await createFindSession();

        await expect(
          service.findInPage('browser-find', text, {}),
        ).rejects.toThrow('Find text must not be empty.');
        expect(webContents.findInPage).not.toHaveBeenCalled();
      },
    );

    it('rejects cleanly when the page webContents is destroyed', async () => {
      const service = await createFindSession();
      webContents.destroyed = true;

      await expect(
        service.findInPage('browser-find', 'needle', {}),
      ).rejects.toThrow('Browser browser-find is no longer available.');
      await expect(
        service.stopFindInPage('browser-find', 'clearSelection'),
      ).rejects.toThrow('Browser browser-find is no longer available.');
      expect(webContents.findInPage).not.toHaveBeenCalled();
      expect(webContents.stopFindInPage).not.toHaveBeenCalled();
    });

    it('rejects for an unknown browser', async () => {
      const service = await createFindSession();

      await expect(
        service.findInPage('browser-missing', 'needle', {}),
      ).rejects.toThrow();
      await expect(
        service.stopFindInPage('browser-missing', 'clearSelection'),
      ).rejects.toThrow();
    });

    it('stops find with the requested selection action', async () => {
      const service = await createFindSession();

      await service.stopFindInPage('browser-find', 'clearSelection');

      expect(webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    });

    it('serves find and stop-find over IPC with validated browser ids', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      const snapshot = await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-find',
        url: 'http://localhost:3000/start',
      });
      const expectedRuntimeGeneration = snapshot.profile?.runtimeGeneration;
      registerBrowserHandlers(mockWindow, service);
      const findIpc = ipcHandlers.get(IPC_CHANNELS.browserFindInPage);
      const stopIpc = ipcHandlers.get(IPC_CHANNELS.browserStopFindInPage);
      if (!findIpc || !stopIpc) throw new Error('Missing find IPC handlers');
      const invokeEvent = {
        sender: {
          isFocused: (): boolean => false,
          isDestroyed: (): boolean => false,
        },
      };
      webContents.findInPage.mockReturnValueOnce(21);

      await expect(
        findIpc(invokeEvent, {
          browserId: 'browser-find',
          expectedRuntimeGeneration,
          text: 'needle',
          findNext: true,
          forward: false,
        }),
      ).resolves.toBe(21);
      expect(webContents.findInPage).toHaveBeenCalledWith('needle', {
        findNext: false,
        forward: false,
      });

      await stopIpc(invokeEvent, {
        browserId: 'browser-find',
        expectedRuntimeGeneration,
        action: 'keepSelection',
      });
      expect(webContents.stopFindInPage).toHaveBeenCalledWith('keepSelection');

      await expect(
        findIpc(invokeEvent, { browserId: '../escape', text: 'needle' }),
      ).rejects.toThrow();
      await expect(
        findIpc(invokeEvent, {
          browserId: 'browser-find',
          expectedRuntimeGeneration,
          text: 42,
        }),
      ).rejects.toThrow('Invalid text');
      await expect(
        stopIpc(invokeEvent, {
          browserId: 'browser-find',
          expectedRuntimeGeneration,
          action: 'bogus',
        }),
      ).rejects.toThrow('Invalid action');
      expect(webContents.findInPage).toHaveBeenCalledTimes(1);
      expect(webContents.stopFindInPage).toHaveBeenCalledTimes(1);
    });

    it('forwards found-in-page results as find-result for that browser only', async () => {
      const service = await createFindSession('browser-find-a');
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'browser-find-b',
        url: 'http://localhost:3000/other',
      });
      const secondContents = createdViews[1]?.webContents;
      expect(secondContents).toBeDefined();
      jest.mocked(sendToWindow).mockClear();

      secondContents?.emit(
        'found-in-page',
        {},
        {
          requestId: 3,
          activeMatchOrdinal: 2,
          matches: 5,
          selectionArea: { x: 0, y: 0, width: 10, height: 10 },
          finalUpdate: true,
        },
      );

      const findResults = sentBrowserEvents().filter(
        (event) => event.type === 'find-result',
      );
      expect(findResults).toEqual([
        expect.objectContaining({
          type: 'find-result',
          browserId: 'browser-find-b',
          requestId: 3,
          activeMatchOrdinal: 2,
          matches: 5,
          finalUpdate: true,
        }),
      ]);
    });
  });

  it('updates the browser URL from CDP same-document navigation events', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-spa',
      url: 'http://localhost:3000/',
    });
    webContents.navigationHistory.canGoBack.mockReturnValue(true);
    const debugCalls = webContents.debugger.on.mock.calls;
    const debugMessage = debugCalls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    expect(debugMessage).toBeDefined();

    webContents.currentUrl = 'http://localhost:3000/dashboard';
    debugMessage?.({}, 'Page.navigatedWithinDocument', {
      frameId: 'main-frame',
      url: 'http://localhost:3000/dashboard',
    });

    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')[0]).toEqual(
      expect.objectContaining({
        url: 'http://localhost:3000/dashboard',
        canGoBack: true,
      }),
    );
  });

  it('returns a failed snapshot instead of rejecting when the initial local load fails', async () => {
    webContents.loadURL.mockRejectedValueOnce(new Error('connection refused'));
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-failed-load',
      url: 'http://localhost:3000',
    });

    expect(snapshot).toMatchObject({
      id: 'browser-failed-load',
      url: 'http://localhost:3000',
      status: 'failed',
      loading: false,
      lastError: 'connection refused',
    });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({ id: 'browser-failed-load', status: 'failed' }),
    ]);
  });

  it('describes a rejected local file load without exposing Chromium internals', async () => {
    webContents.loadURL.mockRejectedValueOnce(
      new Error(
        "ERR_FILE_NOT_FOUND (-6) loading 'file:///tmp/missing%20report.html'",
      ),
    );
    const service = new BrowserService({ getWindow: mockWindow });

    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-rejected-file-load',
      url: 'file:///tmp/missing%20report.html',
    });

    expect(snapshot).toMatchObject({
      status: 'failed',
      loading: false,
      lastError: "Couldn't open missing report.html. The file wasn't found.",
    });
  });

  it('ignores ERR_ABORTED did-fail-load events from superseded navigations', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-aborted',
      url: 'http://localhost:3000',
    });
    webContents.emit('did-finish-load');

    // A superseding navigation aborts the prior load with ERR_ABORTED (-3); the
    // page is still loading successfully, so this must not flash a failed state.
    webContents.emit(
      'did-fail-load',
      {},
      -3,
      'net::ERR_ABORTED',
      'http://localhost:3000',
      true,
    );

    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')[0]).toEqual(
      expect.objectContaining({ status: 'ready', loading: false }),
    );

    // A genuine failure code still marks the browser failed.
    webContents.emit(
      'did-fail-load',
      {},
      -102,
      'net::ERR_CONNECTION_REFUSED',
      'http://localhost:3000',
      true,
    );
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')[0]).toEqual(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  describe('a navigation that turns into a download', () => {
    /** Chromium hands the response to a download before it aborts the navigation. */
    function startDownload(service: BrowserService, url: string): void {
      const native = new EventEmitter();
      service.downloads.observe(native as ElectronTypes.Session);
      // This store admits nothing. The page load is over either way.
      const item = {
        getURL: (): string => url,
        getFilename: (): string => 'report.csv',
        getMimeType: (): string => 'text/csv',
        getTotalBytes: (): number => 0,
        cancel: jest.fn(),
      };
      native.emit('will-download', {}, item, { id: webContents.id });
    }
    function shown(service: BrowserService): object | undefined {
      return service.listWorktreeBrowsers('project-1', 'worktree-1')[0];
    }

    it('leaves the tab ready on the page it was showing, so a load-state wait completes', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-link',
        url: 'http://localhost:3000',
      });
      installNativePipeline({
        waitForProbe: {
          matchCount: 0,
          visibleCount: 0,
          readyState: 'complete',
        },
      });
      webContents.emit('did-finish-load');
      webContents.emit('did-start-loading');
      expect(shown(service)).toMatchObject({ status: 'loading' });
      startDownload(service, 'http://localhost:3000/report.csv');
      webContents.emit('did-stop-loading');

      expect(shown(service)).toMatchObject({
        url: 'http://localhost:3000',
        status: 'ready',
        loading: false,
        lastError: undefined,
      });
      await expect(
        service.automation({
          browserId: 'download-link',
          command: { kind: 'wait_for', loadState: 'load', timeoutMs: 0 },
        }),
      ).resolves.toMatchObject({
        completed: true,
        waitFor: { satisfied: true },
      });
      await service.shutdown();
    });

    it('returns a held first agent load that becomes a download to the blank tab', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      const reportUrl = 'http://localhost:3000/report.csv';
      await service.create(
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'held-download',
          url: reportUrl,
        },
        'agent',
      );
      webContents.loadURL.mockImplementationOnce((url: string) => {
        webContents.emit('did-start-loading');
        startDownload(service, url);
        webContents.emit('did-stop-loading');
        return Promise.reject(
          Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), {
            errno: -3,
          }),
        );
      });
      service.setBounds({
        browserId: 'held-download',
        bounds: { x: 0, y: 0, width: 640, height: 480 },
        visible: true,
      });
      await service.waitForInitialLoad('held-download');

      // An idle tab still on the download URL would make the pane request it
      // again; the tab returns to its blank start instead.
      expect(shown(service)).toMatchObject({ status: 'idle', loading: false });
      expect(shown(service)).not.toMatchObject({ url: reportUrl });
      expect(webContents.loadURL).toHaveBeenCalledTimes(1);
      await service.shutdown();
    });

    it('restores the tab when Chromium announces the download after it aborts the load', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-after-stop',
        url: 'http://localhost:3000',
      });
      webContents.emit('did-finish-load');
      webContents.emit('did-start-loading');
      webContents.emit('did-stop-loading');
      expect(shown(service)).toMatchObject({ status: 'loading' });
      startDownload(service, 'http://localhost:3000/report.csv');

      expect(shown(service)).toMatchObject({
        url: 'http://localhost:3000',
        status: 'ready',
        loading: false,
        lastError: undefined,
      });
      await service.shutdown();
    });

    it('has navigate wait for the announcement, so it returns the tab as it was', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-navigate-late',
        url: 'http://localhost:3000',
      });
      webContents.emit('did-finish-load');
      jest.mocked(sendToWindow).mockClear();
      webContents.loadURL.mockImplementationOnce((url: string) => {
        webContents.emit('did-start-loading');
        webContents.emit('did-stop-loading');
        return Promise.reject(
          Object.assign(new Error(`ERR_FAILED (-2) loading '${url}'`), {
            errno: -2,
          }),
        );
      });
      let returned = false;
      const pending = service
        .navigate({
          browserId: 'download-navigate-late',
          url: 'http://localhost:3000/report.csv',
        })
        .then((snapshot) => {
          returned = true;
          return { ...snapshot };
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
      startDownload(service, 'http://localhost:3000/report.csv');

      await expect(pending).resolves.toMatchObject({
        url: 'http://localhost:3000',
        status: 'ready',
        loading: false,
        lastError: undefined,
      });
      expect(
        jest
          .mocked(sendToWindow)
          .mock.calls.some(
            ([, , event]) =>
              typeof event === 'object' &&
              event !== null &&
              'type' in event &&
              event.type === 'load-failed',
          ),
      ).toBe(false);
      await service.shutdown();
    });

    it('does not fail the navigate when its aborted load is still the one the tab is on', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-first-load',
        url: 'http://localhost:3000',
      });
      webContents.emit('did-finish-load');
      // Nothing is showing, so the tab still names the address it was sent to.
      webContents.currentUrl = '';
      webContents.loadURL.mockImplementationOnce((url: string) => {
        webContents.emit('did-start-loading');
        webContents.emit('did-stop-loading');
        return Promise.reject(
          Object.assign(new Error(`ERR_FAILED (-2) loading '${url}'`), {
            errno: -2,
          }),
        );
      });
      const pending = service.navigate({
        browserId: 'download-first-load',
        url: 'http://localhost:3000/report.csv',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      startDownload(service, 'http://localhost:3000/report.csv');

      await expect(pending).resolves.toMatchObject({
        status: 'ready',
        loading: false,
        lastError: undefined,
      });
      await service.shutdown();
    });

    it('still leaves a stopped load that saved nothing as it was', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-none',
        url: 'http://localhost:3000',
      });
      webContents.emit('did-finish-load');
      // A download that began outside any load says nothing about the next one.
      startDownload(service, 'blob:http://localhost:3000/1');
      webContents.emit('did-start-loading');
      webContents.emit('did-stop-loading');

      expect(shown(service)).toMatchObject({
        status: 'loading',
        loading: false,
      });
      await service.shutdown();
    });

    it('does not mark a navigate to a file that downloads as a failed load', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-navigate',
        url: 'http://localhost:3000',
      });
      webContents.emit('did-finish-load');
      jest.mocked(sendToWindow).mockClear();
      webContents.loadURL.mockImplementationOnce((url: string) => {
        // The page stays where it was: the response is saved, not shown.
        webContents.emit('did-start-loading');
        startDownload(service, url);
        webContents.emit('did-stop-loading');
        return Promise.reject(
          Object.assign(new Error(`ERR_FAILED (-2) loading '${url}'`), {
            errno: -2,
            code: 'ERR_FAILED',
          }),
        );
      });

      const snapshot = await service.navigate({
        browserId: 'download-navigate',
        url: 'http://localhost:3000/report.csv',
      });

      expect(snapshot).toMatchObject({
        url: 'http://localhost:3000',
        status: 'ready',
        loading: false,
        lastError: undefined,
      });
      expect(shown(service)).toMatchObject({
        url: 'http://localhost:3000',
        status: 'ready',
      });
      expect(
        jest
          .mocked(sendToWindow)
          .mock.calls.some(
            ([, , event]) =>
              typeof event === 'object' &&
              event !== null &&
              'type' in event &&
              event.type === 'load-failed',
          ),
      ).toBe(false);
      await service.shutdown();
    });

    it('still fails a navigate that was aborted without a download', async () => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'download-aborted',
        url: 'http://localhost:3000',
      });
      webContents.emit('did-finish-load');
      startDownload(service, 'blob:http://localhost:3000/1');
      webContents.loadURL.mockImplementationOnce((url: string) =>
        Promise.reject(
          Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), {
            errno: -3,
          }),
        ),
      );

      await expect(
        service.navigate({
          browserId: 'download-aborted',
          url: 'http://localhost:3000/next',
        }),
      ).resolves.toMatchObject({ status: 'failed' });
      await service.shutdown();
    });

    it.each([
      ['after its request was reported aborted', true],
      ['before its request is reported aborted', false],
    ])(
      'does not count the saved response as a failed request, %s',
      async (_name, failedFirst) => {
        const service = new BrowserService({ getWindow: mockWindow });
        const browserId = `download-request-${String(failedFirst)}`;
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId,
          url: 'http://localhost:3000',
        });
        installNativePipeline();
        const debuggerMessage = webContents.debugger.on.mock.calls.find(
          ([event]) => event === 'message',
        )?.[1];
        const url = 'http://localhost:3000/report.csv?token=1';
        for (const requestId of ['saved', 'other'])
          debuggerMessage?.({}, 'Network.requestWillBeSent', {
            requestId,
            type: 'Document',
            request: {
              method: 'GET',
              url: requestId === 'saved' ? url : `${url}&other=1`,
            },
          });
        debuggerMessage?.({}, 'Network.responseReceived', {
          requestId: 'saved',
          response: { status: 200, statusText: 'OK', mimeType: 'text/csv' },
        });
        const abort = (requestId: string): void =>
          debuggerMessage?.({}, 'Network.loadingFailed', {
            requestId,
            errorText: 'net::ERR_ABORTED',
            canceled: true,
          });
        if (failedFirst) abort('saved');
        startDownload(service, url);
        if (!failedFirst) abort('saved');
        // A request that was aborted for any other reason still failed.
        abort('other');

        const entries = service.getNetwork({ browserId });
        expect(
          entries.find((entry) => entry.requestId === 'saved'),
        ).toMatchObject({ url, status: 200, failed: false });
        expect(
          entries.find((entry) => entry.requestId === 'saved')?.errorText,
        ).toBeUndefined();
        expect(
          entries.find((entry) => entry.requestId === 'other'),
        ).toMatchObject({ failed: true, errorText: 'net::ERR_ABORTED' });
        await service.shutdown();
      },
    );
  });

  it.each([
    [
      -6,
      'net::ERR_FILE_NOT_FOUND',
      "Couldn't open missing report.html. The file wasn't found.",
    ],
    [
      -10,
      'net::ERR_ACCESS_DENIED',
      "Couldn't open missing report.html. Access was denied.",
    ],
  ])(
    'describes local file load failure %s',
    async (errorCode, description, expected) => {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: `browser-file-error-${errorCode}`,
        url: 'file:///tmp/missing%20report.html',
      });

      webContents.emit(
        'did-fail-load',
        {},
        errorCode,
        description,
        'file:///tmp/missing%20report.html',
        true,
      );

      expect(
        service.listWorktreeBrowsers('project-1', 'worktree-1')[0],
      ).toEqual(
        expect.objectContaining({ status: 'failed', lastError: expected }),
      );
    },
  );

  it('returns a loading snapshot when a local page load does not settle', async () => {
    webContents.loadURL.mockImplementationOnce((url: string) => {
      webContents.currentUrl = url;
      return new Promise<void>(() => {});
    });
    const service = new BrowserService({
      getWindow: mockWindow,
    });

    const createPromise = service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-pending-load',
      url: 'http://localhost:3000',
    });
    const snapshot = await createPromise;

    expect(snapshot).toMatchObject({
      id: 'browser-pending-load',
      url: 'http://localhost:3000',
      status: 'loading',
      loading: true,
      lastError: undefined,
    });
    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({
        id: 'browser-pending-load',
        status: 'loading',
      }),
    ]);
  });

  it('marks the snapshot failed and emits an event when the browser becomes unresponsive', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-unresponsive',
      url: 'http://localhost:3000',
    });
    jest.useFakeTimers();
    jest.mocked(sendToWindow).mockClear();
    jest.mocked(saveWorktreeBrowserState).mockClear();

    webContents.emit('unresponsive');
    await jest.advanceTimersByTimeAsync(250);

    const [snapshot] = service.listWorktreeBrowsers('project-1', 'worktree-1');
    expect(snapshot).toMatchObject({
      id: 'browser-unresponsive',
      status: 'failed',
      loading: false,
      lastError: 'Embedded browser became unresponsive.',
    });
    const failedEvent = sentBrowserEvents().find(
      (event) =>
        event.type === 'load-failed' &&
        event.browserId === 'browser-unresponsive',
    );
    expect(failedEvent).toMatchObject({
      type: 'load-failed',
      browserId: 'browser-unresponsive',
      snapshot: {
        status: 'failed',
        lastError: 'Embedded browser became unresponsive.',
      },
    });
    expect(lastSavedBrowserState().browsers).toContainEqual(
      expect.objectContaining({
        id: 'browser-unresponsive',
        status: 'failed',
        lastError: 'Embedded browser became unresponsive.',
      }),
    );
  });

  it('filters Electron security warnings from captured CDP console output', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-console-filter',
      url: 'http://localhost:3000',
    });
    const debugCalls = webContents.debugger.on.mock.calls;
    const debugMessage = debugCalls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    expect(debugMessage).toBeDefined();

    debugMessage?.({}, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [
        {
          value:
            '%cElectron Security Warning (Insecure Content-Security-Policy)',
        },
      ],
    });
    debugMessage?.({}, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'site warning' }],
    });

    expect(
      service
        .getConsole({ browserId: 'browser-console-filter' })
        .map((entry) => entry.text),
    ).toEqual(['site warning']);
  });

  it('captures the uncaught exception message, not only "Uncaught"', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-console-exception',
      url: 'http://localhost:3000',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];

    debugMessage?.({}, 'Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: {
          description:
            "TypeError: Cannot read properties of undefined (reading 'xyz')\n    at loadError",
        },
      },
    });
    debugMessage?.({}, 'Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught SyntaxError' },
    });

    expect(
      service
        .getConsole({ browserId: 'browser-console-exception' })
        .map((entry) => entry.text),
    ).toEqual([
      "Uncaught TypeError: Cannot read properties of undefined (reading 'xyz')\n    at loadError",
      'Uncaught SyntaxError',
    ]);
  });

  it('does not report pick mode enabled when the preload command fails', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-pick-failure',
      url: 'http://localhost:3000',
    });
    webContents.send.mockImplementationOnce(
      (channel: string, command: { requestId: string }) => {
        ipcListeners.get('canopy-browser-view:result')?.(
          { sender: { id: webContents.id } },
          { requestId: command.requestId, ok: false, error: 'preload failed' },
        );
      },
    );

    await expect(service.setPickMode(snapshot.id, true)).rejects.toThrow(
      'preload failed',
    );

    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({ id: snapshot.id, pickMode: false }),
    ]);
  });

  it('does not report recording enabled when the preload command fails', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-recording-failure',
      url: 'http://localhost:3000',
    });
    webContents.send.mockImplementationOnce(
      (channel: string, command: { requestId: string }) => {
        ipcListeners.get('canopy-browser-view:result')?.(
          { sender: { id: webContents.id } },
          { requestId: command.requestId, ok: false, error: 'preload failed' },
        );
      },
    );

    await expect(service.startRecording(snapshot.id)).rejects.toThrow(
      'preload failed',
    );

    expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual([
      expect.objectContaining({ id: snapshot.id, recording: false }),
    ]);
    expect(service.getRecording(snapshot.id).steps).toEqual([]);
  });

  it('restores recording listeners after a full page load', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-recording-restore',
      url: 'http://localhost:3000',
    });
    await service.startRecording(snapshot.id);
    webContents.send.mockClear();

    webContents.emit('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));

    expect(webContents.send).toHaveBeenCalledWith(
      'canopy-browser-view:command',
      expect.objectContaining({
        type: 'setRecording',
        payload: {
          browserId: 'browser-recording-restore',
          enabled: true,
        },
      }),
    );
  });

  it('bounds network timing state with the network diagnostic records', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-network-bound',
      url: 'http://localhost:3000',
    });
    const debugCalls = webContents.debugger.on.mock.calls;
    const debugMessage = debugCalls.find(
      ([eventName]) => eventName === 'message',
    )?.[1];
    expect(debugMessage).toBeDefined();

    for (let index = 0; index < 1005; index += 1) {
      debugMessage?.({}, 'Network.requestWillBeSent', {
        requestId: `request-${index}`,
        request: {
          method: 'GET',
          url: `http://localhost:3000/${index}`,
        },
      });
    }
    debugMessage?.({}, 'Network.responseReceived', {
      requestId: 'request-0',
      response: {
        url: 'http://localhost:3000/0',
        status: 200,
      },
    });

    const entries = service.getNetwork({
      browserId: 'browser-network-bound',
      limit: 2000,
    });
    expect(entries).toHaveLength(1000);
    expect(entries.find((entry) => entry.requestId === 'request-0')).toEqual(
      expect.objectContaining({
        requestId: 'request-0',
        durationMs: undefined,
      }),
    );
  });

  it('does not rebind a restored task using an older incarnation maintenance preview', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const tab = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'restored-maintenance-tab',
    });
    if (!tab.profile) throw new Error('Missing profile');
    await service.disposeLiveView(tab.id);
    const authority = getBrowserProfileService();
    const { profile } = await authority.resolve(
      tab.projectId,
      tab.worktreeId,
      tab,
    );
    const profileModule = jest.requireMock<{
      getBrowserProfileService: typeof getBrowserProfileService;
    }>('../browser/browser-profile-service');
    const spy = jest
      .spyOn(profileModule, 'getBrowserProfileService')
      .mockReturnValue({
        ...authority,
        repository: { get: jest.fn().mockResolvedValue(profile) },
      } as unknown as ReturnType<typeof getBrowserProfileService>);
    jest.mocked(saveWorktreeBrowserState).mockClear();
    try {
      await service.rebindProfileViews(
        {
          profileId: profile.profileId,
          storageGeneration: 1,
          tabs: [
            {
              browserId: tab.id,
              projectId: tab.projectId,
              worktreeId: tab.worktreeId,
              runtimeGeneration: tab.profile.runtimeGeneration,
              taskIncarnationId: 'retired-incarnation',
            },
          ],
        } as BrowserClearPreview,
        1,
      );
      expect(saveWorktreeBrowserState).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await service.shutdown();
    }
  });

  it('does not resume a tab using an older task incarnation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const tab = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'old-resume',
    });
    if (!tab.profile) throw new Error('Missing profile');
    await service.disposeLiveView(tab.id);
    jest.mocked(saveWorktreeBrowserState).mockClear();
    await service.resumeProfileViews([
      {
        snapshot: {
          ...tab,
          profile: { ...tab.profile, taskIncarnationId: 'retired-incarnation' },
        },
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        visible: false,
        cornerRadii: {
          topLeft: 0,
          topRight: 0,
          bottomRight: 0,
          bottomLeft: 0,
        },
      },
    ]);
    expect(service.captureProfileViews(tab.profile.resolvedProfileId)).toEqual(
      [],
    );
    expect(saveWorktreeBrowserState).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('does not republish a maintenance restore admitted before permanent destroy', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const original = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'resume-destroy-acquire-race',
    });
    if (!original.profile) throw new Error('Missing profile');
    const [captured] = service.captureProfileViews(
      original.profile.resolvedProfileId,
    );
    if (!captured) throw new Error('Missing captured browser view');
    await service.disposeProfileViews(original.profile.resolvedProfileId);

    const acquire = authority.acquireSession.bind(authority);
    let releaseAcquire!: () => void;
    let acquired!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    const acquisitionStarted = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    authority.acquireSession = jest.fn(async (resolution) => {
      acquired();
      await acquisitionGate;
      return acquire(resolution);
    });

    const resume = service.resumeProfileViews([captured]);
    try {
      await acquisitionStarted;
      await service.destroy(original.id);
      expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual(
        [],
      );
      expect(lastSavedBrowserState().browsers).toEqual([]);

      releaseAcquire();
      await resume;
      expect({
        browsers: service.listWorktreeBrowsers('project-1', 'worktree-1'),
        savedBrowsers: lastSavedBrowserState().browsers,
      }).toEqual({ browsers: [], savedBrowsers: [] });
    } finally {
      releaseAcquire();
      await resume;
      await service.shutdown();
    }
  });

  it('does not republish a maintenance restore after permanent destroy during navigation', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const original = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'resume-destroy-navigation-race',
      url: 'http://localhost/resume-destroy-navigation-race',
    });
    if (!original.profile) throw new Error('Missing profile');
    const [captured] = service.captureProfileViews(
      original.profile.resolvedProfileId,
    );
    if (!captured) throw new Error('Missing captured browser view');
    await service.disposeProfileViews(original.profile.resolvedProfileId);

    let releaseNavigation!: () => void;
    let navigating!: () => void;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    const navigationStarted = new Promise<void>((resolve) => {
      navigating = resolve;
    });
    setupNextCreatedView = (contents): void => {
      contents.loadURL.mockImplementation((url: string) => {
        contents.currentUrl = url;
        contents.emit('did-navigate', {}, url);
        navigating();
        return navigationGate;
      });
    };

    const resume = service.resumeProfileViews([captured]);
    try {
      await navigationStarted;
      await service.destroy(original.id);
      expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual(
        [],
      );
      expect(lastSavedBrowserState().browsers).toEqual([]);

      releaseNavigation();
      await resume;
      expect({
        browsers: service.listWorktreeBrowsers('project-1', 'worktree-1'),
        savedBrowsers: lastSavedBrowserState().browsers,
      }).toEqual({ browsers: [], savedBrowsers: [] });
    } finally {
      setupNextCreatedView = undefined;
      releaseNavigation();
      await resume;
      await service.shutdown();
    }
  });

  it('rejects a captured queued epoch after bounded restoration advances, then closes the current epoch through IPC', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    let releaseNavigation!: () => void;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    let resume: Promise<void> | undefined;
    try {
      const originals = [];
      for (let index = 0; index < 5; index += 1) {
        originals.push(
          await service.create({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId: `bounded-restore-${index}`,
            url: `http://localhost/bounded-restore/${index}`,
          }),
        );
      }
      const target = originals[4];
      if (!target.profile) throw new Error('Missing profile');
      const profileId = target.profile.resolvedProfileId;
      const captured = service.captureProfileViews(
        target.profile.resolvedProfileId,
      );
      expect(captured).toHaveLength(5);
      await service.disposeProfileViews(target.profile.resolvedProfileId);
      registerBrowserHandlers(mockWindow, service);
      const destroyIpc = ipcHandlers.get(IPC_CHANNELS.browserDestroy);
      if (!destroyIpc) throw new Error('Missing real browser destroy IPC');

      let firstFourStarted!: () => void;
      let fifthStarted!: () => void;
      const firstFour = new Promise<void>((resolve) => {
        firstFourStarted = resolve;
      });
      const fifth = new Promise<void>((resolve) => {
        fifthStarted = resolve;
      });
      const restoring: MockWebContents[] = [];
      const prepareView = (contents: MockWebContents): void => {
        // The existing one-view hook clears itself; re-arm it for this batch.
        setupNextCreatedView = prepareView;
        contents.loadURL.mockImplementation((url: string) => {
          contents.currentUrl = url;
          contents.emit('did-navigate', {}, url);
          restoring.push(contents);
          if (restoring.length === 4) firstFourStarted();
          if (restoring.length === 5) fifthStarted();
          return navigationGate;
        });
      };
      setupNextCreatedView = prepareView;
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
      resume = service.resumeProfileViews(captured);
      void resume.catch(() => undefined);
      await firstFour;
      const readTarget = (): BrowserSessionSnapshot | undefined =>
        service
          .listWorktreeBrowsers('project-1', 'worktree-1')
          .find((tab) => tab.id === target.id);
      const earlier = readTarget();
      expect(restoring).toHaveLength(4);
      expect(earlier?.profile?.runtimeGeneration).toBe(
        target.profile.runtimeGeneration,
      );

      // Held native loads are not a durable four-worker queue barrier.
      await jest.advanceTimersByTimeAsync(1500);
      await fifth;
      const current = readTarget();
      expect(restoring).toHaveLength(5);
      expect(current?.profile?.runtimeGeneration).toBe(
        target.profile.runtimeGeneration + 1,
      );
      const savesBeforeRejection = jest.mocked(saveWorktreeBrowserState).mock
        .calls.length;
      const savedBeforeRejection = lastSavedBrowserState();
      await expect(
        destroyIpc(
          {},
          {
            browserId: target.id,
            expectedRuntimeGeneration: earlier?.profile?.runtimeGeneration,
          },
        ),
      ).rejects.toMatchObject({
        code: 'stale_runtime',
        message:
          'The browser profile changed since expectedRuntimeGeneration was read. Call browser.list and use the tab’s current profile.runtimeGeneration.',
      });
      expect(readTarget()).toEqual(current);
      expect(
        service.captureProfileViews(target.profile.resolvedProfileId),
      ).toHaveLength(5);
      expect(restoring[4].close).not.toHaveBeenCalled();
      expect(saveWorktreeBrowserState).toHaveBeenCalledTimes(
        savesBeforeRejection,
      );
      expect(lastSavedBrowserState()).toEqual(savedBeforeRejection);
      expect(
        lastSavedBrowserState().browsers.some((tab) => tab.id === target.id),
      ).toBe(true);

      await destroyIpc(
        {},
        {
          browserId: target.id,
          expectedRuntimeGeneration: current?.profile?.runtimeGeneration,
        },
      );
      const survivors = originals
        .slice(0, 4)
        .map((tab) => tab.id)
        .sort();
      const assertSurvivors = (): void => {
        expect(
          service
            .listWorktreeBrowsers('project-1', 'worktree-1')
            .map((tab) => tab.id)
            .sort(),
        ).toEqual(survivors);
        expect(
          lastSavedBrowserState()
            .browsers.map((tab) => tab.id)
            .sort(),
        ).toEqual(survivors);
        expect(
          service
            .captureProfileViews(profileId)
            .map(({ snapshot }) => snapshot.id)
            .sort(),
        ).toEqual(survivors);
        expect(restoring[4].close).toHaveBeenCalledTimes(1);
        for (const contents of restoring.slice(0, 4))
          expect(contents.close).not.toHaveBeenCalled();
        expect(createdViews.slice(-5).map((view) => view.webContents)).toEqual(
          restoring,
        );
      };
      assertSurvivors();
      releaseNavigation();
      await resume;
      assertSurvivors();
    } finally {
      setupNextCreatedView = undefined;
      releaseNavigation();
      try {
        await resume;
      } finally {
        try {
          await service.shutdown();
        } finally {
          jest.useRealTimers();
        }
      }
    }
  });

  it('cancels ownerless and queued creations at permanent close while allowing later reuse', async () => {
    const authority = getBrowserProfileService();
    const service = new BrowserService({
      getWindow: mockWindow,
      profileAuthority: authority,
    });
    const survivor = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'unaffected-tab',
    });
    const acquire = authority.acquireSession.bind(authority);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    authority.acquireSession = jest.fn(async (resolution) => {
      entered();
      await gate;
      return acquire(resolution);
    });
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'ownerless-queued-close',
    };
    const first = service.create(request);
    let settled: Promise<PromiseSettledResult<Awaited<typeof first>>[]> =
      Promise.allSettled([first]);
    try {
      await started;
      const queued = service.create(request);
      settled = Promise.allSettled([first, queued]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await service.destroy(request.browserId);
      expect(
        service
          .listWorktreeBrowsers('project-1', 'worktree-1')
          .map((tab) => tab.id),
      ).toEqual([survivor.id]);
      expect(lastSavedBrowserState().browsers.map((tab) => tab.id)).toEqual([
        survivor.id,
      ]);

      release();
      expect(await settled).toEqual([
        {
          status: 'rejected',
          reason: expect.objectContaining({ code: 'stale_runtime' }) as unknown,
        },
        {
          status: 'rejected',
          reason: expect.objectContaining({ code: 'stale_runtime' }) as unknown,
        },
      ]);
      expect(
        service
          .listWorktreeBrowsers('project-1', 'worktree-1')
          .map((tab) => tab.id),
      ).toEqual([survivor.id]);
      expect(lastSavedBrowserState().browsers.map((tab) => tab.id)).toEqual([
        survivor.id,
      ]);

      const replacement = await service.create({
        ...request,
        url: 'http://localhost/later-reuse',
      });
      expect(replacement.url).toBe('http://localhost/later-reuse');
      await service.navigate({
        browserId: survivor.id,
        url: 'http://localhost/still-usable',
      });
      expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: survivor.id,
            url: 'http://localhost/still-usable',
          }),
          expect.objectContaining({
            id: replacement.id,
            url: 'http://localhost/later-reuse',
          }),
        ]),
      );
      expect(lastSavedBrowserState().browsers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: survivor.id }),
          expect.objectContaining({
            id: replacement.id,
            url: 'http://localhost/later-reuse',
          }),
        ]),
      );
    } finally {
      release();
      await settled;
      await service.shutdown();
    }
  });

  it('removes an ownerless creation whose first binding save is already pending at close', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const survivor = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'binding-save-survivor',
    });
    const request = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'pending-first-binding',
    };
    let durableState = structuredClone(lastSavedBrowserState());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let holdFirstBinding = true;
    jest.mocked(saveWorktreeBrowserState).mockImplementation(async (write) => {
      if (
        holdFirstBinding &&
        write.state.browsers.some((tab) => tab.id === request.browserId)
      ) {
        holdFirstBinding = false;
        entered();
        await gate;
      }
      durableState = structuredClone(write.state);
    });
    const creation = Promise.allSettled([service.create(request)]);
    let close: Promise<void> | undefined;
    try {
      await started;
      expect(durableState.browsers.map((tab) => tab.id)).toEqual([survivor.id]);
      expect(service.getLifecycleStats().liveViews).toBe(1);
      close = service.destroy(request.browserId);
      // Let close enqueue durable deletion before the first binding save completes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await close;
      expect(await creation).toEqual([
        {
          status: 'rejected',
          reason: expect.objectContaining({ code: 'stale_runtime' }) as unknown,
        },
      ]);
      expect({
        liveViews: service.getLifecycleStats().liveViews,
        browsers: service
          .listWorktreeBrowsers('project-1', 'worktree-1')
          .map((tab) => tab.id),
        durableBrowsers: durableState.browsers.map((tab) => tab.id),
      }).toEqual({
        liveViews: 1,
        browsers: [survivor.id],
        durableBrowsers: [survivor.id],
      });

      const replacement = await service.create({
        ...request,
        url: 'http://localhost/reused-after-binding-save',
      });
      await service.navigate({
        browserId: survivor.id,
        url: 'http://localhost/binding-survivor-usable',
      });
      expect(service.listWorktreeBrowsers('project-1', 'worktree-1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: replacement.id, url: replacement.url }),
          expect.objectContaining({
            id: survivor.id,
            url: 'http://localhost/binding-survivor-usable',
          }),
        ]),
      );
      expect(durableState.browsers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: replacement.id,
            url: 'http://localhost/reused-after-binding-save',
          }),
          expect.objectContaining({ id: survivor.id }),
        ]),
      );
      expect(service.getLifecycleStats().liveViews).toBe(2);
    } finally {
      release();
      await Promise.allSettled([creation, close]);
      await service.shutdown();
    }
  });

  it('excludes maintenance while a profile deletion fence owns admission', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.withProfileFence('shared-account', () => {
      expect(() => service.setMaintenanceFence('shared-account', true)).toThrow(
        'being changed',
      );
      return Promise.resolve();
    });
    service.setMaintenanceFence('shared-account', true);
    await expect(
      service.withProfileFence('shared-account', () => Promise.resolve()),
    ).rejects.toThrow('being changed');
    service.setMaintenanceFence('shared-account', false);
    expect(() =>
      service.assertProfileAvailable('shared-account'),
    ).not.toThrow();
    await service.shutdown();
  });

  it('captures the committed frame tree when the first navigation precedes CDP page events', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const tab = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'initial-observation',
    });
    webContents.debugger.sendCommand.mockImplementation((method) =>
      Promise.resolve(
        method === 'Page.getFrameTree'
          ? {
              frameTree: {
                frame: {
                  id: 'main',
                  url: 'https://example.test/private?query=secret',
                  domainAndRegistry: 'example.test',
                },
              },
            }
          : undefined,
      ),
    );
    webContents.emit('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));
    if (!tab.profile) throw new Error('Missing profile');
    expect(
      (service.profileData.observations.record as jest.Mock).mock.calls,
    ).toContainEqual([
      tab.profile.resolvedProfileId,
      tab.profile.storageGeneration,
      'https://example.test/private?query=secret',
      'https://example.test/private?query=secret',
      'example.test',
    ]);
    await service.shutdown();
  });

  it('records cross-process frame storage under its top-level site without navigating the tab', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const tab = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'partition-observation',
      url: 'https://first.test/',
    });
    const debugMessage = webContents.debugger.on.mock.calls.find(
      ([event]) => event === 'message',
    )?.[1];
    debugMessage?.({}, 'Page.frameNavigated', {
      frame: {
        id: 'top',
        url: 'https://first.test/',
        domainAndRegistry: 'first.test',
      },
    });
    debugMessage?.({}, 'Target.attachedToTarget', {
      sessionId: 'child-session',
      targetInfo: { type: 'iframe', targetId: 'child-target' },
    });
    debugMessage?.(
      {},
      'Page.frameNavigated',
      {
        frame: {
          id: 'child-target',
          url: 'https://embedded.test/frame',
          domainAndRegistry: 'embedded.test',
        },
      },
      'child-session',
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (!tab.profile) throw new Error('Missing profile');
    expect(
      (service.profileData.observations.record as jest.Mock).mock.calls,
    ).toContainEqual([
      tab.profile.resolvedProfileId,
      tab.profile.storageGeneration,
      'https://embedded.test/frame',
      'https://first.test/',
      'embedded.test',
    ]);
    expect(
      service
        .listWorktreeBrowsers('project-1', 'worktree-1')
        .find((value) => value.id === tab.id)?.url,
    ).toBe('https://first.test/');
    await service.shutdown();
  });

  it('resumes shared-profile tabs with bounded parallel admission', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    const snapshot = await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'resume-template',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0,
      active = 0,
      peak = 0;
    const create = jest
      .spyOn(service, 'create')
      .mockImplementation(async (request) => {
        started++;
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return { ...snapshot, id: request.browserId ?? snapshot.id };
      });
    const bounds = jest
      .spyOn(service, 'setBounds')
      .mockImplementation(() => undefined);
    const visible = jest
      .spyOn(service, 'setVisible')
      .mockImplementation(() => undefined);
    const resume = service.resumeProfileViews(
      Array.from({ length: 8 }, (_, i) => ({
        snapshot: { ...snapshot, id: `resume-${i}` },
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        visible: false,
        cornerRadii: {
          topLeft: 0,
          topRight: 0,
          bottomRight: 0,
          bottomLeft: 0,
        },
      })),
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(started).toBe(4);
      release();
      await resume;
      expect(started).toBe(8);
      expect(peak).toBe(4);
    } finally {
      release();
      await resume;
      create.mockRestore();
      bounds.mockRestore();
      visible.mockRestore();
      await service.shutdown();
    }
  });

  it('captures a selected-element screenshot for pick events', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-picked',
      url: 'http://localhost:3000',
    });
    jest.mocked(sendToWindow).mockClear();

    ipcListeners.get('canopy-browser-view:event')?.(
      { sender: { id: webContents.id } },
      {
        type: 'element-picked',
        snapshot: {
          browserId: 'browser-picked',
          url: 'http://localhost:3000',
          title: 'Test page',
          capturedAt: new Date(0).toISOString(),
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
          themeMode: 'light',
          tagName: 'button',
          attributes: {},
          bounds: { x: 12.2, y: 20.6, width: 100.4, height: 40.2 },
          locatorCandidates: [],
          domPath: ['html', 'body', 'button'],
          outerHtml: '<button>Save</button>',
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(webContents.capturePage).toHaveBeenCalledWith({
      x: 12,
      y: 21,
      width: 100,
      height: 40,
    });
    const pickedEvent = sentBrowserEvents().find(
      (event) => event.type === 'element-picked',
    );
    expect(pickedEvent?.type).toBe('element-picked');
    expect(
      pickedEvent?.type === 'element-picked'
        ? pickedEvent.snapshot.screenshotAttachmentPath
        : undefined,
    ).toMatch(/^\/browser-owned-scratch\/browser-picked-\d+\.png$/);
  });

  it('records and forwards trusted browser-page user interaction', async () => {
    const service = new BrowserService({
      getWindow: mockWindow,
    });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-interaction',
    });
    jest.mocked(sendToWindow).mockClear();

    expect(service.getUserInteractionGeneration()).toBe(0);
    ipcListeners.get('canopy-browser-view:event')?.(
      { sender: { id: webContents.id } },
      { type: 'user-interaction' },
    );

    expect(service.getUserInteractionGeneration()).toBe(1);
    expect(sentBrowserEvents()).toContainEqual({
      type: 'user-interaction',
      browserId: 'browser-interaction',
      runtimeGeneration: 1,
    });
  });
  describe('phase 06 form actions in the input lane', () => {
    function stubAlgorithm(
      kind: 'type' | 'set_checked' | 'select_option',
      run: (options: FormActionOptions) => Promise<FormActionResult>,
    ): void {
      if (kind === 'type')
        jest.spyOn(TypeActions, 'runType').mockImplementation(run);
      else if (kind === 'set_checked')
        jest.spyOn(CheckActions, 'runSetChecked').mockImplementation(run);
      else jest.spyOn(SelectActions, 'runSelectOption').mockImplementation(run);
    }
    async function formService(browserId: string): Promise<BrowserService> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost/form',
      });
      installNativePipeline();
      jest
        .spyOn(PageModelHost.prototype, 'hostActionTarget')
        .mockImplementation((target) =>
          Promise.resolve({
            ...target,
            objectId: 'host-target',
          }),
        );
      return service;
    }

    const commands = [
      { kind: 'set_checked', ref: 'r', checked: true },
      { kind: 'select_option', ref: 'r', values: ['amber'] },
      { kind: 'type', ref: 'r', text: 'next' },
    ] as const;

    it.each(commands)(
      'runs $kind with a receipt and replays its actionId without dispatch',
      async (example) => {
        const service = await formService(`form-replay-${example.kind}`);
        const run = jest.fn(
          async (options: FormActionOptions): Promise<FormActionResult> => {
            expect(options.target.objectId).toBe('host-target');
            if (example.kind === 'set_checked')
              await options.click({
                objectId: options.target.objectId,
                backendNodeId: options.target.identity.backendNodeId,
              });
            else if (example.kind === 'type') {
              await options.focus();
              options.beforeInput?.({
                type: 'keyDown',
                key: 'n',
                timestamp: Date.now(),
              });
              await options.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: 'n',
              });
            } else {
              options.lane.beginDispatch();
              await options.send('Runtime.callFunctionOn', {
                objectId: options.target.objectId,
                functionDeclaration:
                  'function(){ this.dispatchEvent(new Event("change")); }',
                userGesture: true,
              });
            }
            return {
              inputMode:
                example.kind === 'select_option' ? 'direct' : 'trusted',
              readback: { code: 'state_unchanged' },
              warnings: ['The page kept its previous state.'],
            };
          },
        );
        stubAlgorithm(example.kind, run);
        modelSeam.describeActionTarget.mockResolvedValue({
          ...DESCRIBED_TARGET,
          value: 'observed',
          checked: 'mixed',
          selectedOptions: [{ value: 'amber', label: 'Amber' }],
          invalid: true,
          validationMessage: 'Choose a value.',
        });
        const command =
          example.kind === 'select_option'
            ? {
                ...example,
                values: [...example.values],
                actionId: 'form-once',
              }
            : { ...example, actionId: 'form-once' };
        const first = await service.automation({
          browserId: `form-replay-${example.kind}`,
          command,
        });
        const replay = await service.automation({
          browserId: `form-replay-${example.kind}`,
          command,
        });
        expect(first).toMatchObject({
          ok: true,
          completed: true,
          receipt: {
            kind: example.kind,
            status: 'executed',
            readback: { code: 'state_unchanged' },
            target: {
              value: 'observed',
              checked: 'mixed',
              selectedOptions: [{ value: 'amber', label: 'Amber' }],
              invalid: true,
              validationMessage: 'Choose a value.',
            },
          },
        });
        expect(replay.repeated).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
        expect(modelSeam.resolveActionTarget).toHaveBeenCalledTimes(1);
        expect(modelSeam.releaseActionTarget).toHaveBeenCalledTimes(1);
        await service.shutdown();
      },
    );

    it.each(commands)(
      'returns an executed receipt with no input mode when $kind sends nothing',
      async (example) => {
        const service = await formService(`form-no-input-${example.kind}`);
        const run = jest.fn(
          (): Promise<FormActionResult> =>
            Promise.resolve({ target: { checked: false } }),
        );
        stubAlgorithm(example.kind, run);
        modelSeam.describeActionTarget.mockResolvedValue({
          ...DESCRIBED_TARGET,
          checked: false,
        });
        const command =
          example.kind === 'select_option'
            ? { ...example, values: [...example.values] }
            : example;
        const result = await service.automation({
          browserId: `form-no-input-${example.kind}`,
          command,
        });
        expect(result).toMatchObject({
          ok: true,
          completed: true,
          receipt: {
            kind: example.kind,
            status: 'executed',
            target: { checked: false },
          },
        });
        expect(result.receipt?.inputMode).toBeUndefined();
        expect(result.receipt?.warnings).toBeUndefined();
        expect(run).toHaveBeenCalledTimes(1);
        await service.shutdown();
      },
    );

    it.each(commands)(
      'describes the target of $kind as secret when it was secret before input',
      async (example) => {
        const service = await formService(
          `form-secret-describe-${example.kind}`,
        );
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        stubAlgorithm(
          example.kind,
          (): Promise<FormActionResult> => Promise.resolve({}),
        );
        const command =
          example.kind === 'select_option'
            ? { ...example, values: [...example.values] }
            : example;
        await service.automation({
          browserId: `form-secret-describe-${example.kind}`,
          command,
        });
        expect(modelSeam.describeActionTarget.mock.calls.at(-1)?.[1]).toEqual({
          secret: true,
        });
        await service.shutdown();
      },
    );

    it('lets select_option ask the page model again whether its target is secret', async () => {
      const service = await formService('form-refresh-secret');
      modelSeam.isActionTargetSecret
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      let refreshed: boolean | undefined;
      stubAlgorithm(
        'select_option',
        async (options): Promise<FormActionResult> => {
          refreshed = await options.refreshSecret?.();
          return {};
        },
      );
      await service.automation({
        browserId: 'form-refresh-secret',
        command: { kind: 'select_option', ref: 'r', values: ['amber'] },
      });
      expect(refreshed).toBe(true);
      await service.shutdown();
    });

    it.each(commands)(
      'cancels $kind after its dispatch boundary',
      async (example) => {
        const service = await formService(`form-stop-${example.kind}`);
        const controller = new AbortController();
        stubAlgorithm(example.kind, async (options) => {
          options.lane.beginDispatch();
          await options.send('DOM.focus', {
            objectId: options.target.objectId,
          });
          controller.abort(new Error('Stopped after input.'));
          options.lane.signal.throwIfAborted();
          return { inputMode: 'trusted' };
        });
        const command =
          example.kind === 'select_option'
            ? { ...example, values: [...example.values] }
            : example;
        const result = await service.automation(
          { browserId: `form-stop-${example.kind}`, command },
          controller.signal,
        );
        expect(result).toMatchObject({
          ok: true,
          completed: false,
          receipt: {
            kind: example.kind,
            status: 'outcome_unknown',
            outcomeReason: 'stopped_after_dispatch',
          },
        });
        await service.shutdown();
      },
    );

    it.each(commands)(
      'fences $kind before input when its frame document changed',
      async (example) => {
        const service = await formService(`form-fence-${example.kind}`);
        modelSeam.isTargetDocumentCurrent.mockReturnValue(false);
        const run = jest.fn(
          (): Promise<FormActionResult> => Promise.resolve({}),
        );
        stubAlgorithm(example.kind, run);
        const command =
          example.kind === 'select_option'
            ? { ...example, values: [...example.values] }
            : example;
        const result = await service.automation({
          browserId: `form-fence-${example.kind}`,
          command,
        });
        expect(result).toMatchObject({
          ok: false,
          receipt: {
            status: 'not_executed',
            error: { code: 'frame_unavailable' },
          },
        });
        expect(run).not.toHaveBeenCalled();
        await service.shutdown();
      },
    );

    it.each(commands)(
      'fences $kind between input events after dispatch',
      async (example) => {
        const service = await formService(`form-fence-stop-${example.kind}`);
        stubAlgorithm(example.kind, async (options) => {
          options.lane.beginDispatch();
          await options.send('DOM.focus', {
            objectId: options.target.objectId,
          });
          modelSeam.isTargetDocumentCurrent.mockReturnValue(false);
          await options.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'x',
          });
          return { inputMode: 'trusted' };
        });
        const command =
          example.kind === 'select_option'
            ? { ...example, values: [...example.values] }
            : example;
        const result = await service.automation({
          browserId: `form-fence-stop-${example.kind}`,
          command,
        });
        expect(result).toMatchObject({
          ok: true,
          completed: false,
          receipt: { status: 'outcome_unknown' },
        });
        expect(
          webContents.debugger.sendCommand.mock.calls.some(
            ([method]) => method === 'Input.dispatchKeyEvent',
          ),
        ).toBe(false);
        await service.shutdown();
      },
    );

    it.each([false, true])(
      'refuses native selects and file controls even with force=%s',
      async (force) => {
        const service = await formService(`form-click-${force}`);
        const native = webContents.debugger.sendCommand.getMockImplementation();
        let kind = 'select';
        webContents.debugger.sendCommand.mockImplementation(
          async (method, params) => {
            if (
              method === 'Runtime.callFunctionOn' &&
              String(params?.functionDeclaration).includes("kind: 'select'")
            )
              return {
                result: {
                  value: {
                    kind,
                    options: [
                      {
                        value: 'amber',
                        label: 'Amber',
                        selected: false,
                        disabled: false,
                      },
                    ],
                  },
                },
              };
            return native?.(method, params) ?? {};
          },
        );
        const result = await service.automation({
          browserId: `form-click-${force}`,
          command: { kind: 'click', ref: 'r', force },
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'invalid_target' },
          receipt: {
            status: 'not_executed',
            error: {
              code: 'unsupported_control',
              next: 'browser.select_option',
              options: [{ label: 'Amber' }],
            },
          },
        });
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        const secret = await service.automation({
          browserId: `form-click-${force}`,
          command: { kind: 'click', ref: 'r', force },
        });
        expect(secret.receipt?.error).toMatchObject({
          code: 'unsupported_control',
          candidatesRedacted: true,
        });
        expect(secret.receipt?.error?.options).toBeUndefined();
        kind = 'file';
        const file = await service.automation({
          browserId: `form-click-${force}`,
          command: { kind: 'click', ref: 'r', force },
        });
        expect(file.receipt?.error).toMatchObject({
          code: 'unsupported_control',
          message:
            'Use browser.upload_files to attach files, or browser.request_files to ask the user to choose them.',
        });
        expect(file.receipt?.error?.next).toBe('browser.upload_files');
        expect(
          webContents.debugger.sendCommand.mock.calls.some(([method]) =>
            method.startsWith('Input.'),
          ),
        ).toBe(false);
        await service.shutdown();
      },
    );

    it.each(['unsupported_control', 'option_not_found'] as const)(
      'maps %s and preserves its receipt details',
      async (code) => {
        const service = await formService(`form-map-${code}`);
        const options = [
          { value: 'amber', label: 'Amber', selected: false, disabled: false },
        ];
        stubAlgorithm('select_option', (): Promise<FormActionResult> => {
          throw new FormActionError({
            code,
            message: 'Choose an available option.',
            retryable: false,
            options,
          });
        });
        const result = await service.automation({
          browserId: `form-map-${code}`,
          command: { kind: 'select_option', ref: 'r', values: ['missing'] },
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code:
              code === 'unsupported_control'
                ? 'invalid_target'
                : 'validation_failed',
            details: { error: { code, options } },
          },
          receipt: { status: 'not_executed', error: { code, options } },
        });
        await service.shutdown();
      },
    );

    it.each(
      (['fill', 'type'] as const).flatMap((kind) =>
        [
          'first\nsecond',
          'first\r\nsecond',
          "it's a \\ path\u2028and more",
        ].map((text, index) => ({ kind, text, index })),
      ),
    )(
      'records a $kind of text $index, with line breaks, quotes, and backslashes, as a script that gives the text back',
      async ({ kind, text, index }) => {
        const browserId = `form-record-lines-${kind}-${index}`;
        const service = await formService(browserId);
        await service.startRecording(browserId);
        jest
          .spyOn(PageModelHost.prototype, 'recordingLocator')
          .mockResolvedValue("page.locator('#editor')");
        const run = async (
          options: FormActionOptions,
        ): Promise<FormActionResult> => {
          options.onEditor?.();
          options.lane.beginDispatch();
          await options.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            text: 'E',
          });
          return { inputMode: 'trusted', editor: true };
        };
        if (kind === 'fill')
          jest.spyOn(FillActions, 'runFill').mockImplementation(run);
        else jest.spyOn(TypeActions, 'runType').mockImplementation(run);
        await service.automation({
          browserId,
          command: { kind, ref: 'r', text },
        });
        const step = service
          .getRecording(browserId)
          .steps.find((candidate) => candidate.value === text);
        const received: unknown[] = [];
        const locator = {
          fill: (value: unknown): void => {
            received.push(value);
          },
          pressSequentially: (value: unknown): void => {
            received.push(value);
          },
        };
        await runInNewContext(`(async () => { ${step?.playwright ?? ''} })()`, {
          page: { locator: () => locator },
        });
        expect(received).toEqual([text]);
        await service.shutdown();
      },
    );

    it.each([
      ['becomes secret during the action', 'after-input'],
      ['sends its input to a secret editing host', 'editing-host'],
    ] as const)(
      'records no editor step whose target %s',
      async (_case, trigger) => {
        const browserId = `form-record-secret-${trigger}`;
        const service = await formService(browserId);
        await service.startRecording(browserId);
        jest
          .spyOn(PageModelHost.prototype, 'recordingLocator')
          .mockResolvedValue("page.locator('#editor')");
        const editingHost = {
          ...seamTarget('native-target'),
          objectId: 'editing-host',
        };
        let checks = 0;
        modelSeam.isActionTargetSecret.mockImplementation((candidate) => {
          checks += 1;
          if (trigger === 'after-input') return Promise.resolve(checks > 1);
          return Promise.resolve(candidate.objectId === 'editing-host');
        });
        jest
          .spyOn(TypeActions, 'runType')
          .mockImplementation(async (options) => {
            options.onEditor?.();
            options.lane.beginDispatch();
            await options.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              text: '9',
            });
            return {
              inputMode: 'trusted',
              editor: true,
              ...(trigger === 'editing-host'
                ? { recordingTarget: editingHost }
                : {}),
            };
          });
        await service.automation({
          browserId,
          command: { kind: 'type', ref: 'r', text: '987654' },
        });
        expect(recordingText(service.getRecording(browserId))).not.toContain(
          '987654',
        );
        await service.shutdown();
      },
    );

    it('keeps the secrecy of the editing host an action redirects its input to, read before input', async () => {
      const browserId = 'form-host-secret-before';
      const service = await formService(browserId);
      await service.startRecording(browserId);
      jest
        .spyOn(PageModelHost.prototype, 'recordingLocator')
        .mockResolvedValue("page.locator('#editor')");
      const editingHost = {
        ...seamTarget('native-target'),
        objectId: 'editing-host',
      };
      // Only the editing host is secret, and only until it is focused.
      let hostChecks = 0;
      modelSeam.isActionTargetSecret.mockImplementation((candidate) => {
        if (candidate.objectId !== 'editing-host')
          return Promise.resolve(false);
        hostChecks += 1;
        return Promise.resolve(hostChecks === 1);
      });
      jest.spyOn(TypeActions, 'runType').mockImplementation(async (options) => {
        await options.classifyInputTarget?.(editingHost);
        options.onEditor?.();
        options.lane.beginDispatch();
        await options.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: 'X',
        });
        return {
          inputMode: 'trusted',
          editor: true,
          recordingTarget: editingHost,
        };
      });
      await service.automation({
        browserId,
        command: { kind: 'type', ref: 'r', text: 'TYPED-SECRET' },
      });
      expect(modelSeam.describeActionTarget.mock.calls.at(-1)?.[1]).toEqual({
        secret: true,
      });
      expect(JSON.stringify(service.getRecording(browserId))).not.toContain(
        'TYPED-SECRET',
      );
      await service.shutdown();
    });

    describe('page-recorded steps of an action on a secret target', () => {
      const OPEN = "page.getByRole('combobox', { name: 'Visa ending 4111' })";
      const OPTION = "page.getByText('4111 1111 1111 1111')";
      const pageRecorded = (
        id: string,
        locator: string,
        extra: {
          secretElement?: boolean;
          timestamp?: number;
          action?: 'click' | 'fill';
          valueRedacted?: boolean;
        } = {},
      ): void => {
        ipcListeners.get('canopy-browser-view:event')?.(
          { sender: { id: webContents.id } },
          {
            type: 'recording-step',
            step: {
              id,
              action: extra.action ?? 'click',
              locator,
              ...(extra.valueRedacted ? { valueRedacted: true } : {}),
              playwright: `await ${locator}.click();`,
              timestamp: extra.timestamp ?? Date.now(),
            },
            ...(extra.secretElement ? { secretElement: true } : {}),
          },
        );
      };
      const pageSteps = (
        service: BrowserService,
        browserId: string,
      ): ReturnType<BrowserService['getRecording']>['steps'] =>
        service
          .getRecording(browserId)
          .steps.filter((step) => step.action !== 'goto');
      const OMITTED = {
        action: 'click',
        valueRedacted: true,
        playwright: '// Secret interaction omitted from recording.',
      };

      it('replaces what the page recorded for a select_option on a secret list with one omission', async () => {
        const browserId = 'record-secret-select';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        jest
          .spyOn(SelectActions, 'runSelectOption')
          .mockImplementation((options) => {
            options.lane.beginDispatch();
            pageRecorded('open', OPEN);
            pageRecorded('option', OPTION);
            return Promise.resolve({ inputMode: 'trusted' });
          });

        await service.automation({
          browserId,
          command: { kind: 'select_option', ref: 'r', indexes: [0] },
        });

        const recorded = recordingText(service.getRecording(browserId));
        expect(recorded).not.toContain('4111');
        expect(pageSteps(service, browserId)).toEqual([
          expect.objectContaining(OMITTED),
        ]);
        expect(pageSteps(service, browserId)[0]).not.toHaveProperty('locator');
        await service.shutdown();
      });

      it('keeps what the page recorded for a select_option on a list that is not secret', async () => {
        const browserId = 'record-plain-select';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        modelSeam.isActionTargetSecret.mockResolvedValue(false);
        jest
          .spyOn(SelectActions, 'runSelectOption')
          .mockImplementation((options) => {
            options.lane.beginDispatch();
            pageRecorded('open', OPEN);
            pageRecorded('option', OPTION);
            return Promise.resolve({ inputMode: 'trusted' });
          });

        await service.automation({
          browserId,
          command: { kind: 'select_option', ref: 'r', indexes: [0] },
        });

        expect(pageSteps(service, browserId)).toEqual([
          expect.objectContaining({ id: 'open', locator: OPEN }),
          expect.objectContaining({ id: 'option', locator: OPTION }),
        ]);
        await service.shutdown();
      });

      it('keeps a step the page recorder itself treated as secret', async () => {
        const browserId = 'record-secret-field';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        jest.spyOn(FillActions, 'runFill').mockImplementation((options) => {
          options.lane.beginDispatch();
          pageRecorded('fill', "page.locator('#password')", {
            action: 'fill',
            valueRedacted: true,
            secretElement: true,
          });
          return Promise.resolve({ inputMode: 'direct' });
        });

        await service.automation({
          browserId,
          command: { kind: 'fill', ref: 'r', text: 'hunter2' },
        });

        expect(pageSteps(service, browserId)).toEqual([
          expect.objectContaining({
            id: 'fill',
            action: 'fill',
            locator: "page.locator('#password')",
            valueRedacted: true,
          }),
        ]);
        await service.shutdown();
      });

      it('drops steps reported before the list turned out secret when the combobox opened', async () => {
        const browserId = 'record-secret-on-open';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        let secret = false;
        modelSeam.isActionTargetSecret.mockImplementation(() =>
          Promise.resolve(secret),
        );
        jest
          .spyOn(SelectActions, 'runSelectOption')
          .mockImplementation(async (options) => {
            options.lane.beginDispatch();
            pageRecorded('open', OPEN);
            secret = true;
            await options.refreshSecret?.();
            pageRecorded('option', OPTION);
            return { inputMode: 'trusted' };
          });

        await service.automation({
          browserId,
          command: { kind: 'select_option', ref: 'r', indexes: [0] },
        });

        expect(recordingText(service.getRecording(browserId))).not.toContain(
          '4111',
        );
        expect(pageSteps(service, browserId)).toEqual([
          expect.objectContaining(OMITTED),
        ]);
        await service.shutdown();
      });

      it('checks the target again after input before it keeps a page step', async () => {
        const browserId = 'record-secret-after-input';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        let secret = false;
        modelSeam.isActionTargetSecret.mockImplementation(() =>
          Promise.resolve(secret),
        );
        jest
          .spyOn(SelectActions, 'runSelectOption')
          .mockImplementation((options) => {
            options.lane.beginDispatch();
            pageRecorded('option', OPTION);
            // The page marks the list secret as the click runs.
            secret = true;
            return Promise.resolve({ inputMode: 'trusted' });
          });

        await service.automation({
          browserId,
          command: { kind: 'select_option', ref: 'r', indexes: [0] },
        });

        expect(recordingText(service.getRecording(browserId))).not.toContain(
          '4111',
        );
        await service.shutdown();
      });

      it('treats the action as secret when the action itself reports it, though neither read saw it', async () => {
        const browserId = 'record-secret-by-action';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        // Not secret before the input, and not after it.
        modelSeam.isActionTargetSecret.mockResolvedValue(false);
        jest
          .spyOn(SelectActions, 'runSelectOption')
          .mockImplementation((options) => {
            options.lane.beginDispatch();
            options.markSecret?.();
            pageRecorded('select', "page.getByLabel('Holder')", {
              action: 'fill',
            });
            return Promise.resolve({ inputMode: 'direct' });
          });

        await service.automation({
          browserId,
          command: { kind: 'select_option', ref: 'r', values: ['private'] },
        });

        expect(modelSeam.describeActionTarget.mock.calls.at(-1)?.[1]).toEqual({
          secret: true,
        });
        expect(pageSteps(service, browserId)).toEqual([
          expect.objectContaining({
            valueRedacted: true,
            playwright: '// Secret interaction omitted from recording.',
          }),
        ]);
        expect(pageSteps(service, browserId)[0]).not.toHaveProperty('locator');
        await service.shutdown();
      });

      it('drops a step from a secret action that is reported after the action ended', async () => {
        const browserId = 'record-secret-late';
        const service = await formService(browserId);
        await service.startRecording(browserId);
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        let during = 0;
        jest
          .spyOn(SelectActions, 'runSelectOption')
          .mockImplementation((options) => {
            options.lane.beginDispatch();
            during = Date.now();
            return Promise.resolve({ inputMode: 'trusted' });
          });

        await service.automation({
          browserId,
          command: { kind: 'select_option', ref: 'r', indexes: [0] },
        });
        pageRecorded('late option', OPTION, { timestamp: during });
        pageRecorded('later, by the user', "page.getByText('Next')", {
          timestamp: Date.now() + 60_000,
        });

        expect(recordingText(service.getRecording(browserId))).not.toContain(
          '4111',
        );
        expect(pageSteps(service, browserId)).toEqual([
          expect.objectContaining(OMITTED),
          expect.objectContaining({ id: 'later, by the user' }),
        ]);
        await service.shutdown();
      });
    });

    it.each(['fill', 'type'] as const)(
      'does not record the text of an editor %s that stopped before it was entered',
      async (kind) => {
        const browserId = `editor-stopped-${kind}`;
        const service = await formService(browserId);
        await service.startRecording(browserId);
        jest
          .spyOn(PageModelHost.prototype, 'recordingLocator')
          .mockResolvedValue("page.locator('#editor')");
        // One character was sent, then the editor lost focus.
        const run = async (
          options: FormActionOptions,
        ): Promise<FormActionResult> => {
          options.onEditor?.();
          options.lane.beginDispatch();
          await options.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            text: 'a',
          });
          return {
            inputMode: 'trusted',
            editor: true,
            readback: { code: 'state_unchanged' },
            warnings: [
              'The editor lost focus while typing, so the rest of the text was not typed.',
            ],
          };
        };
        if (kind === 'fill')
          jest.spyOn(FillActions, 'runFill').mockImplementation(run);
        else jest.spyOn(TypeActions, 'runType').mockImplementation(run);

        await service.automation({
          browserId,
          command: { kind, ref: 'r', text: 'abc-never-typed' },
        });

        const recording = service.getRecording(browserId);
        expect(JSON.stringify(recording)).not.toContain('abc-never-typed');
        // The step says an action ran there, and replays nothing.
        expect(
          recording.steps.filter((step) => step.action !== 'goto'),
        ).toEqual([
          expect.objectContaining({
            action: kind === 'fill' ? 'fill' : 'press',
            locator: "page.locator('#editor')",
            playwright:
              kind === 'fill'
                ? '// An editor fill stopped before its text was entered; it is not replayed.'
                : '// An editor type stopped before its text was entered; it is not replayed.',
          }),
        ]);
        expect(recording.steps.at(-1)).not.toHaveProperty('value');
        await service.shutdown();
      },
    );

    it('does not record editor type when only an unsuccessful focus was sent', async () => {
      const service = await formService('editor-focus-failed');
      await service.startRecording('editor-focus-failed');
      jest
        .spyOn(PageModelHost.prototype, 'recordingLocator')
        .mockResolvedValue("page.locator('#editor')");
      jest.spyOn(TypeActions, 'runType').mockImplementation(async (options) => {
        options.onEditor?.();
        options.lane.beginDispatch();
        await options.send('DOM.focus', { objectId: options.target.objectId });
        return {
          editor: true,
          completed: true,
          inputMode: 'trusted',
          readback: { code: 'state_unchanged' },
        };
      });
      await service.automation({
        browserId: 'editor-focus-failed',
        command: { kind: 'type', ref: 'r', text: 'Never typed' },
      });
      expect(
        service
          .getRecording('editor-focus-failed')
          .steps.filter((step) => step.action === 'fill'),
      ).toEqual([]);
      await service.shutdown();
    });

    it.each([
      // A fill replaces the editor's text; a type adds to it, so it is
      // replayed as typing, not as a fill.
      ['fill', 'fill', "await page.locator('#editor').fill('Editor text');"],
      [
        'type',
        'press',
        "await page.locator('#editor').pressSequentially('Editor text');",
      ],
    ] as const)(
      'records one contenteditable step for %s, as %s, and no secret value',
      async (kind, action, playwright) => {
        const service = await formService(`form-record-${kind}`);
        await service.startRecording(`form-record-${kind}`);
        jest
          .spyOn(PageModelHost.prototype, 'recordingLocator')
          .mockResolvedValue("page.locator('#editor')");
        const run = async (
          options: FormActionOptions,
        ): Promise<FormActionResult> => {
          options.onEditor?.();
          options.lane.beginDispatch();
          await options.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            text: 'E',
          });
          ipcListeners.get('canopy-browser-view:event')?.(
            { sender: { id: webContents.id } },
            {
              type: 'recording-step',
              step: {
                id: 'preload-editor-click',
                action: 'click',
                locator: "page.locator('#editor')",
                playwright: "await page.locator('#editor').click();",
                timestamp: Date.now(),
              },
            },
          );
          return { inputMode: 'trusted', editor: true };
        };
        if (kind === 'fill')
          jest.spyOn(FillActions, 'runFill').mockImplementation(run);
        else jest.spyOn(TypeActions, 'runType').mockImplementation(run);
        const command = {
          kind,
          ref: 'r',
          text: 'Editor text',
          actionId: 'editor-once',
        };
        await service.automation({ browserId: `form-record-${kind}`, command });
        await service.automation({ browserId: `form-record-${kind}`, command });
        expect(
          service
            .getRecording(`form-record-${kind}`)
            .steps.filter((step) => step.action === action),
        ).toEqual([
          expect.objectContaining({
            locator: "page.locator('#editor')",
            value: 'Editor text',
            playwright,
          }),
        ]);
        expect(
          service
            .getRecording(`form-record-${kind}`)
            .steps.some((step) => step.id === 'preload-editor-click'),
        ).toBe(false);
        modelSeam.describeActionTarget.mockResolvedValue({
          ...DESCRIBED_TARGET,
          valueRedacted: true,
        });
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        await service.automation({
          browserId: `form-record-${kind}`,
          command: {
            ...command,
            text: 'Never record me',
            actionId: 'secret-editor',
          },
        });
        expect(
          JSON.stringify(service.getRecording(`form-record-${kind}`).steps),
        ).not.toContain('Never record me');
        await service.shutdown();
      },
    );

    it.each(commands)(
      'refuses $kind during pick mode before resolving',
      async (example) => {
        const service = new BrowserService({ getWindow: mockWindow });
        const browserId = `form-pick-${example.kind}`;
        await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId,
          url: 'http://localhost/form',
        });
        await service.setPickMode(browserId, true);
        const command =
          example.kind === 'select_option'
            ? { ...example, values: [...example.values] }
            : example;
        const result = await service.automation({ browserId, command });
        expect(result).toMatchObject({
          ok: false,
          receipt: {
            kind: example.kind,
            status: 'not_executed',
            error: {
              code: 'execution_failed',
              message:
                'The user is picking an element. Try again after they finish.',
            },
          },
        });
        expect(modelSeam.resolveActionTarget).not.toHaveBeenCalled();
        await service.shutdown();
      },
    );

    it.each(commands)('cancels $kind before dispatch', async (example) => {
      const service = new BrowserService({ getWindow: mockWindow });
      const browserId = `form-cancel-${example.kind}`;
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost/form',
      });
      const controller = new AbortController();
      controller.abort(new Error('Stopped.'));
      const command =
        example.kind === 'select_option'
          ? { ...example, values: [...example.values] }
          : example;
      const result = await service.automation(
        { browserId, command },
        controller.signal,
      );
      expect(result).toMatchObject({
        ok: false,
        receipt: {
          kind: example.kind,
          status: 'not_executed',
          error: { code: 'cancelled' },
        },
      });
      expect(modelSeam.resolveActionTarget).not.toHaveBeenCalled();
      await service.shutdown();
    });
  });

  function modelHost(
    service: BrowserService,
    browserId: string,
  ): PageModelHost {
    const sessions: unknown = Reflect.get(service, 'sessions');
    if (!(sessions instanceof Map)) throw new Error('Missing sessions.');
    const state: unknown = sessions.get(browserId);
    if (!isCDPRecord(state) || !(state.pageModel instanceof PageModelHost))
      throw new Error('Missing model host.');
    return state.pageModel;
  }

  it('runs reads and actions on the page model in production, with no E2E hook and no preload fallback', async () => {
    await withScreenshotObservationGlobals(
      false,
      () => undefined,
      async () => {
        Reflect.deleteProperty(globalThis, '__CANOPY_E2E_BROWSER_PAGE_MODEL__');
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'production-model',
          url: 'http://localhost/form',
        });
        expect(
          Object.getOwnPropertyDescriptor(
            globalThis,
            '__CANOPY_E2E_BROWSER_PAGE_MODEL__',
          ),
        ).toBeUndefined();
        const host = modelHost(service, tab.id);
        const event = jest.spyOn(host, 'noteEvent');
        const action = jest.spyOn(host, 'actionBoundary');
        const detach = jest.spyOn(host, 'detachSession');
        const dispose = jest.spyOn(host, 'dispose');
        try {
          const debugMessage = webContents.debugger.on.mock.calls.find(
            ([name]) => name === 'message',
          )?.[1];
          debugMessage?.({}, 'DOM.attributeModified', {}, 'child');
          expect(event).toHaveBeenCalledWith(
            'DOM.attributeModified',
            {},
            'child',
          );
          const sessions: unknown = Reflect.get(service, 'sessions');
          if (!(sessions instanceof Map)) throw new Error('Missing sessions.');
          const state: unknown = sessions.get(tab.id);
          if (
            !isCDPRecord(state) ||
            !(state.observationSessions instanceof Set)
          )
            throw new Error('Missing observations.');
          for (let index = 0; index < 1000; index += 1)
            state.observationSessions.add(`production-${index}`);
          debugMessage?.({}, 'Target.attachedToTarget', {
            sessionId: 'capped',
            targetInfo: { targetId: 'capped', type: 'iframe' },
          });
          expect(detach).toHaveBeenCalledWith('capped');
          installNativePipeline();
          webContents.send.mockClear();
          await service.automation({
            browserId: tab.id,
            command: { kind: 'click', locator: '#button' },
          });
          expect(action).toHaveBeenCalledTimes(2);
          await service.inputSnapshot({
            browserId: tab.id,
            filter: { frame: 'iframe#checkout' },
          });
          await service.inspect({
            browserId: tab.id,
            locator: '#button',
            frame: 'iframe#checkout',
          });
          expect(modelSeam.snapshot).toHaveBeenCalledWith(
            { browserId: tab.id, filter: { frame: 'iframe#checkout' } },
            expect.any(Function),
            { frame: 'iframe#checkout' },
          );
          expect(modelSeam.inspect).toHaveBeenCalledWith(
            { browserId: tab.id, locator: '#button', frame: 'iframe#checkout' },
            expect.any(Function),
            { frame: 'iframe#checkout' },
          );
          expect(webContents.send).not.toHaveBeenCalled();
        } finally {
          await service.shutdown();
          expect(dispose).toHaveBeenCalled();
          event.mockRestore();
          action.mockRestore();
          detach.mockRestore();
          dispose.mockRestore();
        }
      },
    );
  });

  it.each([
    ['inspect', { frame: '' }],
    ['inspect', { frame: '   ' }],
    ['inspect', { frame: 7 }],
    ['inputSnapshot', { frame: '' }],
    ['inputSnapshot', { frame: null }],
  ] as const)(
    'rejects a %s request whose frame is not a non-empty string (%j)',
    async (method, frame) => {
      const service = new BrowserService({ getWindow: mockWindow });
      const tab = await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: 'invalid-frame',
        url: 'http://localhost/form',
      });
      // The renderer's IPC handlers check only the browser id; the frame
      // reaches the service unchecked.
      const request: unknown =
        method === 'inspect'
          ? { browserId: tab.id, locator: '#button', ...frame }
          : { browserId: tab.id, filter: frame };
      const entry: unknown = Reflect.get(service, method);
      if (typeof entry !== 'function') throw new Error(`Missing ${method}.`);
      const call: unknown = Reflect.apply(entry, service, [request]);
      await expect(call).rejects.toThrow(
        'Invalid browser request: frame must be a non-empty string.',
      );
      expect(modelSeam.inspect).not.toHaveBeenCalled();
      expect(modelSeam.snapshot).not.toHaveBeenCalled();
      await service.shutdown();
    },
  );

  it.each([true, false])(
    "enables DOM with whitespace text as each session's first DOM command (E2E build %s)",
    async (enabled) => {
      await withScreenshotObservationGlobals(
        enabled,
        () => undefined,
        async () => {
          webContents.debugger.sendCommand.mockClear();
          const service = new BrowserService({ getWindow: mockWindow });
          await service.create({
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId: `dom-enable-${enabled}`,
            url: 'https://root.test/',
          });
          const debugMessage = webContents.debugger.on.mock.calls.find(
            ([event]) => event === 'message',
          )?.[1];
          debugMessage?.({}, 'Target.attachedToTarget', {
            sessionId: 'whitespace-child',
            targetInfo: { targetId: 'whitespace-target', type: 'iframe' },
          });
          await new Promise((resolve) => setImmediate(resolve));
          const calls = webContents.debugger.sendCommand.mock.calls;
          // Only a session's first DOM.enable decides whether whitespace-only
          // text nodes are reported, so every enable must carry it, and the
          // child's comes before any other command to that session.
          expect(calls.filter(([method]) => method === 'DOM.enable')).toEqual([
            ['DOM.enable', { includeWhitespace: 'all' }],
            ['DOM.enable', { includeWhitespace: 'all' }, 'whitespace-child'],
          ]);
          const sessionOf = (call: unknown[]): unknown => Reflect.get(call, 2);
          const childCommands = calls.filter(
            (call) => sessionOf(call) === 'whitespace-child',
          );
          expect(childCommands[0]?.[0]).toBe('DOM.enable');
          const rootDom = calls.filter(
            (call) =>
              call[0].startsWith('DOM.') && sessionOf(call) === undefined,
          );
          expect(rootDom[0]?.[0]).toBe('DOM.enable');
          await service.shutdown();
        },
      );
    },
  );

  it('wires child frame/session events and DOM revisions ahead of the child early return', async () => {
    await withScreenshotObservationGlobals(
      true,
      () => undefined,
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'child-model-hooks',
          url: 'https://root.test/',
        });
        const host = modelHost(service, tab.id);
        const debugMessage = webContents.debugger.on.mock.calls.find(
          ([event]) => event === 'message',
        )?.[1];
        debugMessage?.(
          {},
          'Page.frameNavigated',
          {
            frame: { id: 'root', loaderId: 'load', url: 'https://root.test/' },
          },
          '',
        );
        debugMessage?.({}, 'Target.attachedToTarget', {
          sessionId: 'child',
          targetInfo: { targetId: 'target', type: 'iframe', url: '' },
        });
        debugMessage?.({}, 'Target.targetInfoChanged', {
          targetInfo: {
            targetId: 'target',
            type: 'iframe',
            url: 'https://child.test/',
          },
        });
        debugMessage?.(
          {},
          'Page.frameNavigated',
          {
            frame: {
              id: 'target',
              parentId: 'root',
              loaderId: 'child-load',
              url: 'https://child.test/',
            },
          },
          'child',
        );
        const before = host.key.domEventRevision;
        debugMessage?.({}, 'DOM.attributeModified', {}, 'child');
        expect(host.key.domEventRevision).toBe(before + 1);
        expect(host.registry.frames()).toContainEqual(
          expect.objectContaining({
            frameId: 'target',
            sessionId: 'child',
            loaderId: 'child-load',
          }),
        );
        const identity = {
          frameId: 'target',
          sessionId: 'child',
          loaderId: 'child-load',
          backendNodeId: 1,
        };
        const firstRef = host.registry.mintRef(identity);
        debugMessage?.(
          {},
          'Page.frameDetached',
          { frameId: 'target' },
          'child',
        );
        expect(host.registry.resolveRef(firstRef)).toBeUndefined();
        debugMessage?.(
          {},
          'Page.frameNavigated',
          {
            frame: {
              id: 'target',
              parentId: 'root',
              loaderId: 'child-load',
              url: 'https://child.test/',
            },
          },
          'child',
        );
        const secondRef = host.registry.mintRef(identity);
        debugMessage?.({}, 'Target.detachedFromTarget', { sessionId: 'child' });
        expect(host.registry.resolveRef(secondRef)).toBeUndefined();
        await service.shutdown();
      },
    );
  });

  it('defines the E2E measurement hook, which only builds and cannot change routing (phase 04b S4)', async () => {
    await withScreenshotObservationGlobals(
      true,
      () => undefined,
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'e2e-model-measurement',
          url: 'http://localhost/form',
        });
        const hook: unknown = Object.getOwnPropertyDescriptor(
          globalThis,
          '__CANOPY_E2E_BROWSER_PAGE_MODEL__',
        )?.value;
        if (typeof hook !== 'function') throw new Error('Missing E2E hook.');
        const model = await buildPageModel(
          recordedDeps(loadRecording('frames')),
        );
        const build = jest
          .spyOn(PageModelHost.prototype, 'build')
          .mockResolvedValue({ model, cached: false, durationMs: 7 });
        try {
          const options = { cache: 'bypass', accessibility: true };
          await expect(
            Reflect.apply(hook, undefined, [
              { kind: 'build', browserId: tab.id, options },
            ]),
          ).resolves.toEqual({
            durationMs: 7,
            cached: false,
            coverage: model.coverage,
            counts: {
              nodes: model.nodes.length,
              frames: model.frames.length,
              inputs: model.nodes.filter((node) =>
                ['input', 'textarea', 'select'].includes(
                  node.tagName.toLowerCase(),
                ),
              ).length,
              accessibilityNodes: model.accessibility.length,
              listenerHits: 0,
            },
            timings: model.timings,
            styleSupplement: model.styleSupplement,
          });
          expect(build).toHaveBeenCalledWith(options);
          build.mockClear();
          // The comparison switch and the preload reads are gone.
          for (const request of [
            { kind: 'set', browserId: tab.id, enabled: false },
            { kind: 'compare', browserId: tab.id, request: {} },
            { kind: 'inspect', browserId: tab.id, ref: 'model-ref' },
            { kind: 'build', browserId: tab.id, options: { cache: 'always' } },
            { kind: 'build', browserId: tab.id },
          ])
            await expect(
              Reflect.apply(hook, undefined, [request]),
            ).rejects.toThrow(
              'The page-model hook only measures a build: { kind: "build", browserId, options: { cache: "use" | "bypass", accessibility?, listeners? } }.',
            );
          expect(build).not.toHaveBeenCalled();
          webContents.send.mockClear();
          await service.inspect({ browserId: tab.id, ref: 'model-ref' });
          await service.inputSnapshot({ browserId: tab.id });
          expect(modelSeam.inspect).toHaveBeenCalledTimes(1);
          expect(modelSeam.snapshot).toHaveBeenCalledTimes(1);
          expect(webContents.send).not.toHaveBeenCalled();
        } finally {
          build.mockRestore();
          await service.shutdown();
        }
        expect(
          Object.getOwnPropertyDescriptor(
            globalThis,
            '__CANOPY_E2E_BROWSER_PAGE_MODEL__',
          ),
        ).toBeUndefined();
      },
    );
  });
  it('bumps the model action sequence at both input-lane boundaries', async () => {
    await withScreenshotObservationGlobals(
      true,
      () => undefined,
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'model-action-boundaries',
          url: 'http://localhost/form',
        });
        const host = modelHost(service, tab.id);
        installNativePipeline();
        const before = host.key.actionSequence;
        const result = await service.automation({
          browserId: tab.id,
          command: { kind: 'click', locator: '#button' },
        });
        expect(result).toMatchObject({ ok: true });
        expect(host.key.actionSequence).toBe(before + 2);
        await service.shutdown();
      },
    );
  });

  it('drops the registry session synchronously when the observation cap rejects attachment', async () => {
    await withScreenshotObservationGlobals(
      true,
      () => undefined,
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'model-observation-cap',
          url: 'https://root.test/',
        });
        const sessions: unknown = Reflect.get(service, 'sessions');
        if (!(sessions instanceof Map)) throw new Error('Missing sessions.');
        const state: unknown = sessions.get(tab.id);
        if (!isCDPRecord(state) || !(state.observationSessions instanceof Set))
          throw new Error('Missing observation sessions.');
        for (let index = 0; index < 1000; index += 1)
          state.observationSessions.add(`existing-${index}`);
        const host = modelHost(service, tab.id);
        host.registry.noteAttached('capped', {
          targetId: 'capped-target',
          type: 'iframe',
        });
        host.registry.noteFrameNavigated('capped', {
          id: 'capped-target',
          loaderId: 'capped-load',
          url: 'https://child.test/',
        });
        const ref = host.registry.mintRef({
          frameId: 'capped-target',
          sessionId: 'capped',
          loaderId: 'capped-load',
          backendNodeId: 1,
        });
        const debugMessage = webContents.debugger.on.mock.calls.find(
          ([event]) => event === 'message',
        )?.[1];
        debugMessage?.({}, 'Target.attachedToTarget', {
          sessionId: 'capped',
          targetInfo: { targetId: 'capped-target', type: 'iframe', url: '' },
        });
        expect(host.registry.resolveRef(ref)).toBeUndefined();
        expect(
          host.registry.frames().some((frame) => frame.sessionId === 'capped'),
        ).toBe(false);
        expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
          'Target.detachFromTarget',
          { sessionId: 'capped' },
        );
        await service.shutdown();
      },
    );
  });

  it('discovers the root frame when only same-process child frames were observed', async () => {
    await withScreenshotObservationGlobals(
      true,
      () => undefined,
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'late-root-discovery',
          url: 'https://root.test/frames',
        });
        const debugMessage = webContents.debugger.on.mock.calls.find(
          ([event]) => event === 'message',
        )?.[1];
        // The root's commit preceded Page.enable; only a child's event arrived.
        debugMessage?.(
          {},
          'Page.frameNavigated',
          {
            frame: {
              id: 'child',
              parentId: 'root',
              loaderId: 'child-load',
              url: 'https://root.test/child',
            },
          },
          '',
        );
        expect(webContents.getURL()).toBe('https://root.test/frames');
        const discover = jest
          .spyOn(PageModelHost.prototype, 'discoverFrames')
          .mockResolvedValue(undefined);
        const snapshot = jest
          .spyOn(PageModelHost.prototype, 'snapshot')
          .mockRejectedValue(new Error('Model snapshot'));
        try {
          await expect(
            service.inputSnapshot({ browserId: tab.id }),
          ).rejects.toThrow('Model snapshot');
          expect(discover).toHaveBeenCalledTimes(1);
        } finally {
          discover.mockRestore();
          snapshot.mockRestore();
          await service.shutdown();
        }
      },
    );
  });

  it('rejects an unknown model ref as target_stale without falling through to preload', async () => {
    await withScreenshotObservationGlobals(
      false,
      () => undefined,
      async () => {
        const service = new BrowserService({ getWindow: mockWindow });
        const tab = await service.create({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'stale-model-ref',
        });
        // The real host: an unknown ref never reaches CDP or the preload.
        modelSeam.inspect.mockRestore();
        webContents.send.mockClear();
        // S2b E3: a typed read failure with a plain message.
        await expect(
          service.inspect({ browserId: tab.id, ref: 'unknown-model-ref' }),
        ).rejects.toMatchObject({
          code: 'target_stale',
          message:
            'That reference is no longer on the page. Run browser.input_snapshot for current references.',
        });
        expect(webContents.send).not.toHaveBeenCalled();
        await service.shutdown();
      },
    );
  });

  describe('reads that race a main-frame navigation (phase 04b S2b E2)', () => {
    async function navigatingService(browserId: string): Promise<{
      service: BrowserService;
      start: (details?: {
        isMainFrame?: boolean;
        isSameDocument?: boolean;
      }) => void;
    }> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost:3000',
      });
      modelSeam.inspect.mockClear();
      modelSeam.snapshot.mockClear();
      return {
        service,
        start: (details = {}): void => {
          webContents.emit('did-start-navigation', {
            url: 'http://localhost:3000/next',
            isSameDocument: details.isSameDocument ?? false,
            isMainFrame: details.isMainFrame ?? true,
            frame: null,
          });
        },
      };
    }

    async function turns(): Promise<void> {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    }

    function commit(): void {
      webContents.currentUrl = 'http://localhost:3000/next';
      webContents.emit('did-navigate', {}, 'http://localhost:3000/next');
    }

    it('answers inspect and inputSnapshot from the new document once it is DOM-ready', async () => {
      const { service, start } = await navigatingService('nav-read');
      start();
      const inspected = service.inspect({
        browserId: 'nav-read',
        locator: '#auth-state',
      });
      const snapshot = service.inputSnapshot({ browserId: 'nav-read' });
      await turns();
      expect(modelSeam.inspect).not.toHaveBeenCalled();
      expect(modelSeam.snapshot).not.toHaveBeenCalled();
      // The document being replaced reaching DOMContentLoaded is not enough.
      webContents.emit('dom-ready', {});
      await turns();
      expect(modelSeam.inspect).not.toHaveBeenCalled();
      commit();
      await turns();
      expect(modelSeam.inspect).not.toHaveBeenCalled();
      webContents.emit('dom-ready', {});
      await expect(inspected).resolves.toMatchObject({ browserId: 'nav-read' });
      await expect(snapshot).resolves.toMatchObject({ browserId: 'nav-read' });
      expect(modelSeam.inspect).toHaveBeenCalledTimes(1);
      expect(modelSeam.snapshot).toHaveBeenCalledTimes(1);
      await service.shutdown();
    });

    it('does not wait after DOMContentLoaded, nor for same-document or child-frame navigations', async () => {
      const { service, start } = await navigatingService('nav-read-none');
      await service.inspect({ browserId: 'nav-read-none', locator: '#a' });
      start({ isSameDocument: true });
      await service.inspect({ browserId: 'nav-read-none', locator: '#a' });
      start({ isMainFrame: false });
      await service.inputSnapshot({ browserId: 'nav-read-none' });
      start();
      commit();
      webContents.emit('dom-ready', {});
      await service.inspect({ browserId: 'nav-read-none', locator: '#a' });
      expect(modelSeam.inspect).toHaveBeenCalledTimes(3);
      expect(modelSeam.snapshot).toHaveBeenCalledTimes(1);
      await service.shutdown();
    });

    it('a failed or stopped navigation ends the wait; a superseded one does not', async () => {
      const { service, start } = await navigatingService('nav-read-fail');
      start();
      const failed = service.inspect({
        browserId: 'nav-read-fail',
        locator: '#a',
      });
      webContents.emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED',
        'http://localhost:3000/next',
        true,
      );
      await expect(failed).resolves.toMatchObject({
        browserId: 'nav-read-fail',
      });

      start();
      const stopped = service.inspect({
        browserId: 'nav-read-fail',
        locator: '#a',
      });
      // A child frame's failure, and ERR_ABORTED (a newer navigation or a
      // stop superseded it), leave the wait to the next event.
      webContents.emit('did-fail-load', {}, -105, 'ERR', 'http://x/', false);
      webContents.emit(
        'did-fail-load',
        {},
        -3,
        'ERR_ABORTED',
        'http://x/',
        true,
      );
      await turns();
      expect(modelSeam.inspect).toHaveBeenCalledTimes(1);
      webContents.emit('did-stop-loading');
      await expect(stopped).resolves.toMatchObject({
        browserId: 'nav-read-fail',
      });
      expect(modelSeam.inspect).toHaveBeenCalledTimes(2);
      await service.shutdown();
    });

    it('proceeds after 2 seconds with whatever document is there', async () => {
      const { service, start } = await navigatingService('nav-read-hung');
      jest.useFakeTimers();
      try {
        start();
        const inspected = service.inspect({
          browserId: 'nav-read-hung',
          locator: '#a',
        });
        await jest.advanceTimersByTimeAsync(1_999);
        expect(modelSeam.inspect).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await expect(inspected).resolves.toMatchObject({
          browserId: 'nav-read-hung',
        });
      } finally {
        jest.useRealTimers();
      }
      await service.shutdown();
    });

    it('a dialog ends the wait as a pending dialog', async () => {
      const { service, start } = await navigatingService('nav-read-dialog');
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      start();
      const inspected = service.inspect({
        browserId: 'nav-read-dialog',
        locator: '#a',
      });
      const automated = service.automation({
        browserId: 'nav-read-dialog',
        command: { kind: 'inspect', locator: '#a' },
      });
      await turns();
      message?.({}, 'Page.javascriptDialogOpening', {
        type: 'beforeunload',
        message: 'Leave site?',
        url: 'http://localhost:3000',
      });
      await expect(inspected).rejects.toThrow(
        'Browser JavaScript dialog is pending',
      );
      await expect(automated).resolves.toMatchObject({
        ok: true,
        completed: false,
        dialog: { type: 'beforeunload' },
      });
      expect(modelSeam.inspect).not.toHaveBeenCalled();
      await service.shutdown();
    });

    it("the automation request's abort, or closing the browser, ends the wait", async () => {
      const { service, start } = await navigatingService('nav-read-abort');
      start();
      const controller = new AbortController();
      const reason = new Error('The request was cancelled.');
      const automated = service.automation(
        {
          browserId: 'nav-read-abort',
          command: { kind: 'inspect', locator: '#a' },
        },
        controller.signal,
      );
      await turns();
      controller.abort(reason);
      await expect(automated).rejects.toBe(reason);

      const inspected = service.inspect({
        browserId: 'nav-read-abort',
        locator: '#a',
      });
      void inspected.catch(() => undefined);
      await turns();
      await service.destroy('nav-read-abort');
      await expect(inspected).rejects.toThrow('is no longer available');
      expect(modelSeam.inspect).not.toHaveBeenCalled();
      await service.shutdown();
    });
  });

  describe('actions on targets in frames (phase 04b S2)', () => {
    const CHILD = 'child-session';

    async function frameService(browserId: string): Promise<{
      service: BrowserService;
      message: DebuggerMessageHandler | undefined;
    }> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost:3000',
      });
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      return { service, message };
    }

    /** A recorder in the frame document that saw the given input. */
    function recorderOf(
      entries: Array<
        | {
            type: 'pointerdown';
            button: number;
            clientX: number;
            clientY: number;
          }
        | { type: 'keydown'; key: string }
      >,
    ): { read: jest.Mock; dispose: jest.Mock } {
      return {
        read: jest.fn(() =>
          Promise.resolve(
            entries.map((entry) => ({ ...entry, at: Date.now() })),
          ),
        ),
        dispose: jest.fn(() => Promise.resolve()),
      };
    }

    function paramOf(call: unknown[], name: string): unknown {
      const params: unknown = call[1];
      return isCDPRecord(params) ? params[name] : undefined;
    }

    function sessionCalls(method: string, sessionId: string): unknown[][] {
      return webContents.debugger.sendCommand.mock.calls.filter(
        (call) => call[0] === method && Reflect.get(call, 2) === sessionId,
      );
    }

    it("resolves the locator in its frame once and sends every target command to the target's own session", async () => {
      const { service } = await frameService('frame-click');
      installNativePipeline({ reportInput: false });
      const target = seamTarget('frame-target', {
        sessionId: CHILD,
        frameId: 'child-frame',
      });
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target,
      });
      const recorder = recorderOf([
        { type: 'pointerdown', button: 0, clientX: 30, clientY: 30 },
      ]);
      modelSeam.armInputRecorder.mockResolvedValue(recorder);
      const end = jest.fn();
      modelSeam.beginActivity.mockReturnValue(end);

      const result = await service.automation({
        browserId: 'frame-click',
        command: { kind: 'click', locator: '#pay', frame: 'iframe#checkout' },
      });

      expect(result).toMatchObject({
        ok: true,
        completed: true,
        receipt: { status: 'executed', inputMode: 'trusted' },
      });
      expect(result.receipt?.warnings).toBeUndefined();
      expect(modelSeam.resolveActionTarget.mock.calls).toEqual([
        [{ kind: 'locator', locator: '#pay', frame: 'iframe#checkout' }],
      ]);
      expect(sessionCalls('DOM.scrollIntoViewIfNeeded', CHILD)).toHaveLength(1);
      expect(
        sessionCalls('Input.dispatchMouseEvent', CHILD).map((call) =>
          paramOf(call, 'type'),
        ),
      ).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
      // Nothing for the target goes to the root session.
      expect(
        webContents.debugger.sendCommand.mock.calls.some(
          (call) =>
            (call[0] === 'Input.dispatchMouseEvent' ||
              call[0] === 'DOM.scrollIntoViewIfNeeded') &&
            Reflect.get(call, 2) === undefined,
        ),
      ).toBe(false);
      // D11: tracking established before input, held until the cleanup.
      const firstInput = webContents.debugger.sendCommand.mock.calls.findIndex(
        ([method]) => method === 'Input.dispatchMouseEvent',
      );
      expect(modelSeam.establishTracking).toHaveBeenCalledTimes(1);
      expect(
        modelSeam.establishTracking.mock.invocationCallOrder[0],
      ).toBeLessThan(
        webContents.debugger.sendCommand.mock.invocationCallOrder[firstInput] ??
          0,
      );
      expect(end).toHaveBeenCalledTimes(1);
      expect(modelSeam.armInputRecorder).toHaveBeenCalledWith(target);
      expect(recorder.dispose).toHaveBeenCalledTimes(1);
      expect(modelSeam.releaseActionTarget.mock.calls).toEqual([[target]]);
      await service.shutdown();
    });

    it("maps a same-process frame's document point through its owner, and hit tests the documents above it", async () => {
      const { service, message } = await frameService('same-process-click');
      message?.({}, 'Page.frameNavigated', {
        frame: {
          id: 'child-frame',
          parentId: 'main-frame',
          loaderId: 'child-document',
          url: 'http://localhost:3000/child',
        },
      });
      installNativePipeline({ reportInput: false });
      const target = seamTarget('same-process-target', {
        frameId: 'child-frame',
        loaderId: 'child-document',
      });
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target,
      });
      // The frame's document starts at (100, 50) in the page.
      modelSeam.documentMapping.mockResolvedValue({
        originX: 100,
        originY: 50,
        scaleX: 1,
        scaleY: 1,
      });
      modelSeam.armInputRecorder.mockResolvedValue(
        recorderOf([
          { type: 'pointerdown', button: 0, clientX: 30, clientY: 30 },
        ]),
      );

      const result = await service.automation({
        browserId: 'same-process-click',
        command: { kind: 'click', locator: '#pay' },
      });

      expect(result).toMatchObject({ ok: true, completed: true });
      expect(modelSeam.outerHitTest).toHaveBeenCalledWith(target, {
        x: 130,
        y: 80,
      });
      const pressed = webContents.debugger.sendCommand.mock.calls.find(
        ([method, params]) =>
          method === 'Input.dispatchMouseEvent' &&
          params?.type === 'mousePressed',
      );
      expect(pressed?.[1]).toMatchObject({ x: 130, y: 80 });
      // A same-process frame shares the root session.
      expect(pressed && Reflect.get(pressed, 2)).toBeUndefined();
      await service.shutdown();
    });

    it('clicks directly, on the retained target in its session, when a document above the frame covers it (D9)', async () => {
      const { service } = await frameService('covered-frame');
      installNativePipeline({ reportInput: false });
      const target = seamTarget('covered-target', {
        sessionId: CHILD,
        frameId: 'child-frame',
      });
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target,
      });
      modelSeam.outerHitTest.mockResolvedValue({
        receivesEvents: false,
        cover: 'div.overlay',
      });
      const result = await service.automation({
        browserId: 'covered-frame',
        command: { kind: 'click', locator: '#pay' },
      });
      expect(result).toMatchObject({
        ok: true,
        receipt: {
          inputMode: 'synthetic',
          warnings: ['Covered by div.overlay; clicked the element directly.'],
        },
      });
      const direct = webContents.debugger.sendCommand.mock.calls.find(
        ([method, params]) =>
          method === 'Runtime.callFunctionOn' && params?.userGesture === true,
      );
      expect(direct?.[1]).toMatchObject({ objectId: 'covered-target' });
      expect(direct && Reflect.get(direct, 2)).toBe(CHILD);
      expect(
        webContents.debugger.sendCommand.mock.calls.some(
          ([method]) =>
            method === 'Input.dispatchMouseEvent' ||
            method === 'Runtime.releaseObject',
        ),
      ).toBe(false);
      // Released exactly once, as the action's object group.
      expect(modelSeam.releaseActionTarget.mock.calls).toEqual([[target]]);
      await service.shutdown();
    });

    it.each([
      ['no recorder could be armed', undefined],
      ['the recorder saw no matching input', []],
    ] as const)(
      'reports unconfirmed delivery to a frame target when %s',
      async (_case, entries) => {
        const { service } = await frameService('frame-unconfirmed');
        jest.useFakeTimers();
        installNativePipeline({ reportInput: false });
        modelSeam.resolveActionTarget.mockResolvedValue({
          status: 'found',
          target: seamTarget('frame-target', {
            sessionId: CHILD,
            frameId: 'child-frame',
          }),
        });
        modelSeam.armInputRecorder.mockResolvedValue(
          entries === undefined ? undefined : recorderOf([...entries]),
        );
        const pending = service.automation({
          browserId: 'frame-unconfirmed',
          command: { kind: 'click', locator: '#pay' },
        });
        await jest.advanceTimersByTimeAsync(2_000);
        await expect(pending).resolves.toMatchObject({
          ok: true,
          completed: false,
          receipt: {
            status: 'outcome_unknown',
            outcomeReason: 'dispatch_timeout',
            warnings: [
              'The page did not report receiving the input; it may not have been delivered.',
            ],
          },
        });
        jest.useRealTimers();
        await service.shutdown();
      },
    );

    it('confirms a key press delivered to a frame target from its recorder', async () => {
      const { service } = await frameService('frame-press');
      installNativePipeline({ reportInput: false });
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: seamTarget('frame-input', {
          sessionId: CHILD,
          frameId: 'child-frame',
        }),
      });
      modelSeam.armInputRecorder.mockResolvedValue(
        recorderOf([{ type: 'keydown', key: 'Enter' }]),
      );
      const result = await service.automation({
        browserId: 'frame-press',
        command: { kind: 'press', locator: '#code', key: 'Enter' },
      });
      expect(result).toMatchObject({
        ok: true,
        completed: true,
        receipt: { status: 'executed', inputMode: 'trusted' },
      });
      expect(sessionCalls('DOM.focus', CHILD)).toHaveLength(1);
      expect(
        sessionCalls('Input.dispatchKeyEvent', CHILD).map((call) =>
          paramOf(call, 'type'),
        ),
      ).toEqual(['keyDown', 'keyUp']);
      await service.shutdown();
    });

    it.each(['target frame', 'another frame'] as const)(
      'answers a pre-armed dialog only when it comes from the action frame document (%s)',
      async (source) => {
        const { service, message } = await frameService('frame-dialog');
        jest.useFakeTimers();
        message?.({}, 'Page.frameNavigated', {
          frame: {
            id: 'child-frame',
            parentId: 'main-frame',
            loaderId: 'child-document',
            url: 'http://localhost:3000/child',
          },
        });
        installNativePipeline({
          reportInput: false,
          input: (_method, params): Promise<unknown> => {
            if (params.type === 'mousePressed')
              message?.({}, 'Page.javascriptDialogOpening', {
                type: 'prompt',
                message: 'Code?',
                url:
                  source === 'target frame'
                    ? 'http://localhost:3000/child#step'
                    : 'http://localhost:3000/other',
                frameId:
                  source === 'target frame' ? 'child-frame' : 'other-frame',
              });
            return Promise.resolve({});
          },
        });
        modelSeam.resolveActionTarget.mockResolvedValue({
          status: 'found',
          target: seamTarget('child-button', {
            frameId: 'child-frame',
            loaderId: 'child-document',
          }),
        });
        modelSeam.armInputRecorder.mockResolvedValue(
          recorderOf([
            { type: 'pointerdown', button: 0, clientX: 30, clientY: 30 },
          ]),
        );
        const previous =
          webContents.debugger.sendCommand.getMockImplementation();
        webContents.debugger.sendCommand.mockImplementation(
          (method, params): Promise<unknown> => {
            if (method === 'Page.handleJavaScriptDialog') {
              message?.({}, 'Page.javascriptDialogClosed', { result: true });
              return Promise.resolve({});
            }
            return previous?.(method, params) ?? Promise.resolve({});
          },
        );
        const pending = service.automation({
          browserId: 'frame-dialog',
          command: {
            kind: 'click',
            locator: '#child-button',
            dialogResponse: { accept: true, promptText: 'private answer' },
          },
        });
        await jest.advanceTimersByTimeAsync(2_500);
        const answers = webContents.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === 'Page.handleJavaScriptDialog',
        );
        if (source === 'target frame') {
          await expect(pending).resolves.toMatchObject({
            ok: true,
            completed: true,
            handledDialog: { accept: true, dialog: { frameId: 'child-frame' } },
          });
          expect(answers).toHaveLength(1);
        } else {
          await expect(pending).resolves.toMatchObject({
            ok: true,
            completed: false,
            dialog: { type: 'prompt', frameId: 'other-frame' },
          });
          expect(answers).toHaveLength(0);
        }
        jest.useRealTimers();
        await service.shutdown();
      },
    );

    it.each([
      [
        {
          status: 'target_ambiguous',
          message: 'The locator matched 2 elements in frames f-1, f-2.',
          matchCount: 2,
          candidates: [],
        },
        'target_ambiguous',
        'The locator matched 2 elements in frames f-1, f-2. Use a current input reference or the frame field.',
      ],
      [
        { status: 'frame_unavailable', message: 'The frame is not available.' },
        'frame_unavailable',
        'The frame is not available. Refresh the input snapshot.',
      ],
      [
        { status: 'target_stale', message: 'gone' },
        'target_stale',
        'The prepared target is no longer in this document. Refresh the input snapshot.',
      ],
    ] as const)(
      'fails before dispatch when the target does not resolve (%j)',
      async (resolution, code, text) => {
        const { service } = await frameService('unresolved');
        installNativePipeline();
        modelSeam.resolveActionTarget.mockResolvedValue(
          resolution.status === 'target_ambiguous'
            ? { ...resolution, candidates: [] }
            : { ...resolution },
        );
        const result = await service.automation({
          browserId: 'unresolved',
          command: { kind: 'click', locator: 'button', frame: 'f-1' },
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'invalid_target', message: text },
          receipt: {
            status: 'not_executed',
            error: { code, next: 'browser.input_snapshot' },
          },
        });
        expect(
          webContents.debugger.sendCommand.mock.calls.some(([method]) =>
            method.startsWith('Input.'),
          ),
        ).toBe(false);
        await service.shutdown();
      },
    );

    it('scopes a wait_for probe to its frame and holds tracking for the wait', async () => {
      const { service } = await frameService('frame-wait');
      installNativePipeline();
      const end = jest.fn();
      modelSeam.beginActivity.mockReturnValue(end);
      const result = await service.automation({
        browserId: 'frame-wait',
        command: {
          kind: 'wait_for',
          text: 'Paid',
          frame: 'iframe#checkout',
          timeoutMs: 1_000,
        },
      });
      expect(result).toMatchObject({ ok: true, waitFor: { satisfied: true } });
      expect(modelSeam.waitProbe).toHaveBeenCalledWith({
        text: 'Paid',
        frame: 'iframe#checkout',
      });
      expect(end).toHaveBeenCalledTimes(1);
      await service.shutdown();
    });
  });

  it('fails an automation inspect whose target did not resolve like an action refusal (E3)', async () => {
    const service = new BrowserService({ getWindow: mockWindow });
    await service.create({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'read-failure',
      url: 'http://localhost:3000',
    });
    modelSeam.inspect.mockRejectedValue(
      new BrowserReadTargetError('target_stale', 'Plain message.'),
    );
    const result = await service.automation({
      browserId: 'read-failure',
      command: { kind: 'inspect', ref: 'r-gone' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Plain message.',
        details: {
          error: {
            code: 'target_stale',
            message: 'Plain message.',
            retryable: false,
            next: 'browser.input_snapshot',
          },
        },
      },
    });
    // The IPC route keeps the typed error; its text carries the code.
    await expect(
      service.inspect({ browserId: 'read-failure', ref: 'r-gone' }),
    ).rejects.toBeInstanceOf(BrowserReadTargetError);
    await service.shutdown();
  });

  describe('the target document is fenced until input is sent (review R2 finding 1)', () => {
    /** A same-process child frame, registered with its current document. */
    async function fencedFrame(browserId: string): Promise<{
      service: BrowserService;
      navigateChild: (loaderId: string) => void;
      navigateMain: (loaderId: string) => void;
      recorder: { read: jest.Mock; dispose: jest.Mock };
    }> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId,
        url: 'http://localhost:3000',
      });
      const message = webContents.debugger.on.mock.calls.find(
        ([event]) => event === 'message',
      )?.[1];
      const navigateMain = (loaderId: string): void =>
        message?.({}, 'Page.frameNavigated', {
          frame: { id: 'main-frame', loaderId, url: 'http://localhost:3000/' },
        });
      const navigateChild = (loaderId: string): void =>
        message?.({}, 'Page.frameNavigated', {
          frame: {
            id: 'child-frame',
            parentId: 'main-frame',
            loaderId,
            url: 'http://localhost:3000/child',
          },
        });
      navigateMain('main-document');
      navigateChild('old-document');
      installNativePipeline({ reportInput: false });
      // The real fence reads the real registry.
      modelSeam.isTargetDocumentCurrent.mockRestore();
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: seamTarget('old-target', {
          frameId: 'child-frame',
          loaderId: 'old-document',
        }),
      });
      const recorder = {
        read: jest.fn(() =>
          Promise.resolve([
            {
              type: 'pointerdown' as const,
              button: 0,
              clientX: 30,
              clientY: 30,
              at: Date.now(),
            },
          ]),
        ),
        dispose: jest.fn(() => Promise.resolve()),
      };
      modelSeam.armInputRecorder.mockResolvedValue(recorder);
      return { service, navigateChild, navigateMain, recorder };
    }

    function inputs(): string[] {
      return webContents.debugger.sendCommand.mock.calls
        .filter(([method]) => method.startsWith('Input.'))
        .map(([, params]) => String(params?.type));
    }

    it('must not click a replacement frame document after the old target passed actionability', async () => {
      const { service, navigateChild } = await fencedFrame('r2-reload');
      // A same-URL reload after actionability, before baseline and recorder.
      modelSeam.establishTracking.mockImplementation(() => {
        navigateChild('new-document');
        return Promise.resolve();
      });
      const result = await service.automation({
        browserId: 'r2-reload',
        command: { kind: 'click', locator: '#pay', frame: 'iframe#checkout' },
      });
      expect(inputs()).toEqual([]);
      expect(modelSeam.armInputRecorder).not.toHaveBeenCalled();
      expect(result.receipt).toMatchObject({
        status: 'not_executed',
        error: { code: 'frame_unavailable', next: 'browser.input_snapshot' },
      });
      await service.shutdown();
    });

    it('refuses a document replaced while the recorder was arming, and disposes the recorder', async () => {
      const { service, navigateChild, recorder } =
        await fencedFrame('r2-arm-reload');
      modelSeam.armInputRecorder.mockImplementation(() => {
        navigateChild('new-document');
        return Promise.resolve(recorder);
      });
      const result = await service.automation({
        browserId: 'r2-arm-reload',
        command: { kind: 'click', locator: '#pay' },
      });
      expect(inputs()).toEqual([]);
      expect(result.receipt).toMatchObject({
        status: 'not_executed',
        error: { code: 'frame_unavailable' },
      });
      expect(recorder.dispose).toHaveBeenCalledTimes(1);
      await service.shutdown();
    });

    it('sends no further input once the document is replaced after dispatch began, and reports the outcome unknown', async () => {
      const { service, navigateChild } = await fencedFrame('r2-gap-reload');
      installNativePipeline({
        reportInput: false,
        // The reload lands in the gap between the move and the press.
        input: (_method, params) => {
          if (params.type === 'mouseMoved') navigateChild('new-document');
          return Promise.resolve({});
        },
      });
      modelSeam.isTargetDocumentCurrent.mockRestore();
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: seamTarget('old-target', {
          frameId: 'child-frame',
          loaderId: 'old-document',
        }),
      });
      const result = await service.automation({
        browserId: 'r2-gap-reload',
        command: { kind: 'click', locator: '#pay' },
      });
      expect(inputs()).toEqual(['mouseMoved']);
      expect(result).toMatchObject({
        ok: true,
        completed: false,
        receipt: { status: 'outcome_unknown' },
      });
      await service.shutdown();
    });

    it('must dispose a frame recorder that finishes arming after lane cancellation (review R2 finding 2)', async () => {
      const { service, recorder } = await fencedFrame('r2-abort-arm');
      const controller = new AbortController();
      let finishArm: (value: typeof recorder) => void = () => undefined;
      let armStarted = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        armStarted = resolve;
      });
      modelSeam.armInputRecorder.mockImplementation(() => {
        armStarted();
        return new Promise((resolve) => {
          finishArm = resolve;
        });
      });
      const action = service.automation(
        {
          browserId: 'r2-abort-arm',
          command: { kind: 'click', locator: '#pay' },
        },
        controller.signal,
      );
      await started;
      controller.abort();
      const result = await action;
      expect(result.receipt).toMatchObject({
        status: 'not_executed',
        error: { code: 'cancelled' },
      });
      expect(modelSeam.releaseActionTarget).toHaveBeenCalledTimes(1);
      finishArm(recorder);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recorder.dispose).toHaveBeenCalledTimes(1);
      expect(inputs()).toEqual([]);
      await service.shutdown();
    });

    it('fences a main-frame target the same way: a replaced top document gets no input', async () => {
      const { service, navigateMain } = await fencedFrame('r2-main-reload');
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: seamTarget('main-target', {
          frameId: 'main-frame',
          loaderId: 'main-document',
        }),
      });
      modelSeam.establishTracking.mockImplementation(() => {
        navigateMain('next-document');
        return Promise.resolve();
      });
      const result = await service.automation({
        browserId: 'r2-main-reload',
        command: { kind: 'press', locator: '#q', key: 'Enter' },
      });
      expect(inputs()).toEqual([]);
      expect(result.receipt).toMatchObject({
        status: 'not_executed',
        error: { code: 'frame_unavailable' },
      });
      await service.shutdown();
    });
  });
  describe('phase 05 pointer and viewport actions', () => {
    async function pointerService(id: string): Promise<BrowserService> {
      const service = new BrowserService({ getWindow: mockWindow });
      await service.create({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: id,
        url: 'http://localhost:3000',
      });
      service.setVisible(id, true);
      installNativePipeline();
      return service;
    }
    it('hover acknowledges one move, records only once, and replays without delivery confirmation', async () => {
      const service = await pointerService('pv-hover');
      await service.startRecording('pv-hover');
      const command = {
        kind: 'hover',
        ref: 'r',
        actionId: 'hover-id',
      } as const;
      const first = await service.automation({
        browserId: 'pv-hover',
        command,
      });
      const replay = await service.automation({
        browserId: 'pv-hover',
        command,
      });
      expect(first).toMatchObject({
        ok: true,
        completed: true,
        receipt: {
          kind: 'hover',
          inputMode: 'trusted',
          status: 'executed',
          target: DESCRIBED_TARGET,
        },
      });
      expect(replay.repeated).toBe(true);
      expect(
        webContents.debugger.sendCommand.mock.calls
          .filter(([m]) => m === 'Input.dispatchMouseEvent')
          .map(([, p]) => p?.type),
      ).toEqual(['mouseMoved']);
      expect(
        service
          .getRecording('pv-hover')
          .steps.filter((step) => step.action === 'hover'),
      ).toHaveLength(1);
      await service.shutdown();
    });
    it.each(['hover', 'scroll', 'drag'] as const)(
      '%s refuses pick mode and cancellation before resolution',
      async (kind) => {
        const service = await pointerService(`pv-refuse-${kind}`);
        const command =
          kind === 'drag'
            ? { kind, from: { ref: 'r' }, to: { dx: 10, dy: 0 } }
            : kind === 'scroll'
              ? { kind, direction: 'down' as const }
              : { kind, ref: 'r' };
        await service.setPickMode(`pv-refuse-${kind}`, true);
        const refused = await service.automation({
          browserId: `pv-refuse-${kind}`,
          command,
        });
        expect(refused.receipt).toMatchObject({
          status: 'not_executed',
          error: { code: 'execution_failed' },
        });
        await service.setPickMode(`pv-refuse-${kind}`, false);
        const abort = new AbortController();
        abort.abort();
        const cancelled = await service.automation(
          { browserId: `pv-refuse-${kind}`, command },
          abort.signal,
        );
        expect(cancelled.receipt).toMatchObject({
          status: 'not_executed',
          error: { code: 'cancelled' },
        });
        expect(modelSeam.resolveActionTarget).not.toHaveBeenCalled();
        await service.shutdown();
      },
    );

    it('point hover keeps the exact session point without scrolling or centering', async () => {
      const service = await pointerService('pv-point');
      jest
        .spyOn(PageModelHost.prototype, 'sessionPoint')
        .mockResolvedValue({ x: 7, y: 9 });
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: { ...seamTarget('point'), point: { x: 7, y: 9 } },
      });
      const native = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        async (method, params) => {
          if (
            method === 'Runtime.callFunctionOn' &&
            String(params?.functionDeclaration).includes('function(x, y)')
          )
            return { result: { value: { receivesEvents: true } } };
          return await (native?.(method, params) ?? Promise.resolve({}));
        },
      );
      const response = await service.automation({
        browserId: 'pv-point',
        command: { kind: 'hover', x: 7, y: 9 },
      });
      expect(response.receipt?.status).toBe('executed');
      expect(
        webContents.debugger.sendCommand.mock.calls.filter(
          ([m]) => m === 'DOM.scrollIntoViewIfNeeded',
        ),
      ).toHaveLength(0);
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
        'Input.dispatchMouseEvent',
        expect.objectContaining({ type: 'mouseMoved', x: 7, y: 9 }),
      );
      await service.shutdown();
    });
    it('off-page hover enters at the edge, then moves the pointer past it', async () => {
      const service = await pointerService('pv-off-page');
      const sessionPoint = jest.spyOn(PageModelHost.prototype, 'sessionPoint');
      jest
        .spyOn(PageModelHost.prototype, 'readDocumentViewport')
        .mockResolvedValue({ width: 536, height: 722 });
      modelSeam.resolveActionTarget.mockResolvedValue({
        status: 'found',
        target: seamTarget('page'),
      });
      const response = await service.automation({
        browserId: 'pv-off-page',
        command: { kind: 'hover', x: 600, y: -5 },
      });
      expect(response.receipt?.status).toBe('executed');
      expect(modelSeam.resolveActionTarget).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'page' }),
      );
      expect(sessionPoint).not.toHaveBeenCalled();
      // A page sees the pointer leave only from inside its viewport.
      expect(
        webContents.debugger.sendCommand.mock.calls
          .filter(([method]) => method === 'Input.dispatchMouseEvent')
          .map(([, params]) => [params?.x, params?.y]),
      ).toEqual([
        [535, 1],
        [600, -5],
      ]);
      await service.shutdown();
    });
    it.each([
      { kind: 'hover', ref: 'r' },
      { kind: 'focus', ref: 'r' },
      { kind: 'press', ref: 'r', key: 'Enter' },
    ] as const)(
      'describes the target of $kind as secret when it was secret before input',
      async (command) => {
        const id = `pv-secret-${command.kind}`;
        const service = await pointerService(id);
        modelSeam.isActionTargetSecret.mockResolvedValue(true);
        await service.automation({ browserId: id, command });
        expect(modelSeam.describeActionTarget).toHaveBeenCalled();
        expect(modelSeam.describeActionTarget.mock.calls.at(-1)?.[1]).toEqual({
          secret: true,
        });
        await service.shutdown();
      },
    );
    it('hover never falls back when focus emulation is unavailable', async () => {
      const service = await pointerService('pv-no-emulation');
      const native = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        async (method, params) => {
          if (method === 'Emulation.setFocusEmulationEnabled')
            throw new Error('Unavailable');
          return await (native?.(method, params) ?? Promise.resolve({}));
        },
      );
      const response = await service.automation({
        browserId: 'pv-no-emulation',
        command: { kind: 'hover', ref: 'r' },
      });
      expect(response.receipt).toMatchObject({
        status: 'not_executed',
        error: {
          code: 'execution_failed',
          message: 'The browser view cannot receive pointer input.',
        },
      });
      expect(
        webContents.debugger.sendCommand.mock.calls.some(([method]) =>
          method.startsWith('Input.'),
        ),
      ).toBe(false);
      await service.shutdown();
    });
    it('records a download a scroll started after that scroll, though the scroll’s step is written after the download', async () => {
      const service = await pointerService('pv-scroll-download');
      let current = scrollState();
      jest
        .spyOn(PageModelHost.prototype, 'readScrollState')
        .mockImplementation(() => Promise.resolve(current));
      jest
        .spyOn(PageModelHost.prototype, 'wheelPoint')
        .mockResolvedValue({ x: 100, y: 50 });
      jest
        .spyOn(PageModelHost.prototype, 'recordingLocator')
        .mockResolvedValue(undefined);
      jest
        .spyOn(PageModelHost.prototype, 'topPoint')
        .mockImplementation((_target, point) => Promise.resolve(point));
      let started = false;
      installNativePipeline({
        input: async (method, params) => {
          if (
            method === 'Input.dispatchMouseEvent' &&
            params.type === 'mouseWheel'
          ) {
            current = { ...current, y: current.y + Number(params.deltaY) };
            if (!started) {
              started = true;
              // The page starts a download as it scrolls; the scroll's step
              // is written once the scroll has settled, after it.
              mockTaskFilesDeps?.emit({
                type: 'transfer',
                browserId: 'pv-scroll-download',
                transfer: {
                  kind: 'download',
                  id: 'during-scroll',
                  browserId: 'pv-scroll-download',
                  source: 'agent',
                  origin: 'https://example.test/export',
                  fileName: 'export.csv',
                  receivedBytes: 0,
                  totalBytes: null,
                  status: 'in_progress',
                  startedAt: Date.now(),
                },
              });
              await new Promise((resolveLater) => setTimeout(resolveLater, 5));
            }
          }
          return {};
        },
      });
      await service.startRecording('pv-scroll-download');
      const scrolled = await service.automation({
        browserId: 'pv-scroll-download',
        command: { kind: 'scroll', direction: 'down' },
      });
      expect(scrolled).toMatchObject({ ok: true });
      expect(
        service
          .getRecording('pv-scroll-download')
          .steps.filter((step) => step.action !== 'goto')
          .map((step) => step.action),
      ).toEqual(['scroll', 'download']);
      await service.shutdown();
    });
    it.each([
      ['cleared', false],
      ['stopped and restarted', true],
    ] as const)(
      'records no held download from before the recording was %s during the action',
      async (_label, restart) => {
        const browserId = `pv-scroll-download-${restart ? 'restart' : 'clear'}`;
        const service = await pointerService(browserId);
        let current = scrollState();
        jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockImplementation(() => Promise.resolve(current));
        jest
          .spyOn(PageModelHost.prototype, 'wheelPoint')
          .mockResolvedValue({ x: 100, y: 50 });
        jest
          .spyOn(PageModelHost.prototype, 'recordingLocator')
          .mockResolvedValue(undefined);
        jest
          .spyOn(PageModelHost.prototype, 'topPoint')
          .mockImplementation((_target, point) => Promise.resolve(point));
        let started = false;
        installNativePipeline({
          input: async (method, params) => {
            if (
              method === 'Input.dispatchMouseEvent' &&
              params.type === 'mouseWheel'
            ) {
              current = { ...current, y: current.y + Number(params.deltaY) };
              if (!started) {
                started = true;
                mockTaskFilesDeps?.emit({
                  type: 'transfer',
                  browserId,
                  transfer: {
                    kind: 'download',
                    id: 'held-then-cleared',
                    browserId,
                    source: 'agent',
                    origin: 'https://example.test/export',
                    fileName: 'export.csv',
                    receivedBytes: 0,
                    totalBytes: null,
                    status: 'in_progress',
                    startedAt: Date.now(),
                  },
                });
                await new Promise((resolveLater) =>
                  setTimeout(resolveLater, 2),
                );
                if (restart) {
                  await service.stopRecording(browserId);
                  await service.startRecording(browserId);
                } else service.clearRecording(browserId);
              }
            }
            return {};
          },
        });
        await service.startRecording(browserId);
        await service.automation({
          browserId,
          command: { kind: 'scroll', direction: 'down' },
        });
        expect(
          service
            .getRecording(browserId)
            .steps.filter((step) => step.action === 'download'),
        ).toEqual([]);
        await service.shutdown();
      },
    );
    it('places a download its action started before a page step taken later in that action', async () => {
      const service = await pointerService('pv-scroll-download-later');
      let current = scrollState();
      jest
        .spyOn(PageModelHost.prototype, 'readScrollState')
        .mockImplementation(() => Promise.resolve(current));
      jest
        .spyOn(PageModelHost.prototype, 'wheelPoint')
        .mockResolvedValue({ x: 100, y: 50 });
      jest
        .spyOn(PageModelHost.prototype, 'recordingLocator')
        .mockResolvedValue(undefined);
      jest
        .spyOn(PageModelHost.prototype, 'topPoint')
        .mockImplementation((_target, point) => Promise.resolve(point));
      let started = false;
      installNativePipeline({
        input: async (method, params) => {
          if (
            method === 'Input.dispatchMouseEvent' &&
            params.type === 'mouseWheel'
          ) {
            current = { ...current, y: current.y + Number(params.deltaY) };
            if (!started) {
              started = true;
              mockTaskFilesDeps?.emit({
                type: 'transfer',
                browserId: 'pv-scroll-download-later',
                transfer: {
                  kind: 'download',
                  id: 'during-scroll-later',
                  browserId: 'pv-scroll-download-later',
                  source: 'agent',
                  origin: 'https://example.test/export',
                  fileName: 'export.csv',
                  receivedBytes: 0,
                  totalBytes: null,
                  status: 'in_progress',
                  startedAt: Date.now(),
                },
              });
              await new Promise((resolveLater) => setTimeout(resolveLater, 3));
              // A page step after the download, held until the action ends.
              ipcListeners.get('canopy-browser-view:event')?.(
                { sender: { id: webContents.id } },
                {
                  type: 'recording-step',
                  step: {
                    id: 'later-click',
                    action: 'click',
                    locator: "page.getByRole('button', { name: 'Next' })",
                    playwright:
                      "await page.getByRole('button', { name: 'Next' }).click();",
                    timestamp: Date.now(),
                  },
                },
              );
            }
          }
          return {};
        },
      });
      await service.startRecording('pv-scroll-download-later');
      await service.automation({
        browserId: 'pv-scroll-download-later',
        command: { kind: 'scroll', direction: 'down' },
      });
      expect(
        service
          .getRecording('pv-scroll-download-later')
          .steps.filter((step) => step.action !== 'goto')
          .map((step) => step.action),
      ).toEqual(['scroll', 'download', 'click']);
      await service.shutdown();
    });
    it('a non-scrollable container maps unsupported_control to invalid_target', async () => {
      const service = await pointerService('pv-not-scrollable');
      jest
        .spyOn(PageModelHost.prototype, 'readScrollState')
        .mockResolvedValue({ ...scrollState(), scriptY: false });
      const response = await service.automation({
        browserId: 'pv-not-scrollable',
        command: { kind: 'scroll', ref: 'r', direction: 'down' },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
        receipt: {
          status: 'not_executed',
          error: { code: 'unsupported_control' },
        },
      });
      await service.shutdown();
    });
    afterEach(() => {
      jest.spyOn(PageModelHost.prototype, 'readScrollState').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'wheelPoint').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'recordingLocator').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'boxOrigin').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'topPoint').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'sessionPoint').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'scrollAncestors').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'textMatchRect').mockRestore();
      jest.spyOn(PageModelHost.prototype, 'textMatchShown').mockRestore();
    });
    function scrollState(
      y = 0,
      maxY = 1000,
    ): Awaited<ReturnType<PageModelHost['readScrollState']>> {
      return {
        x: 0,
        y,
        maxX: 0,
        maxY,
        width: 200,
        height: 100,
        scrollWidth: 200,
        scrollHeight: maxY + 100,
        scriptX: false,
        scriptY: true,
        point: { x: 100, y: 50 },
      };
    }
    it('scroll reads the held page, reports state after settle, normalizes defaults, and records once', async () => {
      const service = await pointerService('pv-scroll');
      let current = scrollState();
      jest
        .spyOn(PageModelHost.prototype, 'readScrollState')
        .mockImplementation(async () => {
          await Promise.resolve();
          return current;
        });
      jest
        .spyOn(PageModelHost.prototype, 'wheelPoint')
        .mockResolvedValue({ x: 100, y: 50 });
      jest
        .spyOn(PageModelHost.prototype, 'recordingLocator')
        .mockResolvedValue(undefined);
      jest
        .spyOn(PageModelHost.prototype, 'topPoint')
        .mockImplementation(async (_target, point) => {
          await Promise.resolve();
          return point;
        });
      installNativePipeline({
        input: async (method, params) => {
          await Promise.resolve();

          if (
            method === 'Input.dispatchMouseEvent' &&
            params.type === 'mouseWheel'
          )
            current = { ...current, y: current.y + Number(params.deltaY) };
          return {};
        },
      });
      await service.startRecording('pv-scroll');
      const first = await service.automation({
        browserId: 'pv-scroll',
        command: {
          kind: 'scroll',
          direction: 'down',
          actionId: 'scroll-default',
        },
      });
      const replay = await service.automation({
        browserId: 'pv-scroll',
        command: {
          kind: 'scroll',
          direction: 'down',
          pages: 1,
          actionId: 'scroll-default',
        },
      });
      expect(first).toMatchObject({
        ok: true,
        receipt: {
          status: 'executed',
          inputMode: 'trusted',
          effects: {
            scroll: {
              container: 'page',
              axis: 'y',
              y: 1000,
              moved: true,
              atEnd: true,
              contentGrew: false,
            },
          },
        },
      });
      expect(replay.repeated).toBe(true);
      expect(modelSeam.resolveActionTarget).toHaveBeenCalledTimes(1);
      expect(modelSeam.resolveActionTarget).toHaveBeenCalledWith({
        kind: 'page',
      });
      expect(
        service
          .getRecording('pv-scroll')
          .steps.filter((step) => step.action === 'scroll'),
      ).toHaveLength(1);
      await service.shutdown();
    });
    it.each(['intoView', 'toText'] as const)(
      'scroll %s takes baselines before dispatch and reports the nearest changed container',
      async (mode) => {
        const service = await pointerService(`pv-${mode}`);
        const owner = seamTarget('container', { backendNodeId: 99 });
        let y = 0;
        const read = jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockImplementation(async (target) => {
            await Promise.resolve();
            return scrollState(target.identity.backendNodeId === 99 ? y : 0);
          });
        jest
          .spyOn(PageModelHost.prototype, 'scrollAncestors')
          .mockResolvedValue([owner]);
        const native = webContents.debugger.sendCommand.getMockImplementation();
        webContents.debugger.sendCommand.mockImplementation(
          async (method, params) => {
            await Promise.resolve();

            if (method === 'DOM.scrollIntoViewIfNeeded') {
              expect(read).toHaveBeenCalled();
              y = 90;
            }
            return native?.(method, params) ?? {};
          },
        );
        const command =
          mode === 'intoView'
            ? { kind: 'scroll' as const, ref: 'r', intoView: true as const }
            : { kind: 'scroll' as const, toText: 'Here', frame: 'f' };
        const response = await service.automation({
          browserId: `pv-${mode}`,
          command,
        });
        expect(response).toMatchObject({
          ok: true,
          receipt: {
            status: 'executed',
            inputMode: 'direct',
            target: DESCRIBED_TARGET,
            effects: { scroll: { container: 'element', y: 90, moved: true } },
          },
        });
        expect(
          webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === 'DOM.scrollIntoViewIfNeeded',
          ),
        ).toHaveLength(1);
        expect(modelSeam.resolveActionTarget.mock.calls[0]?.[0]).toEqual(
          mode === 'intoView'
            ? { kind: 'ref', ref: 'r' }
            : { kind: 'text', text: 'Here', frame: 'f' },
        );
        await service.shutdown();
      },
    );
    it.each([
      // What Chromium answers for display: none: no quads, and no error.
      ['has no quads', (): Promise<unknown> => Promise.resolve({ quads: [] })],
      [
        'cannot be measured',
        async (): Promise<unknown> => {
          await Promise.resolve();
          throw new Error('No node with given id found');
        },
      ],
    ])(
      'refuses to scroll an element that %s into view, before any input',
      async (_case, answer) => {
        const service = await pointerService('pv-unrendered');
        jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockResolvedValue(scrollState());
        jest
          .spyOn(PageModelHost.prototype, 'scrollAncestors')
          .mockResolvedValue([]);
        const native = webContents.debugger.sendCommand.getMockImplementation();
        webContents.debugger.sendCommand.mockImplementation(
          async (method, params) => {
            await Promise.resolve();
            if (method === 'DOM.getContentQuads') return answer();
            return native?.(method, params) ?? {};
          },
        );
        const response = await service.automation({
          browserId: 'pv-unrendered',
          command: { kind: 'scroll', ref: 'r', intoView: true },
        });
        expect(response).toMatchObject({
          ok: false,
          receipt: {
            kind: 'scroll',
            status: 'not_executed',
            error: {
              code: 'target_not_visible',
              message:
                'The element is not rendered, so it cannot be scrolled into view.',
            },
          },
        });
        expect(
          webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === 'DOM.scrollIntoViewIfNeeded',
          ),
        ).toEqual([]);
        await service.shutdown();
      },
    );
    it.each([
      [
        'an element hover from the element, after the scroll into view',
        { kind: 'hover', ref: 'r' },
        true,
      ],
      [
        'a hover at a point at that point, which scrolled nothing',
        { kind: 'hover', x: 40, y: 50 },
        false,
      ],
    ] as const)('records %s', async (_case, command, fromElement) => {
      const service = await pointerService('pv-hover-recorded');
      jest
        .spyOn(PageModelHost.prototype, 'recordingLocator')
        .mockResolvedValue("page.locator('#menu')");
      const origin = jest
        .spyOn(PageModelHost.prototype, 'boxOrigin')
        .mockResolvedValue({ x: 5, y: 5 });
      jest
        .spyOn(PageModelHost.prototype, 'topPoint')
        .mockImplementation(async (_target, point) => {
          await Promise.resolve();
          return point;
        });
      jest
        .spyOn(PageModelHost.prototype, 'sessionPoint')
        .mockImplementation(async (_target, point) => {
          await Promise.resolve();
          return point;
        });
      if (!fromElement) {
        // A point resolves to the element under it, which is hit-tested
        // at that exact point.
        modelSeam.resolveActionTarget.mockResolvedValue({
          status: 'found',
          target: { ...seamTarget('point'), point: { x: 40, y: 50 } },
        });
        const native = webContents.debugger.sendCommand.getMockImplementation();
        webContents.debugger.sendCommand.mockImplementation(
          async (method, params) => {
            if (
              method === 'Runtime.callFunctionOn' &&
              String(params?.functionDeclaration).includes('function(x, y)')
            )
              return { result: { value: { receivesEvents: true } } };
            return await (native?.(method, params) ?? Promise.resolve({}));
          },
        );
      }
      await service.startRecording('pv-hover-recorded');
      const response = await service.automation({
        browserId: 'pv-hover-recorded',
        command,
      });
      expect(response.receipt).toMatchObject({ status: 'executed' });
      const [step] = service
        .getRecording('pv-hover-recorded')
        .steps.filter((recorded) => recorded.action === 'hover');
      if (fromElement) {
        // The viewport point alone would replay over whatever is there
        // before the element is scrolled into view.
        expect(step?.playwright).toMatch(
          /^\{\n {2}const source = page\.locator\('#menu'\);\n {2}await source\.scrollIntoViewIfNeeded\(\);\n {2}const box = await source\.boundingBox\(\);/,
        );
        expect(step?.playwright).toMatch(
          /await page\.mouse\.move\(box\.x[^,]*, box\.y[^)]*\);\n\}$/,
        );
        expect(step?.locator).toBe("page.locator('#menu')");
      } else {
        expect(step?.playwright).toBe('await page.mouse.move(40, 50);');
        expect(origin).not.toHaveBeenCalled();
      }
      await service.shutdown();
    });
    it.each([
      [
        false,
        ['The matched text is still clipped or out of view after scrolling.'],
      ],
      [true, undefined],
      [undefined, undefined],
    ])(
      'warns only when the matched words are known to be out of view (%s)',
      async (shown, warnings) => {
        const service = await pointerService('pv-text-shown');
        jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockResolvedValue(scrollState());
        jest
          .spyOn(PageModelHost.prototype, 'scrollAncestors')
          .mockResolvedValue([]);
        jest
          .spyOn(PageModelHost.prototype, 'textMatchShown')
          .mockResolvedValue(shown);
        modelSeam.resolveActionTarget.mockImplementation(async (request) => {
          await Promise.resolve();
          return {
            status: 'found',
            target:
              request.kind === 'text'
                ? { ...seamTarget('native-target'), scrollNode: 77 }
                : seamTarget('page', { backendNodeId: 1 }),
          };
        });
        const response = await service.automation({
          browserId: 'pv-text-shown',
          command: { kind: 'scroll', toText: 'Here' },
        });
        expect(response.receipt).toMatchObject({ status: 'executed' });
        expect(response.receipt?.warnings).toEqual(warnings);
        await service.shutdown();
      },
    );
    it('reports the element that holds the text as the container when that is what scrolled', async () => {
      const service = await pointerService('pv-text-owner');
      // Text directly inside its scroller, as in a log: the held element
      // (backend node 22) is the box that moves. The walk up from the text
      // node meets it first.
      let y = 0;
      jest
        .spyOn(PageModelHost.prototype, 'readScrollState')
        .mockImplementation(async (target) => {
          await Promise.resolve();
          return scrollState(target.identity.backendNodeId === 22 ? y : 0);
        });
      const ancestors = jest
        .spyOn(PageModelHost.prototype, 'scrollAncestors')
        .mockResolvedValue([
          seamTarget('native-target', { backendNodeId: 22 }),
        ]);
      const measured = jest
        .spyOn(PageModelHost.prototype, 'textMatchRect')
        .mockResolvedValue(undefined);
      const native = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        async (method, params) => {
          await Promise.resolve();
          if (method === 'DOM.scrollIntoViewIfNeeded') y = 90;
          return native?.(method, params) ?? {};
        },
      );
      modelSeam.resolveActionTarget.mockImplementation(async (request) => {
        await Promise.resolve();
        return {
          status: 'found',
          target:
            request.kind === 'text'
              ? { ...seamTarget('native-target'), scrollNode: 77 }
              : seamTarget('page', { backendNodeId: 1 }),
        };
      });
      const response = await service.automation({
        browserId: 'pv-text-owner',
        command: { kind: 'scroll', toText: '  Line   60 HERE ' },
      });
      expect(response).toMatchObject({
        ok: true,
        receipt: {
          status: 'executed',
          effects: { scroll: { container: 'element', y: 90, moved: true } },
        },
      });
      // The scrollers are collected from the text match, and the words are
      // measured with the same normalized text the search used.
      expect(ancestors.mock.calls[0]?.[0]).toMatchObject({ scrollNode: 77 });
      expect(measured).toHaveBeenCalledTimes(1);
      expect(measured.mock.calls[0]?.[1]).toBe('line 60 here');
      await service.shutdown();
    });
    it.each([
      [
        'to the matched words inside their text node',
        { x: 0, y: 1485, width: 133, height: 15 },
        [
          {
            backendNodeId: 77,
            rect: { x: 0, y: 1485, width: 133, height: 15 },
          },
        ],
      ],
      [
        'to the text node when the words cannot be measured',
        undefined,
        [{ backendNodeId: 77 }],
      ],
    ])(
      'scrolls %s, not to the element around it',
      async (_case, rect, sent) => {
        const service = await pointerService('pv-text-node');
        jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockResolvedValue(scrollState());
        jest
          .spyOn(PageModelHost.prototype, 'scrollAncestors')
          .mockResolvedValue([]);
        // One text node can hold a whole log: Chromium is told where in the
        // node the words are, and brings that rectangle into view.
        jest
          .spyOn(PageModelHost.prototype, 'textMatchRect')
          .mockResolvedValue(rect);
        // A text match holds the element and names the text node it found.
        modelSeam.resolveActionTarget.mockImplementation(async (request) => {
          await Promise.resolve();
          return {
            status: 'found',
            target:
              request.kind === 'text'
                ? { ...seamTarget('native-target'), scrollNode: 77 }
                : seamTarget('page', { backendNodeId: 1 }),
          };
        });
        const response = await service.automation({
          browserId: 'pv-text-node',
          command: { kind: 'scroll', toText: 'Here' },
        });
        expect(response).toMatchObject({
          ok: true,
          receipt: { status: 'executed', inputMode: 'direct' },
        });
        const calls = (method: string): unknown[] =>
          webContents.debugger.sendCommand.mock.calls
            .filter(([sentMethod]) => sentMethod === method)
            .map(([, params]) => params);
        expect(calls('DOM.getContentQuads')).toEqual([{ backendNodeId: 77 }]);
        expect(calls('DOM.scrollIntoViewIfNeeded')).toEqual(sent);
        await service.shutdown();
      },
    );
    it('drag confirms its source press and reports the held source state, with steps default replay', async () => {
      const service = await pointerService('pv-drag');
      const command = {
        kind: 'drag',
        from: { ref: 'r' },
        to: { ref: 'd' },
        actionId: 'drag-default',
      } as const;
      const response = await service.automation({
        browserId: 'pv-drag',
        command,
      });
      const replay = await service.automation({
        browserId: 'pv-drag',
        command: { ...command, steps: 10 },
      });
      expect(response).toMatchObject({
        ok: true,
        completed: true,
        receipt: {
          status: 'executed',
          inputMode: 'trusted',
          target: DESCRIBED_TARGET,
        },
      });
      expect(replay.repeated).toBe(true);
      expect(modelSeam.resolveActionTarget).toHaveBeenCalledTimes(2);
      expect(modelSeam.describeActionTarget).toHaveBeenCalledWith(
        expect.objectContaining({ objectId: 'native-target' }),
        { secret: false },
      );
      expect(
        webContents.debugger.sendCommand.mock.calls
          .filter(([m]) => m === 'Input.setInterceptDrags')
          .map(([, p]) => p?.enabled),
      ).toEqual([true, false]);
      await service.shutdown();
    });
    it('records an agent drag once, without the page events it causes', async () => {
      const service = await pointerService('pv-drag-recorded');
      await service.startRecording('pv-drag-recorded');
      // What the page recorder reports for a native slider's input events.
      const pageStep = (id: string, timestamp: number): void => {
        ipcListeners.get('canopy-browser-view:event')?.(
          { sender: { id: webContents.id } },
          {
            type: 'recording-step',
            step: {
              id,
              action: 'fill',
              timestamp,
              playwright: "await page.locator('#range').fill('72');",
            },
          },
        );
      };
      pageStep('before the drag', Date.now() - 10_000);
      let during = 0;
      const native = webContents.debugger.sendCommand.getMockImplementation();
      webContents.debugger.sendCommand.mockImplementation(
        async (method, params) => {
          await Promise.resolve();
          if (
            method === 'Input.dispatchMouseEvent' &&
            params?.type === 'mouseReleased'
          ) {
            during = Date.now();
            pageStep('during the drag', during);
          }
          return native?.(method, params) ?? {};
        },
      );
      const response = await service.automation({
        browserId: 'pv-drag-recorded',
        command: { kind: 'drag', from: { ref: 'r' }, to: { ref: 'd' } },
      });
      expect(response).toMatchObject({
        ok: true,
        receipt: { kind: 'drag', status: 'executed' },
      });
      expect(during).toBeGreaterThan(0);
      // A report can arrive after the action ended; its own time decides.
      pageStep('reported late', during);
      pageStep('after the drag', Date.now() + 1);
      expect(
        service
          .getRecording('pv-drag-recorded')
          .steps.filter((step) => step.action !== 'goto')
          .map((step) => (step.action === 'drag' ? 'drag' : step.id)),
      ).toEqual(['before the drag', 'drag', 'after the drag']);
      await service.shutdown();
    });
    it('leaves a click on a secret target out of the recording when the page recorder did not hold it secret', async () => {
      const service = await pointerService('pv-secret-click');
      await service.startRecording('pv-secret-click');
      jest
        .spyOn(PageModelHost.prototype, 'hostActionTarget')
        .mockImplementation((target) =>
          Promise.resolve({ ...target, objectId: 'host-target' }),
        );
      modelSeam.isActionTargetSecret.mockResolvedValue(true);
      const native = webContents.debugger.sendCommand.getMockImplementation();
      let reported = false;
      webContents.debugger.sendCommand.mockImplementation(
        async (method, params) => {
          await Promise.resolve();
          if (
            method === 'Input.dispatchMouseEvent' &&
            params?.type === 'mouseReleased'
          ) {
            reported = true;
            // What the page recorder reports for a click on an ARIA option.
            ipcListeners.get('canopy-browser-view:event')?.(
              { sender: { id: webContents.id } },
              {
                type: 'recording-step',
                step: {
                  id: 'option',
                  action: 'click',
                  locator: "page.getByText('4111 1111 1111 1111')",
                  playwright:
                    "await page.getByText('4111 1111 1111 1111').click();",
                  timestamp: Date.now(),
                },
              },
            );
          }
          return native?.(method, params) ?? {};
        },
      );

      const response = await service.automation({
        browserId: 'pv-secret-click',
        command: { kind: 'click', ref: 'r' },
      });

      expect(response).toMatchObject({
        ok: true,
        receipt: { kind: 'click', status: 'executed' },
      });
      expect(reported).toBe(true);
      const recording = service.getRecording('pv-secret-click');
      expect(recordingText(recording)).not.toContain('4111');
      expect(recording.steps.filter((step) => step.action !== 'goto')).toEqual([
        expect.objectContaining({
          action: 'click',
          valueRedacted: true,
          playwright: '// Secret interaction omitted from recording.',
        }),
      ]);
      await service.shutdown();
    });
    it.each(['hover', 'scroll', 'drag'] as const)(
      '%s is unknown after its first mutating command is cancelled',
      async (kind) => {
        const service = await pointerService(`pv-after-${kind}`);
        const controller = new AbortController();
        jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockResolvedValue(scrollState());
        jest
          .spyOn(PageModelHost.prototype, 'wheelPoint')
          .mockResolvedValue({ x: 100, y: 50 });
        installNativePipeline({
          input: async () => {
            await Promise.resolve();

            controller.abort();
            return {};
          },
        });
        const command =
          kind === 'drag'
            ? { kind, from: { ref: 'r' }, to: { ref: 'd' } }
            : kind === 'scroll'
              ? { kind, direction: 'down' as const, pixels: 10 }
              : { kind, ref: 'r' };
        const response = await service.automation(
          { browserId: `pv-after-${kind}`, command },
          controller.signal,
        );
        expect(response).toMatchObject({
          ok: true,
          completed: false,
          receipt: { status: 'outcome_unknown' },
        });
        await service.shutdown();
      },
    );
    it.each(['hover', 'scroll', 'drag'] as const)(
      '%s checks the frame fence before input',
      async (kind) => {
        const service = await pointerService(`pv-fence-${kind}`);
        modelSeam.isTargetDocumentCurrent.mockReturnValue(false);
        jest
          .spyOn(PageModelHost.prototype, 'readScrollState')
          .mockResolvedValue(scrollState());
        const command =
          kind === 'drag'
            ? { kind, from: { ref: 'r' }, to: { ref: 'd' } }
            : kind === 'scroll'
              ? { kind, direction: 'down' as const, pixels: 10 }
              : { kind, ref: 'r' };
        const response = await service.automation({
          browserId: `pv-fence-${kind}`,
          command,
        });
        expect(response.receipt).toMatchObject({
          status: 'not_executed',
          error: { code: 'frame_unavailable' },
        });
        expect(
          webContents.debugger.sendCommand.mock.calls.some(([m]) =>
            m.startsWith('Input.'),
          ),
        ).toBe(false);
        await service.shutdown();
      },
    );
    it('drag refuses different documents even when they share a session', async () => {
      const service = await pointerService('pv-cross-drag');
      modelSeam.resolveActionTarget
        .mockResolvedValueOnce({
          status: 'found',
          target: seamTarget('source'),
        })
        .mockResolvedValueOnce({
          status: 'found',
          target: seamTarget('destination', { frameId: 'child' }),
        });
      const response = await service.automation({
        browserId: 'pv-cross-drag',
        command: { kind: 'drag', from: { ref: 'r' }, to: { ref: 'd' } },
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'execution_failed' },
        receipt: {
          status: 'not_executed',
          error: {
            code: 'unsupported_capability',
            message:
              'Drag works within one document; the destination is in another frame.',
          },
        },
      });
      await service.shutdown();
    });
  });
});
