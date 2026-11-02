import type * as ChatMessageListModule from './ChatMessageList';

let loaded: typeof ChatMessageListModule | null = null;
let loading: Promise<typeof ChatMessageListModule> | null = null;

/**
 * Loads the transcript list's code-split chunk once. A Home first send waits
 * for it before opening the chat, so the chat's first frame paints the
 * question instead of the chunk's loading spinner (CAN-4742). A failed load
 * can be retried.
 */
export function loadChatMessageListModule(): Promise<
  typeof ChatMessageListModule
> {
  loading ??= import('./ChatMessageList').then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The transcript list module, once loaded; `null` before that. */
export function loadedChatMessageListModule():
  | typeof ChatMessageListModule
  | null {
  return loaded;
}
