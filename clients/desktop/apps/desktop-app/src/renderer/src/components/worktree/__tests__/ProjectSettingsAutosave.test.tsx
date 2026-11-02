/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';
import { ProjectSettingsModal } from '../ProjectSettingsModal';
import { AUTOSAVE_DELAY_MS, AUTOSAVE_SAVED_HOLD_MS } from '@/hooks/useAutosave';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

jest.mock('@/lib/privateMemory', () => ({
  saveWorkspacePrivateMemory: jest.fn(),
}));
const savePrivateMemory = jest.mocked(saveWorkspacePrivateMemory);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function project(): SingleRepoSidebarItem {
  return {
    id: 'single-project',
    type: 'single-repo',
    name: 'Single project',
    color: '#000000',
    repoPath: '/repos/single-project',
    worktrees: [],
    collapsed: false,
    order: 0,
    scripts: {
      launch: {
        command: 'pnpm dev',
        devServerPattern: 'https?://localhost:\\d+',
      },
    },
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

let container: HTMLDivElement;
let root: Root;
let saveProjectScripts: jest.Mock;
let saveProjectDefaultPlugins: jest.Mock;
let getWorkspaceSettingsData: jest.Mock;
let applyProjectSourceChanges: jest.Mock;

function installWindowApi(): void {
  saveProjectScripts = jest.fn().mockResolvedValue(undefined);
  saveProjectDefaultPlugins = jest.fn().mockResolvedValue(undefined);
  getWorkspaceSettingsData = jest
    .fn()
    .mockRejectedValue(new Error('settings data is not needed'));
  applyProjectSourceChanges = jest
    .fn()
    .mockResolvedValue({ worktreeId: 'wt-new' });
  const api: Record<string, unknown> = {
    saveProjectScripts,
    saveProjectDefaultPlugins,
    getRemoteUrl: jest.fn().mockResolvedValue({ remoteUrl: null }),
    getDefaultCloneDirectory: jest.fn().mockResolvedValue('/repos'),
    getWorkspaceSettingsData,
    applyProjectSourceChanges,
    onProjectSourceChangesApplied: jest.fn(() => (): void => undefined),
    onWorkspaceSourceChangesApplied: jest.fn(() => (): void => undefined),
    loadEnvironmentConfig: jest.fn(() =>
      Promise.resolve({
        data: createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'),
        encryptionAvailable: true,
      }),
    ),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(api, {
      get(target, key: string): unknown {
        return key in target
          ? target[key]
          : jest.fn(() => Promise.resolve(undefined));
      },
    }),
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function waitOutAutosave(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2);
    await Promise.resolve();
  });
  await settle();
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Not found: ${id}`);
  return element;
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    // The prototype's setter, so React sees the change as typed input.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function renderPage(
  onClose: () => void = jest.fn(),
  item: SingleRepoSidebarItem = project(),
): Promise<void> {
  act(() => {
    root.render(
      <CanopyClientProvider client={createFakeClient().client}>
        <ProjectSettingsModal isOpen onClose={onClose} project={item} />
      </CanopyClientProvider>,
    );
  });
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  savePrivateMemory.mockReset().mockResolvedValue(undefined);
  installWindowApi();
  useProjectsStore.setState({
    projects: [project()],
    loadProjects: jest.fn().mockResolvedValue(undefined),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  jest.useRealTimers();
});

describe('ProjectSettingsModal autosave', () => {
  it('holds the save while a collapsed script still has a pattern that cannot be saved', async () => {
    await renderPage();
    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();

    const pattern = byTestId('project-settings-script-launch').querySelector(
      'input[placeholder="https?://localhost:\\\\d+\\\\S*"]',
    );
    if (!(pattern instanceof HTMLInputElement)) {
      throw new Error('Pattern field not found');
    }
    typeInto(pattern, '(');
    // Done collapses the editor; the pattern is still in the draft.
    act(() => byTestId('project-settings-script-edit-launch').click());
    await waitOutAutosave();

    expect(saveProjectScripts).not.toHaveBeenCalled();
  });

  it('holds Save local, not other changes, while a pattern cannot be saved', async () => {
    await renderPage();
    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();
    const pattern = byTestId('project-settings-script-launch').querySelector(
      'input[placeholder="https?://localhost:\\\\d+\\\\S*"]',
    );
    if (!(pattern instanceof HTMLInputElement)) {
      throw new Error('Pattern field not found');
    }
    typeInto(pattern, '(');
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();
    expect(
      byTestId('project-settings-save-local').hasAttribute('disabled'),
    ).toBe(true);

    act(() => byTestId('project-settings-nav-general').click());
    await settle();
    act(() => byTestId('project-settings-always-show').click());
    await waitOutAutosave();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
    expect(saveProjectScripts).not.toHaveBeenCalled();
  });

  it('keeps a page that saves on its own mounted after another page opens', async () => {
    await renderPage();
    act(() => byTestId('project-settings-nav-start-page').click());
    await settle();
    expect(byTestId('start-page-setting')).toBeTruthy();
    act(() => byTestId('project-settings-nav-general').click());
    await settle();

    const startPage = byTestId('start-page-setting');
    expect(startPage.closest('.hidden')).not.toBeNull();
    expect(
      byTestId('project-settings-always-show').closest('.hidden'),
    ).toBeNull();
  });

  it('saves changes for this computer while a canopy.json pattern cannot be saved', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);
    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    act(() => byTestId('project-settings-scope-source').click());
    await settle();
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();
    const addPattern = Array.from(
      byTestId('project-settings-script-launch').querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Add pattern'));
    act(() => addPattern?.click());
    const pattern = byTestId('project-settings-script-launch').querySelector(
      'input[placeholder="https?://localhost:\\\\d+\\\\S*"]',
    );
    if (!(pattern instanceof HTMLInputElement)) {
      throw new Error('Pattern field not found');
    }
    typeInto(pattern, '(');
    act(() => byTestId('project-settings-script-edit-launch').click());
    act(() => byTestId('project-settings-nav-general').click());
    await settle();
    act(() => byTestId('project-settings-always-show').click());
    await waitOutAutosave();

    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens Environments settings only once the page has closed', async () => {
    const openSettings = jest.fn();
    useNavigationStore.setState({ openSettings });
    const onClose = jest.fn();
    await renderPage(onClose);
    // Hold a change with a pattern that cannot be saved.
    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();
    const pattern = byTestId('project-settings-script-launch').querySelector(
      'input[placeholder="https?://localhost:\\\\d+\\\\S*"]',
    );
    if (!(pattern instanceof HTMLInputElement)) {
      throw new Error('Pattern field not found');
    }
    typeInto(pattern, '(');
    act(() => byTestId('project-settings-nav-environment').click());
    await settle();

    act(() => byTestId('workspace-environment-manage').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();

    // Closing again discards the held change; then Settings opens.
    act(() => byTestId('workspace-environment-manage').click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledWith('environment');
  });

  it('clears "Adding to…" after a successful apply when the close is held', async () => {
    getWorkspaceSettingsData.mockResolvedValue({
      manifest: { scripts: { launch: 'pnpm dev' } },
      driftIssues: [],
    });
    saveProjectDefaultPlugins.mockRejectedValue(new Error('Disk is full'));
    const onClose = jest.fn();
    await renderPage(onClose);
    // A change for this computer that cannot be saved holds the close.
    act(() => byTestId('project-settings-always-show').click());
    await waitOutAutosave();

    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    act(() => byTestId('project-settings-scope-source').click());
    await settle();
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();
    const command = byTestId('project-settings-script-launch').querySelector(
      'textarea',
    );
    if (!(command instanceof HTMLTextAreaElement)) {
      throw new Error('Command field not found');
    }
    act(() => {
      Reflect.set(
        HTMLTextAreaElement.prototype,
        'value',
        'pnpm start',
        command,
      );
      command.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const add = byTestId('project-settings-add-to-worktree').querySelector(
      'button',
    );
    act(() => add?.click());
    await settle();

    expect(applyProjectSourceChanges).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Adding to');
  });

  it('waits for a Start page write before closing, and stays open if it fails', async () => {
    let fail: (cause: Error) => void = () => undefined;
    const setWorkspaceStartPage = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    Reflect.set(window.api, 'setWorkspaceStartPage', setWorkspaceStartPage);
    const onClose = jest.fn();
    await renderPage(onClose);
    act(() => byTestId('project-settings-nav-start-page').click());
    await settle();
    act(() => byTestId('start-page-choice-trigger').click());
    act(() => byTestId('start-page-choice-chat').click());
    await settle();
    act(() => byTestId('start-page-save-local').click());
    await settle();
    expect(setWorkspaceStartPage).toHaveBeenCalledTimes(1);

    // Back while the write runs: the page waits for it.
    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      fail(new Error('Disk is full'));
      await Promise.resolve();
    });
    await settle();

    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('project-settings-error').textContent).toContain(
      'Start page choice couldn’t be saved',
    );
  });

  it('saves a General edit made while closing waits for a Start page write', async () => {
    let finish: () => void = () => undefined;
    const setWorkspaceStartPage = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Reflect.set(window.api, 'setWorkspaceStartPage', setWorkspaceStartPage);
    const onClose = jest.fn();
    await renderPage(onClose);
    act(() => byTestId('project-settings-nav-start-page').click());
    await settle();
    act(() => byTestId('start-page-choice-trigger').click());
    act(() => byTestId('start-page-choice-chat').click());
    await settle();
    act(() => byTestId('start-page-save-local').click());
    await settle();
    act(() => byTestId('project-settings-nav-general').click());
    await settle();

    // Back while the Start page write runs, then a General edit before it
    // lands: the close must write that edit too.
    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    act(() => byTestId('project-settings-always-show').click());
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await settle();

    expect(saveProjectDefaultPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysShow: false }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports a refused Private memory change as not saved', async () => {
    savePrivateMemory.mockRejectedValue(new Error('Managed by your team'));
    await renderPage();

    act(() => byTestId('project-settings-private-memory-toggle').click());
    await waitOutAutosave();

    expect(savePrivateMemory).toHaveBeenCalledTimes(1);
    expect(byTestId('settings-save-status').dataset.state).toBe('error');
  });

  it('follows a refreshed project without saving the old values back', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);
    // Changed somewhere else; the page did not touch these.
    await renderPage(onClose, {
      ...project(),
      alwaysShow: false,
      scripts: { launch: { command: 'pnpm start' } },
    });
    await waitOutAutosave();

    expect(saveProjectDefaultPlugins).not.toHaveBeenCalled();
    expect(saveProjectScripts).not.toHaveBeenCalled();
    expect(
      byTestId('project-settings-always-show').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('keeps an edit when the project refreshes, and saves it', async () => {
    await renderPage();
    act(() => byTestId('project-settings-always-show').click());
    await renderPage(jest.fn(), {
      ...project(),
      scripts: { launch: { command: 'pnpm start' } },
    });
    await waitOutAutosave();

    expect(saveProjectScripts).not.toHaveBeenCalled();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysShow: false }),
    );
  });

  it('keeps a change set back while a save runs, when the refresh arrives', async () => {
    let finish: () => void = () => undefined;
    saveProjectDefaultPlugins.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await renderPage();
    act(() => byTestId('project-settings-always-show').click());
    await waitOutAutosave();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysShow: false }),
    );
    // Back on while that save runs; then the save's refresh arrives.
    act(() => byTestId('project-settings-always-show').click());
    await renderPage(jest.fn(), { ...project(), alwaysShow: false });
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await waitOutAutosave();

    expect(
      byTestId('project-settings-always-show').getAttribute('aria-checked'),
    ).toBe('true');
    expect(saveProjectDefaultPlugins).toHaveBeenLastCalledWith(
      expect.objectContaining({ alwaysShow: true }),
    );
  });

  it('follows outside changes that arrive after its own save settled', async () => {
    await renderPage();
    act(() => byTestId('project-settings-always-show').click());
    await waitOutAutosave();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
    // The save's refresh, then two changes made elsewhere.
    await renderPage(jest.fn(), { ...project(), alwaysShow: false });
    await renderPage(jest.fn(), {
      ...project(),
      alwaysShow: false,
      scripts: { launch: { command: 'pnpm start' } },
    });
    await renderPage(jest.fn(), {
      ...project(),
      alwaysShow: false,
      scripts: { launch: { command: 'pnpm serve' } },
    });
    await waitOutAutosave();

    expect(saveProjectScripts).not.toHaveBeenCalled();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
  });

  it('follows repeated outside changes to a field its running save did not change', async () => {
    let finish: () => void = () => undefined;
    saveProjectDefaultPlugins.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await renderPage();
    act(() => byTestId('project-settings-always-show').click());
    await waitOutAutosave();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
    // A script changes elsewhere while that save runs, then the save's own
    // refresh arrives and it settles, then the script changes elsewhere again.
    await renderPage(jest.fn(), {
      ...project(),
      scripts: { launch: { command: 'pnpm start' } },
    });
    await renderPage(jest.fn(), {
      ...project(),
      alwaysShow: false,
      scripts: { launch: { command: 'pnpm start' } },
    });
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await settle();
    await renderPage(jest.fn(), {
      ...project(),
      alwaysShow: false,
      scripts: { launch: { command: 'pnpm serve' } },
    });
    await waitOutAutosave();

    expect(saveProjectScripts).not.toHaveBeenCalled();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
  });

  it('lets a section’s Saved settle back to rest', async () => {
    await renderPage();
    act(() => byTestId('project-settings-nav-start-page').click());
    await settle();
    act(() => byTestId('start-page-choice-trigger').click());
    act(() => byTestId('start-page-choice-chat').click());
    await settle();
    act(() => byTestId('start-page-save-local').click());
    await settle();
    expect(byTestId('settings-save-status').dataset.state).toBe('saved');

    await act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_SAVED_HOLD_MS);
      await Promise.resolve();
    });
    // At rest the Start page, saved with Save local, claims no autosave.
    expect(
      document.querySelector('[data-testid="settings-save-status"]'),
    ).toBeNull();
  });

  it('stays open once on close with an unsaved Start page choice', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);
    act(() => byTestId('project-settings-nav-start-page').click());
    await settle();
    act(() => byTestId('start-page-choice-trigger').click());
    act(() => byTestId('start-page-choice-chat').click());
    await settle();

    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('project-settings-error').textContent).toContain(
      'Your Start page choice isn’t saved.',
    );
    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open with the error when the save on close fails', async () => {
    saveProjectDefaultPlugins.mockRejectedValue(new Error('Disk is full'));
    const onClose = jest.fn();
    await renderPage(onClose);

    act(() => byTestId('project-settings-always-show').click());
    act(() => byTestId('project-settings-back').click());
    await settle();

    expect(saveProjectDefaultPlugins).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('settings-save-status').dataset.state).toBe('error');
  });

  it('keeps the convert dialog busy while the save before converting runs', async () => {
    let finish: () => void = () => undefined;
    saveProjectDefaultPlugins.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const convertWorkspaceType = jest.fn().mockResolvedValue(undefined);
    Reflect.set(window.api, 'convertWorkspaceType', convertWorkspaceType);
    await renderPage();
    act(() => byTestId('project-settings-always-show').click());
    const convert = Array.from(
      byTestId('project-settings-convert').querySelectorAll('button'),
    ).find((button) => button.textContent === 'Convert…');
    if (!(convert instanceof HTMLButtonElement))
      throw new Error('Missing Convert');
    act(() => convert.click());
    const dialog = byTestId('project-settings-convert-dialog');
    const button = (label: string): HTMLButtonElement => {
      const found = Array.from(dialog.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label,
      );
      if (!(found instanceof HTMLButtonElement))
        throw new Error(`Missing ${label}`);
      return found;
    };
    act(() => button('Leave unchanged').click());
    await settle();

    // The pending change is being written before converting. Cancel can't
    // be pressed now: the convert would still run once that write lands.
    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
    expect(button('Cancel').disabled).toBe(true);
    expect(convertWorkspaceType).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await settle();
    expect(convertWorkspaceType).toHaveBeenCalledTimes(1);
  });

  it('closes once the pending change is saved', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);

    act(() => byTestId('project-settings-always-show').click());
    act(() => byTestId('project-settings-back').click());
    await settle();

    expect(saveProjectDefaultPlugins).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectSettingsModal local overrides', () => {
  async function editLaunchCommand(value: string): Promise<void> {
    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    act(() => byTestId('project-settings-script-edit-launch').click());
    await settle();
    const command = byTestId('project-settings-script-launch').querySelector(
      'textarea',
    );
    if (!(command instanceof HTMLTextAreaElement)) {
      throw new Error('Command field not found');
    }
    act(() => {
      Reflect.set(HTMLTextAreaElement.prototype, 'value', value, command);
      command.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  }

  it('shows Source controlled and Local override tabs without claiming autosave', async () => {
    await renderPage();
    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();

    const tabs = byTestId('project-settings-scope');
    expect(tabs.textContent).toContain('Source controlled');
    expect(tabs.textContent).toContain('Local override');
    expect(document.body.textContent).not.toContain('Save changes to');
    expect(document.body.textContent).not.toContain(
      'Changes save automatically',
    );
  });

  it('saves a local override only when Save local is pressed', async () => {
    await renderPage();
    await editLaunchCommand('pnpm dev --port 4000');
    await waitOutAutosave();
    expect(saveProjectScripts).not.toHaveBeenCalled();

    act(() => byTestId('project-settings-save-local').click());
    await settle();
    expect(saveProjectScripts).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(saveProjectScripts.mock.lastCall)).toContain(
      '"command":"pnpm dev --port 4000"',
    );
  });

  it('saves other changes when a close holds for an unsaved local override', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);
    await editLaunchCommand('pnpm dev --port 4000');
    act(() => byTestId('project-settings-nav-general').click());
    await settle();
    act(() => byTestId('project-settings-always-show').click());

    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(saveProjectDefaultPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysShow: false }),
    );
    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveProjectScripts).not.toHaveBeenCalled();
  });

  it('saves a change made after a held close when closing again', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);
    await editLaunchCommand('pnpm dev --port 4000');
    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();

    act(() => byTestId('project-settings-nav-general').click());
    await settle();
    act(() => byTestId('project-settings-always-show').click());
    // Back before the autosave delay runs out.
    act(() => byTestId('project-settings-back').click());
    await settle();

    expect(saveProjectDefaultPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysShow: false }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveProjectScripts).not.toHaveBeenCalled();
  });

  it('does not convert the project while a local override is unsaved', async () => {
    const convertWorkspaceType = jest.fn().mockResolvedValue(undefined);
    Reflect.set(window.api, 'convertWorkspaceType', convertWorkspaceType);
    const onClose = jest.fn();
    await renderPage(onClose);
    await editLaunchCommand('pnpm dev --port 4000');
    act(() => byTestId('project-settings-nav-general').click());
    await settle();
    const convert = Array.from(
      byTestId('project-settings-convert').querySelectorAll('button'),
    ).find((button) => button.textContent === 'Convert…');
    if (!(convert instanceof HTMLButtonElement))
      throw new Error('Missing Convert');
    act(() => convert.click());
    const leave = Array.from(
      byTestId('project-settings-convert-dialog').querySelectorAll('button'),
    ).find((button) => button.textContent === 'Leave unchanged');
    act(() => leave?.click());
    await settle();

    expect(convertWorkspaceType).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('project-settings-manage-error').textContent).toContain(
      'Save or discard your local override first',
    );
  });

  it('stays open once on close with an unsaved local override, then discards it', async () => {
    const onClose = jest.fn();
    await renderPage(onClose);
    await editLaunchCommand('pnpm dev --port 4000');

    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(byTestId('project-settings-error').textContent).toContain(
      'Your local override isn’t saved.',
    );

    act(() => byTestId('project-settings-back').click());
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveProjectScripts).not.toHaveBeenCalled();
  });
});

describe('ProjectSettingsModal session replay', () => {
  it('blocks script commands and masks the project name', async () => {
    await renderPage();
    const remove = document.querySelector<HTMLElement>(
      '[data-testid="project-settings-danger"]',
    );
    expect(
      remove?.querySelector(`.${POSTHOG_REPLAY_MASK_CLASS}`)?.textContent,
    ).toBe('Single project');
    act(() => byTestId('project-settings-remove').click());
    const dialog = byTestId('project-settings-remove-dialog');
    expect(
      Array.from(
        dialog.querySelectorAll(`.${POSTHOG_REPLAY_MASK_CLASS}`),
        (element) => element.textContent,
      ),
    ).toEqual(['Single project', 'Single project']);
    act(() =>
      Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click(),
    );

    act(() => byTestId('project-settings-nav-scripts').click());
    await settle();
    expect(
      byTestId('project-settings-script-launch').querySelector(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      )?.textContent,
    ).toBe('pnpm dev');
  });
});
