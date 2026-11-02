import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  anchorKeptSidebarItemGroups,
  isSidebarItemGroupRetained,
  normalizeGroupedOrder,
  resolveSidebarItemGroupCollapsed,
  type SidebarItemGroup,
  type SidebarItemGroupMoveItemRequest,
} from '@canopy/protocol/sidebar';
import {
  projectPlacements,
  validSidebarPlacement,
  type SidebarPlacementSnapshot,
  type SidebarPlacementIntent,
} from './sidebar-placement-model';

export interface SidebarPlacementHost {
  save(request: SidebarItemGroupMoveItemRequest): Promise<void>;
  read(): Promise<SidebarPlacementSnapshot>;
  classifyFailure(error: unknown): 'rejected' | 'uncertain';
}
export interface SidebarPlacementState {
  confirmed: SidebarPlacementSnapshot;
  rendered: SidebarPlacementSnapshot;
  pending: readonly SidebarPlacementIntent[];
  pendingCount: number;
  error: unknown;
}
export interface SidebarPlacementStore extends StoreApi<SidebarPlacementState> {
  move(
    request: SidebarItemGroupMoveItemRequest,
    membershipOnly?: boolean,
  ): Promise<void>;
  /** Existing group edits share the scope's intent chronology and save lane. */
  changeGroups<T>(
    project: (groups: SidebarItemGroup[]) => SidebarItemGroup[],
    save: () => Promise<T>,
    confirmed?: (groups: SidebarItemGroup[], result: T) => SidebarItemGroup[],
  ): Promise<T>;
  /** Unsolicited inventory cannot confirm pending changes. */
  updateInventory(snapshot: SidebarPlacementSnapshot): void;
  reconcile(): void;
  /** UI consumers may await a projection attempt without holding the write lane. */
  afterReconciliation(): Promise<void>;
  dispose(): void;
}
interface PlacementChange {
  id: number;
  status: SidebarPlacementIntent['status'];
  intent?: SidebarPlacementIntent;
  project(snapshot: SidebarPlacementSnapshot): SidebarPlacementSnapshot;
  save(): Promise<void>;
  complete(): void;
  fail(error: unknown): void;
}

/** One instance per account/owner, connection generation and scope. */
export function createSidebarPlacementStore(
  initial: SidebarPlacementSnapshot,
  host: SidebarPlacementHost,
): SidebarPlacementStore {
  const state = createStore<SidebarPlacementState>(() => ({
    confirmed: initial,
    rendered: initial,
    pending: [],
    pendingCount: 0,
    error: undefined,
  }));
  let disposed = false;
  let sequence = 0;
  let settlement = 0;
  let saving = false;
  let reading = false;
  let readRequested = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changes: PlacementChange[] = [];
  let readGeneration = -1;
  let readers: { generation: number; resolve: () => void }[] = [];
  const settleReaders = (generation: number): void => {
    readGeneration = Math.max(readGeneration, generation);
    const ready = readers.filter((reader) => reader.generation <= generation);
    readers = readers.filter((reader) => reader.generation > generation);
    ready.forEach((reader) => reader.resolve());
  };
  const publish = (
    confirmed = state.getState().confirmed,
    error: unknown = undefined,
  ): void => {
    if (disposed) return;
    let rendered = confirmed;
    for (const change of changes) rendered = change.project(rendered);
    state.setState({
      confirmed,
      rendered,
      pending: changes.flatMap((change) =>
        change.intent ? [{ ...change.intent, status: change.status }] : [],
      ),
      pendingCount: changes.length,
      error,
    });
  };
  const read = async (): Promise<void> => {
    if (disposed || reading || saving || timer !== undefined) return;
    reading = true;
    readRequested = false;
    const generation = settlement;
    const prefix: number[] = [];
    for (const change of changes) {
      if (change.status !== 'acknowledged' && change.status !== 'uncertain')
        break;
      prefix.push(change.id);
    }
    try {
      const confirmed = await host.read();
      if (disposed) return;
      // A write can have committed before its acknowledgement arrives. Never
      // accept that partial inventory and then replay a provisional creation.
      if (generation !== settlement || saving) {
        readRequested = true;
        return;
      }
      const retired = new Set(prefix);
      changes = changes.filter((change) => !retired.has(change.id));
      publish(confirmed);
      settleReaders(generation);
      retry = 0;
      void pump();
    } catch (error) {
      if (disposed) return;
      publish(undefined, error);
      settleReaders(generation);
      const delay = [250, 1000, 2000][retry];
      if (delay !== undefined) {
        retry += 1;
        timer = setTimeout(() => {
          timer = undefined;
          void read();
        }, delay);
      }
    } finally {
      reading = false;
      if (!disposed && readRequested && timer === undefined) void read();
    }
  };
  const reconcile = (): void => {
    if (disposed) return;
    readRequested = true;
    if (!reading && timer === undefined) {
      retry = 0;
      void read();
    }
  };
  const pump = async (): Promise<void> => {
    if (
      disposed ||
      saving ||
      changes.some((change) => change.status === 'uncertain')
    )
      return;
    const next = changes.find((change) => change.status === 'queued');
    if (!next) return;
    saving = true;
    next.status = 'saving';
    publish();
    try {
      await next.save();
      if (disposed) return;
      settlement += 1;
      next.status = 'acknowledged';
      publish();
      next.complete();
    } catch (error) {
      if (disposed) return;
      settlement += 1;
      if (host.classifyFailure(error) === 'rejected')
        changes = changes.filter((change) => change.id !== next.id);
      else next.status = 'uncertain';
      publish(undefined, error);
      next.fail(error);
    } finally {
      saving = false;
      if (!disposed) {
        void pump();
        reconcile();
      }
    }
  };
  const admit = (change: PlacementChange): void => {
    changes = [...changes, change];
    publish();
    void pump();
  };
  return {
    ...state,
    move: (request, membershipOnly = false): Promise<void> => {
      if (disposed)
        return Promise.reject(
          new Error('Sidebar context is no longer available'),
        );
      if (!validSidebarPlacement(state.getState().rendered, request))
        return Promise.reject(new Error('Sidebar placement is unavailable'));
      const id = ++sequence;
      const intent: SidebarPlacementIntent = {
        id,
        generation: settlement,
        request,
        membershipOnly,
        status: 'queued',
      };
      return new Promise<void>((resolve, reject) => {
        admit({
          id,
          status: 'queued',
          intent,
          project: (base) => projectPlacements(base, [intent]),
          save: () => host.save(request),
          complete: resolve,
          fail: reject,
        });
      });
    },
    changeGroups: <T>(
      project: (groups: SidebarItemGroup[]) => SidebarItemGroup[],
      save: () => Promise<T>,
      confirm?: (groups: SidebarItemGroup[], result: T) => SidebarItemGroup[],
    ): Promise<T> => {
      if (disposed)
        return Promise.reject(
          new Error('Sidebar context is no longer available'),
        );
      let receipt: { complete: false } | { complete: true; result: T } = {
        complete: false,
      };
      return new Promise<T>((resolve, reject) => {
        admit({
          id: ++sequence,
          status: 'queued',
          project: (base): SidebarPlacementSnapshot => {
            const copies = base.groups.map((group) => ({
              ...group,
              memberIds: [...group.memberIds],
            }));
            const optimistic = project(copies);
            const groups = (
              receipt.complete && confirm
                ? confirm(optimistic, receipt.result)
                : optimistic
            )
              .map((group) => ({
                ...group,
                collapsed: resolveSidebarItemGroupCollapsed(
                  group,
                  base.groups.find((previous) => previous.id === group.id)
                    ?.memberIds.length ?? group.memberIds.length,
                ),
              }))
              .filter(isSidebarItemGroupRetained);
            return {
              ...base,
              groups: anchorKeptSidebarItemGroups(
                groups,
                normalizeGroupedOrder(base.order, groups),
                {
                  ineligibleItemIds: base.order.filter(
                    (id) => !base.movableItemIds.has(id),
                  ),
                },
              ),
              order: normalizeGroupedOrder(base.order, groups),
            };
          },
          save: async (): Promise<void> => {
            receipt = { complete: true, result: await save() };
          },
          complete: (): void => {
            if (receipt.complete) resolve(receipt.result);
          },
          fail: reject,
        });
      });
    },
    updateInventory: (snapshot): void => {
      if (disposed) return;
      if (changes.length === 0) {
        publish(snapshot);
        return;
      }
      const previous = state.getState().confirmed;
      const live = new Set(snapshot.order);
      const order = previous.order.filter((id) => live.has(id));
      snapshot.order.forEach((id, index) => {
        if (order.includes(id)) return;
        const anchor = snapshot.order
          .slice(index + 1)
          .find((next) => order.includes(next));
        order.splice(
          anchor === undefined ? order.length : order.indexOf(anchor),
          0,
          id,
        );
      });
      // A creation can be broadcast before its acknowledgement. Keep new
      // registry identities out of the base while its provisional edit replays.
      const incoming = new Map(
        snapshot.groups.map((group) => [group.id, group]),
      );
      const groups = changes.some((change) => change.intent === undefined)
        ? previous.groups.flatMap((group) => {
            const current = incoming.get(group.id);
            return current ? [current] : [];
          })
        : snapshot.groups;
      publish({ ...snapshot, order, groups });
    },
    reconcile,
    afterReconciliation: (): Promise<void> => {
      if (disposed || readGeneration >= settlement) return Promise.resolve();
      return new Promise<void>((resolve) => {
        readers.push({ generation: settlement, resolve });
        reconcile();
      });
    },
    dispose: (): void => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const change of changes)
        change.fail(new Error('Sidebar context changed'));
      changes = [];
      readers.forEach((reader) => reader.resolve());
      readers = [];
    },
  };
}

export type SidebarPlacementWriteQueue = <T>(
  scope: string,
  operation: () => Promise<T>,
) => Promise<T>;

/** Existing adapters can share serialization without putting refreshes in this lane. */
export function createSidebarPlacementWriteQueue(): SidebarPlacementWriteQueue {
  const writes = new Map<string, Promise<unknown>>();
  return async <T>(scope: string, operation: () => Promise<T>): Promise<T> => {
    const previous = writes.get(scope);
    const next = previous
      ? previous.catch(() => undefined).then(operation)
      : operation();
    writes.set(scope, next);
    try {
      return await next;
    } finally {
      if (writes.get(scope) === next) writes.delete(scope);
    }
  };
}
