import type { CodexLoginState } from '@canopy/desktop-shared/types';
import { create } from 'zustand';
type AccountProvider = 'claude' | 'codex';

/**
 * What surfaced the resume modal: a verified different-account login
 * (`account-change`, the original trigger), the Usage page/panel per-provider
 * Resume button (`usage-review`), the Usage page application-stop button
 * (`app-restart`), or the Home page banner (`home`, every provider and every
 * interruption reason). The modal keys its request and explanatory copy off
 * this.
 */
export type UsageLimitResumePromptOrigin =
  | 'authentication'
  | 'account-change'
  | 'usage-review'
  | 'app-restart'
  | 'home';

/** Origins that review sessions across providers and need no `provider`. */
export function isProviderlessResumePromptOrigin(
  origin: UsageLimitResumePromptOrigin,
): boolean {
  return origin === 'app-restart' || origin === 'home';
}

interface UsageLimitResumePromptState {
  authentication: CodexLoginState | null;
  openAuthentication: (state: CodexLoginState) => void;
  updateAuthentication: (state: CodexLoginState) => void;
  isOpen: boolean;
  provider: AccountProvider | null;
  origin: UsageLimitResumePromptOrigin;
  open: (
    provider: AccountProvider | null,
    origin?: UsageLimitResumePromptOrigin,
  ) => void;
  close: () => void;
}

export const useUsageLimitResumePromptStore =
  create<UsageLimitResumePromptState>((set) => ({
    authentication: null,
    openAuthentication: (authentication): void =>
      set({
        isOpen: true,
        provider: 'codex',
        origin: 'authentication',
        authentication,
      }),
    updateAuthentication: (authentication): void => set({ authentication }),
    isOpen: false,
    provider: null,
    origin: 'account-change',
    open: (provider, origin = 'account-change'): void =>
      set({ isOpen: true, provider, origin, authentication: null }),
    close: (): void =>
      set({
        isOpen: false,
        provider: null,
        origin: 'account-change',
        authentication: null,
      }),
  }));
