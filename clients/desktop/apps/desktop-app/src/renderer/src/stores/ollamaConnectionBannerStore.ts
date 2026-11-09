import { create } from 'zustand';
import { chatBannerKey, type ChatBannerTarget } from './aiCreditsBannerStore';

interface UnavailableTarget {
  readonly port: number | null;
}

type UnavailableTargets = Readonly<
  Record<string, UnavailableTarget | undefined>
>;

interface OllamaConnectionBannerStore {
  unavailableByChat: Record<string, true | undefined>;
  unavailableTargetsByChat: UnavailableTargets;
  sendTargetsByChat: UnavailableTargets;
  connectionPort: number | null;
  recordSendTarget: (target: ChatBannerTarget) => void;
  showUnavailable: (target: ChatBannerTarget, port?: number) => void;
  clearUnavailable: (target: ChatBannerTarget) => void;
  clearChat: (target: ChatBannerTarget) => void;
  clearWorktree: (projectId: string, worktreeId: string) => void;
  clearProject: (projectId: string) => void;
  setConnectionPort: (port: number | null) => void;
  resetContext: () => void;
  clearRecoveredPort: (port: number, baseline: UnavailableTargets) => void;
}

function clearKeys(
  state: OllamaConnectionBannerStore,
  matches: (key: string) => boolean,
): OllamaConnectionBannerStore {
  const keys = Object.keys({
    ...state.unavailableByChat,
    ...state.sendTargetsByChat,
  }).filter(matches);
  if (keys.length === 0) return state;
  const unavailableByChat = { ...state.unavailableByChat };
  const unavailableTargetsByChat = { ...state.unavailableTargetsByChat };
  const sendTargetsByChat = { ...state.sendTargetsByChat };
  for (const key of keys) {
    delete unavailableByChat[key];
    delete unavailableTargetsByChat[key];
    delete sendTargetsByChat[key];
  }
  return {
    ...state,
    unavailableByChat,
    unavailableTargetsByChat,
    sendTargetsByChat,
  };
}

export const useOllamaConnectionBannerStore =
  create<OllamaConnectionBannerStore>((set) => ({
    unavailableByChat: {},
    unavailableTargetsByChat: {},
    sendTargetsByChat: {},
    connectionPort: null,
    recordSendTarget: (target): void => {
      set((state) => ({
        sendTargetsByChat: {
          ...state.sendTargetsByChat,
          [chatBannerKey(target)]: { port: state.connectionPort },
        },
      }));
    },
    showUnavailable: (target, port): void => {
      const key = chatBannerKey(target);
      set((state) => ({
        unavailableByChat: { ...state.unavailableByChat, [key]: true },
        // Each failure gets a fresh identity, even on the same chat/port.
        unavailableTargetsByChat: {
          ...state.unavailableTargetsByChat,
          // Late turn failures refer to the send's target, never whatever
          // port happens to be configured when its error is delivered.
          [key]: { port: port ?? state.sendTargetsByChat[key]?.port ?? null },
        },
      }));
    },
    clearUnavailable: (target): void => {
      const key = chatBannerKey(target);
      set((state) => {
        if (state.unavailableByChat[key] !== true) return state;
        const unavailableByChat = { ...state.unavailableByChat };
        const unavailableTargetsByChat = { ...state.unavailableTargetsByChat };
        delete unavailableByChat[key];
        delete unavailableTargetsByChat[key];
        return { unavailableByChat, unavailableTargetsByChat };
      });
    },
    clearChat: (target): void => {
      const chatKey = chatBannerKey(target);
      set((state) => clearKeys(state, (key) => key === chatKey));
    },
    clearWorktree: (projectId, worktreeId): void => {
      const prefix = `${projectId}/${worktreeId}/`;
      set((state) => clearKeys(state, (key) => key.startsWith(prefix)));
    },
    clearProject: (projectId): void => {
      const prefix = `${projectId}/`;
      set((state) => clearKeys(state, (key) => key.startsWith(prefix)));
    },
    setConnectionPort: (connectionPort): void => {
      set({ connectionPort });
    },
    resetContext: (): void => {
      set({
        connectionPort: null,
        sendTargetsByChat: {},
        unavailableByChat: {},
        unavailableTargetsByChat: {},
      });
    },
    clearRecoveredPort: (port, baseline): void => {
      set((state) => {
        const unavailableByChat = { ...state.unavailableByChat };
        const unavailableTargetsByChat = { ...state.unavailableTargetsByChat };
        let changed = false;
        for (const [key, target] of Object.entries(baseline)) {
          if (
            target?.port !== port ||
            state.unavailableTargetsByChat[key] !== target
          )
            continue;
          delete unavailableByChat[key];
          delete unavailableTargetsByChat[key];
          changed = true;
        }
        return changed
          ? { unavailableByChat, unavailableTargetsByChat }
          : state;
      });
    },
  }));

/** Existing per-chat API, also used by qualification consumers. */
export function useOllamaConnectionUnavailable(
  target: ChatBannerTarget | null,
): boolean {
  return useOllamaConnectionBannerStore((state) =>
    target ? state.unavailableByChat[chatBannerKey(target)] === true : false,
  );
}

/** Whether any chat's last send found the Ollama server unreachable. */
export function useAnyOllamaConnectionUnavailable(): boolean {
  return useOllamaConnectionBannerStore((state) =>
    Object.values(state.unavailableByChat).some((value) => value === true),
  );
}
