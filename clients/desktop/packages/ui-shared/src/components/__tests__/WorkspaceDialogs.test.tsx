/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PipelinePickerDialog,
  type WorkspaceSettingsValues,
  WorkspaceSettingsDialog,
  WorktreeInfoDialog,
} from '../index';

describe('shared project and worktree dialogs', () => {
  let container: HTMLDivElement;
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

  it('preserves confirmed-empty settings and does not invent a color', async () => {
    let savedValues: WorkspaceSettingsValues | undefined;
    const onSave = jest.fn((values: WorkspaceSettingsValues) => {
      savedValues = values;
      return Promise.resolve();
    });
    const onClose = jest.fn();
    act(() => {
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Workspace"
          initialValues={{ name: 'Workspace', content: '', scripts: {} }}
          tabs={['details', 'claude-md', 'scripts']}
          onSave={onSave}
          onClose={onClose}
          testIds={{ save: 'save' }}
        />,
      );
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="save"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith({
      name: 'Workspace',
      color: undefined,
      content: '',
      scripts: { setup: '', launch: '', teardown: '' },
    });
    expect(savedValues).not.toHaveProperty('description');
    // Save is not a dismiss: the settings span several tabs and none of them
    // persist on switch, so closing here forced a reopen per tab edited.
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Saved');
  });

  it('renders host-defined project fields and submits their values from an extra tab', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    act(() => {
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Cloud Workspace"
          initialValues={{
            name: 'Cloud Workspace',
            description: 'Initial description',
            content: 'Initial instructions',
            scripts: {},
          }}
          tabs={['details', 'claude-md']}
          showDescription
          tabLabels={{ 'claude-md': 'Instructions' }}
          claudeMdCopy={{
            title: 'Instructions',
            description: 'Extra instructions for agents in this project.',
          }}
          extraTabs={[
            {
              id: 'plugins',
              label: 'Plugins',
              content: <div data-testid="plugins-content">Plugin editor</div>,
            },
          ]}
          onSave={onSave}
          onClose={onClose}
          testIds={{ descriptionInput: 'description', save: 'save' }}
        />,
      );
    });

    expect(document.body.textContent).toContain('Instructions');
    const instructionsTab = Array.from(
      document.querySelectorAll('button'),
    ).find((candidate) => candidate.textContent?.trim() === 'Instructions');
    act(() => instructionsTab?.click());
    expect(document.body.textContent).toContain(
      'Extra instructions for agents in this project.',
    );
    const detailsTab = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Details',
    );
    act(() => detailsTab?.click());
    expect(
      document.querySelector<HTMLTextAreaElement>('[data-testid="description"]')
        ?.value,
    ).toBe('Initial description');
    const pluginsTab = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Plugins',
    );
    act(() => pluginsTab?.click());
    expect(
      document.querySelector('[data-testid="plugins-content"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="save"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith({
      name: 'Cloud Workspace',
      description: 'Initial description',
      color: undefined,
      content: 'Initial instructions',
      scripts: { setup: '', launch: '', teardown: '' },
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores extra tabs whose ids collide with built-in tabs', () => {
    act(() => {
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Workspace"
          initialValues={{ name: 'Workspace', content: '', scripts: {} }}
          tabs={['details']}
          extraTabs={[
            {
              id: 'scripts',
              label: 'Override Scripts',
              content: <div>Override content</div>,
            },
          ]}
          onSave={() => Promise.resolve()}
          onClose={jest.fn()}
        />,
      );
    });

    expect(document.body.textContent).not.toContain('Override Scripts');
    expect(document.body.textContent).not.toContain('Override content');
  });

  it('uses host-defined danger copy for project removal', async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    act(() => {
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Cloud Workspace"
          initialValues={{ name: 'Cloud Workspace', content: '', scripts: {} }}
          tabs={['danger']}
          onSave={() => Promise.resolve()}
          onDelete={onDelete}
          onClose={onClose}
          dangerCopy={{
            title: 'Archive Workspace',
            description: 'Archive this project and its chats.',
            triggerLabel: 'Archive project...',
            confirmLabel: 'Confirm archive',
            confirmInProgressLabel: 'Archiving...',
          }}
        />,
      );
    });

    expect(document.body.textContent).toContain('Archive Workspace');
    const clickText = (text: string): void => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      act(() => button?.click());
    };
    clickText('Archive project...');
    await act(async () => {
      clickText('Confirm archive');
      await Promise.resolve();
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps settings open and shows an error after delete rejects', async () => {
    act(() => {
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Workspace"
          initialValues={{ name: 'Workspace', content: '', scripts: {} }}
          tabs={['danger']}
          onSave={() => Promise.resolve()}
          onDelete={jest.fn().mockRejectedValue(new Error('Delete denied'))}
          onClose={jest.fn()}
          testIds={{ dialog: 'settings', error: 'error' }}
        />,
      );
    });
    const clickText = (text: string): void => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      act(() => button?.click());
    };
    clickText('Delete project…');
    await act(async () => {
      clickText('Confirm delete');
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="settings"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe(
      'Delete denied',
    );
  });

  it('trims a label to null and renders disabled pipeline status', () => {
    const onSaveLabel = jest.fn();
    act(() => {
      root.render(
        <WorktreeInfoDialog
          mode="label"
          branch="main"
          worktreeId="wt-1"
          initialLabel="   "
          onSaveLabel={onSaveLabel}
          onClose={jest.fn()}
          testIds={{ save: 'label-save' }}
        />,
      );
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="label-save"]')
        ?.click();
    });
    expect(onSaveLabel).toHaveBeenCalledWith(null);

    act(() => {
      root.render(
        <PipelinePickerDialog
          entries={[
            {
              id: 'pipeline-1',
              name: 'Release',
              disabled: true,
              statusLabel: 'Running',
            },
          ]}
          onRun={jest.fn()}
          onClose={jest.fn()}
          testIds={{ entry: () => 'pipeline' }}
        />,
      );
    });
    const pipeline = document.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline"]',
    );
    expect(pipeline?.disabled).toBe(true);
    expect(pipeline?.textContent).toContain('Running');
  });
});
