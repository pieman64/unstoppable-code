/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppAdvisorSettingsModal } from '@/components/app-advisor/AppAdvisorSettingsModal';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { setNativeInputValue } from '@/test-utils/dom';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/shared', () => ({
  DialogModal: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: ReactNode;
  }): JSX.Element => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
}));

jest.mock('@/components/settings/ModelThinkingPreferenceRow', () => ({
  ModelThinkingPreferenceRow: ({
    onThinkingChange,
  }: {
    onThinkingChange: (level: string) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-thinking-change"
      onClick={() => onThinkingChange('low')}
    >
      thinking
    </button>
  ),
}));

jest.mock('@/components/settings/SettingsPluginPicker', () => ({
  SettingsPluginPicker: ({
    onChange,
  }: {
    onChange: (selections: unknown) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-plugin-change"
      onClick={() =>
        onChange({
          collectionIds: ['picked'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        })
      }
    >
      plugins
    </button>
  ),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function byTestId(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!found) throw new Error(`Element not found: ${testId}`);
  return found;
}

function inputByTestId(testId: string): HTMLInputElement {
  const element = byTestId(testId);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Element is not an input: ${testId}`);
  }
  return element;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AppAdvisorSettingsModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: jest.Mock;
  let loadPreferencesMock: jest.Mock;
  let savePreferencesMock: jest.Mock;
  let settingsLoadMock: jest.Mock;
  let settingsSaveMock: jest.Mock;
  let loadClaudeMdMock: jest.Mock;
  let saveClaudeMdMock: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = jest.fn();
    loadPreferencesMock = jest.fn().mockResolvedValue({
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    savePreferencesMock = jest
      .fn()
      .mockImplementation((patch: Record<string, unknown>) =>
        Promise.resolve({
          appAdvisorModel: 'gpt-5.5',
          appAdvisorThinkingLevel: 'high',
          appAdvisorPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          ...patch,
        }),
      );
    settingsLoadMock = jest.fn().mockResolvedValue({
      version: 1,
      archiveRetentionDays: null,
    });
    settingsSaveMock = jest
      .fn()
      .mockImplementation((patch: { archiveRetentionDays?: number | null }) =>
        Promise.resolve({
          version: 1,
          archiveRetentionDays: patch.archiveRetentionDays ?? null,
        }),
      );
    loadClaudeMdMock = jest.fn().mockResolvedValue('# Existing instructions');
    saveClaudeMdMock = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: loadPreferencesMock,
        savePreferences: savePreferencesMock,
        appAdvisor: {
          settingsLoad: settingsLoadMock,
          settingsSave: settingsSaveMock,
          loadClaudeMd: loadClaudeMdMock,
          saveClaudeMd: saveClaudeMdMock,
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

  async function render(): Promise<void> {
    act(() => {
      root.render(<AppAdvisorSettingsModal onClose={onClose} />);
    });
    await flush();
  }

  it('loads preferences, CLAUDE.md, and project settings on mount', async () => {
    await render();
    expect(loadPreferencesMock).toHaveBeenCalled();
    expect(loadClaudeMdMock).toHaveBeenCalled();
    expect(settingsLoadMock).toHaveBeenCalled();
    // The three tabs render (no rename/color/danger tabs).
    expect(byTestId('app-advisor-settings-tab-defaults')).toBeTruthy();
    expect(byTestId('app-advisor-settings-tab-instructions')).toBeTruthy();
    expect(byTestId('app-advisor-settings-tab-advanced')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Danger');
  });

  it('saves defaults through the shared preference save loop', async () => {
    await render();
    loadPreferencesMock.mockResolvedValue({
      appAdvisorModel: 'gpt-5.5',
      appAdvisorThinkingLevel: 'low',
    });
    click(byTestId('mock-thinking-change'));
    await flush();
    expect(savePreferencesMock).toHaveBeenCalledWith(
      {
        appAdvisorThinkingLevel: 'low',
      },
      { view: 'persisted' },
    );
    // The shared loop applies the saved preferences to the App Advisor store.
    expect(useAppAdvisorStore.getState().appAdvisorThinkingLevel).toBe('low');

    click(byTestId('mock-plugin-change'));
    await flush();
    expect(savePreferencesMock).toHaveBeenCalledWith(
      {
        appAdvisorPluginSelections: expect.objectContaining({
          collectionIds: ['picked'],
        }) as unknown,
      },
      { view: 'persisted' },
    );
  });

  it('edits and saves CLAUDE.md with dirty tracking', async () => {
    // Explicit retention keeps this test scoped to CLAUDE.md dirtiness —
    // legacy-null retention would surface the Save affordance on its own.
    settingsLoadMock.mockResolvedValue({ version: 1, archiveRetentionDays: 7 });
    await render();
    click(byTestId('app-advisor-settings-tab-instructions'));
    const editor = byTestId(
      'app-advisor-settings-claude-md',
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe('# Existing instructions');
    // No save button while pristine.
    expect(
      document.querySelector('[data-testid="app-advisor-settings-save"]'),
    ).toBeNull();

    act(() => {
      setNativeInputValue(editor, '# Updated');
    });
    click(byTestId('app-advisor-settings-save'));
    await flush();
    expect(saveClaudeMdMock).toHaveBeenCalledWith('# Updated');
    // Dirty state clears; the save button disappears.
    expect(
      document.querySelector('[data-testid="app-advisor-settings-save"]'),
    ).toBeNull();
  });

  it('renders legacy null retention as the 7-day default and persists it on the first Save', async () => {
    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: null,
    });
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));
    expect(byTestId('app-advisor-settings-retention').textContent).toContain(
      'Deletion retention',
    );
    expect(byTestId('app-advisor-settings-retention').textContent).toContain(
      'Deleted and archived chats are kept for 7 days before',
    );
    expect(byTestId('app-advisor-settings-retention').textContent).toContain(
      'Archived work entries are kept until you delete them.',
    );
    // No enable/disable control: retention is always on.
    expect(
      document.querySelector(
        '[data-testid="app-advisor-settings-retention-toggle"]',
      ),
    ).toBeNull();
    expect(inputByTestId('app-advisor-settings-retention-days').value).toBe(
      '7',
    );
    // Legacy null must be re-persisted explicitly — the archived-chat sweep
    // honors only explicit values, so the first Save arms it to match the
    // 7-day default shown here.
    click(byTestId('app-advisor-settings-save'));
    await flush();
    expect(settingsSaveMock).toHaveBeenCalledWith({ archiveRetentionDays: 7 });
    expect(
      document.querySelector('[data-testid="app-advisor-settings-save"]'),
    ).toBeNull();
  });

  it('renders never-set (undefined) retention as 7 days pending its first Save', async () => {
    settingsLoadMock.mockResolvedValue({ version: 1 });
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));
    expect(inputByTestId('app-advisor-settings-retention-days').value).toBe(
      '7',
    );
    expect(
      document.querySelector('[data-testid="app-advisor-settings-save"]'),
    ).not.toBeNull();
  });

  it('renders a legacy persisted 0 as 7 days (re-persisted on Save) and a positive value as-is', async () => {
    settingsLoadMock.mockResolvedValue({ version: 1, archiveRetentionDays: 0 });
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));
    expect(inputByTestId('app-advisor-settings-retention-days').value).toBe(
      '7',
    );
    click(byTestId('app-advisor-settings-save'));
    await flush();
    expect(settingsSaveMock).toHaveBeenCalledWith({ archiveRetentionDays: 7 });
    act(() => {
      root.unmount();
    });

    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: 21,
    });
    root = createRoot(container);
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));
    expect(inputByTestId('app-advisor-settings-retention-days').value).toBe(
      '21',
    );
    expect(
      document.querySelector('[data-testid="app-advisor-settings-save"]'),
    ).toBeNull();
  });

  it('persists the chosen day count', async () => {
    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: 7,
    });
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));
    const daysInput = inputByTestId('app-advisor-settings-retention-days');
    act(() => {
      setNativeInputValue(daysInput, '14');
    });
    click(byTestId('app-advisor-settings-save'));
    await flush();
    expect(settingsSaveMock).toHaveBeenCalledWith({
      archiveRetentionDays: 14,
    });
  });

  it('configures Auto Delete with always-on retention and defaults to seven inactive days', async () => {
    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: 30,
      autoArchiveDays: null,
    });
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));

    const autoArchiveToggle = inputByTestId(
      'app-advisor-settings-auto-archive-toggle',
    );
    expect(document.body.textContent).toContain('Auto delete');
    expect(document.body.textContent).not.toContain('Auto Archive');
    expect(
      autoArchiveToggle.closest(
        '[data-testid="app-advisor-settings-retention-card"]',
      ),
    ).not.toBeNull();
    expect(autoArchiveToggle.checked).toBe(false);
    expect(
      document.querySelector(
        '[data-testid="app-advisor-settings-auto-archive-days"]',
      ),
    ).toBeNull();

    act(() => autoArchiveToggle.click());
    expect(inputByTestId('app-advisor-settings-auto-archive-days').value).toBe(
      '7',
    );
    click(byTestId('app-advisor-settings-save'));
    await flush();

    expect(settingsSaveMock).toHaveBeenCalledWith({
      autoArchiveDays: 7,
    });

    expect(
      document.querySelector(
        '[data-testid="app-advisor-settings-retention-toggle"]',
      ),
    ).toBeNull();
  });

  it('restores the seven-day Auto Delete default when the day field is cleared', async () => {
    settingsLoadMock.mockResolvedValue({
      version: 1,
      archiveRetentionDays: 30,
      autoArchiveDays: 14,
    });
    await render();
    click(byTestId('app-advisor-settings-tab-advanced'));

    const daysInput = inputByTestId('app-advisor-settings-auto-archive-days');
    act(() => {
      setNativeInputValue(daysInput, '');
    });

    expect(daysInput.value).toBe('7');
    click(byTestId('app-advisor-settings-save'));
    await flush();
    expect(settingsSaveMock).toHaveBeenCalledWith({
      autoArchiveDays: 7,
    });
  });

  it('surfaces save errors without closing the modal', async () => {
    saveClaudeMdMock.mockRejectedValueOnce(new Error('disk full'));
    await render();
    click(byTestId('app-advisor-settings-tab-instructions'));
    const editor = byTestId(
      'app-advisor-settings-claude-md',
    ) as HTMLTextAreaElement;
    act(() => {
      setNativeInputValue(editor, '# Broken save');
    });
    click(byTestId('app-advisor-settings-save'));
    await flush();
    expect(document.body.textContent).toContain('disk full');
    expect(onClose).not.toHaveBeenCalled();
    // Still dirty — the save button remains for a retry.
    expect(byTestId('app-advisor-settings-save')).toBeTruthy();
  });
});
