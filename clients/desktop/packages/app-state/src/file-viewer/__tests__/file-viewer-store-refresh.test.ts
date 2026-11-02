import type {
  CanopyCapabilities,
  CanopyClient,
  ChatMessageEvent,
  CommandMap,
  CommandName,
  DomainEventMap,
  DomainEventName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  PortalChatPart,
  PortalFilePreview,
  PortalFileReadPayload,
} from '@canopy/protocol/portal';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
} from '../../client-store-lifecycle';
import { createFileViewerStore } from '../create-file-viewer-store';

const CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

const REQUEST: PortalFileReadPayload = {
  projectId: 'p1',
  worktreeId: 'wt1',
  fileRootLocalId: 'root',
  relativePath: 'research/onboarding-findings.md',
};

const OTHER_REQUEST: PortalFileReadPayload = {
  ...REQUEST,
  relativePath: 'notes.md',
};

function preview(
  content: string,
  version = 'v1',
  overrides: Partial<PortalFilePreview> = {},
): PortalFilePreview {
  return {
    workspaceLocalId: 'p1',
    worktreeLocalId: 'wt1',
    path: REQUEST.relativePath,
    content,
    size: content.length,
    version,
    truncated: false,
    modifiedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = (): void => {};
  let reject: (error: Error) => void = (): void => {};
  const promise = new Promise<T>((res, rej): void => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ReadHandler = (args: PortalFileReadPayload) => Promise<PortalFilePreview>;
type SaveHandler = (
  args: CommandMap['file.save']['args'],
) => Promise<PortalFilePreview>;

interface Harness {
  client: CanopyClient;
  setRead(handler: ReadHandler): void;
  setSave(handler: SaveHandler): void;
  reads(): number;
  emit(event: ChatMessageEvent): void;
  listenerCount(): number;
}

function createHarness(): Harness {
  let read: ReadHandler = () => Promise.resolve(preview('six'));
  let save: SaveHandler = () => Promise.reject(new Error('no save'));
  let readCount = 0;
  const listeners = new Set<(event: ChatMessageEvent) => void>();
  const client: CanopyClient = {
    capabilities: CAPS,
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      if (name !== 'file.read') {
        return Promise.reject(new Error(`unexpected query ${name}`));
      }
      readCount += 1;
      return read(args as PortalFileReadPayload);
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      if (name !== 'file.save') {
        return Promise.reject(new Error(`unexpected command ${name}`));
      }
      return save(args as CommandMap['file.save']['args']);
    },
    subscribe<E extends DomainEventName>(
      name: E,
      listener: (event: DomainEventMap[E]) => void,
    ): Unsubscribe {
      if (name !== 'chat.message') return (): void => {};
      const typed = listener as (event: ChatMessageEvent) => void;
      listeners.add(typed);
      return (): void => {
        listeners.delete(typed);
      };
    },
  };
  return {
    client,
    setRead: (handler): void => {
      read = handler;
    },
    setSave: (handler): void => {
      save = handler;
    },
    reads: (): number => readCount,
    emit: (event): void => listeners.forEach((listener) => listener(event)),
    listenerCount: (): number => listeners.size,
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function editEvent(input: {
  toolUseId: string;
  filePath: string;
  chatId?: string;
  isError?: boolean;
  projectId?: string;
  worktreeId?: string;
}): ChatMessageEvent {
  const parts: PortalChatPart[] = [
    {
      kind: 'tool_use',
      data: {
        toolUseId: input.toolUseId,
        toolName: 'Edit',
        input: JSON.stringify({
          file_path: input.filePath,
          old_string: 'six',
          new_string: 'eight',
        }),
      },
    },
    {
      kind: 'tool_result',
      data: {
        toolUseId: input.toolUseId,
        output: 'ok',
        isError: input.isError ?? false,
      },
    },
  ];
  return {
    occurredAt: new Date().toISOString(),
    scope: 'worktree',
    workspaceLocalId: input.projectId ?? 'p1',
    worktreeLocalId: input.worktreeId ?? 'wt1',
    chatId: input.chatId ?? 'chat-1',
    message: {
      messageId: `m-${input.toolUseId}`,
      chatId: input.chatId ?? 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts,
      createdAtMs: Date.now(),
    },
  };
}

describe('file viewer refresh', () => {
  it('correlates an Edit started before its target session opens', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    const event = editEvent({
      toolUseId: 'open-during-edit',
      filePath: '/Users/r/Cowork/research/onboarding-findings.md',
    });
    harness.emit({
      ...event,
      message: { ...event.message, parts: event.message.parts?.slice(0, 1) },
    });
    expect(harness.reads()).toBe(0);
    const key = await store.getState().openFile(REQUEST);
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    harness.emit({
      ...event,
      message: {
        ...event.message,
        role: 'user',
        parts: event.message.parts?.slice(1),
      },
    });
    await flush();
    expect(store.getState().files[key].content).toBe('eight');
    expect(harness.reads()).toBe(2);
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('resolves a reopen during an in-flight refresh only once the refreshed bytes land', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);
    void store.getState().refreshFile(key);
    let reopened = false;
    const reopen = store
      .getState()
      .openFile(REQUEST)
      .then((reopenedKey) => {
        reopened = true;
        return reopenedKey;
      });
    await flush();
    // A caller revealing a location waits for the content it will reveal in.
    expect(reopened).toBe(false);
    read.resolve(preview('six\nseven\neight', 'v2'));
    expect(await reopen).toBe(key);
    expect(store.getState().files[key].content).toBe('six\nseven\neight');
    expect(store.getState().activeFileKey).toBe(key);
    expect(harness.reads()).toBe(2);
  });

  it('waits for one follow-up read at most while the file keeps changing', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const reads = [
      deferred<PortalFilePreview>(),
      deferred<PortalFilePreview>(),
      deferred<PortalFilePreview>(),
    ];
    let next = 0;
    harness.setRead(() => {
      const read = reads[next];
      next += 1;
      return read ? read.promise : Promise.resolve(preview('later', 'v9'));
    });
    void store.getState().refreshFile(key);
    let reopened = false;
    const reopen = store
      .getState()
      .openFile(REQUEST)
      .then(() => {
        reopened = true;
      });
    // A write lands during the refresh, so a follow-up read runs after it.
    store.getState().markFileChanged(key, 'agent-edit');
    reads[0]?.resolve(preview('seven', 'v2'));
    await flush();
    expect(reopened).toBe(false);
    // Another write lands during the follow-up; the reopen does not wait for
    // the read it starts.
    store.getState().markFileChanged(key, 'agent-edit');
    reads[1]?.resolve(preview('eight', 'v3'));
    await reopen;
    expect(store.getState().files[key].content).toBe('eight');
    reads[2]?.resolve(preview('nine', 'v4'));
    await flush();
    expect(store.getState().files[key].content).toBe('nine');
  });

  it('refreshes without activating when undo returns an externally changed buffer to clean', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const otherKey = await store.getState().openFile(OTHER_REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);

    store.getState().updateContent(key, 'six');

    expect(store.getState().files[key].externalChange).not.toBeNull();
    expect(harness.reads()).toBe(4);
    read.resolve(preview('eight', 'v2'));
    await flush();
    expect(store.getState().files[key].content).toBe('eight');
    expect(store.getState().files[key].externalChange).toBeNull();
    expect(store.getState().activeFileKey).toBe(otherKey);
  });

  it('retains recovery when the refresh after undo fails, and preserves new typing on retry', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    harness.setRead(() => Promise.reject(new Error('File not found')));
    store.getState().updateContent(key, 'six');
    await flush();
    expect(store.getState().files[key].content).toBe('six');
    expect(store.getState().files[key].externalChange).not.toBeNull();
    expect(store.getState().files[key].error).toBe('File not found');

    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);
    const retry = store.getState().reloadFromDisk(key);
    store.getState().updateContent(key, 'new typing');
    read.resolve(preview('eight', 'v2'));
    expect(await retry).toBe(false);
    expect(store.getState().files[key].content).toBe('new typing');
    expect(store.getState().files[key].preview?.version).toBe('v1');
  });

  it('does not replace edits after typing away and back during Show latest', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);
    const pending = store.getState().reloadFromDisk(key);
    store.getState().updateContent(key, 'mine plus typing');
    store.getState().updateContent(key, 'mine');
    read.resolve(preview('eight', 'v2'));
    expect(await pending).toBe(false);
    expect(store.getState().files[key].content).toBe('mine');
    expect(store.getState().files[key].preview?.version).toBe('v1');
  });

  it('retains a recoverable error for a deleted dirty file on background refresh', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.reject(new Error('File not found')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    expect(store.getState().files[key].content).toBe('mine');
    expect(store.getState().files[key].preview?.version).toBe('v1');
    expect(store.getState().files[key].error).toContain('File not found');
  });

  it('refreshes a clean background session without activating it', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const otherKey = await store.getState().openFile(OTHER_REQUEST);
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));

    await store.getState().refreshFile(key);

    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.preview?.version).toBe('v2');
    expect(session.reloadRevision).toBe(1);
    expect(store.getState().activeFileKey).toBe(otherKey);
  });

  it('does not count an initial load or an identical read as a reload', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    expect(store.getState().files[key].reloadRevision).toBe(0);
    harness.setRead(() => Promise.resolve(preview('six', 'v1b')));

    await store.getState().refreshFile(key);

    const session = store.getState().files[key];
    expect(session.reloadRevision).toBe(0);
    // Identical content may still refresh clean-session metadata.
    expect(session.preview?.version).toBe('v1b');
  });

  it('keeps unsaved edits and flags a changed disk version', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'six + my note');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));

    store.getState().markFileChanged(key, 'agent-edit');
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('six + my note');
    expect(session.dirty).toBe(true);
    expect(session.preview?.version).toBe('v1');
    expect(session.externalChange).toEqual({
      reloading: false,
      error: null,
      source: 'agent-edit',
    });
  });

  it('Keep my edits hides the notice and a later write shows it again', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();

    store.getState().dismissExternalChange(key);
    expect(store.getState().files[key].externalChange).toBeNull();
    expect(store.getState().files[key].preview?.version).toBe('v1');

    // Re-reading the version already dismissed keeps it dismissed.
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    expect(store.getState().files[key].externalChange).toBeNull();

    harness.setRead(() => Promise.resolve(preview('nine', 'v3')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    expect(store.getState().files[key].externalChange).not.toBeNull();
    expect(store.getState().files[key].content).toBe('mine');
  });

  it('keeps the stale baseline so a save after Keep my edits still conflicts', async () => {
    const harness = createHarness();
    const saves: CommandMap['file.save']['args'][] = [];
    harness.setSave((args) => {
      saves.push(args);
      return Promise.reject(new Error('File changed on disk.'));
    });
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    store.getState().dismissExternalChange(key);

    expect(await store.getState().saveFile(key)).toBe(false);
    expect(saves[0]?.expectedVersion).toBe('v1');
    expect(store.getState().files[key].content).toBe('mine');
    expect(store.getState().files[key].dirty).toBe(true);
  });

  it('Show latest replaces the buffer after a successful read', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();

    expect(await store.getState().reloadFromDisk(key)).toBe(true);

    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.dirty).toBe(false);
    expect(session.preview?.version).toBe('v2');
    expect(session.externalChange).toBeNull();
    expect(session.reloadRevision).toBe(1);
  });

  it('Show latest keeps edits and the notice when the read fails', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    harness.setRead(() =>
      Promise.reject(new Error('File not found: onboarding-findings.md')),
    );

    expect(await store.getState().reloadFromDisk(key)).toBe(false);

    const session = store.getState().files[key];
    expect(session.content).toBe('mine');
    expect(session.dirty).toBe(true);
    expect(session.externalChange).toEqual({
      reloading: false,
      error: 'File not found: onboarding-findings.md',
      source: 'agent-edit',
    });
  });

  it('Show latest does not overwrite typing that happens during its read', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    const gate = deferred<PortalFilePreview>();
    harness.setRead(() => gate.promise);

    const reload = store.getState().reloadFromDisk(key);
    expect(store.getState().files[key].externalChange?.reloading).toBe(true);
    store.getState().updateContent(key, 'mine, still typing');
    gate.resolve(preview('eight', 'v2'));

    expect(await reload).toBe(false);
    const session = store.getState().files[key];
    expect(session.content).toBe('mine, still typing');
    expect(session.preview?.version).toBe('v1');
    expect(session.externalChange).toEqual({
      reloading: false,
      error: null,
      source: 'agent-edit',
    });
  });

  it('refuses Show latest while a save is in flight', async () => {
    const harness = createHarness();
    const save = deferred<PortalFilePreview>();
    harness.setSave(() => save.promise);
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    const saving = store.getState().saveFile(key);

    expect(await store.getState().reloadFromDisk(key)).toBe(false);
    save.resolve(preview('mine', 'v2'));
    await saving;
  });

  it('runs one coalesced follow-up read for writes during the initial load', async () => {
    const harness = createHarness();
    const first = deferred<PortalFilePreview>();
    harness.setRead(() => first.promise);
    const store = createFileViewerStore(harness.client);
    const opening = store.getState().openFile(REQUEST);
    const key = Object.keys(store.getState().files)[0] ?? '';

    store.getState().markFileChanged(key, 'agent-edit');
    store.getState().markFileChanged(key, 'agent-edit');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    first.resolve(preview('six'));
    await opening;
    await flush();

    expect(harness.reads()).toBe(2);
    expect(store.getState().files[key].content).toBe('eight');
  });

  it('keeps a write reported during a follow-up read', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const second = deferred<PortalFilePreview>();
    harness.setRead(() => second.promise);
    store.getState().markFileChanged(key, 'agent-edit');
    store.getState().markFileChanged(key, 'agent-edit');
    harness.setRead(() => Promise.resolve(preview('eight, with quotes', 'v3')));
    second.resolve(preview('eight', 'v2'));
    await flush();

    expect(harness.reads()).toBe(3);
    expect(store.getState().files[key].content).toBe('eight, with quotes');
  });

  it('holds a write reported during a save until the save settles', async () => {
    const harness = createHarness();
    const save = deferred<PortalFilePreview>();
    harness.setSave(() => save.promise);
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    const saving = store.getState().saveFile(key);

    store.getState().markFileChanged(key, 'agent-edit');
    expect(harness.reads()).toBe(1);
    harness.setRead(() => Promise.resolve(preview('agent after save', 'v3')));
    save.resolve(preview('mine', 'v2'));
    await saving;
    await flush();

    expect(harness.reads()).toBe(2);
    expect(store.getState().files[key].content).toBe('agent after save');
  });

  it('keeps a pending write after a failed save and flags it', async () => {
    const harness = createHarness();
    const save = deferred<PortalFilePreview>();
    harness.setSave(() => save.promise);
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    const saving = store.getState().saveFile(key);

    store.getState().markFileChanged(key, 'agent-edit');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    save.reject(new Error('conflict'));
    await saving;
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('mine');
    expect(session.externalChange).toEqual({
      reloading: false,
      error: null,
      source: 'agent-edit',
    });
  });

  it.each([
    ['Discard', 'during'],
    ['Show latest', 'during'],
    ['Discard', 'before'],
    ['Show latest', 'before'],
  ])(
    'recovers through %s when an invalidation reported %s a failed save cannot be read',
    async (action, timing) => {
      const harness = createHarness();
      const save = deferred<PortalFilePreview>();
      harness.setSave(() => save.promise);
      const store = createFileViewerStore(harness.client);
      const key = await store.getState().openFile(REQUEST);
      store.getState().updateContent(key, 'mine');
      const read = deferred<PortalFilePreview>();
      harness.setRead(() => read.promise);
      if (timing === 'before')
        store.getState().markFileChanged(key, 'agent-edit');
      const saving = store.getState().saveFile(key);
      if (timing === 'during')
        store.getState().markFileChanged(key, 'agent-edit');
      harness.setRead(() => Promise.reject(new Error('offline')));
      save.reject(new Error('conflict'));
      expect(await saving).toBe(false);
      if (timing === 'before')
        read.reject(new Error('superseded read offline'));
      await flush();

      expect(store.getState().files[key].content).toBe('mine');
      expect(store.getState().files[key].reloadRevision).toBe(0);
      expect(store.getState().files[key].externalChange).toMatchObject({
        reloading: false,
        error: 'offline',
      });
      // Keeping the draft must not acknowledge the unchecked disk version.
      store.getState().dismissExternalChange(key);
      harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
      if (action === 'Discard') store.getState().discardEdits(key);
      else expect(await store.getState().reloadFromDisk(key)).toBe(true);
      await flush();

      const recovered = store.getState().files[key];
      expect(recovered.content).toBe('eight');
      expect(recovered.preview?.version).toBe('v2');
      expect(recovered.dirty).toBe(false);
      expect(recovered.status).toBe('idle');
      expect(recovered.error).toBeNull();
      expect(recovered.externalChange).toBeNull();
      expect(recovered.baselineStale).toBe(false);
      expect(recovered.reloadRevision).toBe(1);
      expect(harness.reads()).toBe(timing === 'before' ? 4 : 3);
    },
  );

  it('surfaces the change instead of overwriting typing during a background read', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const gate = deferred<PortalFilePreview>();
    harness.setRead(() => gate.promise);

    store.getState().markFileChanged(key, 'agent-edit');
    store.getState().updateContent(key, 'typed meanwhile');
    gate.resolve(preview('eight', 'v2'));
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('typed meanwhile');
    expect(session.preview?.version).toBe('v1');
    expect(session.externalChange).not.toBeNull();
  });

  it('keeps visible content and reports a recoverable error when a background read fails', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    harness.setRead(() => Promise.reject(new Error('File not found: x')));

    await store.getState().refreshFile(key);

    const session = store.getState().files[key];
    expect(session.content).toBe('six');
    expect(session.status).toBe('error');
    expect(session.error).toBe('File not found: x');
  });

  it('does not resurrect a session closed during a background read', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    const gate = deferred<PortalFilePreview>();
    harness.setRead(() => gate.promise);

    store.getState().markFileChanged(key, 'agent-edit');
    store.getState().markFileChanged(key, 'agent-edit');
    store.getState().closeFile(key);
    gate.resolve(preview('eight', 'v2'));
    await flush();

    expect(store.getState().files[key]).toBeUndefined();
    expect(harness.reads()).toBe(2);
  });

  it('does not apply a background read after disposal', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    const key = await store.getState().openFile(REQUEST);
    const gate = deferred<PortalFilePreview>();
    harness.setRead(() => gate.promise);

    store.getState().markFileChanged(key, 'agent-edit');
    store[CLIENT_STORE_DISPOSE]?.();
    gate.resolve(preview('eight', 'v2'));
    await flush();

    expect(store.getState().files[key].content).toBe('six');
  });
});

describe('file viewer agent-edit subscription', () => {
  it('refreshes aliases of one identity, including dirty sessions', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const a = await store.getState().openFile(REQUEST);
    const b = await store.getState().openFile({
      ...REQUEST,
      relativePath: 'research/./onboarding-findings.md',
    });
    store.getState().updateContent(a, 'mine a');
    store.getState().updateContent(b, 'mine b');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().notifyFileChanged({
      scope: { projectIds: ['p1'], worktreeIds: ['wt1'] },
      paths: ['/abs/research/onboarding-findings.md'],
    });
    await flush();
    expect(store.getState().files[a].externalChange).not.toBeNull();
    expect(store.getState().files[b].externalChange).not.toBeNull();
    expect(store.getState().files[a].content).toBe('mine a');
    expect(store.getState().files[b].content).toBe('mine b');
  });

  it('uses explicit root identity to resolve an otherwise ambiguous target', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const a = await store.getState().openFile(REQUEST);
    const b = await store
      .getState()
      .openFile({ ...REQUEST, fileRootLocalId: 'other' });
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().notifyFileChanged({
      scope: {
        projectIds: ['p1'],
        worktreeIds: ['wt1'],
        fileRootLocalId: 'root',
      },
      paths: ['/abs/research/onboarding-findings.md'],
    });
    await flush();
    expect(store.getState().files[a].content).toBe('eight');
    expect(store.getState().files[b].content).toBe('six');
  });

  it('can reopen after disposal interrupts an initial read', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    const oldRead = deferred<PortalFilePreview>();
    harness.setRead(() => oldRead.promise);
    const pending = store.getState().openFile(REQUEST);
    store[CLIENT_STORE_DISPOSE]?.();
    store[CLIENT_STORE_ACTIVATE]?.();
    harness.setRead(() => Promise.resolve(preview('eight')));
    const key = await store.getState().openFile(REQUEST);
    oldRead.resolve(preview('old late data'));
    await pending;
    expect(store.getState().files[key].content).toBe('eight');
    expect(store.getState().files[key].status).toBe('idle');
    expect(harness.listenerCount()).toBe(1);
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it('subscribes once and refreshes a matching clean session on a successful edit', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    store[CLIENT_STORE_ACTIVATE]?.();
    expect(harness.listenerCount()).toBe(1);
    const key = await store.getState().openFile(REQUEST);
    const otherKey = await store.getState().openFile(OTHER_REQUEST);
    harness.setRead((args) =>
      Promise.resolve(
        args.relativePath === REQUEST.relativePath
          ? preview('eight', 'v2')
          : preview('notes'),
      ),
    );

    harness.emit(
      editEvent({
        toolUseId: 'tu-1',
        filePath: '/Users/r/Cowork/research/onboarding-findings.md',
      }),
    );
    await flush();

    expect(store.getState().files[key].content).toBe('eight');
    expect(store.getState().activeFileKey).toBe(otherKey);
    expect(harness.reads()).toBe(3);

    // Replays of the same completion do not read again.
    harness.emit(
      editEvent({
        toolUseId: 'tu-1',
        filePath: '/Users/r/Cowork/research/onboarding-findings.md',
      }),
    );
    await flush();
    expect(harness.reads()).toBe(3);

    store[CLIENT_STORE_DISPOSE]?.();
    expect(harness.listenerCount()).toBe(0);
  });

  it('ignores failed edits, other scopes, and events without a scope', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    store[CLIENT_STORE_ACTIVATE]?.();
    await store.getState().openFile(REQUEST);
    const filePath = '/Users/r/Cowork/research/onboarding-findings.md';

    harness.emit(editEvent({ toolUseId: 'a', filePath, isError: true }));
    harness.emit(editEvent({ toolUseId: 'b', filePath, worktreeId: 'wt2' }));
    harness.emit({
      ...editEvent({ toolUseId: 'c', filePath }),
      workspaceLocalId: undefined,
      worktreeLocalId: undefined,
    });
    await flush();

    expect(harness.reads()).toBe(1);
  });

  it('does not warn a dirty session when roots sharing a relative path make the target ambiguous', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const keyA = await store.getState().openFile(REQUEST);
    const keyB = await store
      .getState()
      .openFile({ ...REQUEST, fileRootLocalId: 'other-root' });
    store.getState().updateContent(keyA, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));

    store.getState().notifyFileChanged({
      scope: { projectIds: ['p1'], worktreeIds: ['wt1'] },
      paths: ['/abs/research/onboarding-findings.md'],
    });
    await flush();

    expect(store.getState().files[keyA].externalChange ?? null).toBeNull();
    expect(store.getState().files[keyB].content).toBe('six');
  });

  it('skips an absolute suffix when two distinct identities match', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const deepKey = await store.getState().openFile(REQUEST);
    const shallowKey = await store
      .getState()
      .openFile({ ...REQUEST, relativePath: 'onboarding-findings.md' });
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));

    store.getState().notifyFileChanged({
      scope: { projectIds: ['p1'], worktreeIds: ['wt1'] },
      paths: ['/abs/research/onboarding-findings.md'],
    });
    await flush();

    expect(store.getState().files[deepKey].content).toBe('six');
    expect(store.getState().files[shallowKey].content).toBe('six');
  });

  it('does not suffix-match a relative tool path', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store
      .getState()
      .openFile({ ...REQUEST, relativePath: 'onboarding-findings.md' });
    harness.setRead(() => Promise.resolve(preview('eight')));
    store.getState().notifyFileChanged({
      scope: { projectIds: ['p1'], worktreeIds: ['wt1'] },
      paths: ['research/onboarding-findings.md'],
    });
    await flush();
    expect(store.getState().files[key].content).toBe('six');
  });
});

describe('file viewer notice resolution', () => {
  it('Discard drops the notice and shows the disk version', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();

    store.getState().discardEdits(key);
    await flush();

    const session = store.getState().files[key];
    expect(session.externalChange).toBeNull();
    expect(session.content).toBe('eight');
    expect(session.dirty).toBe(false);
  });
});

describe('file viewer Discard after Keep my edits', () => {
  // Opens six/v1, edits it, observes eight/v2 on disk, then keeps the edits.
  async function keepEditsOverChangedDisk(
    harness: Harness,
  ): Promise<{ store: ReturnType<typeof createFileViewerStore>; key: string }> {
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    store.getState().dismissExternalChange(key);
    expect(store.getState().files[key].externalChange).toBeNull();
    return { store, key };
  }

  it('loads the disk version on Discard', async () => {
    const harness = createHarness();
    let saves = 0;
    harness.setSave(() => {
      saves += 1;
      return Promise.reject(new Error('no save'));
    });
    const { store, key } = await keepEditsOverChangedDisk(harness);
    expect(harness.reads()).toBe(2);

    store.getState().discardEdits(key);
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.preview?.version).toBe('v2');
    expect(session.dirty).toBe(false);
    expect(session.status).toBe('idle');
    expect(session.error).toBeNull();
    expect(session.externalChange).toBeNull();
    expect(session.reloadRevision).toBe(1);
    expect(harness.reads()).toBe(3);
    expect(saves).toBe(0);
  });

  it('loads the disk version on Discard after a failed save, clearing its error only on success', async () => {
    const harness = createHarness();
    harness.setSave(() => Promise.reject(new Error('File changed on disk.')));
    const { store, key } = await keepEditsOverChangedDisk(harness);
    expect(await store.getState().saveFile(key)).toBe(false);
    expect(store.getState().files[key].error).toBe('File changed on disk.');
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);

    store.getState().discardEdits(key);

    const pending = store.getState().files[key];
    expect(pending.dirty).toBe(false);
    expect(pending.status).toBe('error');
    expect(pending.error).toBe('File changed on disk.');
    expect(pending.externalChange).toMatchObject({
      reloading: true,
      error: null,
    });
    expect(pending.reloadRevision).toBe(0);
    read.resolve(preview('eight', 'v2'));
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.preview?.version).toBe('v2');
    expect(session.status).toBe('idle');
    expect(session.error).toBeNull();
    expect(session.externalChange).toBeNull();
    expect(session.reloadRevision).toBe(1);
  });

  it('re-checks disk when undo returns the buffer to a kept stale baseline', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);

    store.getState().updateContent(key, 'six');

    expect(store.getState().files[key].content).toBe('six');
    read.resolve(preview('eight', 'v2'));
    await flush();
    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.preview?.version).toBe('v2');
    expect(session.externalChange).toBeNull();
    expect(harness.reads()).toBe(3);
  });

  it('reads the latest disk version rather than the earlier refresh', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    harness.setRead(() => Promise.resolve(preview('nine', 'v3')));

    store.getState().discardEdits(key);
    await flush();

    expect(store.getState().files[key].content).toBe('nine');
    expect(store.getState().files[key].preview?.version).toBe('v3');
  });

  it('keeps stale knowledge through dismissal and a failed read', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    harness.setRead(() => Promise.reject(new Error('offline')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    expect(store.getState().files[key].baselineStale).toBe(true);
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));

    store.getState().discardEdits(key);
    await flush();

    expect(store.getState().files[key].content).toBe('eight');
    expect(store.getState().files[key].baselineStale).toBe(false);
  });

  it('keeps an ordinary Discard local once Show latest established the baseline', async () => {
    const harness = createHarness();
    const store = createFileViewerStore(harness.client);
    const key = await store.getState().openFile(REQUEST);
    store.getState().updateContent(key, 'mine');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    store.getState().markFileChanged(key, 'agent-edit');
    await flush();
    expect(await store.getState().reloadFromDisk(key)).toBe(true);
    const reads = harness.reads();

    store.getState().updateContent(key, 'again');
    store.getState().discardEdits(key);
    await flush();

    expect(store.getState().files[key].content).toBe('eight');
    expect(store.getState().files[key].baselineStale).toBe(false);
    expect(harness.reads()).toBe(reads);
  });

  it('keeps an ordinary Discard local after a successful save', async () => {
    const harness = createHarness();
    harness.setSave((args) => Promise.resolve(preview(args.content, 'v3')));
    const { store, key } = await keepEditsOverChangedDisk(harness);
    expect(await store.getState().saveFile(key)).toBe(true);
    expect(store.getState().files[key].baselineStale).toBe(false);
    const reads = harness.reads();

    store.getState().updateContent(key, 'again');
    store.getState().discardEdits(key);
    await flush();

    expect(store.getState().files[key].content).toBe('mine');
    expect(harness.reads()).toBe(reads);
  });

  it('does not carry stale knowledge into a reopened session', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    store.getState().closeFile(key);
    await store.getState().openFile(REQUEST);
    expect(store.getState().files[key].baselineStale).toBe(false);
    const reads = harness.reads();

    store.getState().updateContent(key, 'mine');
    store.getState().discardEdits(key);
    await flush();

    expect(store.getState().files[key].content).toBe('eight');
    expect(harness.reads()).toBe(reads);
  });

  it('retains recovery with a retry when the Discard read fails', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    harness.setRead(() =>
      Promise.reject(new Error(`File not found: ${REQUEST.relativePath}`)),
    );

    store.getState().discardEdits(key);
    await flush();

    const failed = store.getState().files[key];
    expect(failed.content).toBe('six');
    expect(failed.dirty).toBe(false);
    expect(failed.baselineStale).toBe(true);
    expect(failed.reloadRevision).toBe(0);
    expect(failed.externalChange).toMatchObject({
      reloading: false,
      error: `File not found: ${REQUEST.relativePath}`,
    });

    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    expect(await store.getState().reloadFromDisk(key)).toBe(true);
    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.externalChange).toBeNull();
    expect(session.baselineStale).toBe(false);
    expect(session.reloadRevision).toBe(1);
  });

  it('clears stale knowledge when a clean refresh lands after failed recovery', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    harness.setRead(() => Promise.reject(new Error('offline')));
    store.getState().discardEdits(key);
    await flush();
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));

    await store.getState().refreshFile(key);

    expect(store.getState().files[key].content).toBe('eight');
    expect(store.getState().files[key].baselineStale).toBe(false);
    expect(store.getState().files[key].externalChange).toBeNull();
  });

  it('retains recovery with a retry when the read after undo fails', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    harness.setRead(() => Promise.reject(new Error('offline')));

    store.getState().updateContent(key, 'six');
    await flush();

    const failed = store.getState().files[key];
    expect(failed.content).toBe('six');
    expect(failed.baselineStale).toBe(true);
    expect(failed.externalChange).not.toBeNull();
    expect(failed.reloadRevision).toBe(0);
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    expect(await store.getState().reloadFromDisk(key)).toBe(true);
    expect(store.getState().files[key].content).toBe('eight');
  });

  it('keeps edits typed while the Discard read is pending', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);

    store.getState().discardEdits(key);
    store.getState().updateContent(key, 'new typing');
    read.resolve(preview('eight', 'v2'));
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('new typing');
    expect(session.dirty).toBe(true);
    expect(session.preview?.version).toBe('v1');
    expect(session.baselineStale).toBe(true);
    expect(session.externalChange).toMatchObject({
      reloading: false,
      error: null,
    });
    expect(session.reloadRevision).toBe(0);
  });

  it('re-reads after typing away and back while the Discard read is pending', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);

    store.getState().discardEdits(key);
    store.getState().updateContent(key, 'typed');
    store.getState().updateContent(key, 'six');
    harness.setRead(() => Promise.resolve(preview('eight', 'v2')));
    read.resolve(preview('eight', 'v2'));
    await flush();
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('eight');
    expect(session.preview?.version).toBe('v2');
    expect(session.dirty).toBe(false);
  });

  it('follows a write reported during the Discard read', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);

    store.getState().discardEdits(key);
    store.getState().markFileChanged(key, 'agent-edit');
    harness.setRead(() => Promise.resolve(preview('nine', 'v3')));
    read.resolve(preview('eight', 'v2'));
    await flush();
    await flush();

    expect(store.getState().files[key].content).toBe('nine');
    expect(store.getState().files[key].preview?.version).toBe('v3');
  });

  it('does not apply a late Discard read to a reopened session', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const read = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);
    store.getState().discardEdits(key);
    store.getState().closeFile(key);
    harness.setRead(() => Promise.resolve(preview('reopened', 'v4')));
    await store.getState().openFile(REQUEST);

    read.resolve(preview('eight', 'v2'));
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('reopened');
    expect(session.preview?.version).toBe('v4');
    expect(session.externalChange).toBeNull();
  });

  it('ignores Discard while a save is in flight', async () => {
    const harness = createHarness();
    const save = deferred<PortalFilePreview>();
    harness.setSave(() => save.promise);
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const saving = store.getState().saveFile(key);
    const reads = harness.reads();

    store.getState().discardEdits(key);

    const session = store.getState().files[key];
    expect(session.content).toBe('mine');
    expect(session.dirty).toBe(true);
    expect(session.status).toBe('saving');
    expect(harness.reads()).toBe(reads);
    save.reject(new Error('File changed on disk.'));
    await saving;
    expect(store.getState().files[key].baselineStale).toBe(true);
  });

  it('re-establishes stale knowledge for a write reported during a save', async () => {
    const harness = createHarness();
    const save = deferred<PortalFilePreview>();
    harness.setSave(() => save.promise);
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const saving = store.getState().saveFile(key);
    store.getState().updateContent(key, 'mine and more');
    store.getState().markFileChanged(key, 'agent-edit');
    harness.setRead(() => Promise.resolve(preview('nine', 'v4')));

    save.resolve(preview('mine', 'v3'));
    await saving;
    await flush();

    expect(store.getState().files[key].baselineStale).toBe(true);
    store.getState().dismissExternalChange(key);
    store.getState().discardEdits(key);
    await flush();
    expect(store.getState().files[key].content).toBe('nine');
    expect(store.getState().files[key].preview?.version).toBe('v4');
  });

  it.each(['Discard', 'undo'])(
    'keeps %s recovery pending until a newer invalidation succeeds, with retry on failure',
    async (action) => {
      const harness = createHarness();
      const { store, key } = await keepEditsOverChangedDisk(harness);
      const read = deferred<PortalFilePreview>();
      const latestRead = deferred<PortalFilePreview>();
      harness.setRead(() => read.promise);
      if (action === 'Discard') store.getState().discardEdits(key);
      else store.getState().updateContent(key, 'six');
      store.getState().markFileChanged(key, 'agent-edit');
      harness.setRead(() => latestRead.promise);

      read.resolve(preview('eight', 'v2'));
      await flush();

      const pending = store.getState().files[key];
      expect(pending.content).toBe('six');
      expect(pending.baselineStale).toBe(true);
      expect(pending.externalChange).not.toBeNull();
      expect(pending.reloadRevision).toBe(0);
      expect(harness.reads()).toBe(4);
      latestRead.reject(new Error('offline'));
      await flush();

      const failed = store.getState().files[key];
      expect(failed.baselineStale).toBe(true);
      expect(failed.externalChange).toMatchObject({
        reloading: false,
        error: 'offline',
      });
      expect(failed.reloadRevision).toBe(0);
      harness.setRead(() => Promise.resolve(preview('nine', 'v3')));
      expect(await store.getState().reloadFromDisk(key)).toBe(true);
      const recovered = store.getState().files[key];
      expect(recovered.content).toBe('nine');
      expect(recovered.preview?.version).toBe('v3');
      expect(recovered.baselineStale).toBe(false);
      expect(recovered.externalChange).toBeNull();
      expect(recovered.error).toBeNull();
      expect(recovered.reloadRevision).toBe(1);
    },
  );

  it.each(['mine', 'mine and more'])(
    'retains stale knowledge after Save with buffer "%s" while a newer invalidation is pending or fails',
    async (content) => {
      const harness = createHarness();
      const { store, key } = await keepEditsOverChangedDisk(harness);
      const save = deferred<PortalFilePreview>();
      const read = deferred<PortalFilePreview>();
      harness.setSave(() => save.promise);
      harness.setRead(() => read.promise);
      const saving = store.getState().saveFile(key);
      store.getState().updateContent(key, content);
      store.getState().markFileChanged(key, 'agent-edit');

      save.resolve(preview('mine', 'v3'));
      // CAN-5000 returns true only when the current buffer is clean.
      expect(await saving).toBe(content === 'mine');

      const pending = store.getState().files[key];
      expect(pending.content).toBe(content);
      expect(pending.dirty).toBe(content !== 'mine');
      expect(pending.baselineStale).toBe(true);
      expect(pending.externalChange).not.toBeNull();
      read.reject(new Error('offline'));
      await flush();
      expect(store.getState().files[key].baselineStale).toBe(true);
      expect(store.getState().files[key].externalChange).toMatchObject({
        reloading: false,
        error: 'offline',
      });
      harness.setRead(() => Promise.resolve(preview('nine', 'v4')));
      expect(await store.getState().reloadFromDisk(key)).toBe(true);
      expect(store.getState().files[key].content).toBe('nine');
      expect(store.getState().files[key].baselineStale).toBe(false);
    },
  );

  it('keeps new typing while a follow-up recovery read is pending', async () => {
    const harness = createHarness();
    const { store, key } = await keepEditsOverChangedDisk(harness);
    const read = deferred<PortalFilePreview>();
    const latestRead = deferred<PortalFilePreview>();
    harness.setRead(() => read.promise);
    store.getState().discardEdits(key);
    store.getState().markFileChanged(key, 'agent-edit');
    harness.setRead(() => latestRead.promise);
    read.resolve(preview('eight', 'v2'));
    await flush();

    store.getState().updateContent(key, 'new typing');
    latestRead.resolve(preview('nine', 'v3'));
    await flush();

    const session = store.getState().files[key];
    expect(session.content).toBe('new typing');
    expect(session.preview?.version).toBe('v1');
    expect(session.dirty).toBe(true);
    expect(session.baselineStale).toBe(true);
    expect(session.externalChange).toMatchObject({
      reloading: false,
      error: null,
    });
    expect(session.reloadRevision).toBe(0);
  });
});
