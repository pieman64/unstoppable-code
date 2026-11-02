/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  SidebarContextMenuItems,
  SidebarContextRow,
  buildOrganizationOptions,
  type SidebarContextOrgScopedActions,
  type SidebarContextRowProps,
} from '../SidebarContextRow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACME = '11111111-1111-4111-8111-111111111111';
const ACME_TWIN = '22222222-2222-4222-8222-222222222222';
const ZEN = '33333333-3333-4333-8333-333333333333';

// No personal organization and no host callbacks: Personal offers only
// Create an organization.
const NO_ORG_ACTIONS: SidebarContextOrgScopedActions = {
  personalOrganizationId: null,
  freeAccess: false,
  onOpenPath: jest.fn(),
};

const ORGANIZATIONS = [
  { id: ZEN, name: 'Zen', role: 'MEMBER' as const },
  { id: ACME, name: 'Acme', role: 'OWNER' as const },
];

describe('buildOrganizationOptions', () => {
  it('sorts by name and disambiguates duplicate names with an id suffix', () => {
    const options = buildOrganizationOptions([
      ...ORGANIZATIONS,
      { id: ACME_TWIN, name: 'acme', role: 'MEMBER' },
    ]);
    expect(options.map((option) => option.organization.id)).toEqual([
      ACME,
      ACME_TWIN,
      ZEN,
    ]);
    expect(options.map((option) => option.secondary)).toEqual([
      '111111',
      '222222',
      null,
    ]);
  });
});

describe('SidebarContextRow', () => {
  let container: HTMLElement;
  let root: Root;
  let onSelect: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = jest.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<SidebarContextRowProps> = {}): void {
    act(() => {
      root.render(
        <SidebarContextRow
          context={{ kind: 'personal' }}
          organizations={ORGANIZATIONS}
          onSelect={onSelect}
          orgScoped={NO_ORG_ACTIONS}
          {...props}
        />,
      );
    });
  }

  // The menu renders through a portal, so look up from the document.
  function query<T extends Element>(testId: string): T {
    const element = document.querySelector<T>(`[data-testid="${testId}"]`);
    if (!element) throw new Error(`missing ${testId}`);
    return element;
  }
  function menuItems(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
  }

  function openMenu(): void {
    act(() => {
      query<HTMLButtonElement>('sidebar-context-row').click();
    });
  }

  it('shows Personal alone for an account with no organizations', () => {
    render({ organizations: [] });
    const trigger = query<HTMLButtonElement>('sidebar-context-row');
    expect(trigger.textContent).toBe('Personal');
    expect(trigger.getAttribute('aria-label')).toBe(
      'Workspace context: Personal',
    );

    openMenu();
    const items = menuItems();
    expect(items.map((item) => item.textContent)).toEqual(['Personal']);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the current context and lists Personal first, then organizations by name', () => {
    const acme: WorkspaceContext = {
      kind: 'organization',
      organizationId: ACME,
    };
    render({ context: acme });
    const trigger = query<HTMLButtonElement>('sidebar-context-row');
    expect(trigger.textContent).toContain('Acme');
    expect(trigger.getAttribute('aria-label')).toBe('Workspace context: Acme');

    openMenu();
    const items = menuItems();
    expect(items.map((item) => item.textContent)).toEqual([
      'Personal',
      'Acme',
      'Zen',
    ]);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('shows the organization logo in the collapsed row and menu item', () => {
    const logoUrl = 'https://example.test/acme.png';
    render({
      context: { kind: 'organization', organizationId: ACME },
      organizations: ORGANIZATIONS.map((organization) => ({
        ...organization,
        logoUrl,
      })),
    });
    openMenu();
    for (const testId of [
      'sidebar-context-row',
      `sidebar-context-option-${ACME}`,
    ]) {
      const logo = query(testId).querySelector('img');
      expect(logo?.getAttribute('src')).toBe(logoUrl);
      expect(logo?.getAttribute('data-testid')).toBe(
        'sidebar-context-glyph-logo',
      );
      expect(logo?.getAttribute('alt')).toBe('');
      expect(logo?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('shows BuildingIcon in the collapsed row and menu without a logo', () => {
    render({ context: { kind: 'organization', organizationId: ACME } });
    openMenu();
    for (const testId of [
      'sidebar-context-row',
      `sidebar-context-option-${ACME}`,
    ]) {
      expect(
        query(testId).querySelector(
          '[data-testid="sidebar-context-glyph-building"]',
        ),
      ).not.toBeNull();
    }
  });

  it('does not render an organization initial', () => {
    render({ context: { kind: 'organization', organizationId: ACME } });
    expect(query('sidebar-context-row').textContent).toBe('Acme');
    openMenu();
    expect(query(`sidebar-context-option-${ACME}`).textContent).toBe('Acme');
  });

  it('falls back on logo errors and retries when the URL changes', () => {
    const organizations = ORGANIZATIONS.map((organization) => ({
      ...organization,
      logoUrl: 'https://example.test/broken.png',
    }));
    const context: WorkspaceContext = {
      kind: 'organization',
      organizationId: ACME,
    };
    render({ context, organizations });
    openMenu();
    for (const testId of [
      'sidebar-context-row',
      `sidebar-context-option-${ACME}`,
    ]) {
      const surface = query(testId);
      const logo = surface.querySelector('img');
      expect(logo).not.toBeNull();
      act(() => {
        logo?.dispatchEvent(new Event('error'));
      });
      expect(
        surface.querySelector('[data-testid="sidebar-context-glyph-building"]'),
      ).not.toBeNull();
    }
    render({
      context,
      organizations: organizations.map((organization) => ({
        ...organization,
        logoUrl: 'https://example.test/replacement.png',
      })),
    });
    expect(
      query('sidebar-context-row').querySelector('img')?.getAttribute('src'),
    ).toBe('https://example.test/replacement.png');
  });

  it('shows PersonIcon in both Personal surfaces', () => {
    render();
    openMenu();
    for (const testId of [
      'sidebar-context-row',
      'sidebar-context-option-personal',
    ]) {
      expect(
        query(testId).querySelector(
          '[data-testid="sidebar-context-glyph-person"]',
        ),
      ).not.toBeNull();
    }
  });

  it('selects an organization, ignores re-selecting the current one, and closes', () => {
    render();
    openMenu();
    act(() => {
      query<HTMLButtonElement>('sidebar-context-option-personal').click();
    });
    expect(onSelect).not.toHaveBeenCalled();

    openMenu();
    act(() => {
      query<HTMLButtonElement>(`sidebar-context-option-${ZEN}`).click();
    });
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: ZEN,
    });
    expect(
      container.querySelector('[data-testid="sidebar-context-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(query('sidebar-context-row'));
  });

  it('supports keyboard navigation between options', () => {
    render();
    openMenu();
    const menu = query<HTMLElement>('sidebar-context-menu');
    const items = menuItems();
    act(() => {
      items[0]?.focus();
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      container.querySelector('[data-testid="sidebar-context-menu"]'),
    ).toBeNull();
  });

  it('disables the trigger while a switch is pending', () => {
    render({ disabled: true });
    expect(query<HTMLButtonElement>('sidebar-context-row').disabled).toBe(true);
  });

  it('re-enters the desktop instant-feedback scope only when asked', () => {
    render();
    openMenu();
    expect(query('sidebar-context-menu').className).not.toContain(
      'sidebar-instant-interactions',
    );
    render({ menuInstantInteractions: true });
    expect(query('sidebar-context-menu').className).toContain(
      'sidebar-instant-interactions',
    );
  });

  it('renders no updates dot when no other context has updates', () => {
    render({ contextsWithUpdates: new Set(['personal']) });
    // Updates in the current context are already on screen.
    expect(
      container.querySelector('[data-testid="sidebar-context-attention-dot"]'),
    ).toBeNull();
    expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
      'Workspace context: Personal',
    );
    openMenu();
    expect(
      document.querySelector(
        '[data-testid="sidebar-context-activity-personal"]',
      ),
    ).toBeNull();
  });

  it('marks other contexts with updates on the trigger and their menu rows (CAN-2959)', () => {
    render({ contextsWithUpdates: new Set([ZEN, 'personal']) });
    const trigger = query<HTMLButtonElement>('sidebar-context-row');
    expect(
      query('sidebar-context-attention-dot').getAttribute('class'),
    ).toContain('bg-fg-info');
    expect(trigger.getAttribute('aria-label')).toBe(
      'Workspace context: Personal, updates in Zen',
    );
    expect(trigger.textContent).toBe('Personal');

    openMenu();
    expect(
      query(`sidebar-context-activity-${ZEN}`).getAttribute('class'),
    ).toContain('bg-fg-info');
    expect(
      document.querySelector(
        `[data-testid="sidebar-context-activity-${ACME}"]`,
      ),
    ).toBeNull();
    expect(
      query(`sidebar-context-option-${ZEN}`).getAttribute('aria-label'),
    ).toBe('Zen, has updates');
    expect(
      query(`sidebar-context-option-${ACME}`).getAttribute('aria-label'),
    ).toBeNull();
    // The current context's own updates stay quiet in the menu too.
    expect(
      document.querySelector(
        '[data-testid="sidebar-context-activity-personal"]',
      ),
    ).toBeNull();
  });

  it('keeps the footer row look and opens its menu upward by default', () => {
    render();
    const trigger = query('sidebar-context-row');
    expect(trigger.className).toContain('hover:bg-subtle');
    expect(trigger.className).not.toContain('bg-quaternary');
    openMenu();
    expect(
      query('sidebar-context-menu').getAttribute('data-placement'),
    ).toMatch(/^top/);
  });

  it('at the top of the sidebar, rests without a surface and opens downward', () => {
    render({ placement: 'top' });
    const trigger = query('sidebar-context-row');
    // At rest the switcher has no fill or border, so it does not read as a
    // second selected row above New task; hover, focus and open still wash it.
    expect(trigger.className).not.toContain('bg-quaternary');
    expect(trigger.className).not.toContain('shadow-md');
    expect(trigger.classList).toContain('focus-ring');
    expect(trigger.classList).toContain('hover:bg-subtle');
    expect(trigger.classList).toContain('focus-visible:bg-subtle');
    expect(trigger.classList).toContain('aria-expanded:bg-subtle');
    expect(trigger.classList).toContain('h-8');
    expect(trigger.classList).toContain('text-base');
    expect(trigger.classList).toContain('font-bold');
    expect(trigger.classList).toContain('rounded-row');
    openMenu();
    expect(
      query('sidebar-context-menu').getAttribute('data-placement'),
    ).toMatch(/^bottom/);
  });

  it('names Personal in the trigger label when an organization is selected', () => {
    render({
      context: { kind: 'organization', organizationId: ACME },
      contextsWithUpdates: new Set(['personal']),
    });
    expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
      'Workspace context: Acme, updates in Personal',
    );
    openMenu();
    expect(
      query('sidebar-context-option-personal').getAttribute('aria-label'),
    ).toBe('Personal, has updates');
    expect(query('sidebar-context-activity-personal')).not.toBeNull();
  });

  describe('pending shares (CAN-4783)', () => {
    function attentionDot(): Element | null {
      return container.querySelector(
        '[data-testid="sidebar-context-attention-dot"]',
      );
    }
    function rowDot(key: string): Element | null {
      return document.querySelector(
        `[data-testid="sidebar-context-activity-${key}"]`,
      );
    }
    function optionLabel(key: string): string | null {
      return query(`sidebar-context-option-${key}`).getAttribute('aria-label');
    }

    it('marks a context with pending shares alone, with the count only in its name', () => {
      render({ pendingSharesByContext: new Map([[ZEN, 1]]) });
      const trigger = query<HTMLButtonElement>('sidebar-context-row');
      expect(attentionDot()?.getAttribute('class')).toContain('bg-fg-info');
      expect(trigger.getAttribute('aria-label')).toBe(
        'Workspace context: Personal, 1 pending share in Zen',
      );
      expect(trigger.textContent).toBe('Personal');

      openMenu();
      expect(rowDot(ZEN)?.getAttribute('class')).toContain('bg-fg-info');
      expect(rowDot(ACME)).toBeNull();
      expect(optionLabel(ZEN)).toBe('Zen, 1 pending share');
      expect(optionLabel(ACME)).toBeNull();
      expect(query(`sidebar-context-option-${ZEN}`).textContent).toBe('Zen');
    });

    it('orders updates before shares and paints one dot per surface', () => {
      render({
        contextsWithUpdates: new Set([ACME, ZEN]),
        pendingSharesByContext: new Map([
          [ZEN, 2],
          [ACME, 1],
        ]),
      });
      expect(
        container.querySelectorAll(
          '[data-testid="sidebar-context-attention-dot"]',
        ),
      ).toHaveLength(1);
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Personal, updates in Acme, Zen, 1 pending share in Acme, 2 pending shares in Zen',
      );

      openMenu();
      expect(
        document.querySelectorAll(
          `[data-testid="sidebar-context-activity-${ZEN}"]`,
        ),
      ).toHaveLength(1);
      expect(optionLabel(ZEN)).toBe('Zen, has updates, 2 pending shares');
      expect(optionLabel(ACME)).toBe('Acme, has updates, 1 pending share');
    });

    it('combines updates in one context with shares in another', () => {
      render({
        contextsWithUpdates: new Set([ACME]),
        pendingSharesByContext: new Map([[ZEN, 2]]),
      });
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Personal, updates in Acme, 2 pending shares in Zen',
      );
      openMenu();
      expect(optionLabel(ACME)).toBe('Acme, has updates');
      expect(optionLabel(ZEN)).toBe('Zen, 2 pending shares');
    });

    it('ignores the current context, unknown organizations and zero counts', () => {
      render({
        context: { kind: 'organization', organizationId: ZEN },
        pendingSharesByContext: new Map([
          [ZEN, 3],
          ['44444444-4444-4444-8444-444444444444', 2],
          [ACME, 0],
        ]),
      });
      expect(attentionDot()).toBeNull();
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Zen',
      );
      openMenu();
      expect(rowDot(ZEN)).toBeNull();
      expect(rowDot(ACME)).toBeNull();
      expect(rowDot('personal')).toBeNull();
      expect(optionLabel(ZEN)).toBeNull();
      expect(optionLabel(ACME)).toBeNull();
    });

    it('marks Personal direct shares while an organization is selected', () => {
      render({
        context: { kind: 'organization', organizationId: ACME },
        pendingSharesByContext: new Map([['personal', 1]]),
      });
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Acme, 1 pending share in Personal',
      );
      openMenu();
      expect(rowDot('personal')).not.toBeNull();
      expect(optionLabel('personal')).toBe('Personal, 1 pending share');
    });

    it('keeps same-named organizations distinct', () => {
      render({
        organizations: [
          { id: ACME, name: 'Acme', role: 'OWNER' },
          { id: ACME_TWIN, name: 'Acme', role: 'MEMBER' },
        ],
        pendingSharesByContext: new Map([[ACME_TWIN, 1]]),
      });
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Personal, 1 pending share in Acme 222222',
      );
      openMenu();
      expect(rowDot(ACME)).toBeNull();
      expect(rowDot(ACME_TWIN)).not.toBeNull();
      expect(optionLabel(ACME)).toBe('Acme 111111');
      expect(optionLabel(ACME_TWIN)).toBe('Acme 222222, 1 pending share');
    });

    it('drops only the share cue as counts fall, keeping updates', () => {
      render({
        contextsWithUpdates: new Set([ACME]),
        pendingSharesByContext: new Map([
          [ACME, 1],
          [ZEN, 2],
        ]),
      });
      render({
        contextsWithUpdates: new Set([ACME]),
        pendingSharesByContext: new Map([[ZEN, 1]]),
      });
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Personal, updates in Acme, 1 pending share in Zen',
      );
      render({
        contextsWithUpdates: new Set([ACME]),
        pendingSharesByContext: new Map(),
      });
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Personal, updates in Acme',
      );
      expect(attentionDot()).not.toBeNull();
      openMenu();
      expect(rowDot(ACME)).not.toBeNull();
      expect(rowDot(ZEN)).toBeNull();
      expect(optionLabel(ACME)).toBe('Acme, has updates');
      expect(optionLabel(ZEN)).toBeNull();
    });

    it('clears the trigger dot once the last share resolves', () => {
      render({ pendingSharesByContext: new Map([[ZEN, 1]]) });
      expect(attentionDot()).not.toBeNull();
      render({ pendingSharesByContext: new Map() });
      expect(attentionDot()).toBeNull();
      expect(query('sidebar-context-row').getAttribute('aria-label')).toBe(
        'Workspace context: Personal',
      );
    });
  });
});

describe('SidebarContextMenuItems', () => {
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

  function render(disabled?: boolean): {
    onSelect: jest.Mock;
    onClose: jest.Mock;
    onOpenPath: jest.Mock;
  } {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    const onOpenPath = jest.fn();
    act(() => {
      root.render(
        <SidebarContextMenuItems
          context={{ kind: 'organization', organizationId: ACME }}
          organizations={ORGANIZATIONS}
          onSelect={onSelect}
          onClose={onClose}
          orgScoped={{ ...NO_ORG_ACTIONS, onOpenPath }}
          disabled={disabled}
        />,
      );
    });
    return { onSelect, onClose, onOpenPath };
  }

  /** The menu rows and dividers in order, by test id or `---`. */
  function rowSequence(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"], [role="separator"]',
      ),
    ).map((element) =>
      element.getAttribute('role') === 'separator'
        ? '---'
        : (element.getAttribute('data-testid') ?? '?'),
    );
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!element) throw new Error(`missing ${testId}`);
    return element;
  }

  it('lists Personal, the organizations by name, Create an organization, then the organization actions, for a host menu', () => {
    const { onSelect, onClose, onOpenPath } = render();
    expect(rowSequence()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
      `sidebar-context-option-${ZEN}`,
      'sidebar-context-create-organization',
      '---',
      'account-personal-activity-row',
      'account-context-statistics-row',
      'sidebar-context-organization-settings',
    ]);
    expect(
      button('sidebar-context-option-personal').hasAttribute('disabled'),
    ).toBe(false);

    // The current context closes the host menu without a switch.
    act(() => button(`sidebar-context-option-${ACME}`).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    act(() => button('sidebar-context-option-personal').click());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'personal' });

    act(() => button('sidebar-context-organization-settings').click());
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onOpenPath).toHaveBeenCalledWith(`/organization/${ACME}/settings`);
  });

  it('disables the context options, not the organization actions, while a switch is in flight', () => {
    render(true);
    expect(button('sidebar-context-option-personal').disabled).toBe(true);
    expect(button(`sidebar-context-option-${ACME}`).disabled).toBe(true);
    expect(button('sidebar-context-organization-settings').disabled).toBe(
      false,
    );
    expect(button('sidebar-context-create-organization').disabled).toBe(false);
  });

  it('offers Personal only Create an organization when its organization is unknown', () => {
    const onOpenPath = jest.fn();
    const onClose = jest.fn();
    act(() => {
      root.render(
        <SidebarContextMenuItems
          context={{ kind: 'personal' }}
          organizations={ORGANIZATIONS}
          onSelect={jest.fn()}
          onClose={onClose}
          orgScoped={{ ...NO_ORG_ACTIONS, onOpenPath }}
        />,
      );
    });
    expect(rowSequence()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
      `sidebar-context-option-${ZEN}`,
      'sidebar-context-create-organization',
    ]);
    act(() => button('sidebar-context-create-organization').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenPath).toHaveBeenCalledWith('/organization?create=1');
  });
});
