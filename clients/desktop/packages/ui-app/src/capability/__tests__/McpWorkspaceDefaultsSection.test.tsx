/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  chooseSettingsOptionSync,
  settingsSelectOptionLabels,
  settingsSelectTrigger,
} from '../../settings/__tests__/helpers/settings-select';
import {
  McpWorkspaceDefaultsSection,
  type McpWorkspaceDefaultsChoice,
} from '../McpWorkspaceDefaultsSection';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('McpWorkspaceDefaultsSection', () => {
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

  function render(
    workspaces: McpWorkspaceDefaultsChoice[],
    loading = false,
  ): void {
    act(() =>
      root.render(
        <McpWorkspaceDefaultsSection
          workspaces={workspaces}
          loading={loading}
          onAdd={(): Promise<void> => Promise.resolve()}
          onRemove={(): Promise<void> => Promise.resolve()}
          testId="projects"
        />,
      ),
    );
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('waits for the projects before saying where the server is', () => {
    render([{ id: 'acme', name: 'Acme', enabled: undefined }], true);
    expect(byTestId('projects-status')?.textContent).toBe('Checking projects…');
    const add = byTestId('projects-add');
    expect(add instanceof HTMLButtonElement && add.disabled).toBe(true);
  });

  it('claims no project only once every project was read', () => {
    render([
      { id: 'acme', name: 'Acme', enabled: false },
      { id: 'beta', name: 'Beta', enabled: undefined },
    ]);
    expect(byTestId('projects-status')?.textContent).toBe('');
    const add = byTestId('projects-add');
    expect(add?.textContent).toBe('Add to Acme');
    expect(add instanceof HTMLButtonElement && add.disabled).toBe(false);
  });

  it('lists the projects and says where the server is enabled', () => {
    render([
      { id: 'acme', name: 'Acme', enabled: true },
      { id: 'beta', name: 'Beta', enabled: false },
    ]);
    expect(
      settingsSelectOptionLabels(
        settingsSelectTrigger(container, '[data-testid="projects-select"]'),
      ),
    ).toEqual(['Acme', 'Beta']);
    const status = byTestId('projects-status')?.querySelector('span');
    expect(status?.textContent).toBe('Enabled in Acme.');
  });

  it('masks project names in session replay text', () => {
    render([
      { id: 'acme', name: 'Acme', enabled: true },
      { id: 'beta', name: 'Beta', enabled: false },
    ]);
    const masked = (node: Element | null | undefined): boolean =>
      node?.closest(`.${REPLAY_MASK_CLASS}`) !== null && node !== undefined;
    const select = settingsSelectTrigger(
      container,
      '[data-testid="projects-select"]',
    );
    // The chosen project name on the trigger.
    const chosen = Array.from(select.querySelectorAll('span')).find(
      (span) => span.childElementCount === 0 && span.textContent === 'Acme',
    );
    expect(masked(chosen)).toBe(true);
    const status = byTestId('projects-status')?.querySelector('span');
    expect(masked(status)).toBe(true);
    chooseSettingsOptionSync(select, 'beta');
    const add = byTestId('projects-add');
    expect(add?.textContent).toBe('Add to Beta');
    // The action word stays readable; only the project name is masked.
    expect(masked(add)).toBe(false);
    const name = add?.querySelector(`.${REPLAY_MASK_CLASS}`);
    expect(name?.textContent).toBe('Beta');
  });

  it('renders nothing without a project to name', () => {
    render([]);
    expect(byTestId('projects')).toBeNull();
  });
});
