import { createContext } from 'react';

export interface ChatMarkdownFileTarget {
  projectId: string;
  worktreeId: string;
  /** `false` blocks remote image loads; it does not affect file links. */
  allowRemoteImages?: boolean;
}

export const ChatMarkdownFileTargetContext =
  createContext<ChatMarkdownFileTarget | null>(null);
