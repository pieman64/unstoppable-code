/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrgProjectMoveErrorCode } from '@canopy/protocol/org-projects';
import {
  MoveProjectToOrganizationDialog,
  moveProjectToOrganizationErrorMessage,
  type MoveProjectToOrganizationDialogProps,
} from '../MoveProjectToOrganizationDialog';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const ACME = { id: 'org-acme', name: 'Acme' };
const GLOBEX = { id: 'org-globex', name: 'Globex' };

const ALL_CODES: readonly OrgProjectMoveErrorCode[] = [
  'unavailable',
  'workspace-not-found',
  'workspace-unreadable',
  'unsupported-workspace',
  'not-personal',
  'repository-outside-organization',
  'repository-unavailable',
  'limit-reached',
  'project-unavailable',
  'project-already-bound',
  'busy',
  'offline',
  'move-failed',
];

describe('MoveProjectToOrganizationDialog', () => {
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
    props: Partial<MoveProjectToOrganizationDialogProps> = {},
  ): void {
    act(() => {
      root.render(
        <MoveProjectToOrganizationDialog
          projectName="canopy"
          organizations={[ACME]}
          onMove={jest.fn()}
          onCancel={jest.fn()}
          {...props}
        />,
      );
    });
  }

  function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.body.querySelector<T>(`[data-testid="${id}"]`);
  }

  function select(): HTMLSelectElement {
    const element = byTestId<HTMLSelectElement>(
      'move-project-to-organization-select',
    );
    if (!element) throw new Error('select missing');
    return element;
  }

  function moveButton(): HTMLButtonElement {
    const element = byTestId<HTMLButtonElement>(
      'move-project-to-organization-move',
    );
    if (!element) throw new Error('move missing');
    return element;
  }

  function pick(id: string): void {
    act(() => {
      const element = select();
      element.value = id;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('preselects the only organization and shows the one-way warning', () => {
    const onMove = jest.fn();
    render({ onMove });
    expect(select().value).toBe(ACME.id);
    expect(
      byTestId('move-project-to-organization-dialog')?.textContent,
    ).toContain(
      'Once canopy moves to an organization, it stays there and cannot move back to your personal space.',
    );
    expect(moveButton().disabled).toBe(false);
    act(() => moveButton().click());
    expect(onMove).toHaveBeenCalledWith(ACME.id);
  });

  it('starts on the placeholder with several organizations and keeps Move disabled until a pick', () => {
    const onMove = jest.fn();
    render({ organizations: [ACME, GLOBEX], onMove });
    expect(select().value).toBe('');
    expect(select().textContent).toContain('Choose an organization');
    expect(moveButton().disabled).toBe(true);
    pick(GLOBEX.id);
    expect(moveButton().disabled).toBe(false);
    act(() => moveButton().click());
    expect(onMove).toHaveBeenCalledWith(GLOBEX.id);
  });

  it('disables every control while busy and blocks Escape', () => {
    const onCancel = jest.fn();
    render({ busy: true, onCancel });
    expect(moveButton().disabled).toBe(true);
    expect(moveButton().textContent).toBe('Moving…');
    expect(select().disabled).toBe(true);
    expect(
      byTestId<HTMLButtonElement>('move-project-to-organization-cancel')
        ?.disabled,
    ).toBe(true);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel from Cancel when idle', () => {
    const onCancel = jest.fn();
    render({ onCancel });
    act(() =>
      byTestId<HTMLButtonElement>(
        'move-project-to-organization-cancel',
      )?.click(),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the error only for the organization it was for', () => {
    render({
      organizations: [ACME, GLOBEX],
      error: { code: 'limit-reached', organizationId: ACME.id },
    });
    expect(byTestId('move-project-to-organization-error')).toBeNull();
    pick(ACME.id);
    const alert = byTestId('move-project-to-organization-error');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe(
      "Couldn't move canopy. You've reached Acme's limit for private projects.",
    );
    pick(GLOBEX.id);
    expect(byTestId('move-project-to-organization-error')).toBeNull();
  });

  it('resets the pick when the selected organization leaves the list', () => {
    render({ organizations: [ACME, GLOBEX] });
    pick(GLOBEX.id);
    render({ organizations: [ACME, { id: 'org-initech', name: 'Initech' }] });
    expect(select().value).toBe('');
    expect(moveButton().disabled).toBe(true);
    render({ organizations: [ACME] });
    expect(select().value).toBe(ACME.id);
  });

  it('clears the sole-organization pick when another organization appears', () => {
    render({ organizations: [ACME] });
    expect(select().value).toBe(ACME.id);
    render({ organizations: [ACME, GLOBEX] });
    expect(select().value).toBe('');
    expect(moveButton().disabled).toBe(true);
  });

  it('keeps an explicit pick when another organization appears', () => {
    render({ organizations: [ACME] });
    pick(ACME.id);
    render({ organizations: [ACME, GLOBEX] });
    expect(select().value).toBe(ACME.id);
    expect(moveButton().disabled).toBe(false);
  });

  it('has a sentence for every error code', () => {
    for (const code of ALL_CODES) {
      const message = moveProjectToOrganizationErrorMessage(
        code,
        'canopy',
        'Acme',
      );
      expect(message).toContain('canopy');
      expect(message).not.toContain('!');
    }
  });
});
