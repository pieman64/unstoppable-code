// Late-bound handle to the assembled chat store. Helper modules use this
// instead of importing the store hook so the module graph stays acyclic:
// chatStore.ts registers the store API right after create().
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatState } from './state';

type ChatStoreApi = UseBoundStore<StoreApi<ChatState>>;

let api: ChatStoreApi | undefined;

export function registerChatStoreApi(instance: ChatStoreApi): void {
  api = instance;
}

export function chatStoreApi(): ChatStoreApi {
  if (!api) {
    throw new Error('chat store API accessed before registration');
  }
  return api;
}

/** The registered store, or `undefined` before `chatStore.ts` registers it. */
export function tryChatStoreApi(): ChatStoreApi | undefined {
  return api;
}
