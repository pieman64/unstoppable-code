/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  WORKSPACE_COLOR_PALETTE,
  WORKSPACE_SETTINGS_DIALOG_MIN_HEIGHT,
  WorkspaceSettingsDialog,
} from '../WorkspaceSettingsDialog';
import { DEFAULT_ARCHIVE_RETENTION_DAYS } from '@canopy/protocol/archive-retention';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
it('saves retention days and shows both remove actions at the end of General', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn(() => Promise.resolve());
  act(() =>
    root.render(
      <WorkspaceSettingsDialog
        workspaceName="Project"
        initialValues={{
          name: 'Project',
          content: '',
          scripts: {},
          deletionRetentionDays: 7,
        }}
        onSave={onSave}
        onClose={() => undefined}
        onDelete={() => Promise.resolve()}
        secondaryDanger={{
          copy: {
            title: 'Delete workspace',
            triggerLabel: 'Delete workspace…',
          },
          onConfirm: () => Promise.resolve(),
        }}
      />,
    ),
  );
  const input = document.querySelector('input[type="number"]');
  if (!(input instanceof HTMLInputElement))
    throw new Error('Missing retention');
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const click = (label: string): void => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    act(() => button.click());
  };
  click('Save');
  await act(async () => {
    await Promise.resolve();
  });
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ deletionRetentionDays: 30 }),
  );
  // Removing is the last rows of General, not a Danger tab or a titled
  // Manage card.
  expect(
    Array.from(document.querySelectorAll('[role="tab"]')).map(
      (tab) => tab.textContent,
    ),
  ).toEqual(['General', 'CLAUDE.md', 'Scripts']);
  expect(document.body.textContent).not.toContain('Manage');
  const rows = document.querySelector('[role="tabpanel"] [data-surface]');
  const lastRows = Array.from(rows?.children ?? [])
    .slice(-2)
    .map((row) => row.textContent);
  expect(lastRows[0]).toContain('Delete project');
  expect(lastRows[1]).toContain('Delete workspace…');
  act(() => root.unmount());
  container.remove();
});

it('keeps cleared retention out of helper copy and extra tabs without allowing save', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn(() => Promise.resolve());
  try {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Project"
          initialValues={{
            name: 'Project',
            content: '',
            scripts: {},
            deletionRetentionDays: 30,
          }}
          onSave={onSave}
          onClose={() => undefined}
          extraTabs={[
            {
              id: 'preview',
              label: 'Preview',
              content: (values): JSX.Element => (
                <span data-testid="retention-preview">
                  {values.deletionRetentionDays}
                </span>
              ),
            },
          ]}
        />,
      ),
    );
    const input = document.querySelector('input[type="number"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Missing retention');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain('NaN');
    const click = (label: string): void => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === label,
      );
      if (!button) throw new Error(`Missing ${label}`);
      act(() => button.click());
    };
    click('Save');
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter a whole number');
    click('Preview');
    expect(
      document.querySelector('[data-testid="retention-preview"]')?.textContent,
    ).toBe(String(DEFAULT_ARCHIVE_RETENTION_DAYS));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('saves a trimmed rename and the picked palette color from Details', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn(() => Promise.resolve());
  try {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Project"
          initialValues={{
            name: 'Project',
            color: WORKSPACE_COLOR_PALETTE[0],
            content: '',
            scripts: {},
          }}
          onSave={onSave}
          onClose={() => undefined}
          testIds={{
            nameInput: 'name-input',
            colorSwatches: 'color-swatches',
            save: 'save',
            saved: 'saved',
          }}
        />,
      ),
    );

    const nameInput = document.querySelector('[data-testid="name-input"]');
    if (!(nameInput instanceof HTMLInputElement))
      throw new Error('Missing name input');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, '  Renamed  ');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const swatches = document.querySelector('[data-testid="color-swatches"]');
    if (!swatches) throw new Error('Missing color swatches');
    expect(swatches.querySelectorAll('button')).toHaveLength(
      WORKSPACE_COLOR_PALETTE.length,
    );
    const picked = WORKSPACE_COLOR_PALETTE[1];
    const swatch = swatches.querySelector(`[aria-label="Color ${picked}"]`);
    if (!(swatch instanceof HTMLButtonElement))
      throw new Error('Missing swatch');
    act(() => swatch.click());
    // Selection is visible before saving, so the picker reads as a choice.
    expect(swatch.getAttribute('aria-pressed')).toBe('true');
    expect(
      swatches
        .querySelector(`[aria-label="Color ${WORKSPACE_COLOR_PALETTE[0]}"]`)
        ?.getAttribute('aria-pressed'),
    ).toBe('false');

    const save = document.querySelector('[data-testid="save"]');
    if (!(save instanceof HTMLButtonElement)) throw new Error('Missing save');
    act(() => save.click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Renamed', color: picked }),
    );
    // Saving confirms in place rather than dismissing the dialog.
    expect(
      document.querySelector('[data-testid="saved"]')?.textContent,
    ).toContain('Saved');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('adopts refreshed pristine metadata without overwriting dirty edits', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn(() => Promise.resolve());
  const render = (name: string, color: string): void => {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName={name}
          initialValues={{ name, color, content: '', scripts: {} }}
          onSave={onSave}
          onClose={() => undefined}
          testIds={{
            nameInput: 'name-input',
            colorSwatches: 'color-swatches',
          }}
        />,
      ),
    );
  };

  try {
    render('Project', WORKSPACE_COLOR_PALETTE[0]);
    render('Remote rename', WORKSPACE_COLOR_PALETTE[1]);

    const nameInput = document.querySelector('[data-testid="name-input"]');
    if (!(nameInput instanceof HTMLInputElement))
      throw new Error('Missing name input');
    expect(nameInput.value).toBe('Remote rename');
    expect(
      document
        .querySelector(
          `[data-testid="color-swatches"] [aria-label="Color ${WORKSPACE_COLOR_PALETTE[1]}"]`,
        )
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, 'Local draft');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const localColor = document.querySelector(
      `[data-testid="color-swatches"] [aria-label="Color ${WORKSPACE_COLOR_PALETTE[2]}"]`,
    );
    if (!(localColor instanceof HTMLButtonElement))
      throw new Error('Missing local color swatch');
    act(() => localColor.click());

    render('New remote rename', WORKSPACE_COLOR_PALETTE[3]);
    expect(nameInput.value).toBe('Local draft');
    expect(localColor.getAttribute('aria-pressed')).toBe('true');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('preserves edits back to the old metadata while Save is in flight', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const onSaveImpl = async (): Promise<void> => {
    await saveGate;
    render('Renamed', WORKSPACE_COLOR_PALETTE[1]);
  };
  const onSave = jest.fn(onSaveImpl);
  const render = (name: string, color: string): void => {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName={name}
          initialValues={{ name, color, content: '', scripts: {} }}
          onSave={onSave}
          onClose={() => undefined}
          testIds={{
            nameInput: 'name-input',
            colorSwatches: 'color-swatches',
            save: 'save',
          }}
        />,
      ),
    );
  };

  try {
    render('Project', WORKSPACE_COLOR_PALETTE[0]);
    const nameInput = document.querySelector('[data-testid="name-input"]');
    const save = document.querySelector('[data-testid="save"]');
    if (!(nameInput instanceof HTMLInputElement))
      throw new Error('Missing name input');
    if (!(save instanceof HTMLButtonElement)) throw new Error('Missing save');
    const rename = (name: string): void => {
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(nameInput, name);
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const pickColor = (color: string): HTMLButtonElement => {
      const swatch = document.querySelector(
        `[data-testid="color-swatches"] [aria-label="Color ${color}"]`,
      );
      if (!(swatch instanceof HTMLButtonElement))
        throw new Error(`Missing ${color} swatch`);
      act(() => swatch.click());
      return swatch;
    };

    rename('Renamed');
    pickColor(WORKSPACE_COLOR_PALETTE[1]);
    act(() => save.click());

    // These are newer edits even though they equal the baseline captured when
    // Save began. The optimistic props from that save must not overwrite them.
    rename('Project');
    const originalColor = pickColor(WORKSPACE_COLOR_PALETTE[0]);
    await act(async () => {
      releaseSave();
      await saveGate;
    });

    expect(nameInput.value).toBe('Project');
    expect(originalColor.getAttribute('aria-pressed')).toBe('true');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('blocks saving a workspace renamed to blank', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn(() => Promise.resolve());
  try {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Project"
          initialValues={{ name: 'Project', content: '', scripts: {} }}
          onSave={onSave}
          onClose={() => undefined}
          testIds={{ nameInput: 'name-input', save: 'save' }}
        />,
      ),
    );
    const nameInput = document.querySelector('[data-testid="name-input"]');
    if (!(nameInput instanceof HTMLInputElement))
      throw new Error('Missing name input');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, '   ');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = document.querySelector('[data-testid="save"]');
    if (!(save instanceof HTMLButtonElement)) throw new Error('Missing save');
    expect(save.disabled).toBe(true);
    act(() => save.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSave).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('retains a saved unavailable model until the user clears it', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn(() => Promise.resolve());
  try {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Project"
          initialValues={{
            name: 'Project',
            content: '',
            scripts: {},
            defaultModelDefinitionId: 'removed-model',
          }}
          modelOptions={[
            { id: 'model-a', label: 'Model A' },
            { id: 'locked', label: 'Locked model', disabled: true },
          ]}
          onSave={onSave}
          onClose={() => undefined}
        />,
      ),
    );
    const select = document.querySelector(
      '[role="combobox"][aria-label="Default model"]',
    );
    if (!(select instanceof HTMLButtonElement))
      throw new Error('Missing model picker');
    expect(select.textContent).toBe('Saved model unavailable');
    act(() => select.click());
    const clear = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((option) => option.textContent === 'Use account default');
    if (!clear) throw new Error('Missing account default option');
    act(() => clear.click());
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!save) throw new Error('Missing Save');
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModelDefinitionId: null }),
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('never asks for more height than the dialog may take on a short screen', () => {
  // DialogModal caps its card at min(80vh, 85dvh); the minimum stays under it.
  expect(WORKSPACE_SETTINGS_DIALOG_MIN_HEIGHT).toBe('min(30rem, 80vh, 85dvh)');
});

it('shows the pages as tabs above plain rows, with one Save and no Done', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Project"
          initialValues={{ name: 'Project', content: '', scripts: {} }}
          onSave={() => Promise.resolve()}
          onClose={() => undefined}
          onDelete={() => Promise.resolve()}
          testIds={{ save: 'save' }}
        />,
      ),
    );
    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist).toBeInstanceOf(HTMLElement);
    expect(tablist?.getAttribute('aria-orientation')).not.toBe('vertical');
    // No page title or subtitle over the rows: the tab names the page.
    const panel = document.querySelector('[role="tabpanel"]');
    expect(panel?.querySelector('h2, h3')).toBeNull();
    expect(document.body.textContent).not.toContain('Name, color and');
    // Rows sit on the dialog, separated by hairlines, not in a box.
    const rows = panel?.querySelector('[data-surface]');
    expect(rows?.getAttribute('data-surface')).toBe('plain');
    expect(rows?.className).not.toContain('bg-secondary');
    const buttons = Array.from(document.querySelectorAll('button')).map(
      (button) => button.textContent,
    );
    expect(buttons).not.toContain('Done');
    expect(buttons.filter((label) => label === 'Save')).toHaveLength(1);
    expect(document.querySelector('[data-testid="save"]')?.className).toContain(
      'bg-accent',
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('deletes from a quiet last row that confirms in place', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onDelete = jest.fn(() => Promise.resolve());
  const onClose = jest.fn();
  try {
    act(() =>
      root.render(
        <WorkspaceSettingsDialog
          workspaceName="Project"
          initialValues={{ name: 'Project', content: '', scripts: {} }}
          onSave={() => Promise.resolve()}
          onClose={onClose}
          onDelete={onDelete}
          testIds={{ danger: 'danger' }}
        />,
      ),
    );
    const row = document.querySelector('[data-testid="danger"]');
    const trigger = row?.querySelector('button');
    if (!(trigger instanceof HTMLButtonElement))
      throw new Error('Missing delete trigger');
    expect(trigger.textContent).toBe('Delete…');
    // A danger text button, not a filled or outlined one.
    expect(trigger.className).toContain('fg-destructive');
    expect(trigger.className).toContain('bg-transparent');
    act(() => trigger.click());
    expect(row?.textContent).toContain("This can't be undone.");
    const confirm = Array.from(row?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Delete',
    );
    if (!(confirm instanceof HTMLButtonElement))
      throw new Error('Missing confirm');
    await act(async () => {
      confirm.click();
      await Promise.resolve();
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('scrolls the tabs sideways and wraps controls on a phone-width screen', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <WorkspaceSettingsDialog
        workspaceName="Project"
        initialValues={{ name: 'Project', content: '', scripts: {} }}
        onSave={() => Promise.resolve()}
        onClose={() => undefined}
      />,
    ),
  );
  const pages = document.querySelector<HTMLElement>(
    '[data-testid="workspace-settings-pages"]',
  );
  expect(pages?.className).toContain('overflow-x-auto');
  // The page can shrink, so its body scrolls and Save stays visible.
  expect(pages?.nextElementSibling?.className).toContain('min-h-0');
  const nameLabel = Array.from(document.querySelectorAll('label')).find(
    (label) => label.textContent === 'Name',
  );
  expect(nameLabel?.closest('.max-sm\\:flex-wrap')).not.toBeNull();
  act(() => root.unmount());
  container.remove();
});
