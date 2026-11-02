/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { useModelUnlockReturn } from '../useModelUnlockReturn';
import {
  beginModelUnlockIntent,
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import { resetModelLibraryAccessForTests } from '@/lib/modelLibraryAccess';

jest.mock('@/lib/aiCreditsScope', () => ({
  useNavigationScopeKey: (): string => 'personal',
}));
const mockToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockToast } => ({ addToast: mockToast }),
  },
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true });

function Probe(): null {
  useModelUnlockReturn();
  return null;
}

it.each(['account:acct_1', 'account:another'])(
  'focus confirms once and real account-event reconciliation respects %s',
  async (accountKey) => {
    resetModelUnlockIntentForTests();
    resetModelLibraryAccessForTests();
    const priorApi = Object.getOwnPropertyDescriptor(window, 'api');
    const loadAccount = jest.fn().mockResolvedValue({
      connected: true,
      account: { id: accountKey.slice('account:'.length) },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAccount: loadAccount },
    });
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    const announcements: Event[] = [];
    const record = (event: Event): void => {
      announcements.push(event);
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    try {
      act(() => root.render(<Probe />));
      const apply = jest.fn().mockResolvedValue(true);
      await act(async () => {
        beginModelUnlockIntent(
          {
            requestId: 'focus-unlock',
            accountId: 'account:acct_1',
            owner: 'personal',
            chatId: 'chat-1',
            modelId: 'sonnet',
            startedAt: Date.now(),
          },
          {
            apply,
            resolveOwner: () => Promise.resolve('personal'),
            refreshAccess: () =>
              Promise.resolve({
                accountKey: 'account:acct_1',
                ownerKey: 'personal',
                access: 'unlocked',
                authoritative: true,
              }),
          },
        );
        window.dispatchEvent(new Event('focus'));
        for (let index = 0; index < 30; index++) await Promise.resolve();
      });
      expect(announcements).toHaveLength(1);
      expect(loadAccount).toHaveBeenCalled();
      const accountReads = loadAccount.mock.calls.length;
      if (accountKey === 'account:acct_1') {
        expect(apply).toHaveBeenCalledTimes(1);
        expect(useModelUnlockIntentStore.getState().phase).toBe('unlocked');
      } else {
        expect(useModelUnlockIntentStore.getState().intent).toBeNull();
      }
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await Promise.resolve();
      });
      expect(announcements).toHaveLength(1);
      expect(loadAccount).toHaveBeenCalledTimes(accountReads);
    } finally {
      act(() => root.unmount());
      element.remove();
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
      if (priorApi) Object.defineProperty(window, 'api', priorApi);
      else Reflect.deleteProperty(window, 'api');
      resetModelUnlockIntentForTests();
      resetModelLibraryAccessForTests();
    }
  },
);
