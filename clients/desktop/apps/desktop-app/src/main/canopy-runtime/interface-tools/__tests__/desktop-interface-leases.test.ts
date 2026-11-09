import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import {
  interfaceToolDescriptor,
  type CanopyCallerDescriptor,
  type CanopySchemaOutput,
  type CoreClientToolsRegisterParamsSchema,
  type CoreClientToolsRegisterResult,
  type CoreClientToolsUnregisterParamsSchema,
  type CoreClientToolsUnregisterResult,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorRendererToolCancellation,
  AppAdvisorRendererToolRequest,
  PipelineEditorRendererToolRequest,
} from '@canopy/desktop-shared/types';
import {
  createDesktopInterfaceLeases,
  type DesktopInterfaceLeases,
  type InterfaceLeaseWebContents,
} from '../desktop-interface-leases';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoreOperationAdapter } from '../../core-operation-adapter';
import { createDesktopRuntime } from '../../desktop-runtime';
import { createInterimInMemoryBindingProvider } from '../../renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelayEvent,
} from '../../renderer-relay/relay';

type LeaseEvent = 'did-navigate' | 'render-process-gone' | 'destroyed';

class FakeWebContents implements InterfaceLeaseWebContents {
  destroyed = false;
  readonly listeners = new Map<LeaseEvent, Set<() => void>>();
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  once(event: LeaseEvent, listener: () => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }
  removeListener(event: LeaseEvent, listener: () => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: LeaseEvent): void {
    const set = this.listeners.get(event);
    this.listeners.delete(event);
    for (const listener of set ?? []) listener();
  }
  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

const showFilesPayload = {
  files: [{ path: 'README.md' }],
  target: { projectId: 'p1', worktreeId: 'w1' },
  origin: { projectId: 'p1', worktreeId: 'w1', chatTabId: 'chat-1' },
};
const scope = { workspaceId: 'p1', worktreeId: 'w1', chatId: 'chat-1' };

interface Registrant {
  caller: CanopyCallerDescriptor;
  webContentsId: number;
}

function caller(
  overrides: Partial<CanopyCallerDescriptor> = {},
  surface: 'main' | 'app-advisor' = 'main',
  webContentsId = 1,
): Registrant {
  return {
    caller: {
      principalId: `local-desktop-renderer:${surface}`,
      clientInstanceId: 'renderer-relay:test',
      interfaceKind: 'desktop',
      authorityId: 'local-desktop',
      grants: ['core.client.manage'],
      ...overrides,
    },
    webContentsId,
  };
}

const register = (
  desktop: DesktopInterfaceLeases,
  { caller: registrant, webContentsId }: Registrant,
  input: CanopySchemaOutput<typeof CoreClientToolsRegisterParamsSchema>,
): CoreClientToolsRegisterResult =>
  desktop.register(registrant, input, webContentsId);
const unregister = (
  desktop: DesktopInterfaceLeases,
  { caller: registrant, webContentsId }: Registrant,
  input: CanopySchemaOutput<typeof CoreClientToolsUnregisterParamsSchema>,
): CoreClientToolsUnregisterResult =>
  desktop.unregister(registrant, input, webContentsId);

let keys = 0;
const params = (
  names: readonly InterfaceToolName[],
): CanopySchemaOutput<typeof CoreClientToolsRegisterParamsSchema> => ({
  tools: names.map(interfaceToolDescriptor),
  _meta: { idempotencyKey: `key-${++keys}` },
});

interface Harness {
  registry: InterfaceToolRegistry;
  contents: Map<number, FakeWebContents>;
  sent: { target: number; request: AppAdvisorRendererToolRequest }[];
  cancellations: {
    target: number;
    cancellation: AppAdvisorRendererToolCancellation;
  }[];
  editorSent: { target: number; request: PipelineEditorRendererToolRequest }[];
  desktop: DesktopInterfaceLeases;
}

function harness(): Harness {
  const registry = new InterfaceToolRegistry();
  const contents = new Map<number, FakeWebContents>([
    [1, new FakeWebContents(1)],
    [2, new FakeWebContents(2)],
  ]);
  const sent: { target: number; request: AppAdvisorRendererToolRequest }[] = [];
  const cancellations: {
    target: number;
    cancellation: AppAdvisorRendererToolCancellation;
  }[] = [];
  const editorSent: {
    target: number;
    request: PipelineEditorRendererToolRequest;
  }[] = [];
  let leases = 0;
  const desktop = createDesktopInterfaceLeases({
    registry,
    webContentsFromId: (id) => contents.get(id) ?? null,
    send: (target, request) => {
      sent.push({ target: target.id, request });
      return true;
    },
    sendCancellation: (target, cancellation) => {
      cancellations.push({ target: target.id, cancellation });
      return true;
    },
    sendPipelineEditor: (target, request) => {
      editorSent.push({ target: target.id, request });
      return true;
    },
    newLeaseId: (surface, id) => `lease-${surface}-${id}-${++leases}`,
  });
  return { registry, contents, sent, cancellations, editorSent, desktop };
}

const showFiles = (
  registry: InterfaceToolRegistry,
): ReturnType<InterfaceToolRegistry['invoke']> =>
  registry.invoke({
    toolName: 'ui.show_files',
    input: { payload: showFilesPayload },
    scope,
  });

function permissionDenied(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && 'payload' in error) {
      const payload: unknown = error.payload;
      if (typeof payload === 'object' && payload !== null && 'kind' in payload)
        return String(payload.kind);
    }
    return 'unknown';
  }
  return undefined;
}

describe('desktop interface leases (CAN-4131)', () => {
  it('a caller that is not a trusted renderer surface is refused before the registry', () => {
    const { registry, desktop } = harness();
    for (const bad of [
      caller({ principalId: 'local-desktop-renderer:portal' }),
      caller({ principalId: 'remote:main' }),
      { ...caller(), webContentsId: Number.NaN },
      { ...caller(), webContentsId: 1.5 },
      caller({ interfaceKind: 'portal' }),
    ]) {
      expect(
        permissionDenied(() =>
          register(desktop, bad, params(['ui.show_files'])),
        ),
      ).toBe('permission_denied');
    }
    expect(registry.available().toolNames).toEqual([]);
    expect(registry.hasLiveLease()).toBe(false);
  });

  it('a caller without core.client.manage is refused', () => {
    const { registry, desktop } = harness();
    expect(
      permissionDenied(() =>
        register(desktop, caller({ grants: [] }), params(['ui.show_files'])),
      ),
    ).toBe('permission_denied');
    expect(
      permissionDenied(() =>
        unregister(desktop, caller({ grants: [] }), { all: true }),
      ),
    ).toBe('permission_denied');
    expect(registry.hasLiveLease()).toBe(false);
  });

  it('a surface registers only its allowed tools', () => {
    const { registry, desktop } = harness();
    expect(
      register(
        desktop,
        caller(),
        params(['ui.get_current_ui_state', 'ui.show_files']),
      ).effectiveToolNames,
    ).toEqual(['ui.get_current_ui_state', 'ui.show_files']);
    expect(
      permissionDenied(() =>
        register(
          desktop,
          caller({}, 'app-advisor', 2),
          params(['ui.show_files']),
        ),
      ),
    ).toBe('invalid_argument');
    expect(
      register(desktop, caller({}, 'app-advisor', 2), params([]))
        .effectiveToolNames,
    ).toEqual([]);
    expect(registry.available().toolNames).toEqual([
      'ui.get_current_ui_state',
      'ui.show_files',
    ]);
  });

  it('navigation, crash and destroy each end the lease', async () => {
    for (const event of [
      'did-navigate',
      'render-process-gone',
      'destroyed',
    ] as const) {
      const { registry, contents, desktop, cancellations } = harness();
      register(desktop, caller(), params(['ui.show_files']));
      const main = contents.get(1);
      expect(main?.listenerCount()).toBe(3);
      const pending = showFiles(registry);
      if (event === 'destroyed' && main) main.destroyed = true;
      main?.emit(event);
      const outcome = await pending;
      expect(outcome.ok ? 'ok' : outcome.error.kind).toBe(
        'capability_unavailable',
      );
      expect(registry.available().toolNames).toEqual([]);
      expect(registry.hasLiveLease()).toBe(false);
      expect(main?.listenerCount()).toBe(0);
      expect(cancellations).toHaveLength(event === 'destroyed' ? 0 : 1);
      if (event === 'destroyed') continue;
      register(desktop, caller(), params(['ui.show_files']));
      expect(registry.available().toolNames).toEqual(['ui.show_files']);
    }
  });

  it("a delivered call reaches only its lease's WebContents with the call id as request id", async () => {
    const { registry, sent, desktop } = harness();
    register(desktop, caller({}, 'main', 1), params(['ui.show_files']));
    register(desktop, caller({}, 'app-advisor', 2), params([]));
    const pending = showFiles(registry);
    expect(sent).toHaveLength(1);
    const [{ target, request }] = sent;
    expect(target).toBe(1);
    expect(request).toMatchObject({
      kind: 'show_files',
      payload: showFilesPayload,
    });
    expect(desktop.reply(1, { requestId: request.requestId, ok: true })).toBe(
      'settled',
    );
    expect((await pending).ok).toBe(true);
    const uiState = registry.invoke({
      toolName: 'ui.get_current_ui_state',
      input: { originChatTabId: 'advisor-chat' },
      scope,
    });
    register(
      desktop,
      caller({}, 'main', 1),
      params(['ui.get_current_ui_state', 'ui.show_files']),
    );
    expect(errorOf(await uiState)).toBe('capability_unavailable');
    const second = registry.invoke({
      toolName: 'ui.get_current_ui_state',
      input: { originChatTabId: 'advisor-chat' },
      scope,
    });
    expect(sent[1]).toEqual({
      target: 1,
      request: {
        kind: 'get_current_ui_state',
        requestId: sent[1]?.request.requestId,
        originChatTabId: 'advisor-chat',
      },
    });
    desktop.reply(1, { requestId: sent[1]?.request.requestId, ok: true });
    expect((await second).ok).toBe(true);
  });

  it('a Pipeline Editor call reaches its lease as a pipeline editor request and only its reply settles it (CAN-5822)', async () => {
    const { registry, sent, editorSent, cancellations, desktop } = harness();
    expect(
      permissionDenied(() =>
        register(
          desktop,
          caller({}, 'app-advisor', 2),
          params(['ui.pipeline_editor.get_current']),
        ),
      ),
    ).toBe('invalid_argument');
    register(
      desktop,
      caller({}, 'main', 1),
      params(['ui.pipeline_editor.get_current', 'ui.pipeline_editor.open']),
    );
    const pending = registry.invoke({
      toolName: 'ui.pipeline_editor.open',
      input: { locator: { pipelineId: 'pipe-1' }, originChatId: 'editor' },
      scope,
    });
    expect(sent).toEqual([]);
    expect(editorSent).toEqual([
      {
        target: 1,
        request: {
          kind: 'open',
          requestId: editorSent[0]?.request.requestId,
          locator: { pipelineId: 'pipe-1' },
          originChatId: 'editor',
        },
      },
    ]);
    const requestId = editorSent[0]?.request.requestId;
    expect(desktop.reply(2, { requestId, ok: true })).toBe('wrong_lease');
    expect(desktop.reply(1, { requestId, ok: true })).toBe('settled');
    expect((await pending).ok).toBe(true);
    // A malformed call is never delivered; a cancelled one sends no cancel.
    expect(
      errorOf(
        await registry.invoke({
          toolName: 'ui.pipeline_editor.open',
          input: { locator: 'not a locator' },
          scope,
        }),
      ),
    ).toBe('capability_unavailable');
    const controller = new AbortController();
    const cancelled = registry.invoke({
      toolName: 'ui.pipeline_editor.get_current',
      input: {},
      scope,
      signal: controller.signal,
    });
    controller.abort();
    expect(errorOf(await cancelled)).toBe('cancelled');
    expect(cancellations).toEqual([]);
  });

  it('App Advisor presentation reaches the main lease as a flagged dispatch and a malformed action is not delivered (CAN-4133)', async () => {
    const { registry, sent, desktop } = harness();
    register(
      desktop,
      caller({}, 'main', 1),
      params(['ui.app_advisor.present']),
    );
    register(
      desktop,
      caller({}, 'app-advisor', 2),
      params(['ui.app_advisor.show_files']),
    );
    const presented = registry.invoke({
      toolName: 'ui.app_advisor.present',
      input: {
        action: { type: 'navigation.go_to_page', page: 'workflows' },
        originWorktreeId: 'global',
        originChatTabId: 'advisor-chat',
        expectedUiRevision: 3,
      },
      scope,
    });
    expect(sent).toEqual([
      {
        target: 1,
        request: {
          kind: 'dispatch_action',
          requestId: sent[0]?.request.requestId,
          action: { type: 'navigation.go_to_page', page: 'workflows' },
          originWorktreeId: 'global',
          originChatTabId: 'advisor-chat',
          expectedUiRevision: 3,
          interfaceToolCall: true,
        },
      },
    ]);
    desktop.reply(1, { requestId: sent[0]?.request.requestId, ok: true });
    expect((await presented).ok).toBe(true);

    const malformed = await registry.invoke({
      toolName: 'ui.app_advisor.present',
      input: { action: { page: 'workflows' }, originWorktreeId: 'global' },
      scope,
    });
    expect(errorOf(malformed)).toBe('capability_unavailable');
    expect(sent).toHaveLength(1);
  });

  it('a reply from another WebContents never settles the call', async () => {
    const { registry, sent, desktop } = harness();
    register(desktop, caller({}, 'main', 1), params(['ui.show_files']));
    let settled = false;
    const pending = showFiles(registry).then((outcome) => {
      settled = true;
      return outcome;
    });
    const requestId = sent[0]?.request.requestId;
    expect(desktop.reply(2, { requestId, ok: true })).toBe('wrong_lease');
    register(desktop, caller({}, 'app-advisor', 2), params([]));
    expect(desktop.reply(2, { requestId, ok: true })).toBe('wrong_lease');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(desktop.reply(1, { requestId, ok: true })).toBe('settled');
    expect((await pending).ok).toBe(true);
  });

  it("a forged clientInstanceId cannot bind another window's lease", async () => {
    const { registry, sent, desktop } = harness();
    register(desktop, caller({}, 'main', 1), params(['ui.show_files']));
    const forged = caller(
      { clientInstanceId: 'electron-web-contents:1' },
      'main',
      2,
    );
    expect(
      permissionDenied(() => unregister(desktop, forged, { all: true })),
    ).toBe('not_found');
    expect(registry.available().toolNames).toEqual(['ui.show_files']);

    const pending = showFiles(registry);
    expect(sent.map((entry) => entry.target)).toEqual([1]);
    const requestId = sent[0]?.request.requestId;
    expect(desktop.reply(2, { requestId, ok: true })).toBe('wrong_lease');
    expect(desktop.reply(1, { requestId, ok: true })).toBe('settled');
    expect((await pending).ok).toBe(true);
  });

  it('a reply with undefined optional fields settles as its JSON', async () => {
    const { registry, sent, desktop } = harness();
    register(desktop, caller(), params(['ui.show_files']));
    const pending = showFiles(registry);
    const requestId = sent[0]?.request.requestId;
    expect(
      desktop.reply(1, {
        requestId,
        ok: true,
        result: { opened: 1, section: undefined },
        error: undefined,
      }),
    ).toBe('settled');
    expect(await pending).toMatchObject({
      ok: true,
      reply: { requestId, ok: true, result: { opened: 1 } },
    });
  });

  it('a reply to a legacy request is not claimed', () => {
    const { desktop } = harness();
    register(desktop, caller(), params(['ui.show_files']));
    expect(desktop.reply(1, { requestId: 'legacy-request', ok: true })).toBe(
      'unknown_call',
    );
    expect(desktop.reply(1, { ok: true })).toBe('unknown_call');
    expect(desktop.reply(1, null)).toBe('unknown_call');
  });

  it("a cancellation carries the call's origin chat id", async () => {
    const { registry, sent, cancellations, desktop } = harness();
    register(desktop, caller(), params(['ui.show_files']));
    const controller = new AbortController();
    const pending = registry.invoke({
      toolName: 'ui.show_files',
      input: { payload: showFilesPayload },
      scope,
      signal: controller.signal,
    });
    controller.abort();
    expect(errorOf(await pending)).toBe('cancelled');
    expect(cancellations).toEqual([
      {
        target: 1,
        cancellation: {
          requestId: sent[0]?.request.requestId,
          originChatId: 'chat-1',
        },
      },
    ]);
    desktop.dispose();
    expect(registry.hasLiveLease()).toBe(false);
  });

  it('a registration through the renderer relay opens a lease for the sending WebContents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-interface-leases-'));
    const runtime = createDesktopRuntime({
      operationAdapter: createCoreOperationAdapter({
        ledgerPath: () => join(root, 'ledger.sqlite'),
      }),
      shutdownTimeoutMs: 25,
    });
    try {
      const sender = new FakeWebContents(7);
      const frame = {
        url: 'canopy://app',
        detached: false,
        isDestroyed: (): boolean => false,
      };
      const event: RendererRelayEvent = {
        sender: {
          id: sender.id,
          mainFrame: frame,
          getURL: (): string => frame.url,
          isDestroyed: (): boolean => sender.isDestroyed(),
          on: (name, listener) => sender.once(name, listener),
          removeListener: (name, listener) =>
            sender.removeListener(name, listener),
        },
        senderFrame: frame,
      };
      const sent: number[] = [];
      const desktop = createDesktopInterfaceLeases({
        registry: runtime.interfaceTools,
        webContentsFromId: (id) => (id === sender.id ? sender : null),
        send: (target) => {
          sent.push(target.id);
          return true;
        },
        sendCancellation: () => true,
        sendPipelineEditor: () => true,
      });
      const relay = createRendererRelay({
        bindingProvider: createInterimInMemoryBindingProvider(runtime, {
          onTools: {
            register: desktop.register,
            unregister: desktop.unregister,
          },
        }),
        resolveSurface: () => ({
          surface: 'main',
          caller: {
            principalId: 'local-desktop-host',
            clientInstanceId: 'host',
            authorityId: 'local-desktop',
            interfaceKind: 'desktop',
            grants: ['core.client.manage'],
          },
        }),
      });

      const reply = await relay.invoke(event, {
        kind: 'request',
        method: 'core.client.tools.register',
        params: params(['ui.show_files']),
      });
      expect(reply).toMatchObject({
        ok: true,
        value: { effectiveToolNames: ['ui.show_files'] },
      });
      expect(runtime.interfaceTools.available().toolNames).toEqual([
        'ui.show_files',
      ]);

      const pending = runtime.interfaceTools.invoke({
        toolName: 'ui.show_files',
        input: { payload: showFilesPayload },
        scope,
      });
      expect(sent).toEqual([sender.id]);
      sender.emit('destroyed');
      expect(errorOf(await pending)).toBe('capability_unavailable');
      expect(runtime.interfaceTools.hasLiveLease()).toBe(false);
      relay.dispose();
      desktop.dispose();
    } finally {
      await runtime.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function errorOf(
  outcome: Awaited<ReturnType<InterfaceToolRegistry['invoke']>>,
): string {
  return outcome.ok ? 'ok' : outcome.error.kind;
}
