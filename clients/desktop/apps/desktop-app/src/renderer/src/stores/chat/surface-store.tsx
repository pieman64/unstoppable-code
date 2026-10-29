import { createContext, useContext, type ReactNode, type JSX } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { ChatState } from './state';

export type ChatSurfaceStore = UseBoundStore<StoreApi<ChatState>>;
export interface ChatSurfaceScope {
  store: ChatSurfaceStore;
  mode: 'sandbox';
  disconnected: boolean;
}
const ChatSurfaceContext = createContext<ChatSurfaceScope | null>(null);

/** Explicit host boundary; never changes or replaces the application's store. */
export function ChatSurfaceProvider({
  scope,
  children,
}: {
  scope: ChatSurfaceScope;
  children: ReactNode;
}): JSX.Element {
  return (
    <ChatSurfaceContext.Provider value={scope}>
      {children}
    </ChatSurfaceContext.Provider>
  );
}
export function useChatSurfaceScope(): ChatSurfaceScope | null {
  return useContext(ChatSurfaceContext);
}
/** Also binds imperative getState/setState/subscribe calls inside a surface. */
export function useChatSurfaceStore(
  fallback: ChatSurfaceStore,
): ChatSurfaceStore {
  return useChatSurfaceScope()?.store ?? fallback;
}
