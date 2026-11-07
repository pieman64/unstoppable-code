import { randomUUID } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import type {
  InterfaceToolCall,
  InterfaceToolCallPort,
  InterfaceToolRegistry,
  InterfaceToolReplyDisposition,
} from '@canopy/core-runtime/node/client';
import {
  getAppAdvisorRendererToolRequestOriginChatId,
  type AppAdvisorRendererToolCancellation,
  type AppAdvisorRendererToolRequest,
  type ShowFilesRendererRequest,
} from '@canopy/desktop-shared/types';
import type { InterimInMemoryBindingOptions } from '../renderer-relay/interim-in-memory-binding';
import { appAdvisorActionSchema } from '../../app-advisor/definitions';

type LeaseEvent = 'did-navigate' | 'render-process-gone' | 'destroyed';
const LEASE_EVENTS: readonly LeaseEvent[] = [
  'did-navigate',
  'render-process-gone',
  'destroyed',
];
const MAX_TRACKED_ORIGINS = 32;
const SURFACE = /^local-desktop-renderer:(main|app-advisor)$/;

/** The WebContents members this module uses; Electron's WebContents satisfies it. */
export interface InterfaceLeaseWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: LeaseEvent, listener: () => void): unknown;
  removeListener(event: LeaseEvent, listener: () => void): unknown;
}
type ToolHooks = NonNullable<InterimInMemoryBindingOptions['onTools']>;
export interface DesktopInterfaceLeases {
  register: ToolHooks['register'];
  unregister: ToolHooks['unregister'];
  /** IPC reply routing (R10, R11). 'unknown_call' means the reply is not the registry's. */
  reply(
    senderWebContentsId: number,
    response: unknown,
  ): InterfaceToolReplyDisposition;
  /** Ends every desktop lease. */
  dispose(): void;
}
export interface DesktopInterfaceLeasesOptions {
  registry: InterfaceToolRegistry;
  webContentsFromId: (id: number) => InterfaceLeaseWebContents | null;
  send: (
    target: InterfaceLeaseWebContents,
    request: AppAdvisorRendererToolRequest,
  ) => boolean;
  sendCancellation: (
    target: InterfaceLeaseWebContents,
    cancellation: AppAdvisorRendererToolCancellation,
  ) => boolean;
  newLeaseId?: (
    surface: 'main' | 'app-advisor',
    webContentsId: number,
  ) => string;
}

interface DesktopLease {
  readonly leaseId: string;
  readonly surface: 'main' | 'app-advisor';
  readonly listeners: Map<LeaseEvent, () => void>;
  /** callId -> origin chat id of a delivered call. */
  readonly origins: Map<string, string | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isShowFilesRendererRequest(
  value: unknown,
): value is ShowFilesRendererRequest {
  if (!isRecord(value) || !Array.isArray(value.files)) return false;
  const { target, origin } = value;
  return (
    value.files.every(
      (file) => isRecord(file) && typeof file.path === 'string',
    ) &&
    isRecord(target) &&
    typeof target.projectId === 'string' &&
    typeof target.worktreeId === 'string' &&
    isRecord(origin) &&
    typeof origin.projectId === 'string' &&
    typeof origin.worktreeId === 'string' &&
    typeof origin.chatTabId === 'string'
  );
}

function rendererRequestFor(
  call: InterfaceToolCall,
): AppAdvisorRendererToolRequest | null {
  if (call.toolName === 'ui.app_advisor.present') {
    const action = appAdvisorActionSchema.safeParse(call.input.action);
    const {
      originWorktreeId,
      originProjectId,
      originChatTabId,
      expectedUiRevision,
    } = call.input;
    if (!action.success || typeof originWorktreeId !== 'string') return null;
    return {
      kind: 'dispatch_action',
      requestId: call.callId,
      action: action.data,
      originWorktreeId,
      ...(typeof originProjectId === 'string' ? { originProjectId } : {}),
      ...(typeof originChatTabId === 'string' ? { originChatTabId } : {}),
      ...(typeof expectedUiRevision === 'number' ? { expectedUiRevision } : {}),
      interfaceToolCall: true,
    };
  }
  if (
    call.toolName === 'ui.show_files' ||
    call.toolName === 'ui.app_advisor.show_files'
  ) {
    const payload = call.input.payload;
    return isShowFilesRendererRequest(payload)
      ? { kind: 'show_files', requestId: call.callId, payload }
      : null;
  }
  const originChatTabId = call.input.originChatTabId;
  return {
    kind: 'get_current_ui_state',
    requestId: call.callId,
    ...(typeof originChatTabId === 'string' ? { originChatTabId } : {}),
  };
}

/** IPC keeps `undefined` properties; a reply is judged as the JSON it would serialize to. */
function asJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return value;
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return value;
  }
}

function trustedSurface(
  caller: CanopyCallerDescriptor,
  webContentsId: number,
): 'main' | 'app-advisor' {
  const surface = SURFACE.exec(caller.principalId)?.[1];
  if (
    (surface !== 'main' && surface !== 'app-advisor') ||
    !Number.isSafeInteger(webContentsId) ||
    caller.interfaceKind !== 'desktop' ||
    !caller.grants.includes('core.client.manage')
  )
    throw canopyPermissionDeniedError('Untrusted interface tool registration.');
  return surface;
}

/**
 * Desktop interface leases (CAN-4131 D6): one lease per trusted renderer page
 * that registers tools, ended by that WebContents' navigation, crash or
 * destruction. Calls reach the page over the existing renderer tool IPC, and
 * only a reply from the same WebContents settles them.
 */
export function createDesktopInterfaceLeases(
  options: DesktopInterfaceLeasesOptions,
): DesktopInterfaceLeases {
  const { registry, webContentsFromId, send, sendCancellation } = options;
  const newLeaseId =
    options.newLeaseId ??
    ((surface, id): string =>
      `desktop-renderer:${surface}:${id}:${randomUUID()}`);
  const leases = new Map<number, DesktopLease>();

  const endLease = (webContentsId: number): void => {
    const lease = leases.get(webContentsId);
    if (!lease) return;
    const target = webContentsFromId(webContentsId);
    for (const [event, listener] of lease.listeners)
      target?.removeListener(event, listener);
    lease.listeners.clear();
    registry.endLease(lease.leaseId);
    leases.delete(webContentsId);
    lease.origins.clear();
  };

  const portFor = (
    webContentsId: number,
    origins: DesktopLease['origins'],
  ): InterfaceToolCallPort => ({
    deliver: (call) => {
      const target = webContentsFromId(webContentsId);
      if (!target || target.isDestroyed()) return false;
      const request = rendererRequestFor(call);
      if (!request) return false;
      origins.set(
        call.callId,
        getAppAdvisorRendererToolRequestOriginChatId(request),
      );
      while (origins.size > MAX_TRACKED_ORIGINS) {
        const oldest = origins.keys().next().value;
        if (oldest === undefined) break;
        origins.delete(oldest);
      }
      return send(target, request);
    },
    cancel: (callId) => {
      const originChatId = origins.get(callId);
      origins.delete(callId);
      const target = webContentsFromId(webContentsId);
      if (!target || target.isDestroyed()) return;
      sendCancellation(target, {
        requestId: callId,
        ...(originChatId ? { originChatId } : {}),
      });
    },
  });

  const openLease = (
    surface: 'main' | 'app-advisor',
    webContentsId: number,
  ): DesktopLease => {
    const target = webContentsFromId(webContentsId);
    if (!target || target.isDestroyed())
      throw canopyPermissionDeniedError(
        'Untrusted interface tool registration.',
      );
    const leaseId = newLeaseId(surface, webContentsId);
    const origins: DesktopLease['origins'] = new Map();
    registry.openLease(
      { leaseId, surface, interfaceKind: 'desktop' },
      portFor(webContentsId, origins),
    );
    const lease: DesktopLease = {
      leaseId,
      surface,
      listeners: new Map(),
      origins,
    };
    leases.set(webContentsId, lease);
    for (const event of LEASE_EVENTS) {
      const listener = (): void => {
        if (leases.get(webContentsId) === lease) endLease(webContentsId);
      };
      lease.listeners.set(event, listener);
      target.once(event, listener);
    }
    return lease;
  };

  return {
    register: (caller, params, webContentsId) => {
      const surface = trustedSurface(caller, webContentsId);
      let lease = leases.get(webContentsId);
      if (lease && lease.surface !== surface) {
        endLease(webContentsId);
        lease = undefined;
      }
      lease ??= openLease(surface, webContentsId);
      return registry.register(lease.leaseId, params);
    },
    unregister: (caller, params, webContentsId) => {
      trustedSurface(caller, webContentsId);
      const lease = leases.get(webContentsId);
      return registry.unregister(lease?.leaseId ?? '', params);
    },
    reply: (senderWebContentsId, response) => {
      if (!isRecord(response) || typeof response.requestId !== 'string')
        return 'unknown_call';
      const lease = leases.get(senderWebContentsId);
      const disposition = registry.reply(
        lease?.leaseId ?? '',
        response.requestId,
        asJson(response),
      );
      if (disposition === 'settled' || disposition === 'invalid')
        lease?.origins.delete(response.requestId);
      return disposition;
    },
    dispose: () => {
      for (const webContentsId of [...leases.keys()]) endLease(webContentsId);
    },
  };
}
