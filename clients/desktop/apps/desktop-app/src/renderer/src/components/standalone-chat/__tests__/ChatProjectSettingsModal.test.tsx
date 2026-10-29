/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  type ChatProjectData,
} from '@canopy/desktop-shared/types';
import { ChatProjectSettingsModal } from '@/components/standalone-chat/ChatProjectSettingsModal';
import { setNativeInputValue } from '@/test-utils/dom';
import { useNavigationStore } from '@/stores/navigationStore';
import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';

// The dialog's one Private memory write path (CAN-3562); the helper's own
// IPC and row reload are covered in privateMemory.test.ts.
jest.mock('@/lib/privateMemory', () => ({
  saveWorkspacePrivateMemory: jest.fn(),
}));
const savePrivateMemory = jest.mocked(saveWorkspacePrivateMemory);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/shared', () => ({
  DialogModal: ({
    children,
    title,
    maxWidth,
  }: {
    children: ReactNode;
    title: ReactNode;
    maxWidth?: string;
  }): JSX.Element => (
    <section data-max-width={maxWidth}>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));

jest.mock('@/components/shared/PluginSelector', () => ({
  PluginSelector: (): JSX.Element => <div />,
}));

jest.mock('@/components/worktree/WorkspaceEnvironmentTab', () => ({
  WorkspaceEnvironmentTab: ({
    workspaceKind,
    onManageEnvironments,
  }: {
    workspaceKind?: string;
    onManageEnvironments?: () => void;
  }): JSX.Element => (
    <div
      data-testid="mock-workspace-environment-tab"
      data-workspace-kind={workspaceKind}
    >
      {workspaceKind}
      <button type="button" onClick={onManageEnvironments}>
        Manage environments
      </button>
      <button type="button">Save environment assignments</button>
    </div>
  ),
}));

jest.mock('@/components/standalone-chat/WorkspaceTemplateShareTab', () => ({
  WorkspaceTemplateShareTab: ({
    projectId,
    draft,
  }: {
    projectId: string;
    draft?: unknown;
  }): JSX.Element => (
    <div
      data-testid="mock-workspace-template-share-tab"
      data-draft={JSON.stringify(draft)}
    >
      {projectId}
    </div>
  ),
}));

jest.mock('@/components/ClaudeLogo', () => ({
  ClaudeLogo: (): JSX.Element => <span />,
}));

function project(overrides: Partial<ChatProjectData> = {}): ChatProjectData {
  return {
    id: 'alpha',
    name: 'Alpha',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim().includes(label),
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ChatProjectSettingsModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let loadClaudeMd: jest.Mock;
  let saveClaudeMd: jest.Mock;
  let onSave: jest.Mock;
  let onDelete: jest.Mock;
  let onClose: jest.Mock;
  let openSettings: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadClaudeMd = jest.fn().mockResolvedValue('');
    saveClaudeMd = jest.fn().mockResolvedValue(undefined);
    onSave = jest.fn().mockResolvedValue(undefined);
    onDelete = jest.fn().mockResolvedValue(undefined);
    onClose = jest.fn();
    openSettings = jest.fn();
    useNavigationStore.setState({ openSettings });
    savePrivateMemory.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chatProject: {
          loadClaudeMd,
          saveClaudeMd,
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it('keeps the deferred Starters editor out of this PR', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    expect(
      Array.from(container.querySelectorAll('[role="tab"]')).some(
        (tab) => tab.textContent === 'Starters',
      ),
    ).toBe(false);
  });

  it.each([
    'General',
    'Instructions',
    'Plugins',
    'Environment',
    'Share',
    'Danger',
  ])('uses project copy on the %s tab', async (tab) => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    clickButton(container, tab);
    await flush();

    expect(container.textContent).not.toMatch(/\bworkspaces?\b/i);
    if (tab === 'General') {
      expect(
        container
          .querySelector('#chat-project-description')
          ?.getAttribute('placeholder'),
      ).toBe('Optional project description');
    }
    if (tab === 'Instructions') {
      expect(
        container.querySelector('#claude-md-description')?.textContent,
      ).toBe('Instructions for every chat in this project.');
      expect(container.querySelector('textarea')?.placeholder).toBe(
        '# Project instructions\n\nAdd project-specific CLAUDE.md content here…',
      );
    }
    if (tab === 'Danger') {
      expect(container.querySelector('h3')?.textContent).toBe('Delete project');
    }
  });

  it('opens directly on the Share tab', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          initialTab="share"
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    expect(
      container.querySelector(
        '[data-testid="mock-workspace-template-share-tab"]',
      )?.textContent,
    ).toBe('alpha');
  });

  it('passes unsaved workspace settings to the Share tab', async () => {
    const defaultPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom', skillName: 'study-helper' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project({
            description: 'Initial description',
            color: '#7C3AED',
            defaultPluginSelections,
          })}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    const nameInput =
      container.querySelector<HTMLInputElement>('#chat-project-name');
    const descriptionInput = container.querySelector<HTMLTextAreaElement>(
      '#chat-project-description',
    );
    if (!nameInput || !descriptionInput) {
      throw new Error('Workspace details fields were not rendered');
    }
    act(() => {
      setNativeInputValue(nameInput, 'Draft workspace');
      setNativeInputValue(descriptionInput, 'Draft description');
    });
    clickButton(container, 'Instructions');
    const instructions = container.querySelector<HTMLTextAreaElement>(
      '[aria-labelledby="claude-md-label"]',
    );
    if (!instructions) throw new Error('Instructions field was not rendered');
    act(() => setNativeInputValue(instructions, 'Draft instructions'));
    clickButton(container, 'Share');

    const shareTab = container.querySelector<HTMLElement>(
      '[data-testid="mock-workspace-template-share-tab"]',
    );
    expect(JSON.parse(shareTab?.dataset.draft ?? 'null')).toEqual({
      name: 'Draft workspace',
      description: 'Draft description',
      color: '#7C3AED',
      instructions: 'Draft instructions',
      defaultPluginSelections,
    });
  });

  it('waits for workspace instructions before rendering the Share tab', async () => {
    let resolveInstructions: ((value: string) => void) | undefined;
    loadClaudeMd.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveInstructions = resolve;
        }),
    );
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          initialTab="share"
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="mock-workspace-template-share-tab"]',
      ),
    ).toBeNull();
    await act(async () => {
      resolveInstructions?.('Loaded workspace instructions');
      await Promise.resolve();
    });
    const shareTab = container.querySelector<HTMLElement>(
      '[data-testid="mock-workspace-template-share-tab"]',
    );
    expect(JSON.parse(shareTab?.dataset.draft ?? 'null')).toMatchObject({
      instructions: 'Loaded workspace instructions',
    });
  });
  it('does not offer a "move chats to Default" delete option — the backend has no merge disposition', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project({ id: 'alpha' })}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    clickButton(container, 'Danger');

    expect(container.textContent).not.toContain('Move chats to Default');
    expect(container.textContent).not.toContain('Default project');
    expect(container.textContent).toContain('Delete permanently');

    clickButton(container, 'Delete project…');
    clickButton(container, 'Confirm delete');
    await flush();

    // The only delete behavior left is a plain delete-by-id — there is no
    // disposition argument to opt a "preserve chats" path into.
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('alpha');
    expect(onDelete.mock.calls[0]).toHaveLength(1);
  });

  it('does not show a Danger tab for the real default cowork project', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project({
            id: DEFAULT_COWORK_WORKSPACE_ID,
            name: 'Default',
          })}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    expect(container.querySelector('section')?.dataset.maxWidth).toBe('5xl');
    const tabLabels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent?.trim(),
    );
    expect(tabLabels).not.toContain('Danger');
  });

  it('uses the accent line token for the selected tab', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    const generalTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'General',
    );
    expect(generalTab?.className).toContain('canopy-tab-trigger');
    expect(generalTab?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps retention and Always show on General, exposes Environment, and removes Advanced', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project({ archiveRetentionDays: 12 })}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    const tabLabels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent?.trim(),
    );
    expect(tabLabels).toContain('Environment');
    expect(tabLabels).not.toContain('Advanced');
    expect(container.textContent).toContain('Deletion retention');
    expect(container.textContent).toContain(
      "Deleted chats and legacy archived chats are kept for 12 days before they're removed. Archived work entries are kept until you delete them.",
    );
    expect(container.textContent).toContain('Always show project');

    clickButton(container, 'Environment');
    expect(
      container
        .querySelector('[data-testid="mock-workspace-environment-tab"]')
        ?.getAttribute('data-workspace-kind'),
    ).toBe('cowork');
  });

  it('closes before opening Settings → Environments from Environment settings', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    clickButton(container, 'Environment');
    clickButton(container, 'Manage environments');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledWith('environment');
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      openSettings.mock.invocationCallOrder[0],
    );
  });

  it('hides the overall Save footer while Environment owns its save controls', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project()}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    clickButton(container, 'Environment');
    const buttonLabels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent?.trim(),
    );
    expect(buttonLabels).toContain('Save environment assignments');
    expect(buttonLabels).not.toContain('Save');
  });

  it('persists the Always show project toggle', async () => {
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project({ archiveRetentionDays: 7 })}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    const alwaysShow = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Always show project"]',
    );
    expect(alwaysShow?.getAttribute('aria-checked')).toBe('true');
    act(() => alwaysShow?.click());
    clickButton(container, 'Save');
    await flush();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysShow: false }),
    );
  });

  it('shows a Danger tab for a non-default cowork project whose id happens to be the legacy "default" id', async () => {
    // Regression test for DEFAULT_CHAT_PROJECT_ID ('default') vs
    // DEFAULT_COWORK_WORKSPACE_ID ('cowork-default') confusion: only the real
    // cowork default workspace id should suppress the Danger tab.
    act(() => {
      root.render(
        <ChatProjectSettingsModal
          isOpen
          project={project({ id: 'default', name: 'Some Workspace' })}
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
        />,
      );
    });
    await flush();

    const tabLabels = Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent?.trim(),
    );
    expect(tabLabels).toContain('Danger');
  });

  describe('deletion retention (shared semantics)', () => {
    function retentionDaysInput(): HTMLInputElement | null {
      return container.querySelector<HTMLInputElement>(
        '[data-testid="chat-project-settings-retention-days"]',
      );
    }

    function saveButton(): HTMLButtonElement | null {
      return (
        Array.from(container.querySelectorAll('button')).find(
          (candidate) => candidate.textContent?.trim() === 'Save',
        ) ?? null
      );
    }

    async function renderGeneralTab(
      archiveRetentionDays: number | null | undefined,
    ): Promise<void> {
      act(() => {
        root.render(
          <ChatProjectSettingsModal
            isOpen
            project={project({ archiveRetentionDays })}
            onClose={onClose}
            onSave={onSave}
            onDelete={onDelete}
          />,
        );
      });
      await flush();
    }

    it('renders never-set retention as the 7-day default pending its first Save', async () => {
      await renderGeneralTab(undefined);

      expect(container.textContent).toContain('Deletion retention');
      expect(container.textContent).not.toContain('Enable retention');
      expect(
        container.querySelector(
          '[data-testid="chat-project-settings-retention-toggle"]',
        ),
      ).toBeNull();
      expect(retentionDaysInput()?.value).toBe('7');
      // Legacy null/absent must be re-persisted explicitly — the per-chat
      // archive sweep honors only explicit values, so Save is offered until
      // the displayed 7-day default has been written once.
      expect(saveButton()).not.toBeNull();
    });

    it('renders legacy explicit null as 7 days and persists it on the first Save', async () => {
      await renderGeneralTab(null);

      expect(retentionDaysInput()?.value).toBe('7');
      const save = saveButton();
      expect(save).not.toBeNull();
      act(() => {
        save?.click();
      });
      await flush();
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ archiveRetentionDays: 7 }),
      );
    });

    it('renders a legacy persisted 0 as the 7-day default and re-persists it', async () => {
      await renderGeneralTab(0);

      expect(retentionDaysInput()?.value).toBe('7');
      const save = saveButton();
      expect(save).not.toBeNull();
      act(() => {
        save?.click();
      });
      await flush();
      expect(onSave).toHaveBeenCalledWith({
        projectId: 'alpha',
        archiveRetentionDays: 7,
      });
    });

    it('renders a positive day count with that value and stays clean', async () => {
      await renderGeneralTab(12);

      expect(retentionDaysInput()?.value).toBe('12');
      expect(saveButton()).toBeNull();
    });

    it('persists the chosen day count', async () => {
      await renderGeneralTab(12);

      const daysInput = retentionDaysInput();
      if (!daysInput) throw new Error('Retention days input not found');
      act(() => {
        setNativeInputValue(daysInput, '30');
      });
      const save = saveButton();
      if (!save) throw new Error('Save button not found');
      act(() => {
        save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenCalledWith({
        projectId: 'alpha',
        archiveRetentionDays: 30,
      });
    });

    it('offers Auto Delete with always-on retention and defaults inactivity to 7 days', async () => {
      await renderGeneralTab(0);

      const autoToggle = container.querySelector<HTMLInputElement>(
        '[data-testid="chat-project-settings-auto-archive-toggle"]',
      );
      expect(autoToggle).not.toBeNull();
      expect(
        autoToggle?.closest(
          '[data-testid="chat-project-settings-retention-card"]',
        ),
      ).not.toBeNull();
      act(() => autoToggle?.click());
      expect(
        container.querySelector<HTMLInputElement>(
          '[data-testid="chat-project-settings-auto-archive-days"]',
        )?.value,
      ).toBe('7');

      clickButton(container, 'Save');
      await flush();
      expect(onSave).toHaveBeenCalledWith({
        projectId: 'alpha',
        archiveRetentionDays: 7,
        autoArchiveDays: 7,
      });
    });
  });

  describe('Private memory (CAN-3562)', () => {
    function renderModal(overrides: Partial<ChatProjectData> = {}): void {
      act(() => {
        root.render(
          <ChatProjectSettingsModal
            isOpen
            // A saved retention keeps the footer clean until the toggle moves.
            project={project({ archiveRetentionDays: 7, ...overrides })}
            onClose={onClose}
            onSave={onSave}
            onDelete={onDelete}
          />,
        );
      });
    }

    function toggle(): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-project-settings-private-memory-toggle"]',
      );
    }

    function hasSave(): boolean {
      return Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Save',
      );
    }

    it.each([
      [undefined, 'false'],
      [false, 'false'],
      [true, 'true'],
    ])(
      'seeds the toggle from the project (%s) with the approved explanation',
      async (privateMemory, checked) => {
        renderModal({ privateMemory });
        await flush();

        expect(toggle()?.getAttribute('aria-checked')).toBe(checked);
        expect(toggle()?.disabled).toBe(false);
        expect(
          container.querySelector(
            '[data-testid="chat-project-settings-private-memory"]',
          )?.textContent,
        ).toContain(
          "Agents won't use memory from other projects or your organization. New memories stay here.",
        );
        expect(hasSave()).toBe(false);
      },
    );

    it.each([
      [false, true],
      [true, false],
    ])(
      'saves a change from %s to %s through the Private memory path only',
      async (from, to) => {
        renderModal({ privateMemory: from });
        await flush();

        act(() => toggle()?.click());
        expect(toggle()?.getAttribute('aria-checked')).toBe(String(to));
        clickButton(container, 'Save');
        await flush();

        expect(savePrivateMemory).toHaveBeenCalledTimes(1);
        expect(savePrivateMemory).toHaveBeenCalledWith('alpha', to);
        expect(onSave).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
      },
    );

    it('saves the other settings before Private memory', async () => {
      renderModal();
      await flush();

      act(() => toggle()?.click());
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[role="switch"][aria-label="Always show project"]',
          )
          ?.click(),
      );
      clickButton(container, 'Save');
      await flush();

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ alwaysShow: false }),
      );
      expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(
        savePrivateMemory.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('shows an organization-managed value locked, with no way to save it', async () => {
      renderModal({
        privateMemory: true,
        privateMemoryManagedBy: 'organization',
      });
      await flush();

      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      expect(toggle()?.disabled).toBe(true);
      expect(
        container.querySelector(
          '[data-testid="chat-project-settings-private-memory-managed"]',
        )?.textContent,
      ).toBe('Managed by your organization');
      act(() => toggle()?.click());
      expect(hasSave()).toBe(false);
      expect(savePrivateMemory).not.toHaveBeenCalled();
    });

    it('keeps the dialog open with the reason when the save is refused', async () => {
      savePrivateMemory.mockRejectedValue(
        new Error('Private memory is managed by your organization'),
      );
      renderModal();
      await flush();

      act(() => toggle()?.click());
      clickButton(container, 'Save');
      await flush();

      expect(onClose).not.toHaveBeenCalled();
      expect(
        container.querySelector(
          '[data-testid="chat-project-settings-private-memory-error"]',
        )?.textContent,
      ).toBe('Private memory is managed by your organization');
      // The draft is dropped: the toggle shows the row's value again.
      expect(toggle()?.getAttribute('aria-checked')).toBe('false');

      // The refusal's reload then delivers the managed row.
      renderModal({
        privateMemory: true,
        privateMemoryManagedBy: 'organization',
      });
      await flush();
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
      expect(toggle()?.disabled).toBe(true);
      expect(
        container.querySelector(
          '[data-testid="chat-project-settings-private-memory-error"]',
        ),
      ).not.toBeNull();
    });

    it('drops an unsaved draft when the dialog is reopened', async () => {
      const row = project({ archiveRetentionDays: 7 });
      const render = (isOpen: boolean): void => {
        act(() => {
          root.render(
            <ChatProjectSettingsModal
              isOpen={isOpen}
              project={row}
              onClose={onClose}
              onSave={onSave}
              onDelete={onDelete}
            />,
          );
        });
      };
      render(true);
      await flush();
      act(() => toggle()?.click());
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');

      render(false);
      render(true);
      await flush();
      expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    });
  });
});
