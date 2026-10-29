import { create } from 'zustand';
import { chatBannerKey, type ChatBannerTarget } from './aiCreditsBannerStore';

interface OllamaConnectionBannerStore {
  unavailableByChat: Record<string, true | undefined>;
  showUnavailable: (target: ChatBannerTarget) => void;
  clearUnavailable: (target: ChatBannerTarget) => void;
}

export const useOllamaConnectionBannerStore =
  create<OllamaConnectionBannerStore>((set) => ({
    unavailableByChat: {},
    showUnavailable: (target): void => {
      const key = chatBannerKey(target);
      set((state) =>
        state.unavailableByChat[key] === true
          ? state
          : {
              unavailableByChat: {
                ...state.unavailableByChat,
                [key]: true,
              },
            },
      );
    },
    clearUnavailable: (target): void => {
      const key = chatBannerKey(target);
      set((state) => {
        if (state.unavailableByChat[key] !== true) return state;
        const unavailableByChat = { ...state.unavailableByChat };
        delete unavailableByChat[key];
        return { unavailableByChat };
      });
    },
  }));

export function useOllamaConnectionUnavailable(
  target: ChatBannerTarget | null,
): boolean {
  return useOllamaConnectionBannerStore((state) =>
    target ? state.unavailableByChat[chatBannerKey(target)] === true : false,
  );
}
