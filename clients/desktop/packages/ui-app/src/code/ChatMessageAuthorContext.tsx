'use client';

import type { PortalChatMessage } from '@canopy/protocol/portal';
import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
} from 'react';

export type ChatMessageAuthor = NonNullable<PortalChatMessage['author']>;

export interface ChatMessageAuthorResolver {
  readonly resolve: (
    message: PortalChatMessage,
  ) => ChatMessageAuthor | undefined;
  readonly request: (message: PortalChatMessage) => void;
}

const ChatMessageAuthorContext =
  createContext<ChatMessageAuthorResolver | null>(null);

export interface ChatMessageAuthorProviderProps {
  readonly resolver: ChatMessageAuthorResolver;
  readonly children: ReactNode;
}

export function ChatMessageAuthorProvider({
  resolver,
  children,
}: ChatMessageAuthorProviderProps): JSX.Element {
  return (
    <ChatMessageAuthorContext.Provider value={resolver}>
      {children}
    </ChatMessageAuthorContext.Provider>
  );
}

export function useChatMessageAuthor(
  message: PortalChatMessage,
): ChatMessageAuthor | undefined {
  const resolver = useContext(ChatMessageAuthorContext);
  const author = resolver ? resolver.resolve(message) : message.author;

  useEffect(() => {
    if (
      resolver &&
      message.role === 'user' &&
      message.clientRequestId &&
      !message.author
    ) {
      resolver.request(message);
    }
  }, [message, resolver]);

  return author;
}
