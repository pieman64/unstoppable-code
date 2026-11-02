/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import { resetModelLibraryAccessForTests } from '@/lib/modelLibraryAccess';
import {
  resetModelUnlockIntentForTests,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import { CanopyProxyErrorNotice } from '../CanopyProxyErrorNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mockOpenAccountOrganizationPage = jest.fn<
  'settings' | 'web',
  [unknown]
>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openCloudAccountSettings: jest.fn(),
  openAccountOrganizationPage: (route: unknown): 'settings' | 'web' =>
    mockOpenAccountOrganizationPage(route),
}));

describe('CanopyProxyErrorNotice for work owned by a left organization', () => {
  it('opens the Organizations list from View organizations', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <CanopyProxyErrorNotice
          error={{
            code: 'work_owner_not_member',
            message: null,
            correlationId: 'corr-1',
          }}
        />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-canopy-proxy-error-view-organizations"]',
        )
        ?.click();
    });
    expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
      scope: 'organizations',
    });
    act(() => root.unmount());
    container.remove();
  });
});

describe('CanopyProxyErrorNotice strict model unlock (CAN-4693)', () => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  afterEach(() => {
    resetModelUnlockIntentForTests();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });
  it.each([true, false])(
    'uses payment handoff and only waits after successful opening (ok=%s)',
    async (ok) => {
      invalidateSharedAiCreditsRead();
      resetModelLibraryAccessForTests();
      resetModelUnlockIntentForTests();
      const requestId = '11111111-1111-4111-8111-111111111111';
      const paymentHandoff = jest
        .fn()
        .mockResolvedValue(
          ok ? { ok: true, requestId } : { ok: false, reason: 'failed' },
        );
      const openAuthenticatedPortalPage = jest.fn();
      const openExternal = jest.fn();
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          loadCanopyCloudAccount: jest
            .fn()
            .mockResolvedValue({ hasApiKey: true, account: { id: 'acct_1' } }),
          loadNativeAiCreditsAvailability: jest.fn().mockResolvedValue({
            personalEligible: true,
            inOrg: false,
            orgSpendable: false,
            orgCreditPoolCovered: false,
          }),
          loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
            resolved: true,
            modelLibraryAccountKey: 'account:acct_1',
            modelLibraryOwnerKey: 'personal',
            workModelLibrary: {
              status: 'reported',
              access: 'needs_purchase',
            },
          }),
          accountOrganizationSettings: { paymentHandoff },
          openAuthenticatedPortalPage,
          browser: { openExternal },
        },
      });
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        act(() => {
          root.render(
            <CanopyProxyErrorNotice
              error={{
                code: 'model_locked',
                message: null,
                correlationId: 'corr-1',
              }}
            />,
          );
        });
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="chat-canopy-proxy-error-unlock"]',
            )
            ?.click();
          for (let i = 0; i < 40; i++) await Promise.resolve();
        });
        expect(paymentHandoff).toHaveBeenCalledWith({
          accountId: 'acct_1',
          owner: { kind: 'personal' },
          intent: {
            kind: 'top-up',
            reason: 'unlock_models',
            source: 'desktop',
          },
        });
        expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
        expect(
          container.querySelector(
            '[data-testid="chat-canopy-proxy-error-unlock-waiting"]',
          ) !== null,
        ).toBe(ok);
        expect(
          container.querySelector(
            '[data-testid="chat-canopy-proxy-error-unlock-failed"]',
          ) !== null,
        ).toBe(!ok);
        if (ok)
          expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
            requestId,
          );
        else expect(useModelUnlockIntentStore.getState().intent).toBeNull();
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
});
