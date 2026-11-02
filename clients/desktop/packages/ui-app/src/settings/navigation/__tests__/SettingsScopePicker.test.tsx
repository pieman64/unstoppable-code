/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SettingsNavModel } from '@canopy/protocol/settings';
import { SettingsScopePicker } from '../SettingsScopePicker';

function model(overrides: Partial<SettingsNavModel> = {}): SettingsNavModel {
  return {
    account: {
      billingEnabled: true,
      digestsEnabled: false,
      integrationsEnabled: false,
      externalAgentsEnabled: false,
    },
    adminVisible: false,
    organization: null,
    organizations: [
      {
        id: 'org-1',
        name: 'Northwind Labs',
        logoUrl: null,
        role: 'OWNER',
        isPersonal: false,
      },
    ],
    viewer: { name: 'Maya Chen', email: 'maya@example.com', image: null },
    ...overrides,
  };
}

describe('SettingsScopePicker', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function q(testId: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    expect(element).toBeInstanceOf(HTMLElement);
    return element as HTMLElement;
  }

  it('fits a person to one initial in the small trigger and menu avatars', () => {
    act(() =>
      root.render(
        <SettingsScopePicker
          model={model()}
          currentPath="/account"
          onNavigate={jest.fn()}
          testIdPrefix="nav-"
        />,
      ),
    );
    const trigger = q('nav-scope-picker');
    const triggerAvatar = trigger.querySelector('[role="img"]');
    expect(triggerAvatar).toBeInstanceOf(HTMLElement);
    // Two letters do not fit a 16–24px circle; the lab shows one.
    expect(triggerAvatar?.textContent).toBe('M');

    act(() => trigger.click());
    const menuAvatar = q('nav-scope-option-account').querySelector(
      '[role="img"]',
    );
    expect(menuAvatar).toBeInstanceOf(HTMLElement);
    expect(menuAvatar?.textContent).toBe('M');
  });

  it('fits an organization to one initial in the trigger logo', () => {
    act(() =>
      root.render(
        <SettingsScopePicker
          model={model({
            organization: {
              id: 'org-1',
              name: 'Northwind Labs',
              visibleTabs: ['members', 'settings'],
              disabledTabs: [],
              billingNeedsAttention: false,
              viewerRole: 'OWNER',
              settingsSubtabs: ['general'],
            },
          })}
          currentPath="/organization/org-1/members"
          onNavigate={jest.fn()}
          testIdPrefix="nav-"
        />,
      ),
    );
    const logo = q('nav-scope-picker').querySelector(
      '[data-testid="org-logo"]',
    );
    expect(logo).toBeInstanceOf(HTMLElement);
    expect(logo?.textContent).toBe('N');
  });
});
