/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IncomingTeamInvitation } from '@canopy/protocol/settings/organization';
import {
  SidebarContextRow,
  type SidebarContextOrgScopedActions,
  type SidebarContextRowProps,
} from '../SidebarContextRow';
import type {
  PendingInvitationResponse,
  SidebarContextInvitations,
} from '../usePendingOrganizationInvitations';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACME = '11111111-1111-4111-8111-111111111111';

const ORG_SCOPED: SidebarContextOrgScopedActions = {
  personalOrganizationId: null,
  freeAccess: false,
  onOpenPath: jest.fn(),
};

function invitation(
  id: string,
  overrides: Partial<IncomingTeamInvitation> = {},
): IncomingTeamInvitation {
  return {
    id,
    organizationId: `org-${id}`,
    organizationName: 'Globex',
    organizationTeamName: null,
    role: 'ADMIN',
    invitedByName: 'Ada',
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-11-01T00:00:00.000Z',
    enforcedSettings: [],
    ...overrides,
  };
}

function invitations(
  overrides: Partial<SidebarContextInvitations> = {},
): SidebarContextInvitations {
  return {
    items: [],
    pending: null,
    error: null,
    refresh: jest.fn(),
    accept: jest.fn().mockResolvedValue({ kind: 'accepted' }),
    decline: jest.fn().mockResolvedValue({ kind: 'declined' }),
    review: jest.fn(),
    dismissError: jest.fn(),
    ...overrides,
  };
}

describe('SidebarContextRow invitations (CAN-3672)', () => {
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

  function render(props: Partial<SidebarContextRowProps> = {}): void {
    act(() => {
      root.render(
        <SidebarContextRow
          context={{ kind: 'personal' }}
          organizations={[{ id: ACME, name: 'Acme', role: 'OWNER' }]}
          onSelect={jest.fn()}
          orgScoped={ORG_SCOPED}
          {...props}
        />,
      );
    });
  }

  function find(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }
  function query(testId: string): HTMLElement {
    const element = find(testId);
    if (!element) throw new Error(`missing ${testId}`);
    return element;
  }
  function click(testId: string): void {
    act(() => query(testId).click());
  }
  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }
  function trigger(): HTMLElement {
    return query('sidebar-context-row');
  }
  function menuItemLabels(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]',
      ),
    ).map((item) => item.getAttribute('aria-label') ?? item.textContent ?? '');
  }

  it.each([
    [1, 'Workspace context: Personal, 1 pending invitation'],
    [2, 'Workspace context: Personal, 2 pending invitations'],
  ])(
    'counts %i invitation(s) in the trigger and shows the dot',
    (count, label) => {
      render({
        invitations: invitations({
          items: Array.from({ length: count }, (_, i) => invitation(`i${i}`)),
        }),
      });
      expect(trigger().getAttribute('aria-label')).toBe(label);
      expect(find('sidebar-context-attention-dot')).not.toBeNull();
    },
  );

  it('appends the invitation count after pending shares', () => {
    render({
      pendingSharesByContext: new Map([[ACME, 2]]),
      invitations: invitations({ items: [invitation('a')] }),
    });
    expect(trigger().getAttribute('aria-label')).toBe(
      'Workspace context: Personal, 2 pending shares in Acme, 1 pending invitation',
    );
  });

  it('keeps the trigger and menu unchanged with no invitations, and re-reads on each open', () => {
    const model = invitations();
    render({ invitations: model });
    expect(trigger().getAttribute('aria-label')).toBe(
      'Workspace context: Personal',
    );
    expect(find('sidebar-context-attention-dot')).toBeNull();
    click('sidebar-context-row');
    expect(model.refresh).toHaveBeenCalledTimes(1);
    expect(find('sidebar-context-invitations')).toBeNull();
    click('sidebar-context-row');
    click('sidebar-context-row');
    expect(model.refresh).toHaveBeenCalledTimes(2);
  });

  it('shows no group and no cue for an unauthenticated account', () => {
    const model = invitations({ items: [invitation('a')] });
    render({
      orgScoped: { ...ORG_SCOPED, authenticated: false },
      invitations: model,
    });
    expect(find('sidebar-context-attention-dot')).toBeNull();
    click('sidebar-context-row');
    expect(find('sidebar-context-invitations')).toBeNull();
    expect(model.refresh).not.toHaveBeenCalled();
  });

  it('lists invitations after the organizations and before Create an organization', () => {
    render({
      orgScoped: { ...ORG_SCOPED, personalOrganizationId: 'personal' },
      invitations: invitations({ items: [invitation('a')] }),
    });
    click('sidebar-context-row');
    expect(menuItemLabels()).toEqual([
      'Personal',
      'Acme',
      'Accept invitation to Globex',
      'Decline invitation to Globex',
      'Create an organization',
    ]);
    const row = query('sidebar-context-invitation-a');
    expect(row.textContent).toContain('Globex');
    expect(row.textContent).toContain('Admin');
  });

  it('tells same-named invitations apart by team or role', () => {
    render({
      invitations: invitations({
        items: [
          invitation('a', { organizationTeamName: 'Design' }),
          invitation('b', { role: 'MEMBER' }),
        ],
      }),
    });
    click('sidebar-context-row');
    expect(
      query('sidebar-context-invitation-accept-a').getAttribute('aria-label'),
    ).toBe('Accept invitation to Globex (Design, Admin)');
    expect(
      query('sidebar-context-invitation-accept-b').getAttribute('aria-label'),
    ).toBe('Accept invitation to Globex (Member)');
  });

  it('accepts with the menu open, then closes it on success', async () => {
    const model = invitations({ items: [invitation('a')] });
    render({ invitations: model });
    click('sidebar-context-row');
    click('sidebar-context-invitation-accept-a');
    expect(model.accept).toHaveBeenCalledWith(
      invitation('a'),
      expect.any(Function),
    );
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the menu open with the error after a failed accept', async () => {
    const failed: PendingInvitationResponse = {
      kind: 'failed',
      message: "Couldn't accept the invitation. Try again.",
    };
    const model = invitations({
      items: [invitation('a')],
      accept: jest.fn().mockResolvedValue(failed),
    });
    render({ invitations: model });
    click('sidebar-context-row');
    click('sidebar-context-invitation-accept-a');
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    render({
      invitations: {
        ...model,
        error: { kind: 'action', message: failed.message },
      },
    });
    expect(query('sidebar-context-invitations-error').textContent).toBe(
      failed.message,
    );
  });

  it('shows Joining… on the accepting row and disables every invitation action', () => {
    render({
      invitations: invitations({
        items: [invitation('a'), invitation('b')],
        pending: { inviteId: 'a', action: 'accept' },
      }),
    });
    click('sidebar-context-row');
    const accept = query('sidebar-context-invitation-accept-a');
    expect(accept.textContent).toBe('Joining…');
    for (const testId of [
      'sidebar-context-invitation-accept-a',
      'sidebar-context-invitation-decline-a',
      'sidebar-context-invitation-accept-b',
    ]) {
      expect(query(testId).hasAttribute('disabled')).toBe(true);
    }
  });

  it('routes an invitation with enforced settings to review, never answering it here', () => {
    const model = invitations({
      items: [
        invitation('a', {
          enforcedSettings: [
            {
              organizationId: 'org-a',
              organizationName: 'Globex',
              policies: [],
            },
          ],
        }),
      ],
    });
    render({ invitations: model });
    click('sidebar-context-row');
    expect(find('sidebar-context-invitation-accept-a')).toBeNull();
    click('sidebar-context-invitation-review-a');
    expect(model.review).toHaveBeenCalledTimes(1);
    expect(model.accept).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('confirms a decline outside the menu, and cancelling sends nothing', () => {
    const model = invitations({ items: [invitation('a')] });
    render({ invitations: model });
    click('sidebar-context-row');
    click('sidebar-context-invitation-decline-a');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(query('sidebar-context-decline-invitation').textContent).toContain(
      'Decline the invitation to join Globex?',
    );
    click('sidebar-context-decline-invitation-cancel');
    expect(find('sidebar-context-decline-invitation')).toBeNull();
    expect(model.decline).not.toHaveBeenCalled();
  });

  it('declines once on confirm and closes the dialog', async () => {
    const model = invitations({ items: [invitation('a')] });
    render({ invitations: model });
    click('sidebar-context-row');
    click('sidebar-context-invitation-decline-a');
    click('sidebar-context-decline-invitation-confirm');
    await settle();
    expect(model.decline).toHaveBeenCalledTimes(1);
    expect(find('sidebar-context-decline-invitation')).toBeNull();
  });

  it('keeps the decline dialog open with its error after a failure', async () => {
    const model = invitations({
      items: [invitation('a')],
      decline: jest.fn().mockResolvedValue({
        kind: 'failed',
        message: "Couldn't decline the invitation. Try again.",
      }),
    });
    render({ invitations: model });
    click('sidebar-context-row');
    click('sidebar-context-invitation-decline-a');
    click('sidebar-context-decline-invitation-confirm');
    await settle();
    expect(query('confirm-dialog-error').textContent).toBe(
      "Couldn't decline the invitation. Try again.",
    );
    click('sidebar-context-decline-invitation-cancel');
    expect(model.dismissError).toHaveBeenCalledTimes(1);
  });

  it('serializes confirmation clicks and preserves the first response error', async () => {
    let finish: (result: PendingInvitationResponse) => void = () => {};
    const response = new Promise<PendingInvitationResponse>((resolve) => {
      finish = resolve;
    });
    const decline = jest.fn(() => response);
    render({ invitations: invitations({ items: [invitation('a')], decline }) });
    click('sidebar-context-row');
    click('sidebar-context-invitation-decline-a');
    click('sidebar-context-decline-invitation-confirm');
    click('sidebar-context-decline-invitation-confirm');
    expect(decline).toHaveBeenCalledTimes(1);
    finish({ kind: 'failed', message: 'Could not decline. Try again.' });
    await settle();
    expect(query('confirm-dialog-error').textContent).toBe(
      'Could not decline. Try again.',
    );
  });

  it('drops the decline dialog when its invitation disappears', () => {
    const model = invitations({ items: [invitation('a')] });
    render({ invitations: model });
    click('sidebar-context-row');
    click('sidebar-context-invitation-decline-a');
    render({ invitations: { ...model, items: [] } });
    expect(find('sidebar-context-decline-invitation')).toBeNull();
  });

  it('keeps an unavailable message after the last row is gone, and offers Organizations after a failed follow-up', () => {
    const model = invitations({
      error: {
        kind: 'follow-up',
        message: 'You joined, but it could not open.',
      },
    });
    render({ invitations: model });
    // Under the closed trigger.
    expect(query('sidebar-context-invitations-error').textContent).toContain(
      'You joined, but it could not open.',
    );
    click('sidebar-context-invitations-open-organizations');
    expect(model.review).toHaveBeenCalledTimes(1);
    click('sidebar-context-invitations-dismiss');
    expect(model.dismissError).toHaveBeenCalled();
    // In the open menu, even with no rows left.
    click('sidebar-context-row');
    expect(find('sidebar-context-invitations')).not.toBeNull();
  });
});
