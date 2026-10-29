/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
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
