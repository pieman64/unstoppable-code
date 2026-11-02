/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  InviteTeammateDialog,
  InviteTeammateRefusal,
} from '../InviteTeammateDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function click(testId: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  return {
    promise: new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve,
    reject,
  };
}

async function searchFor(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search teammates"]',
  );
  if (input === null) {
    throw new Error('Expected teammate search input');
  }
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set?.bind(input);
  await act(async () => {
    setValue?.(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('InviteTeammateDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  const searchMembers = jest.fn();
  const invite = jest.fn();
  const loadRecipients = jest.fn();
  const revoke = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    searchMembers.mockResolvedValue([
      { userId: 'user-2', name: 'Taylor Teammate', image: '/taylor.png' },
    ]);
    loadRecipients.mockResolvedValue({ containerId: null, recipients: [] });
    invite.mockResolvedValue({
      containerId: 'container-1',
      grant: {
        id: 'grant-1',
        containerId: 'container-1',
        recipient: {
          kind: 'member',
          userId: 'user-2',
          name: 'Taylor Teammate',
        },
        capabilities: ['VIEW', 'PROMPT'],
        createdAt: '2026-09-23T10:00:00.000Z',
        updatedAt: '2026-09-23T10:00:00.000Z',
      },
    });
    revoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderDialog(
    organizations = [{ id: 'org-1', name: 'Acme' }],
    existingShareOrganizationId?: string,
    context?: WorkspaceContext,
    defaultOrganizationId?: string,
  ): void {
    act(() => {
      root.render(
        <InviteTeammateDialog
          chatId="chat-1"
          chatTitle="Launch planning"
          organizations={organizations}
          existingShareOrganizationId={existingShareOrganizationId}
          context={context}
          defaultOrganizationId={defaultOrganizationId}
          searchMembers={searchMembers}
          invite={invite}
          loadRecipients={loadRecipients}
          revoke={revoke}
          onClose={jest.fn()}
          onSharingChanged={jest.fn()}
        />,
      );
    });
  }

  it('defaults to the organization selected in the workspace context', async () => {
    renderDialog(
      [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Beta' },
      ],
      undefined,
      { kind: 'organization', organizationId: 'org-2' },
    );
    await settle();

    expect(searchMembers).toHaveBeenCalledWith('org-2', '');
    expect(
      document.querySelector<HTMLSelectElement>(
        '[data-testid="invite-teammate-organization"]',
      )?.value,
    ).toBe('org-2');
  });

  it('shows the only selected organization as text', async () => {
    renderDialog(undefined, undefined, undefined);
    await settle();

    expect(
      document.querySelector(
        '[data-testid="invite-teammate-organization-name"]',
      )?.textContent,
    ).toContain('Acme');
  });

  it('requires an explicit organization when Personal has multiple choices', async () => {
    renderDialog(
      [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Beta' },
      ],
      undefined,
      { kind: 'personal' },
    );
    await settle();

    expect(searchMembers).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="invite-teammate-submit"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLSelectElement>(
        '[data-testid="invite-teammate-organization"]',
      )?.value,
    ).toBe('');
  });

  it('rebinds an unowned dialog and names the new context', async () => {
    const organizations = [
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Beta' },
    ];
    renderDialog(organizations, undefined, {
      kind: 'organization',
      organizationId: 'org-1',
    });
    await settle();
    renderDialog(organizations, undefined, {
      kind: 'organization',
      organizationId: 'org-2',
    });
    await settle();

    expect(
      document.querySelector('[data-testid="invite-teammate-context-changed"]')
        ?.textContent,
    ).toContain('Switched to Beta.');
    expect(searchMembers).toHaveBeenLastCalledWith('org-2', '');
  });

  it('applies a context change after a failed invite settles', async () => {
    const organizations = [
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Beta' },
    ];
    const pending = deferred<Awaited<ReturnType<typeof invite>>>();
    invite.mockReturnValueOnce(pending.promise);
    renderDialog(organizations, undefined, {
      kind: 'organization',
      organizationId: 'org-1',
    });
    await settle();
    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');

    renderDialog(organizations, undefined, {
      kind: 'organization',
      organizationId: 'org-2',
    });
    await settle();
    expect(
      document.querySelector('[data-testid="invite-teammate-context-changed"]'),
    ).toBeNull();

    await act(async () => {
      pending.reject(new Error('invite failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(
      document.querySelector('[data-testid="invite-teammate-context-changed"]')
        ?.textContent,
    ).toContain('Switched to Beta.');
    expect(
      document.querySelector<HTMLSelectElement>(
        '[data-testid="invite-teammate-organization"]',
      )?.value,
    ).toBe('org-2');
  });

  it('keeps a successful first invite bound when context changes in flight', async () => {
    const organizations = [
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Beta' },
    ];
    const pending = deferred<Awaited<ReturnType<typeof invite>>>();
    invite.mockReturnValueOnce(pending.promise);
    renderDialog(organizations, undefined, {
      kind: 'organization',
      organizationId: 'org-1',
    });
    await settle();
    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');

    renderDialog(organizations, undefined, {
      kind: 'organization',
      organizationId: 'org-2',
    });
    await settle();

    await act(async () => {
      pending.resolve({
        containerId: 'container-1',
        grant: {
          id: 'grant-1',
          containerId: 'container-1',
          recipient: {
            kind: 'member',
            userId: 'user-2',
            name: 'Taylor Teammate',
          },
          capabilities: ['VIEW', 'PROMPT'],
          createdAt: '2026-09-23T10:00:00.000Z',
          updatedAt: '2026-09-23T10:00:00.000Z',
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(
      document.querySelector('[data-testid="invite-teammate-context-changed"]'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLSelectElement>(
        '[data-testid="invite-teammate-organization"]',
      )?.value,
    ).toBe('org-1');
  });

  it('keeps footer actions at the minimum touch-target height', async () => {
    renderDialog();
    await settle();

    // The shared compact capsule extends its hit area to 44px on a coarse
    // pointer, so the 28px visible control still meets the touch target.
    expect(
      document
        .querySelector('[data-testid="invite-teammate-submit"]')
        ?.classList.contains('pointer-coarse:before:-inset-y-2'),
    ).toBe(true);
  });

  it('marks the picked teammate with a semantic checkmark', async () => {
    renderDialog();
    await settle();

    await click('invite-teammate-member-user-2');

    const selectedMember = document.querySelector(
      '[data-testid="invite-teammate-member-user-2"]',
    );
    expect(selectedMember?.getAttribute('aria-selected')).toBe('true');
    expect(
      selectedMember?.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
    expect(selectedMember?.className).not.toContain('bg-fg-primary/[0.08]');
  });

  it('searches, invites with VIEW and PROMPT, then shows recipients', async () => {
    renderDialog();
    await settle();
    expect(document.body.textContent).toContain(
      'Teammates you invite can read this chat, send prompts, and stop running turns. Their prompts run and bill under your account.',
    );
    expect(searchMembers).toHaveBeenCalledWith('org-1', '');
    expect(document.body.textContent).toContain(
      'Teammates you invite can read this chat, send prompts, and stop running turns. Their prompts run and bill under your account.',
    );
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="invite-teammate-access-divider"]')
        ?.className,
    ).toContain('bg-line-base');

    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');
    await settle();

    expect(invite).toHaveBeenCalledWith({
      organizationId: 'org-1',
      cloudChatId: 'chat-1',
      recipientUserId: 'user-2',
      capabilities: ['VIEW', 'PROMPT'],
    });
    expect(document.body.textContent).toContain('Taylor Teammate');
    expect(document.body.textContent).toContain('Can view and prompt');
    expect(document.body.textContent).toContain('Remove');
  });

  it('does not reload recipients when the member search changes', async () => {
    renderDialog();
    await settle();

    await searchFor('Taylor');
    await settle();

    expect(searchMembers).toHaveBeenLastCalledWith('org-1', 'Taylor');
    expect(loadRecipients).toHaveBeenCalledTimes(1);
  });

  it('does not let a search-triggered recipient response wipe a new grant', async () => {
    renderDialog();
    await settle();

    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');
    await settle();
    await searchFor('Taylor');
    await settle();

    expect(loadRecipients).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Taylor Teammate');
    expect(document.body.textContent).not.toContain('No one has access yet.');
  });

  it('clears recipient loading when an invite supersedes the initial load', async () => {
    const pending = deferred<{ containerId: null; recipients: [] }>();
    loadRecipients.mockReturnValueOnce(pending.promise);
    renderDialog();
    await settle();

    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');
    await settle();

    expect(document.body.textContent).not.toContain('Loading people…');
    expect(document.body.textContent).toContain('Taylor Teammate');
    pending.resolve({ containerId: null, recipients: [] });
  });

  it('keeps the initial recipient result when an invite fails', async () => {
    const pending = deferred<{
      containerId: string;
      recipients: [
        {
          id: string;
          containerId: string;
          recipient: { kind: 'member'; userId: string; name: string };
          capabilities: ['VIEW', 'PROMPT'];
          createdAt: string;
          updatedAt: string;
        },
      ];
    }>();
    loadRecipients.mockReturnValueOnce(pending.promise);
    invite.mockRejectedValueOnce(new Error('invite failed'));
    renderDialog();
    await settle();

    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');
    await settle();

    expect(document.body.textContent).not.toContain('Loading people…');
    expect(document.body.textContent).toContain(
      'Could not invite that teammate. Try again.',
    );
    await act(async () => {
      pending.resolve({
        containerId: 'container-1',
        recipients: [
          {
            id: 'grant-existing',
            containerId: 'container-1',
            recipient: {
              kind: 'member',
              userId: 'user-3',
              name: 'Existing Teammate',
            },
            capabilities: ['VIEW', 'PROMPT'],
            createdAt: '2026-09-22T10:00:00.000Z',
            updatedAt: '2026-09-22T10:00:00.000Z',
          },
        ],
      });
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Existing Teammate');
    await click('invite-teammate-revoke-user-3');
    await settle();
    expect(revoke).toHaveBeenCalledWith({
      organizationId: 'org-1',
      containerId: 'container-1',
      recipientUserId: 'user-3',
    });
  });

  it('loads existing recipients and revokes through the ports', async () => {
    loadRecipients.mockResolvedValue({
      containerId: 'container-1',
      recipients: [
        {
          id: 'grant-1',
          containerId: 'container-1',
          recipient: {
            kind: 'member',
            userId: 'user-2',
            name: 'Taylor Teammate',
          },
          capabilities: ['VIEW', 'PROMPT'],
          createdAt: '2026-09-23T10:00:00.000Z',
          updatedAt: '2026-09-23T10:00:00.000Z',
        },
      ],
    });
    renderDialog();
    await settle();

    expect(
      document
        .querySelector('[data-testid="invite-teammate-revoke-user-2"]')
        ?.classList.contains('min-h-11'),
    ).toBe(true);
    await click('invite-teammate-revoke-user-2');
    await settle();

    expect(revoke).toHaveBeenCalledWith({
      organizationId: 'org-1',
      containerId: 'container-1',
      recipientUserId: 'user-2',
    });
    expect(document.body.textContent).toContain('No one has access yet.');
  });

  it('keeps a recipient who removed the share listed, labelled, and revocable', async () => {
    loadRecipients.mockResolvedValue({
      containerId: 'container-1',
      recipients: [
        {
          id: 'grant-1',
          containerId: 'container-1',
          recipient: {
            kind: 'member',
            userId: 'user-2',
            name: 'Taylor Teammate',
          },
          capabilities: ['VIEW', 'PROMPT'],
          createdAt: '2026-09-23T10:00:00.000Z',
          updatedAt: '2026-09-23T10:00:00.000Z',
          dismissedAt: '2026-10-01T10:00:00.000Z',
        },
      ],
    });
    renderDialog();
    await settle();

    expect(
      document.querySelector(
        '[data-testid="invite-teammate-removed-by-recipient-user-2"]',
      )?.textContent,
    ).toBe('Removed by recipient');
    expect(document.body.textContent).not.toContain('Can view and prompt');
    expect(
      document.querySelector('[data-testid="invite-teammate-revoke-user-2"]'),
    ).not.toBeNull();
  });

  it('keeps an existing share bound to its container organization', async () => {
    renderDialog(
      [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Beta' },
      ],
      'org-2',
    );
    await settle();

    expect(searchMembers).toHaveBeenCalledWith('org-2', '');
    expect(loadRecipients).toHaveBeenCalledWith('org-2', 'chat-1');
    expect(document.querySelector<HTMLSelectElement>('select')?.disabled).toBe(
      true,
    );
  });

  it('starts on the default organization when the chat is not shared yet (CAN-3458)', async () => {
    renderDialog(
      [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Beta' },
      ],
      undefined,
      undefined,
      'org-2',
    );
    await settle();

    expect(searchMembers).toHaveBeenCalledWith('org-2', '');
    expect(loadRecipients).toHaveBeenCalledWith('org-2', 'chat-1');
  });

  it('keeps an eligible project owner ahead of navigation context changes', async () => {
    const organizations = [
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Beta' },
    ];
    renderDialog(
      organizations,
      undefined,
      { kind: 'organization', organizationId: 'org-1' },
      'org-2',
    );
    await settle();
    expect(loadRecipients).toHaveBeenCalledWith('org-2', 'chat-1');

    renderDialog(organizations, undefined, { kind: 'personal' }, 'org-2');
    await settle();
    expect(loadRecipients).not.toHaveBeenCalledWith('org-1', 'chat-1');
    expect(
      document.querySelector<HTMLSelectElement>(
        '[data-testid="invite-teammate-organization"]',
      )?.value,
    ).toBe('org-2');
  });

  it('prefers the existing share over the default organization', async () => {
    renderDialog(
      [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Beta' },
      ],
      'org-1',
      undefined,
      'org-2',
    );
    await settle();

    expect(loadRecipients).toHaveBeenCalledWith('org-1', 'chat-1');
    expect(loadRecipients).not.toHaveBeenCalledWith('org-2', 'chat-1');
  });

  it('ignores a default organization the user cannot pick', async () => {
    renderDialog(
      [{ id: 'org-1', name: 'Acme' }],
      undefined,
      undefined,
      'org-9',
    );
    await settle();

    expect(loadRecipients).toHaveBeenCalledWith('org-1', 'chat-1');
  });

  it('surfaces member and invite errors without closing', async () => {
    searchMembers.mockRejectedValueOnce(new Error('offline'));
    renderDialog();
    await settle();
    expect(document.body.textContent).toContain('Could not load teammates.');

    searchMembers.mockResolvedValueOnce([
      { userId: 'user-2', name: 'Taylor Teammate' },
    ]);
    await click('invite-teammate-search-retry');
    await settle();
    invite.mockRejectedValueOnce(new Error('denied'));
    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');
    await settle();
    expect(document.body.textContent).toContain(
      'Could not invite that teammate. Try again.',
    );
  });

  it("shows a host refusal's own explanation instead of the retry copy (CAN-3458)", async () => {
    renderDialog();
    await settle();
    invite.mockRejectedValueOnce(
      new InviteTeammateRefusal('Share this chat inside its own organization.'),
    );
    await click('invite-teammate-member-user-2');
    await click('invite-teammate-submit');
    await settle();
    expect(document.body.textContent).toContain(
      'Share this chat inside its own organization.',
    );
    expect(document.body.textContent).not.toContain(
      'Could not invite that teammate. Try again.',
    );
  });

  it('retries loading recipients after an error', async () => {
    loadRecipients
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ containerId: null, recipients: [] });
    renderDialog();
    await settle();
    expect(document.body.textContent).toContain(
      'Could not load people with access.',
    );

    await click('invite-teammate-recipients-retry');
    await settle();
    expect(loadRecipients).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('No one has access yet.');
  });

  it('ignores recipient results from a previously selected organization', async () => {
    let resolveFirst:
      | ((value: { containerId: string; recipients: [] }) => void)
      | undefined;
    loadRecipients
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ containerId: 'container-2', recipients: [] });
    renderDialog([
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Beta' },
    ]);
    await settle();

    const select = document.querySelector<HTMLSelectElement>('select');
    await act(async () => {
      if (select) select.value = 'org-2';
      select?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      resolveFirst?.({ containerId: 'container-1', recipients: [] });
      await Promise.resolve();
    });

    expect(loadRecipients).toHaveBeenLastCalledWith('org-2', 'chat-1');
    expect(document.body.textContent).toContain('No one has access yet.');
  });
});
