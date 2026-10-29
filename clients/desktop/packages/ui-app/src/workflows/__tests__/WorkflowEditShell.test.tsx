/** @jest-environment jsdom */
import { act, useEffect, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WorkflowEditShell,
  resolveWorkflowEditPlan,
  type WorkflowEditPlan,
  type WorkflowEditPlanInput,
  type WorkflowEditSection,
  type WorkflowEditShellProps,
} from '../edit-shell';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

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

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function getByTestId(id: string): HTMLElement {
  const element = byTestId(id);
  if (!element) throw new Error(`Missing [data-testid="${id}"]`);
  return element;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

function keyDown(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function planFor(
  overrides: Partial<WorkflowEditPlanInput> = {},
): WorkflowEditPlan {
  return resolveWorkflowEditPlan({
    kind: 'automation',
    readOnly: false,
    dirty: false,
    saving: false,
    draft: false,
    canSubmit: true,
    userOwned: true,
    capabilities: { pipelines: 'execute', automations: true },
    ...overrides,
  });
}

const handlers = {
  onSave: jest.fn(),
  onRun: jest.fn(),
  onShare: jest.fn(),
  onDuplicate: jest.fn(),
  onDelete: jest.fn<Promise<void>, []>(),
  onToggleEnabled: jest.fn(),
};

beforeEach(() => {
  for (const handler of Object.values(handlers)) handler.mockReset();
  handlers.onDelete.mockResolvedValue(undefined);
});

function shellProps(
  overrides: Partial<WorkflowEditShellProps> = {},
): WorkflowEditShellProps {
  return {
    kind: 'automation',
    name: 'Nightly triage',
    backLabel: 'Library',
    onBack: jest.fn(),
    plan: planFor(),
    section: 'definition',
    onSectionChange: jest.fn(),
    renderSection: (section) => <p>{section} body</p>,
    targetKey: 'automation:a1',
    enabled: true,
    ...handlers,
    ...overrides,
  };
}

/** Owns `section` so tab changes re-render the shell. */
function StatefulShell({
  initial = 'definition',
  targetKey = 'automation:a1',
  renderSection,
}: {
  readonly initial?: WorkflowEditSection;
  readonly targetKey?: string;
  readonly renderSection?: WorkflowEditShellProps['renderSection'];
}): JSX.Element {
  const [section, setSection] = useState<WorkflowEditSection>(initial);
  return (
    <WorkflowEditShell
      {...shellProps({
        section,
        onSectionChange: setSection,
        targetKey,
        ...(renderSection ? { renderSection } : {}),
      })}
    />
  );
}

/** Opens the More menu and returns its rows' test ids, in order. */
function openMenu(): string[] {
  click(getByTestId('workflow-edit-more'));
  const menu = getByTestId('workflow-edit-menu');
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    (element) => element.dataset.testid ?? '',
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function actionOrder(): string[] {
  return Array.from(
    getByTestId('workflow-edit-actions').querySelectorAll<HTMLElement>(
      '[data-testid]',
    ),
    (element) => element.dataset.testid ?? '',
  );
}

describe('WorkflowEditShell header', () => {
  it('renders Back, the name, the save state and the actions in order', () => {
    const onBack = jest.fn();
    render(
      <WorkflowEditShell
        {...shellProps({
          kind: 'pipeline',
          onBack,
          plan: planFor({ kind: 'pipeline', userOwned: false, dirty: true }),
        })}
      />,
    );

    const shell = getByTestId('workflow-edit-shell');
    expect(shell.getAttribute('aria-label')).toBe('Nightly triage');
    expect(shell.dataset.kind).toBe('pipeline');
    expect(shell.dataset.readonly).toBe('false');
    expect(shell.dataset.dirty).toBe('true');
    expect(getByTestId('workflow-edit-name').tagName).toBe('H1');
    expect(getByTestId('workflow-edit-name').textContent).toBe(
      'Nightly triage',
    );
    expect(getByTestId('workflow-edit-save-state').textContent).toBe(
      'Unsaved changes',
    );
    // Run, Share and Save stay buttons; the rest wait in the More menu,
    // which leads the bar.
    expect(actionOrder()).toEqual([
      'workflow-edit-more',
      'workflow-edit-run',
      'workflow-edit-share',
      'workflow-edit-save',
    ]);
    expect(openMenu()).toEqual([
      'workflow-edit-toggle',
      'workflow-edit-duplicate',
      'workflow-edit-delete',
    ]);
    // Every row leads with an icon, and Delete sits alone in the last group.
    const menu = getByTestId('workflow-edit-menu');
    for (const row of Array.from(menu.querySelectorAll('[role="menuitem"]'))) {
      expect(row.querySelector('svg')).not.toBeNull();
    }
    const separators = menu.querySelectorAll('[role="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.nextElementSibling).toBe(
      getByTestId('workflow-edit-delete'),
    );

    click(getByTestId('workflow-edit-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(getByTestId('workflow-edit-back').textContent).toBe('Library');
  });

  it('keeps an adapter’s test ids and labels', () => {
    render(
      <WorkflowEditShell
        {...shellProps({
          plan: planFor({ dirty: true }),
          actionTestIds: {
            save: 'automations-form-submit',
            toggle: 'automations-form-enabled',
            delete: 'automation-details-delete',
            back: 'pipeline-editor-back',
            name: 'automation-name',
          },
          actionLabels: { save: 'Save changes', run: 'Run now' },
        })}
      />,
    );

    expect(getByTestId('automations-form-submit').textContent).toBe(
      'Save changes',
    );
    expect(getByTestId('workflow-edit-run').textContent).toBe('Run now');
    expect(openMenu()).toEqual([
      'automations-form-enabled',
      'automation-details-delete',
    ]);
    click(getByTestId('automation-details-delete'));
    expect(byTestId('automation-details-delete-confirm')).not.toBeNull();
    expect(byTestId('pipeline-editor-back')).not.toBeNull();
    expect(byTestId('automation-name')).not.toBeNull();
    expect(byTestId('workflow-edit-save')).toBeNull();
  });

  it('shows Duplicate as the primary action and no Save on a read-only item', () => {
    render(
      <WorkflowEditShell
        {...shellProps({ plan: planFor({ readOnly: true }) })}
      />,
    );

    expect(actionOrder()).toEqual(['workflow-edit-duplicate']);
    expect(getByTestId('workflow-edit-shell').dataset.readonly).toBe('true');
    expect(getByTestId('workflow-edit-save-state').textContent).toBe(
      'Read-only',
    );
    click(getByTestId('workflow-edit-duplicate'));
    expect(handlers.onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('omits the save state on a saved item and disables a clean Save', () => {
    render(<WorkflowEditShell {...shellProps()} />);

    expect(byTestId('workflow-edit-save-state')).toBeNull();
    const save = getByTestId('workflow-edit-save');
    expect(save).toHaveProperty('disabled', true);
    click(save);
    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it('explains a dirty-gated action and does not run it', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ dirty: true }) })} />,
    );

    const run = getByTestId('workflow-edit-run');
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(run.getAttribute('aria-description')).toBe(
      'Save to run the latest changes',
    );
    click(run);
    expect(handlers.onRun).not.toHaveBeenCalled();
    expect(
      getByTestId('workflow-edit-share').getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('runs a clean saved item and turns it off from the menu', () => {
    render(<WorkflowEditShell {...shellProps()} />);

    click(getByTestId('workflow-edit-run'));
    expect(handlers.onRun).toHaveBeenCalledTimes(1);
    openMenu();
    const toggle = getByTestId('workflow-edit-toggle');
    expect(toggle.textContent).toBe('Turn off');
    click(toggle);
    expect(handlers.onToggleEnabled).toHaveBeenCalledWith(false);
    expect(byTestId('workflow-edit-menu')).toBeNull();
  });

  it('shows Off beside the name and offers Turn on when turned off', () => {
    render(
      <WorkflowEditShell
        {...shellProps({ enabled: false, plan: planFor({ dirty: true }) })}
      />,
    );

    expect(getByTestId('workflow-edit-enabled-state').textContent).toBe('Off');
    expect(getByTestId('workflow-edit-save-state').textContent).toBe(
      'Unsaved changes',
    );
    openMenu();
    expect(getByTestId('workflow-edit-toggle').textContent).toBe('Turn on');
    click(getByTestId('workflow-edit-toggle'));
    expect(handlers.onToggleEnabled).toHaveBeenCalledWith(true);
  });

  it('shows no Off state when the item is on or cannot be turned off', () => {
    render(<WorkflowEditShell {...shellProps()} />);
    expect(byTestId('workflow-edit-enabled-state')).toBeNull();

    // A host that cannot toggle reports no state, whatever `enabled` says.
    render(
      <WorkflowEditShell
        {...shellProps({ enabled: false, onToggleEnabled: undefined })}
      />,
    );
    expect(byTestId('workflow-edit-enabled-state')).toBeNull();

    render(
      <WorkflowEditShell
        {...shellProps({ enabled: false, plan: planFor({ draft: true }) })}
      />,
    );
    expect(byTestId('workflow-edit-enabled-state')).toBeNull();
  });

  it('explains a disabled menu row beneath it and does not run it', () => {
    render(
      <WorkflowEditShell
        {...shellProps({
          kind: 'pipeline',
          plan: planFor({ kind: 'pipeline', userOwned: false, dirty: true }),
        })}
      />,
    );

    openMenu();
    const duplicate = getByTestId('workflow-edit-duplicate');
    expect(duplicate).toHaveProperty('disabled', true);
    const reasonId = duplicate.getAttribute('aria-describedby');
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? '')?.textContent).toBe(
      'Save to duplicate the latest changes',
    );
    click(duplicate);
    expect(handlers.onDuplicate).not.toHaveBeenCalled();
  });

  it('keeps Run and Share in place, disabled, on a draft', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ draft: true }) })} />,
    );

    expect(actionOrder()).toEqual([
      'workflow-edit-run',
      'workflow-edit-share',
      'workflow-edit-save',
    ]);
    expect(
      getByTestId('workflow-edit-run').getAttribute('aria-description'),
    ).toBe('Save it first to run it');
    expect(byTestId('workflow-edit-more')).toBeNull();
  });

  it('hides Run without the capability', () => {
    render(
      <WorkflowEditShell
        {...shellProps({
          plan: planFor({
            capabilities: { pipelines: 'read-only', automations: false },
          }),
        })}
      />,
    );

    expect(byTestId('workflow-edit-run')).toBeNull();
  });

  it('renders only actions it has a handler for', () => {
    render(
      <WorkflowEditShell
        {...shellProps({
          onRun: undefined,
          onShare: undefined,
          onDelete: undefined,
        })}
      />,
    );

    expect(actionOrder()).toEqual(['workflow-edit-more', 'workflow-edit-save']);
    expect(openMenu()).toEqual(['workflow-edit-toggle']);
  });

  it('puts a host assistant in the bar as a labelled toggle', () => {
    const onToggle = jest.fn();
    render(
      <WorkflowEditShell
        {...shellProps({ assistant: { open: false, onToggle } })}
      />,
    );

    expect(actionOrder()).toEqual([
      'workflow-edit-more',
      'workflow-edit-assistant',
      'workflow-edit-run',
      'workflow-edit-share',
      'workflow-edit-save',
    ]);
    const toggle = getByTestId('workflow-edit-assistant');
    expect(toggle.textContent).toBe('Assistant');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    render(
      <WorkflowEditShell
        {...shellProps({ assistant: { open: true, onToggle } })}
      />,
    );
    expect(
      getByTestId('workflow-edit-assistant').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('renders no menu when nothing would be in it', () => {
    render(
      <WorkflowEditShell
        {...shellProps({ onToggleEnabled: undefined, onDelete: undefined })}
      />,
    );

    expect(actionOrder()).toEqual([
      'workflow-edit-run',
      'workflow-edit-share',
      'workflow-edit-save',
    ]);
  });

  it('marks a busy action', () => {
    render(
      <WorkflowEditShell
        {...shellProps({
          plan: planFor({ dirty: true, saving: true }),
          busyActions: { save: true },
        })}
      />,
    );

    const save = getByTestId('workflow-edit-save');
    expect(save.getAttribute('aria-busy')).toBe('true');
    expect(save).toHaveProperty('disabled', true);
    expect(getByTestId('workflow-edit-save-state').textContent).toBe('Saving…');
  });

  it('renders an inline rename control in the heading', () => {
    render(
      <WorkflowEditShell
        {...shellProps({ nameEditor: <input data-testid="rename" /> })}
      />,
    );

    expect(
      getByTestId('workflow-edit-name').querySelector('[data-testid="rename"]'),
    ).not.toBeNull();
  });
});

describe('WorkflowEditShell delete', () => {
  it('confirms before deleting and closes once the delete resolves', async () => {
    render(<WorkflowEditShell {...shellProps()} />);

    openMenu();
    click(getByTestId('workflow-edit-delete'));
    const dialog = getByTestId('workflow-edit-delete-dialog');
    expect(dialog.textContent).toContain('Delete "Nightly triage"?');
    expect(handlers.onDelete).not.toHaveBeenCalled();

    click(getByTestId('workflow-edit-delete-confirm'));
    await flush();
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(byTestId('workflow-edit-delete-dialog')).toBeNull();
  });

  it('keeps the confirmation open with the error when the delete fails', async () => {
    handlers.onDelete.mockRejectedValue(
      new Error('The automation is running.'),
    );
    render(<WorkflowEditShell {...shellProps()} />);

    openMenu();
    click(getByTestId('workflow-edit-delete'));
    click(getByTestId('workflow-edit-delete-confirm'));
    await flush();

    expect(getByTestId('confirm-dialog-error').textContent).toBe(
      'The automation is running.',
    );
    expect(getByTestId('workflow-edit-delete-confirm')).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('cancels without deleting', () => {
    render(<WorkflowEditShell {...shellProps()} />);

    openMenu();
    click(getByTestId('workflow-edit-delete'));
    const cancel = Array.from(
      getByTestId('workflow-edit-delete-dialog').querySelectorAll('button'),
    ).find((button) => button.textContent === 'Cancel');
    if (!cancel) throw new Error('Missing Cancel');
    click(cancel);

    expect(byTestId('workflow-edit-delete-dialog')).toBeNull();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it('shows a host that throws instead of rejecting as a failure', async () => {
    handlers.onDelete.mockImplementation(() => {
      throw new Error('Not allowed.');
    });
    render(<WorkflowEditShell {...shellProps()} />);

    openMenu();
    click(getByTestId('workflow-edit-delete'));
    click(getByTestId('workflow-edit-delete-confirm'));
    await flush();

    expect(getByTestId('confirm-dialog-error').textContent).toBe(
      'Not allowed.',
    );
  });

  it('masks the item name in the confirmation title for session replay', () => {
    render(<WorkflowEditShell {...shellProps()} />);

    openMenu();
    click(getByTestId('workflow-edit-delete'));
    const masked = getByTestId('workflow-edit-delete-dialog').querySelector(
      `.${REPLAY_MASK_CLASS}`,
    );
    expect(masked?.textContent).toBe('Nightly triage');
  });

  it('settles quietly when the shell has already left the item', async () => {
    let finish: () => void = () => undefined;
    handlers.onDelete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<WorkflowEditShell {...shellProps()} />);
    openMenu();
    click(getByTestId('workflow-edit-delete'));
    click(getByTestId('workflow-edit-delete-confirm'));

    render(<></>);
    finish();
    await flush();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('drops an open confirmation when the target changes', () => {
    render(<WorkflowEditShell {...shellProps()} />);
    openMenu();
    click(getByTestId('workflow-edit-delete'));

    render(
      <WorkflowEditShell {...shellProps({ targetKey: 'automation:a2' })} />,
    );
    expect(byTestId('workflow-edit-delete-dialog')).toBeNull();
  });
});

describe('WorkflowEditShell sections', () => {
  it('renders the tabs with roving focus', () => {
    render(<StatefulShell />);

    const tablist = document.body.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute('aria-label')).toBe('Nightly triage sections');
    const definition = getByTestId('workflow-edit-tab-definition');
    const trigger = getByTestId('workflow-edit-tab-trigger');
    expect(definition.getAttribute('aria-selected')).toBe('true');
    expect(definition.tabIndex).toBe(0);
    expect(trigger.tabIndex).toBe(-1);
    const panel = document.body.querySelector('[role="tabpanel"]');
    expect(definition.getAttribute('aria-controls')).toBe(panel?.id);
    expect(panel?.getAttribute('aria-labelledby')).toBe(definition.id);
  });

  it('moves between tabs with the arrow keys, Home and End', () => {
    render(<StatefulShell />);

    keyDown(getByTestId('workflow-edit-tab-definition'), 'ArrowRight');
    expect(
      getByTestId('workflow-edit-tab-trigger').getAttribute('aria-selected'),
    ).toBe('true');
    expect(document.activeElement).toBe(
      getByTestId('workflow-edit-tab-trigger'),
    );

    keyDown(getByTestId('workflow-edit-tab-trigger'), 'End');
    expect(document.activeElement).toBe(getByTestId('workflow-edit-tab-runs'));

    keyDown(getByTestId('workflow-edit-tab-runs'), 'ArrowRight');
    expect(document.activeElement).toBe(
      getByTestId('workflow-edit-tab-definition'),
    );

    keyDown(getByTestId('workflow-edit-tab-definition'), 'ArrowLeft');
    expect(document.activeElement).toBe(getByTestId('workflow-edit-tab-runs'));

    keyDown(getByTestId('workflow-edit-tab-runs'), 'Home');
    expect(
      getByTestId('workflow-edit-tab-definition').getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('keeps visited sections mounted and hidden', () => {
    const mounts: string[] = [];
    function Body({ id }: { readonly id: string }): JSX.Element {
      useEffect(() => {
        mounts.push(id);
      }, [id]);
      return <p>{id} body</p>;
    }
    render(<StatefulShell renderSection={(id) => <Body id={id} />} />);

    expect(byTestId('workflow-edit-section-trigger')).toBeNull();
    click(getByTestId('workflow-edit-tab-trigger'));
    expect(getByTestId('workflow-edit-section-definition').hidden).toBe(true);
    expect(getByTestId('workflow-edit-section-trigger').hidden).toBe(false);
    expect(byTestId('workflow-edit-section-runs')).toBeNull();

    click(getByTestId('workflow-edit-tab-definition'));
    expect(getByTestId('workflow-edit-section-definition').hidden).toBe(false);
    expect(getByTestId('workflow-edit-section-trigger').hidden).toBe(true);
    expect(mounts).toEqual(['definition', 'trigger']);
  });

  it('forgets visited sections when the target changes', () => {
    render(<StatefulShell targetKey="a" />);
    click(getByTestId('workflow-edit-tab-runs'));
    expect(byTestId('workflow-edit-section-definition')).not.toBeNull();

    render(<StatefulShell targetKey="b" />);
    expect(byTestId('workflow-edit-section-definition')).toBeNull();
    expect(getByTestId('workflow-edit-section-runs').hidden).toBe(false);
  });
});

describe('WorkflowEditShell focus', () => {
  it('focuses the heading on open and on a new target, not on a section change', () => {
    render(<WorkflowEditShell {...shellProps()} />);
    const heading = getByTestId('workflow-edit-name');
    expect(document.activeElement).toBe(heading);

    getByTestId('workflow-edit-tab-definition').focus();
    render(<WorkflowEditShell {...shellProps({ section: 'trigger' })} />);
    expect(document.activeElement).toBe(
      getByTestId('workflow-edit-tab-definition'),
    );

    render(
      <WorkflowEditShell
        {...shellProps({ section: 'trigger', targetKey: 'automation:a2' })}
      />,
    );
    expect(document.activeElement).toBe(getByTestId('workflow-edit-name'));
  });
});

describe('WorkflowEditShell ⌘S', () => {
  it('saves when Save is enabled', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ dirty: true }) })} />,
    );

    const event = keyDown(window, 's', { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);

    keyDown(window, 's', { ctrlKey: true });
    expect(handlers.onSave).toHaveBeenCalledTimes(2);
  });

  it('does not save a clean item, while saving, or a read-only item', () => {
    render(<WorkflowEditShell {...shellProps()} />);
    keyDown(window, 's', { metaKey: true });

    render(
      <WorkflowEditShell
        {...shellProps({ plan: planFor({ dirty: true, saving: true }) })}
      />,
    );
    keyDown(window, 's', { metaKey: true });

    render(
      <WorkflowEditShell
        {...shellProps({ plan: planFor({ readOnly: true }) })}
      />,
    );
    const event = keyDown(window, 's', { metaKey: true });
    expect(event.defaultPrevented).toBe(false);

    expect(handlers.onSave).not.toHaveBeenCalled();
  });

  it('leaves ⌘S to an overlay that already handled it', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ dirty: true }) })} />,
    );
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    overlay.addEventListener('keydown', (event) => event.preventDefault());

    keyDown(overlay, 's', { metaKey: true });

    expect(handlers.onSave).not.toHaveBeenCalled();
    overlay.remove();
  });

  it('leaves ⌘S to a modal dialog that has focus, but not to a picker', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ dirty: true }) })} />,
    );
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const field = document.createElement('input');
    dialog.appendChild(field);
    document.body.appendChild(dialog);

    const event = keyDown(field, 's', { metaKey: true });

    expect(handlers.onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    // A picker popover is a non-modal dialog inside the form: ⌘S still saves.
    dialog.removeAttribute('aria-modal');
    keyDown(field, 's', { metaKey: true });
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    dialog.remove();
  });

  it('saves once while ⌘S is held', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ dirty: true }) })} />,
    );
    keyDown(window, 's', { metaKey: true });
    keyDown(window, 's', { metaKey: true, repeat: true });
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  it('ignores S without the modifier and stops listening on unmount', () => {
    render(
      <WorkflowEditShell {...shellProps({ plan: planFor({ dirty: true }) })} />,
    );
    keyDown(window, 's');
    expect(handlers.onSave).not.toHaveBeenCalled();

    render(<></>);
    keyDown(window, 's', { metaKey: true });
    expect(handlers.onSave).not.toHaveBeenCalled();
  });
});

describe('WorkflowEditShell unsaved prompt', () => {
  it('renders the unsaved-changes dialog with the name', () => {
    const prompt = {
      saving: false,
      onSave: jest.fn(),
      onDiscard: jest.fn(),
      onKeepEditing: jest.fn(),
    };
    render(<WorkflowEditShell {...shellProps({ unsavedPrompt: null })} />);
    expect(byTestId('workflows-unsaved-dialog')).toBeNull();

    render(<WorkflowEditShell {...shellProps({ unsavedPrompt: prompt })} />);
    expect(getByTestId('workflows-unsaved-dialog').textContent).toContain(
      'Save changes to "Nightly triage"?',
    );
    click(getByTestId('workflows-unsaved-discard'));
    expect(prompt.onDiscard).toHaveBeenCalledTimes(1);
    click(getByTestId('workflows-unsaved-save'));
    expect(prompt.onSave).toHaveBeenCalledTimes(1);
  });
});
