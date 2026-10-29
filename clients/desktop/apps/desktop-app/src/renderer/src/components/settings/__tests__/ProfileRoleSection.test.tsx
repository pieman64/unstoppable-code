/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { setNativeInputValue } from '@/test-utils/dom';
import { makeTestPreferences } from '@/test-utils/preferences';
import { ProfileRoleSection } from '../ProfileRoleSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let loadPreferences: jest.Mock;
let savePreferences: jest.Mock;
let onPreferencesSynced: jest.Mock;
let syncSubscribers: ((preferences: PreferencesData) => void)[];

function setPreferences(overrides: Partial<PreferencesData>): void {
  loadPreferences.mockResolvedValue(makeTestPreferences(overrides));
}

function broadcastSynced(overrides: Partial<PreferencesData>): void {
  act(() => {
    for (const subscriber of syncSubscribers) {
      subscriber(makeTestPreferences(overrides));
    }
  });
}

beforeEach(() => {
  syncSubscribers = [];
  loadPreferences = jest.fn().mockResolvedValue(makeTestPreferences());
  savePreferences = jest.fn().mockResolvedValue(makeTestPreferences());
  onPreferencesSynced = jest.fn((cb: (p: PreferencesData) => void) => {
    syncSubscribers.push(cb);
    return (): void => {
      syncSubscribers = syncSubscribers.filter((entry) => entry !== cb);
    };
  });

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadPreferences, savePreferences, onPreferencesSynced },
  });
});

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<ProfileRoleSection />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function button(selector: string): HTMLButtonElement {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Expected button: ${selector}`);
  }
  return found;
}

function tile(role: string): Element | null {
  return document.querySelector(
    `[data-testid="settings-profile-role-tile-${role}"]`,
  );
}

function option(role: string): HTMLButtonElement {
  return button(`[data-testid="settings-profile-role-option-${role}"]`);
}

function click(target: HTMLButtonElement): void {
  act(() => target.click());
}

function openEditor(): void {
  click(button('[data-testid="settings-profile-role-edit"]'));
}

async function saveRoles(): Promise<void> {
  await act(async () => {
    button('[data-testid="settings-profile-role-save"]').click();
    await Promise.resolve();
  });
}

describe('ProfileRoleSection', () => {
  it('holds the role line with a skeleton bar, not loading copy, until preferences load', async () => {
    loadPreferences.mockReturnValue(new Promise<PreferencesData>(() => {}));
    const { container, cleanup } = await mount();
    try {
      const loading = container.querySelector(
        '[data-testid="settings-profile-role-loading"]',
      );
      expect(loading?.getAttribute('role')).toBe('status');
      expect(loading?.querySelector('.canopy-inline-skeleton')).not.toBeNull();
      expect(container.textContent).not.toContain('Loading roles');
      expect(
        container.querySelector('[data-testid="settings-profile-role-edit"]'),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('saves an empty answer and reopens only the tools step that asks for roles', async () => {
    setPreferences({
      profileRole: 'other',
      profileRoles: ['other'],
      profileRoleDetail: 'Writer',
      homeOnboardingSuggestions: {
        startedAt: '2026-09-01T00:00:00.000Z',
        entries: {
          'add-repo': { completedAt: 'done' },
          github: { completedAt: 'done', dismissedAt: 'skipped' },
          notifications: { completedAt: 'done' },
        },
      },
    });
    const { container, cleanup } = await mount();
    try {
      openEditor();
      click(option('other'));
      expect(
        button('[data-testid="settings-profile-role-save"]').disabled,
      ).toBe(false);
      await saveRoles();
      expect(savePreferences).toHaveBeenCalledWith({
        profileRole: undefined,
        profileRoles: [],
        profileRoleDetail: '',
        homeOnboardingSuggestions: {
          startedAt: '2026-09-01T00:00:00.000Z',
          entries: {
            'add-repo': { completedAt: 'done' },
            notifications: { completedAt: 'done' },
          },
        },
      });
      expect(container.textContent).not.toContain('Not set');
      expect(tile('other')).toBeNull();
      expect(
        button('[data-testid="settings-profile-role-edit"]'),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-testid="settings-profile-role-modal"]'),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('retains the saved roles and allows retry when clearing them fails', async () => {
    setPreferences({ profileRole: 'designer', profileRoles: ['designer'] });
    savePreferences.mockRejectedValueOnce(new Error('disk full'));
    const { cleanup } = await mount();
    try {
      openEditor();
      click(option('designer'));
      await saveRoles();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not save your roles',
      );
      expect(tile('designer')).not.toBeNull();
      expect(
        button('[data-testid="settings-profile-role-save"]').disabled,
      ).toBe(false);
      await saveRoles();
      expect(tile('designer')).toBeNull();
      expect(
        document.querySelector('[data-testid="settings-profile-role-modal"]'),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('expands a saved combined role into independently editable Marketing and Sales tiles', async () => {
    setPreferences({
      profileRole: 'marketing-sales',
      profileRoles: ['marketing-sales'],
    });
    const { cleanup } = await mount();
    try {
      expect(tile('marketing')?.textContent).toBe('Marketing');
      expect(tile('sales')?.textContent).toBe('Sales');
      expect(tile('marketing-sales')).toBeNull();
      openEditor();
      expect(option('marketing').getAttribute('aria-pressed')).toBe('true');
      expect(option('sales').getAttribute('aria-pressed')).toBe('true');
      expect(
        document.querySelector(
          '[data-testid="settings-profile-role-option-marketing-sales"]',
        ),
      ).toBeNull();
      click(option('marketing'));
      await saveRoles();
      expect(savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({
          profileRole: 'sales',
          profileRoles: ['sales'],
        }),
      );
      expect(tile('marketing')).toBeNull();
      expect(tile('sales')?.textContent).toBe('Sales');
    } finally {
      cleanup();
    }
  });

  it('expands a saved combined role into independently editable Operations and Support tiles', async () => {
    setPreferences({
      profileRole: 'operations-support',
      profileRoles: ['operations-support'],
    });
    const { cleanup } = await mount();
    try {
      expect(tile('operations')?.textContent).toBe('Operations');
      expect(tile('support')?.textContent).toBe('Support');
      expect(tile('operations-support')).toBeNull();
      openEditor();
      expect(option('operations').getAttribute('aria-pressed')).toBe('true');
      expect(option('support').getAttribute('aria-pressed')).toBe('true');
      expect(
        document.querySelector(
          '[data-testid="settings-profile-role-option-operations-support"]',
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('shows every saved role as a tile and preselects each one in the modal', async () => {
    setPreferences({
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'designer'],
    });
    const { container, cleanup } = await mount();

    try {
      expect(
        container.querySelector('[data-testid="settings-profile-role-select"]'),
      ).toBeNull();
      expect(tile('software-engineer')?.textContent).toContain(
        'Software engineer',
      );
      expect(tile('designer')?.textContent).toContain('Designer');
      // Edit belongs to the section header, beside the question it answers,
      // not inside the list of saved roles.
      const heading = container.querySelector('#settings-profile-role-heading');
      const edit = container.querySelector(
        '[data-testid="settings-profile-role-edit"]',
      );
      expect(edit).not.toBeNull();
      expect(
        container
          .querySelector('[data-testid="settings-profile-role-tiles"]')
          ?.contains(edit),
      ).toBe(false);
      expect(
        heading &&
          edit &&
          heading.compareDocumentPosition(edit) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      openEditor();
      expect(option('software-engineer').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(option('designer').getAttribute('aria-pressed')).toBe('true');
      expect(option('founder').getAttribute('aria-pressed')).toBe('false');
      expect(
        document.querySelectorAll(
          '[data-testid^="settings-profile-role-option-"]',
        ),
      ).toHaveLength(12);
    } finally {
      cleanup();
    }
  });

  it('falls back to the legacy single role and shows only Edit when empty', async () => {
    setPreferences({ profileRole: 'product-manager' });
    const first = await mount();
    try {
      expect(tile('product-manager')?.textContent).toContain('Product manager');
    } finally {
      first.cleanup();
    }

    setPreferences({});
    const second = await mount();
    try {
      expect(second.container.textContent).not.toContain('Not set');
      expect(
        second.container.querySelector(
          '[data-testid^="settings-profile-role-tile-"]',
        ),
      ).toBeNull();
      expect(
        button('[data-testid="settings-profile-role-edit"]'),
      ).not.toBeNull();
      openEditor();
      expect(option('designer').getAttribute('aria-pressed')).toBe('false');
      expect(
        button('[data-testid="settings-profile-role-save"]').disabled,
      ).toBe(false);
      expect(savePreferences).not.toHaveBeenCalled();
    } finally {
      second.cleanup();
    }
  });

  it('cancels without saving, then saves the full edited selection', async () => {
    setPreferences({
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'designer'],
    });
    const { cleanup } = await mount();

    try {
      openEditor();
      click(option('designer'));
      click(option('founder'));
      click(button('[data-testid="settings-profile-role-cancel"]'));
      expect(savePreferences).not.toHaveBeenCalled();
      expect(tile('designer')).not.toBeNull();
      expect(tile('founder')).toBeNull();

      openEditor();
      click(option('designer'));
      click(option('founder'));
      await saveRoles();
      expect(savePreferences).toHaveBeenCalledWith({
        profileRole: 'software-engineer',
        profileRoles: ['software-engineer', 'founder'],
        profileRoleDetail: '',
      });
      expect(tile('designer')).toBeNull();
      expect(tile('founder')).not.toBeNull();
      expect(
        document.querySelector('[data-testid="settings-profile-role-modal"]'),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('uses checklist order for the primary role even when selected second', async () => {
    setPreferences({ profileRole: 'designer', profileRoles: ['designer'] });
    const { cleanup } = await mount();
    try {
      openEditor();
      click(option('software-engineer'));
      await saveRoles();
      expect(savePreferences).toHaveBeenCalledWith({
        profileRole: 'software-engineer',
        profileRoles: ['designer', 'software-engineer'],
        profileRoleDetail: '',
      });
    } finally {
      cleanup();
    }
  });

  it('edits role details with multiple roles selected and keeps them when one role is removed', async () => {
    setPreferences({
      profileRole: 'software-engineer',
      profileRoles: ['software-engineer', 'other'],
      profileRoleDetail: 'Archivist',
    });
    const { cleanup } = await mount();
    try {
      expect(
        document.querySelector('[data-testid="settings-profile-role-detail"]')
          ?.textContent,
      ).toBe('Archivist');
      openEditor();
      const input = document.querySelector(
        '[data-testid="settings-profile-role-detail-input"]',
      );
      if (!(input instanceof HTMLInputElement))
        throw new Error('Expected Other input');
      expect(input.value).toBe('Archivist');
      expect(input.maxLength).toBe(256);
      act(() => setNativeInputValue(input, 'Technical writer'));
      expect(savePreferences).not.toHaveBeenCalled();
      await saveRoles();
      expect(savePreferences).toHaveBeenCalledWith({
        profileRole: 'software-engineer',
        profileRoles: ['software-engineer', 'other'],
        profileRoleDetail: 'Technical writer',
      });
      expect(
        document.querySelector('[data-testid="settings-profile-role-detail"]')
          ?.textContent,
      ).toBe('Technical writer');

      openEditor();
      click(option('other'));
      expect(
        document.querySelector(
          '[data-testid="settings-profile-role-detail-input"]',
        ),
      ).not.toBeNull();
      await saveRoles();
      expect(savePreferences).toHaveBeenLastCalledWith({
        profileRole: 'software-engineer',
        profileRoles: ['software-engineer'],
        profileRoleDetail: 'Technical writer',
      });
    } finally {
      cleanup();
    }
  });

  it('reflects external changes without overwriting an open draft', async () => {
    setPreferences({ profileRole: 'designer', profileRoles: ['designer'] });
    const { cleanup } = await mount();
    try {
      openEditor();
      click(option('founder'));
      broadcastSynced({ profileRole: 'student', profileRoles: ['student'] });
      expect(tile('student')).not.toBeNull();
      expect(option('founder').getAttribute('aria-pressed')).toBe('true');
      click(button('[data-testid="settings-profile-role-cancel"]'));
      expect(tile('designer')).toBeNull();
      expect(tile('student')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('keeps a local selection when an older save broadcasts mid-flight', async () => {
    setPreferences({ profileRole: 'student', profileRoles: ['student'] });
    let resolveSave: (value: PreferencesData) => void = () => {};
    savePreferences.mockReturnValueOnce(
      new Promise<PreferencesData>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { cleanup } = await mount();
    try {
      openEditor();
      click(option('student'));
      click(option('designer'));
      act(() => button('[data-testid="settings-profile-role-save"]').click());
      broadcastSynced({ profileRole: 'student', profileRoles: ['student'] });
      await act(async () => {
        resolveSave(
          makeTestPreferences({
            profileRole: 'designer',
            profileRoles: ['designer'],
          }),
        );
        await Promise.resolve();
      });
      expect(tile('designer')).not.toBeNull();
      expect(tile('student')).toBeNull();
      broadcastSynced({ profileRole: 'founder', profileRoles: ['founder'] });
      expect(tile('founder')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('keeps the modal open and reports a failed save', async () => {
    savePreferences.mockRejectedValueOnce(new Error('disk write failed'));
    const { cleanup } = await mount();
    try {
      openEditor();
      click(option('designer'));
      await saveRoles();
      expect(
        document.querySelector('[data-testid="settings-profile-role-modal"]'),
      ).not.toBeNull();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not save',
      );
      expect(tile('designer')).toBeNull();
    } finally {
      cleanup();
    }
  });
});
