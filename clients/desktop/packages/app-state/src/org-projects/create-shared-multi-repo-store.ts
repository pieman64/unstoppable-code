import { useCanopyClientStore } from '../CanopyClientProvider';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { create, useStore } from 'zustand';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../client-store-lifecycle';
import type { CanopyClient, Unsubscribe } from '@canopy/app-core';
import type { SharedMultiRepoClient } from '@canopy/app-core/client';
import {
  normalizeOrgProjectName,
  type CreateSharedMultiRepoParams,
  type PrepareSharedMultiRepoParams,
  type PreparedSharedMultiRepo,
  type SharedMultiRepoCreationStatus,
} from '@canopy/protocol/org-projects';

export interface SharedMultiRepoState {
  name: string;
  preview: PreparedSharedMultiRepo | null;
  selection: PrepareSharedMultiRepoParams | null;
  submitted: CreateSharedMultiRepoParams | null;
  status: SharedMultiRepoCreationStatus | null;
  recent: readonly SharedMultiRepoCreationStatus[];
  recoveryChecked: boolean;
  recoveryError: string | null;
  busy: boolean;
  error: string | null;
  setName(name: string): void;
  prepare(selection: PrepareSharedMultiRepoParams): Promise<void>;
  submit(): Promise<void>;
  refresh(): Promise<void>;
  discover(): Promise<void>;
  observe(status: SharedMultiRepoCreationStatus): void;
  cancelSetup(): Promise<void>;
  revise(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The selected desktop is unavailable. Reconnect and try again.';
}

function currentStatus(
  previous: SharedMultiRepoCreationStatus | null,
  next: SharedMultiRepoCreationStatus,
): SharedMultiRepoCreationStatus {
  return previous?.creationKey === next.creationKey &&
    previous.updatedAt > next.updatedAt
    ? previous
    : next;
}

/** Renderer drafts are editable only until acceptance. The host persists intent. */
export function createSharedMultiRepoStore(
  client: SharedMultiRepoClient,
  newKey: () => string = () => crypto.randomUUID(),
): StoreApi<SharedMultiRepoState> {
  let generation = 0;
  let reading = false;
  return createStore<SharedMultiRepoState>((set, get) => ({
    name: '',
    preview: null,
    selection: null,
    submitted: null,
    status: null,
    recent: [],
    recoveryChecked: false,
    recoveryError: null,
    busy: false,
    error: null,
    setName: (name): void => {
      if (!get().submitted && !get().status) set({ name, error: null });
    },
    prepare: async (selection): Promise<void> => {
      if (get().submitted || get().status) return;
      const request = ++generation;
      const snapshot: PrepareSharedMultiRepoParams = {
        mode: selection.mode,
        selections: selection.selections.map((item) => ({ ...item })),
      };
      set({ busy: true, preview: null, selection: snapshot, error: null });
      try {
        const preview = await client.prepare(snapshot);
        if (request !== generation) return;
        set({ preview, name: get().name || preview.suggestedName });
      } catch (error) {
        if (request === generation) set({ error: message(error) });
      } finally {
        if (request === generation) set({ busy: false });
      }
    },
    submit: async (): Promise<void> => {
      if (get().busy) return;
      const recovered = get().status;
      if (!get().submitted && recovered) {
        if (
          !client.resume ||
          ![
            'create-unconfirmed',
            'setup-failed',
            'setup-cancelled',
            'completion-pending',
            'access-blocked',
          ].includes(recovered.state)
        )
          return;
        set({ busy: true, error: null });
        try {
          const status = await client.resume(recovered.creationKey);
          set((state) => ({ status: currentStatus(state.status, status) }));
        } catch (error) {
          set({ error: message(error) });
        } finally {
          set({ busy: false });
        }
        return;
      }
      if (!get().submitted && !get().recoveryChecked) {
        set({ busy: true });
        await get().discover();
        set({ busy: false });
        if (!get().recoveryChecked) return;
      }
      let params = get().submitted;
      if (!params) {
        const { preview, selection, name, status } = get();
        if (status || !preview || !selection || !preview.canCreate) return;
        const normalizedName = normalizeOrgProjectName(name);
        const invalid =
          normalizedName.length === 0 ? 'Enter a project name.' : null;
        if (invalid || normalizedName.length > 256) {
          set({
            error:
              invalid || 'Use at most 256 characters for the project name.',
          });
          return;
        }
        params = {
          ...selection,
          selections: selection.selections.map((item) => ({ ...item })),
          request: {
            organizationId: preview.organizationId,
            creationKey: newKey(),
            name: normalizedName,
            sourceProjects: preview.sourceProjects.map((source) => ({
              ...source,
            })),
          },
        };
        // Lock synchronously, including when the transport loses the reply.
        set({ submitted: params });
      }
      set({ busy: true, error: null });
      try {
        const status = await client.create(params);
        set((state) => ({ status: currentStatus(state.status, status) }));
      } catch (error) {
        set({ error: message(error) });
      } finally {
        set({ busy: false });
      }
    },
    refresh: async (): Promise<void> => {
      const key =
        get().submitted?.request.creationKey ?? get().status?.creationKey;
      if (!key || reading) return;
      reading = true;
      try {
        const status = await client.getCreation(key);
        if (
          status &&
          key ===
            (get().submitted?.request.creationKey ?? get().status?.creationKey)
        )
          set((state) => ({
            status: currentStatus(state.status, status),
            error: null,
          }));
      } catch (error) {
        set({ error: message(error) });
      } finally {
        reading = false;
      }
    },
    discover: async (): Promise<void> => {
      try {
        set({
          recent: await client.listCreations(),
          recoveryChecked: true,
          recoveryError: null,
        });
      } catch (error) {
        set({ recoveryChecked: false, recoveryError: message(error) });
      }
    },
    observe: (status): void => {
      if (get().busy || get().submitted) return;
      ++generation;
      set({ status, preview: null, error: null });
    },
    revise: async (): Promise<void> => {
      const { status, submitted, busy } = get();
      if (status?.state !== 'rejected' || busy) return;
      const selection = submitted
        ? {
            mode: submitted.mode,
            selections: submitted.selections,
          }
        : get().selection;
      if (!selection) return;
      set({ submitted: null, status: null, error: null });
      await get().prepare(selection);
    },
    cancelSetup: async (): Promise<void> => {
      const status = get().status;
      if (!status?.projectId || get().busy) return;
      set({ busy: true, error: null });
      try {
        await client.cancelSetup(status.organizationId, status.projectId);
        await get().refresh();
      } catch (error) {
        set({ error: message(error) });
      } finally {
        set({ busy: false });
      }
    },
  }));
}

// The provider keeps immutable attempts when their dialog closes. Host identity
// is part of the key: switching a paired desktop never carries a request over.
const sessionsKey = Symbol('shared-multi-repo-sessions');
interface SharedMultiRepoSessions {
  epoch: number;
  session(
    client: SharedMultiRepoClient,
    key: string,
  ): StoreApi<SharedMultiRepoState>;
}
export function createSharedMultiRepoSessions(
  client: CanopyClient,
): ClientStore<SharedMultiRepoSessions> {
  const clients = new Map<
    SharedMultiRepoClient,
    Map<string, StoreApi<SharedMultiRepoState>>
  >();
  const registry: ClientStore<SharedMultiRepoSessions> =
    create<SharedMultiRepoSessions>(() => ({
      epoch: 0,
      session: (client, key): StoreApi<SharedMultiRepoState> => {
        const sessions =
          clients.get(client) ??
          new Map<string, StoreApi<SharedMultiRepoState>>();
        clients.set(client, sessions);
        const existing = sessions.get(key);
        if (existing) return existing;
        const store = createSharedMultiRepoStore(client);
        sessions.set(key, store);
        return store;
      },
    }));
  let unsubscribe: Unsubscribe | undefined;
  registry[CLIENT_STORE_ACTIVATE] = (): void => {
    unsubscribe?.();
    unsubscribe = client.subscribe('workspace-context.changed', (event) => {
      if (event.reason !== 'account-change') return;
      clients.clear();
      registry.setState((state) => ({ epoch: state.epoch + 1 }));
    });
  };
  registry[CLIENT_STORE_DISPOSE] = (): void => {
    unsubscribe?.();
    clients.clear();
  };
  return registry;
}

export function useSharedMultiRepoSession(
  client: SharedMultiRepoClient,
  key: string,
): StoreApi<SharedMultiRepoState> {
  const sessions = useCanopyClientStore(
    sessionsKey,
    createSharedMultiRepoSessions,
  );
  const epoch = useStore(sessions, (state) => state.epoch);
  return sessions.getState().session(client, `${epoch}:${key}`);
}
