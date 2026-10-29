import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import {
  getResourceMonitorService,
  type ResourceRegistrationHandle,
} from '../resource-monitor';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WebContentsView,
  webContents,
  type Session,
  type WebContents,
} from 'electron';
import { isProfileRecord } from '@canopy/protocol/browser-profiles';
import { registerIpcSurface } from '../lib/web-contents-send';

export interface BrowserVerifiedSite {
  origin: string;
  topLevelOrigin: string;
  registrableDomain: string;
  localStorageCount: number;
  databaseCount: number;
  cacheCount: number;
  workerCount: number;
  opfsEntries: number;
}
export interface BrowserNetworkFence {
  /** One permanent Session policy listener; maintenance never replaces it. */
  allowControl(contentsId: number): () => void;
}
export const SITE_DATA_TYPES = [
  'cookies',
  'fileSystems',
  'indexedDB',
  'localStorage',
  'serviceWorkers',
  'cache',
] satisfies NonNullable<Electron.ClearDataOptions['dataTypes']>;

/** Only origins, never supplied document paths or executable HTML. */
export function verificationOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserProfileError(
      'unsupported_scope',
      'This site cannot be verified. Choose a whole-profile reset.',
    );
  }
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' &&
      !(
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      ))
  )
    throw new BrowserProfileError(
      'unsupported_scope',
      'This site does not support trusted storage verification. Choose a whole-profile reset.',
    );
  return parsed.origin;
}
function bounded<T>(operation: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new BrowserProfileError(
              'unsupported_scope',
              'Storage verification did not finish. The profile remains paused; retry or choose a whole-profile reset.',
            ),
          ),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Used only while every real view/producer is fenced and closed. Never opens site code. */
export class BrowserNativeMaintenance {
  private readonly view: WebContentsView;
  readonly contents: WebContents;
  private disallow: () => void = () => undefined;
  private disposed = false;
  private resource?: ResourceRegistrationHandle;
  constructor(
    readonly native: Session,
    fence: BrowserNetworkFence,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        session: native,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.contents = this.view.webContents;
    registerIpcSurface(this.contents, 'browser');
    try {
      this.disallow = fence.allowControl(this.contents.id);
      this.contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.contents.debugger.attach('1.3');
      this.contents.on('did-finish-load', () => {
        const pid = this.contents.getOSProcessId();
        if (pid <= 0) return;
        if (this.resource) this.resource.update({ pid });
        else
          this.resource = getResourceMonitorService().registerProcess({
            id: `browser-verification:${randomUUID()}`,
            groupId: 'browser',
            kind: 'in-app-browser',
            label: 'Browser data verification',
            pid,
            startedAt: new Date().toISOString(),
            metadata: { type: 'generic' },
          });
      });
      this.contents.once('destroyed', () => this.resource?.unregister());
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  async stopWorkers(): Promise<void> {
    try {
      await bounded(this.native.closeAllConnections());
      await bounded(this.contents.loadURL('about:blank'));
      const target: unknown = await bounded(
        this.contents.debugger.sendCommand('Target.getTargetInfo'),
      );
      const context =
        isProfileRecord(target) && isProfileRecord(target.targetInfo)
          ? target.targetInfo.browserContextId
          : undefined;
      if (typeof context !== 'string' || !context)
        throw new Error('Unknown worker ownership');
      // Last-client closure stops dedicated/shared workers in the pinned runtime.
      // Prove termination in this Session before invoking a destructive API.
      await bounded(
        (async (): Promise<void> => {
          while (true) {
            const response: unknown =
              await this.contents.debugger.sendCommand('Target.getTargets');
            const targetInfos = isProfileRecord(response)
              ? response.targetInfos
              : undefined;
            if (!Array.isArray(targetInfos))
              throw new Error('Missing worker inventory');
            if (
              !targetInfos.some(
                (entry: unknown) =>
                  isProfileRecord(entry) &&
                  ['worker', 'shared_worker'].includes(String(entry.type)) &&
                  entry.browserContextId === context,
              )
            )
              return;
            await delay(20);
          }
        })(),
      );
      await bounded(this.contents.debugger.sendCommand('ServiceWorker.enable'));
      await bounded(
        this.contents.debugger.sendCommand('ServiceWorker.stopAllWorkers'),
      );
      await bounded(
        (async (): Promise<void> => {
          while (
            !this.disposed &&
            Object.keys(this.native.serviceWorkers.getAllRunning()).length
          )
            await delay(20);
        })(),
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  async inspect(
    originValue: string,
    topValue = originValue,
  ): Promise<BrowserVerifiedSite> {
    const origin = verificationOrigin(originValue);
    const topLevelOrigin = verificationOrigin(topValue);
    if (this.disposed)
      throw new BrowserProfileError(
        'recovery_required',
        'Storage verification is no longer active.',
      );
    // A per-inspection path prevents an existing cached/SW resource matching the document.
    const segment = `/__browser_profile_verification_${randomUUID()}`;
    const inspectUrl = origin + segment;
    const topUrl = topLevelOrigin + segment;
    const pending = new Set<Promise<unknown>>();
    const childSessions = new Set<string>();
    let failed = false;
    const send = (
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ): Promise<unknown> =>
      sessionId
        ? this.contents.debugger.sendCommand(method, params, sessionId)
        : this.contents.debugger.sendCommand(method, params);
    const track = (value: Promise<unknown>): void => {
      const handled = value.catch(() => {
        failed = true;
      });
      pending.add(handled);
      void handled.finally(() => pending.delete(handled));
    };
    const configure = async (sessionId?: string): Promise<void> => {
      await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
      await send(
        'Network.setCacheDisabled',
        { cacheDisabled: true },
        sessionId,
      );
      await send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
        sessionId,
      );
    };
    const handle = (
      _event: Electron.Event,
      method: string,
      parameters: Record<string, unknown>,
      sessionId?: string,
    ): void => {
      if (method === 'Target.attachedToTarget') {
        if (
          !isProfileRecord(parameters.targetInfo) ||
          parameters.targetInfo.type !== 'iframe' ||
          typeof parameters.sessionId !== 'string'
        ) {
          failed = true;
          return;
        }
        const childSessionId = parameters.sessionId;
        childSessions.add(childSessionId);
        track(
          configure(childSessionId).then(() =>
            send('Runtime.runIfWaitingForDebugger', {}, childSessionId),
          ),
        );
        return;
      }
      if (
        method === 'Target.detachedFromTarget' &&
        typeof parameters.sessionId === 'string'
      )
        childSessions.delete(parameters.sessionId);
      if (method !== 'Fetch.requestPaused') return;
      const request = isProfileRecord(parameters.request)
        ? parameters.request
        : {};
      const allowed =
        typeof request.url === 'string' &&
        parameters.resourceType === 'Document' &&
        [topUrl, inspectUrl].includes(request.url) &&
        request.method === 'GET';
      if (!allowed) {
        track(
          send(
            'Fetch.failRequest',
            { requestId: parameters.requestId, errorReason: 'BlockedByClient' },
            sessionId,
          ),
        );
        return;
      }
      const body =
        '<!doctype html><title>Local storage verification</title>' +
        (request.url === topUrl && topUrl !== inspectUrl
          ? `<iframe src="${inspectUrl}"></iframe>`
          : '');
      track(
        send(
          'Fetch.fulfillRequest',
          {
            requestId: parameters.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/html; charset=utf-8' },
              {
                name: 'Content-Security-Policy',
                value: `default-src 'none'; frame-src ${origin}; frame-ancestors ${topLevelOrigin}`,
              },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: Buffer.from(body).toString('base64'),
          },
          sessionId,
        ),
      );
    };
    this.contents.debugger.on('message', handle);
    try {
      const result = await bounded(
        (async (): Promise<BrowserVerifiedSite> => {
          await configure();
          if (topUrl !== inspectUrl)
            await send('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
              filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
            });

          await this.contents.loadURL(topUrl);

          const frame = this.contents.mainFrame.framesInSubtree.find(
            (frame) => frame.url === inspectUrl,
          );
          if (!frame) throw new Error('Missing verification frame');
          const counts: unknown = await frame.executeJavaScript(`(async () => {
          const root = await navigator.storage.getDirectory(); let opfsEntries = 0;
          for await (const entry of root.values()) { if (++opfsEntries > 100000) throw new Error('Inventory limit'); }
          return { localStorageCount: localStorage.length, databaseCount: (await indexedDB.databases()).length,
            cacheCount: (await caches.keys()).length, workerCount: (await navigator.serviceWorker.getRegistrations()).length, opfsEntries };
        })()`);

          await Promise.all(pending);

          if (
            failed ||
            !isProfileRecord(counts) ||
            Object.keys(counts).length !== 5 ||
            Object.values(counts).some(
              (value) =>
                typeof value !== 'number' ||
                !Number.isSafeInteger(value) ||
                value < 0,
            )
          )
            throw new Error('Incomplete verification');
          // The browser supplies its public-suffix-aware domain; never approximate it by splitting a hostname.
          const frameTree: unknown =
            await this.contents.debugger.sendCommand('Page.getFrameTree');
          const findDomain = (tree: unknown): string | undefined => {
            if (!isProfileRecord(tree)) return undefined;
            if (isProfileRecord(tree.frame) && tree.frame.url === inspectUrl)
              return typeof tree.frame.domainAndRegistry === 'string'
                ? tree.frame.domainAndRegistry
                : undefined;
            const children: unknown[] = Array.isArray(tree.childFrames)
              ? tree.childFrames
              : [];
            for (const child of children) {
              const domain = findDomain(child);
              if (domain !== undefined) return domain;
            }
            return undefined;
          };
          let registrableDomain = findDomain(
            isProfileRecord(frameTree) ? frameTree.frameTree : undefined,
          );
          // Out-of-process frames are absent from the parent target's tree.
          // Read their own CDP session; this still obtains Chromium's domain.
          for (const sessionId of Array.from(childSessions)) {
            if (registrableDomain !== undefined) break;
            const childTree = await send('Page.getFrameTree', {}, sessionId);
            registrableDomain = findDomain(
              isProfileRecord(childTree) ? childTree.frameTree : undefined,
            );
          }
          if (typeof registrableDomain !== 'string')
            throw new Error('Unknown cookie domain');
          const verified: BrowserVerifiedSite = {
            origin,
            topLevelOrigin,
            registrableDomain,
            localStorageCount: Number(counts.localStorageCount),
            databaseCount: Number(counts.databaseCount),
            cacheCount: Number(counts.cacheCount),
            workerCount: Number(counts.workerCount),
            opfsEntries: Number(counts.opfsEntries),
          };
          return verified;
        })(),
      );

      await bounded(this.contents.loadURL('about:blank'));
      if (topUrl !== inspectUrl)
        await bounded(
          send('Target.setAutoAttach', {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          }),
        );
      await bounded(send('Fetch.disable'));
      return result;
    } catch {
      this.dispose();
      throw new BrowserProfileError(
        'unsupported_scope',
        'The selected storage context could not be verified. Choose a whole-profile reset.',
      );
    } finally {
      this.contents.debugger.removeListener('message', handle);
    }
  }

  async verifyEmpty(
    contexts: { origin: string; topLevelOrigin: string }[],
  ): Promise<void> {
    for (const context of contexts) {
      const result = await this.inspect(context.origin, context.topLevelOrigin);
      if (
        [
          result.localStorageCount,
          result.databaseCount,
          result.cacheCount,
          result.workerCount,
          result.opfsEntries,
        ].some((count) => count !== 0)
      )
        throw new BrowserProfileError(
          'recovery_required',
          'Site data verification failed. This profile stays paused until cleanup succeeds.',
        );
    }
  }
  async release(): Promise<void> {
    this.dispose();
    await bounded(
      (async (): Promise<void> => {
        while (!this.contents.isDestroyed()) await delay(20);
      })(),
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The control never gets a path back to the network if teardown is interrupted.
    if (!this.contents.isDestroyed())
      this.contents.close({ waitForBeforeUnload: false });
    this.disallow();
  }
}

/** Exact Session ownership comes from the profile adapter, never a caller path. */
export async function closeProfileSessionViews(native: Session): Promise<void> {
  const owned = webContents
    .getAllWebContents()
    .filter((contents) => contents.session === native);
  for (const contents of owned)
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  await bounded(
    (async (): Promise<void> => {
      while (owned.some((contents) => !contents.isDestroyed())) await delay(20);
    })(),
  );
}

export async function clearRetiredBrowserSession(
  native: Session,
  fence: BrowserNetworkFence,
): Promise<void> {
  await closeProfileSessionViews(native);
  const control = new BrowserNativeMaintenance(native, fence);
  try {
    await control.stopWorkers();
    await native.clearData();
    await native.clearCache();
  } finally {
    await control.release();
  }
}
