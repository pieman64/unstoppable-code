'use client';

import { createContext, useContext, type ReactNode, type JSX } from 'react';
import type { GitHubStarPromptStore } from '@canopy/app-state';

const Context = createContext<GitHubStarPromptStore | null>(null);

/**
 * Hosts own persistence; shared composers consume the same scope's store.
 * A null store (a brand without a source repository, or a guest) means
 * nothing counts and the prompt never shows.
 */
export function GitHubStarPromptProvider({
  store,
  children,
}: {
  store: GitHubStarPromptStore | null;
  children: ReactNode;
}): JSX.Element {
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useGitHubStarPromptStore(): GitHubStarPromptStore | null {
  return useContext(Context);
}
