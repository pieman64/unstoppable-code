// S0.3 probe: one browser profile binding (a Session) with its probe-owned
// enforcement surface. Electron main process only.
//
// Per Session this installs exactly ONE onBeforeRequest listener, modelling
// BrowserProfileNetworkPolicy as the sole owner: the maintenance pause and the
// lease URL policy compose inside that single callback. Everything else here
// (resolving gateway, header attribution, permission/download/device handlers,
// window-open and frame-navigation guards, CDP chooser interception) is a
// disposable probe fixture, not a production composition claim.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  BrowserWindow,
  session,
  webContents as electronWebContents,
} from 'electron';
import { evaluateLeasedUrl } from '../net/address-policy.mjs';
import {
  createGatewayProxy,
  createSyntheticResolver,
  defaultDecide,
} from '../net/gateway-proxy.mjs';
import { redactUrl } from '../evidence.mjs';

export const ATTRIBUTION_HEADER = 'x-s03-lease';
const SAFE_CONTROL_PERMISSIONS = new Set(['notifications']);
const MAX_EVENTS = 20000;

/**
 * @param {{
 *   kind: 'shared'|'task',
 *   partition: string,
 *   workDir: string,
 *   ports: { local: number, public: number },
 *   deniedOrigins: string[],
 * }} options
 */
export async function createBinding(options) {
  const { kind, partition, workDir, ports } = options;
  const ses = session.fromPartition(partition, { cache: false });
  const downloadsDir = path.join(workDir, 'downloads', kind);
  mkdirSync(downloadsDir, { recursive: true });

  /** @type {Map<number, { token: string, exceptionOrigin: string, deniedOrigins: string[] }>} */
  const leases = new Map();
  /** Task profile: every request in the Session belongs to the task lease. */
  let sessionLease = null;
  const controlIds = new Set();
  const windows = new Set();
  const listenerEvents = [];
  const handlerEvents = [];
  const setupNotes = [];
  // Mirrors BrowserProfileNetworkPolicy's maintenance fence so the single
  // callback shows how a lease decision composes with it. Never fenced here.
  const maintenance = { paused: false, controls: new Set() };

  const push = (list, entry) => {
    if (list.length < MAX_EVENTS)
      list.push({ seq: list.length, at: Date.now(), ...entry });
  };
  const leaseFor = (id) =>
    id !== undefined && leases.has(id)
      ? leases.get(id)
      : kind === 'task'
        ? sessionLease
        : null;
  const isLeasedId = (id) =>
    (id !== undefined && id !== null && leases.has(id)) ||
    (kind === 'task' && sessionLease !== null);

  // ── Resolving gateway: the only component that sees the actual address ──
  const resolver = createSyntheticResolver({
    'public.s03.test': ['203.0.113.10'],
    'local.s03.test': ['127.0.0.1'],
    'dev.s03.test': ['127.0.0.1'],
    'rebind.s03.test': ['203.0.113.20', '127.0.0.1'],
    'metadata.s03.test': ['169.254.169.254'],
  });
  const route = (address, port) => {
    if (address.startsWith('203.0.113.'))
      return { host: '127.0.0.1', port: ports.public };
    if (
      address === '127.0.0.1' ||
      address === '::ffff:127.0.0.1' ||
      address === '::ffff:7f00:1'
    ) {
      return { host: '127.0.0.1', port };
    }
    return null; // never dial anything else: no egress
  };
  const decide = (ctx) => {
    const lease =
      kind === 'task'
        ? sessionLease
        : [...leases.values()].find((entry) => entry.token === ctx.attribution);
    if (!lease) return { allow: true, reason: 'unattributed-user-traffic' };
    return defaultDecide({
      exceptionOrigins: [lease.exceptionOrigin],
      deniedOrigins: lease.deniedOrigins,
    })(ctx);
  };
  const gateway = createGatewayProxy({
    name: `${kind}-gateway`,
    resolver,
    route,
    decide,
    attributionHeader: ATTRIBUTION_HEADER,
  });
  const { port: gatewayPort } = await gateway.listen(0, '127.0.0.1');
  await ses.setProxy({
    proxyRules: `http://127.0.0.1:${gatewayPort}`,
    proxyBypassRules: '<-loopback>',
  });
  await ses.closeAllConnections();
  const proxyResolution = {};
  for (const probe of [
    'http://127.0.0.1:9/',
    'ws://local.s03.test:9/',
    'https://public.s03.test/',
    'http://[::1]:9/',
  ]) {
    proxyResolution[probe] = await ses.resolveProxy(probe);
  }

  // ── The sole onBeforeRequest listener for this Session ──
  ses.webRequest.onBeforeRequest((details, callback) => {
    const id = details.webContentsId;
    const maintenanceCancel =
      maintenance.paused && (id === undefined || !maintenance.controls.has(id));
    const lease = leaseFor(id);
    const decision = lease
      ? evaluateLeasedUrl(details.url, {
          exceptionOrigin: lease.exceptionOrigin,
          deniedOrigins: lease.deniedOrigins,
        })
      : null;
    const cancel = maintenanceCancel || (decision ? !decision.allow : false);
    push(listenerEvents, {
      webContentsId: id ?? null,
      leased: isLeasedId(id),
      resourceType: details.resourceType,
      url: redactUrl(details.url),
      cancel,
      reason: maintenanceCancel
        ? 'maintenance-fence'
        : decision
          ? decision.reason
          : 'no-lease',
      hostKind: decision ? decision.hostKind : null,
    });
    callback({ cancel });
  });
  // Attribution for the gateway: plain-HTTP proxy requests carry the lease
  // token. CONNECT tunnels cannot. Page-supplied copies are always removed.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = {};
    for (const [name, value] of Object.entries(details.requestHeaders)) {
      if (name.toLowerCase() !== ATTRIBUTION_HEADER)
        requestHeaders[name] = value;
    }
    const lease = leaseFor(details.webContentsId);
    if (lease) requestHeaders[ATTRIBUTION_HEADER] = lease.token;
    callback({ requestHeaders });
  });

  // ── Permission, device, download handlers (attributed by webContents) ──
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const id = contents ? contents.id : null;
    const leased = isLeasedId(id ?? undefined);
    const allow =
      !leased && SAFE_CONTROL_PERMISSIONS.has(permission) && controlIds.has(id);
    push(handlerEvents, {
      kind: permission === 'openExternal' ? 'external' : 'permission',
      phase: 'request',
      permission,
      webContentsId: id,
      decision: allow ? 'allow' : 'deny',
      detail:
        permission === 'openExternal'
          ? redactUrl(details?.externalURL ?? '')
          : undefined,
    });
    callback(allow);
  });
  ses.setPermissionCheckHandler((contents, permission) => {
    const id = contents ? contents.id : null;
    const leased = isLeasedId(id ?? undefined);
    const allow =
      !leased &&
      SAFE_CONTROL_PERMISSIONS.has(permission) &&
      id !== null &&
      controlIds.has(id);
    push(handlerEvents, {
      kind: permission === 'openExternal' ? 'external' : 'permission',
      phase: 'check',
      permission,
      webContentsId: id,
      decision: allow ? 'allow' : 'deny',
    });
    return allow;
  });
  ses.setDevicePermissionHandler((details) => {
    push(handlerEvents, {
      kind: 'device',
      phase: 'device-permission',
      permission: details.deviceType,
      webContentsId: null,
      decision: 'deny',
    });
    return false;
  });
  for (const eventName of [
    'select-usb-device',
    'select-hid-device',
    'select-serial-port',
  ]) {
    ses.on(eventName, (event, details, callback) => {
      event.preventDefault();
      const contents = details.frame
        ? electronWebContents.fromFrame(details.frame)
        : null;
      push(handlerEvents, {
        kind: 'device',
        phase: eventName,
        webContentsId: contents ? contents.id : null,
        decision: 'deny',
      });
      callback();
    });
  }
  ses.on('will-download', (event, item, contents) => {
    const id = contents ? contents.id : null;
    if (id !== null && controlIds.has(id) && !isLeasedId(id)) {
      item.setSavePath(
        path.join(
          downloadsDir,
          `control-${randomBytes(4).toString('hex')}.bin`,
        ),
      );
      push(handlerEvents, {
        kind: 'download',
        phase: 'will-download',
        webContentsId: id,
        decision: 'allow',
      });
      item.once('done', (_event, state) => {
        push(handlerEvents, {
          kind: 'download',
          phase: 'done',
          webContentsId: id,
          decision: state === 'completed' ? 'completed' : state,
        });
      });
      return;
    }
    event.preventDefault();
    push(handlerEvents, {
      kind: 'download',
      phase: 'will-download',
      webContentsId: id,
      decision: 'deny',
    });
  });

  /**
   * Opens a hidden tab. Leased tabs get a lease before any navigation.
   * @param {'leased'|'control'} role
   * @param {string|null} exceptionOrigin
   */
  async function openTab(role, exceptionOrigin) {
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    windows.add(win);
    const contents = win.webContents;
    const id = contents.id;
    let lease = null;
    if (role === 'leased') {
      lease = {
        token: `lease-${randomBytes(8).toString('hex')}`,
        exceptionOrigin,
        deniedOrigins: options.deniedOrigins,
      };
      leases.set(id, lease);
      if (kind === 'task') sessionLease = lease;
    } else {
      controlIds.add(id);
    }

    contents.setWindowOpenHandler((details) => {
      const leased = isLeasedId(id);
      push(handlerEvents, {
        kind: 'popup',
        phase: 'window-open',
        webContentsId: id,
        decision: leased ? 'deny' : 'allow',
        detail: redactUrl(details.url),
      });
      if (leased) return { action: 'deny' };
      // The child inherits the opener's Session and web preferences; only
      // visibility is overridden so the control pop-up stays hidden.
      return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
    });
    contents.on('did-create-window', (child) => {
      windows.add(child);
      push(handlerEvents, {
        kind: 'popup',
        phase: 'did-create-window',
        webContentsId: id,
        decision: 'created',
      });
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      setTimeout(() => {
        if (!child.isDestroyed()) child.destroy();
      }, 1000);
    });
    contents.on('will-frame-navigate', (event) => {
      if (!isLeasedId(id) || !lease) return;
      const decision = evaluateLeasedUrl(event.url, {
        exceptionOrigin: lease.exceptionOrigin,
        deniedOrigins: lease.deniedOrigins,
      });
      if (decision.allow) return;
      // Only non-network schemes are decided here; network URLs are the sole
      // listener's job so its evidence is not double counted.
      if (decision.reason !== 'scheme-denied') return;
      event.preventDefault();
      push(handlerEvents, {
        kind: 'external',
        phase: 'will-frame-navigate',
        webContentsId: id,
        decision: 'deny',
        detail: redactUrl(event.url),
      });
    });
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      push(handlerEvents, {
        kind: 'device',
        phase: 'select-bluetooth-device',
        webContentsId: id,
        decision: 'deny',
      });
      callback('');
    });

    // Chooser interception must be active before any page can open one: a
    // native panel would otherwise appear on screen.
    await contents.loadURL('about:blank');
    contents.debugger.attach('1.3');
    contents.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') {
        push(handlerEvents, {
          kind: 'file-chooser',
          phase: 'Page.fileChooserOpened',
          webContentsId: id,
          decision: isLeasedId(id) ? 'deny' : 'intercepted',
          detail: String(params?.mode ?? ''),
        });
      } else if (method === 'Page.javascriptDialogOpening') {
        push(handlerEvents, {
          kind: 'dialog',
          phase: method,
          webContentsId: id,
          decision: 'dismissed',
        });
        contents.debugger
          .sendCommand('Page.handleJavaScriptDialog', { accept: false })
          .catch(() => {});
      }
    });
    await contents.debugger.sendCommand('Page.enable');
    await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
      enabled: true,
    });
    return { win, contents, id, lease };
  }

  async function dispose() {
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      try {
        if (win.webContents.debugger.isAttached())
          win.webContents.debugger.detach();
      } catch (error) {
        setupNotes.push(`debugger detach failed: ${String(error)}`);
      }
      win.destroy();
    }
    windows.clear();
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onBeforeSendHeaders(null);
    ses.setPermissionRequestHandler(null);
    ses.setPermissionCheckHandler(null);
    ses.setDevicePermissionHandler(null);
    ses.removeAllListeners('will-download');
    for (const eventName of [
      'select-usb-device',
      'select-hid-device',
      'select-serial-port',
    ])
      ses.removeAllListeners(eventName);
    await ses.closeAllConnections().catch(() => {});
    await ses.clearStorageData().catch(() => {});
    await ses.setProxy({ mode: 'direct' }).catch(() => {});
    await gateway.close();
  }

  return {
    kind,
    partition,
    ses,
    gateway,
    gatewayPort,
    resolver,
    proxyResolution,
    listenerEvents,
    handlerEvents,
    setupNotes,
    openTab,
    dispose,
  };
}
