/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PersonalOrganizationUpgradePort } from '@canopy/app-state/personal-organization-upgrade';
import { createBrowserUpgradeRecovery } from '@canopy/app-state/personal-organization-upgrade';
import { OrganizationOperationFailure } from '@canopy/app-core';
import type {
  PersonalOrganizationPromotionOutcome,
  PersonalProject,
  PersonalProjectOperation,
} from '@canopy/protocol/organizations';
import {
  InviteToOrganizationDialog,
  type InviteToOrganizationDialogProps,
} from '../InviteToOrganizationDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PERSONAL_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_ID = '22222222-2222-4222-8222-222222222222';
const INVITE_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '44444444-4444-4444-8444-444444444444';

const PROJECTS: PersonalProject[] = [
  { workspaceId: 'ws-a', name: 'Alpha', kind: 'single-repo' },
  { workspaceId: 'ws-b', name: 'Beta', kind: 'single-repo' },
];

function promotion(operationId: string): PersonalOrganizationPromotionOutcome {
  return {
    promotion: {
      organizationId: PERSONAL_ID,
      name: 'Acme',
      personalOrganizationId: REPLACEMENT_ID,
      operationId,
      alreadyUpgraded: false,
      warnings: [],
    },
    contextSwitched: true,
    warnings: [],
  };
}

function makePort(
  overrides: Partial<PersonalOrganizationUpgradePort> = {},
): PersonalOrganizationUpgradePort {
  return {
    canPromote: true,
    canInvite: true,
    canBringProjects: true,
    promote: jest.fn((request: { operationId: string }) =>
      Promise.resolve(promotion(request.operationId)),
    ),
    invite: jest.fn(() =>
      Promise.resolve({ status: 'sent' as const, inviteId: INVITE_ID }),
    ),
    listProjects: jest.fn(() => Promise.resolve(PROJECTS)),
    convert: jest.fn(
      (request: { operationId: string; workspaceIds: string[] }) =>
        Promise.resolve({
          operationId: request.operationId,
          accountId: 'account-1',
          organizationId: PERSONAL_ID,
          selection: request.workspaceIds,
          projects: request.workspaceIds.map((workspaceId) => ({
            workspaceId,
            stage: 'complete' as const,
            outcome: 'moved' as const,
          })),
          updatedAt: '2026-10-09T00:00:00.000Z',
        }),
    ),
    status: jest.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

it('shows journal names and refused repositories after Personal no longer lists the projects', async () => {
  const operationId = '55555555-5555-4555-8555-555555555555';
  const recovery = createBrowserUpgradeRecovery('account-1', localStorage);
  recovery.write({
    accountKey: 'account-1',
    personalOrganizationId: PERSONAL_ID,
    promotionOperationId: operationId,
    conversionOperationId: operationId,
    name: 'Acme',
    selection: ['ws-a'],
    inviteEmail: '',
    promotion: promotion(operationId),
    invite: null,
  });
  const port = makePort({
    listProjects: () => Promise.resolve([]),
    status: () =>
      Promise.resolve({
        operationId,
        accountId: 'account-1',
        organizationId: PERSONAL_ID,
        selection: ['ws-a'],
        projects: [
          {
            workspaceId: 'ws-a',
            name: 'Saved project',
            kind: 'multi-repo',
            stage: 'queued',
            outcome: 'repositories-not-in-team',
            reason: 'outside-organization: acme/repo',
          },
        ],
        updatedAt: '2026-10-09T00:00:00.000Z',
      }),
  });
  await render({
    target: { kind: 'personal', personalOrganizationId: PERSONAL_ID },
    port,
    accountKey: 'account-1',
    recovery,
    onClose: jest.fn(),
  });
  expect(
    byTestId('invite-to-organization-outcome-ws-a')?.textContent,
  ).toContain('Saved project');
  expect(
    byTestId('invite-to-organization-outcome-ws-a')?.textContent,
  ).toContain('acme/repo');
});
it('offers a targeted retry for a committed project whose catalog refresh failed', async () => {
  const operationId = '55555555-5555-4555-8555-555555555555';
  const recovery = createBrowserUpgradeRecovery('account-1', localStorage);
  recovery.write({
    accountKey: 'account-1',
    personalOrganizationId: PERSONAL_ID,
    promotionOperationId: operationId,
    conversionOperationId: operationId,
    name: 'Acme',
    selection: ['ws-a'],
    inviteEmail: '',
    promotion: promotion(operationId),
    invite: null,
  });
  const port = makePort({
    listProjects: () => Promise.resolve([]),
    status: () =>
      Promise.resolve({
        operationId,
        accountId: 'account-1',
        organizationId: PERSONAL_ID,
        selection: ['ws-a'],
        projects: [
          {
            workspaceId: 'ws-a',
            name: 'Saved project',
            stage: 'complete',
            outcome: 'moved',
            projectId: TEAM_ID,
            refreshWarning: true,
          },
        ],
        updatedAt: '2026-10-09T00:00:00.000Z',
      }),
  });
  await render({
    target: { kind: 'personal', personalOrganizationId: PERSONAL_ID },
    port,
    accountKey: 'account-1',
    recovery,
    onClose: jest.fn(),
  });
  const retry = byTestId('invite-to-organization-retry-projects');
  expect(retry).not.toBeNull();
  await act(async () => {
    retry?.click();
    await Promise.resolve();
  });
  expect(port.convert).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId,
      workspaceIds: ['ws-a'],
      retryWorkspaceIds: ['ws-a'],
    }),
  );
  expect(port.promote).not.toHaveBeenCalled();
});

it('reopens a project-limit refusal and retries only that row with the frozen selection', async () => {
  const operationId = '55555555-5555-4555-8555-555555555555';
  const recovery = createBrowserUpgradeRecovery('account-1', localStorage);
  recovery.write({
    accountKey: 'account-1',
    personalOrganizationId: PERSONAL_ID,
    promotionOperationId: operationId,
    conversionOperationId: operationId,
    name: 'Acme',
    selection: ['ws-a', 'ws-b'],
    inviteEmail: '',
    promotion: promotion(operationId),
    invite: null,
  });
  const operation: PersonalProjectOperation = {
    operationId,
    accountId: 'account-1',
    organizationId: PERSONAL_ID,
    selection: ['ws-a', 'ws-b'],
    updatedAt: '2026-10-09T00:00:00.000Z',
    projects: [
      {
        workspaceId: 'ws-a',
        stage: 'complete',
        outcome: 'moved',
        projectId: TEAM_ID,
      },
      { workspaceId: 'ws-b', stage: 'queued', outcome: 'limit-reached' },
    ],
  };
  const port = makePort({ status: jest.fn(() => Promise.resolve(operation)) });
  await render({
    target: { kind: 'personal', personalOrganizationId: REPLACEMENT_ID },
    port,
    accountKey: 'account-1',
    recovery,
    onClose: jest.fn(),
  });
  expect(port.convert).not.toHaveBeenCalled();
  expect(
    byTestId('invite-to-organization-outcome-ws-b')?.textContent,
  ).toContain('project limit');
  const retry = byTestId('invite-to-organization-retry-projects');
  expect(retry).not.toBeNull();
  await act(async () => {
    retry?.click();
    await Promise.resolve();
  });
  expect(port.convert).toHaveBeenCalledTimes(1);
  expect(port.convert).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId,
      workspaceIds: ['ws-a', 'ws-b'],
      retryWorkspaceIds: ['ws-b'],
    }),
  );
  expect(port.promote).not.toHaveBeenCalled();
});

it('keeps the form active through Strict Mode mount replay', async () => {
  const { StrictMode } = await import('react');
  const port = makePort({ canBringProjects: false });
  await act(async () => {
    root.render(
      <StrictMode>
        <InviteToOrganizationDialog
          target={{ kind: 'personal', personalOrganizationId: PERSONAL_ID }}
          accountKey="account-1"
          port={port}
          onClose={jest.fn()}
        />
      </StrictMode>,
    );
    await Promise.resolve();
  });
  expect(
    byTestId<HTMLButtonElement>('invite-to-organization-submit')?.disabled,
  ).toBe(true);
  typeInto(byTestId('invite-to-organization-team-name'), 'Strict team');
  expect(
    byTestId<HTMLButtonElement>('invite-to-organization-submit')?.disabled,
  ).toBe(false);
});

it('shows the resumed invitation after closing during conversion and reopening', async () => {
  const recovery = createBrowserUpgradeRecovery('account-1', localStorage);
  let finish: (result: PersonalProjectOperation) => void = () => {};
  let requestId = '';
  const port = makePort({
    convert: jest.fn((request) => {
      requestId = request.operationId;
      return new Promise<PersonalProjectOperation>((resolve) => {
        finish = resolve;
      });
    }),
  });
  const onClose = jest.fn();
  await render({
    target: { kind: 'personal', personalOrganizationId: PERSONAL_ID },
    accountKey: 'account-1',
    port,
    recovery,
    onClose,
  });
  typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
  typeInto(byTestId('invite-to-organization-email'), 'person@example.com');
  await act(async () => {
    click(byTestId('invite-to-organization-submit'));
    await Promise.resolve();
  });
  expect(byTestId('invite-to-organization-projects-moving')).not.toBeNull();
  click(byTestId('invite-to-organization-done'));
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => {
    root.render(null);
    await Promise.resolve();
  });
  const completed: PersonalProjectOperation = {
    operationId: requestId,
    accountId: 'account-1',
    organizationId: PERSONAL_ID,
    selection: ['ws-a', 'ws-b'],
    projects: ['ws-a', 'ws-b'].map((workspaceId) => ({
      workspaceId,
      stage: 'complete',
      outcome: 'moved',
    })),
    updatedAt: '2026-10-09T00:00:00.000Z',
  };
  await act(async () => {
    finish(completed);
    await Promise.resolve();
  });
  expect(port.invite).not.toHaveBeenCalled();
  const reopenedPort = makePort({ status: () => Promise.resolve(completed) });
  await render({
    target: { kind: 'personal', personalOrganizationId: REPLACEMENT_ID },
    accountKey: 'account-1',
    port: reopenedPort,
    recovery,
    onClose,
  });
  expect(
    byTestId('invite-to-organization-invite-outcome')?.getAttribute(
      'data-status',
    ),
  ).toBe('sent');
  expect(reopenedPort.invite).toHaveBeenCalledTimes(1);
  expect(reopenedPort.promote).not.toHaveBeenCalled();
  expect(reopenedPort.convert).not.toHaveBeenCalled();
});

it('allows closing a stalled critical submission after a bounded wait', async () => {
  jest.useFakeTimers();
  try {
    const onClose = jest.fn();
    const port = makePort({
      canBringProjects: false,
      promote: () => new Promise(() => {}),
    });
    await render({
      target: { kind: 'personal', personalOrganizationId: PERSONAL_ID },
      accountKey: 'account-1',
      port,
      onClose,
    });
    typeInto(byTestId('invite-to-organization-team-name'), 'Stalled team');
    click(byTestId('invite-to-organization-submit'));
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: InviteToOrganizationDialogProps): Promise<void> {
  await act(async () => {
    root.render(<InviteToOrganizationDialog {...props} />);
    await Promise.resolve();
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) throw new Error('input missing');
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(element: HTMLElement | null): void {
  if (!element) throw new Error('element missing');
  act(() => element.click());
}

const personalTarget = {
  kind: 'personal' as const,
  personalOrganizationId: PERSONAL_ID,
};

describe('InviteToOrganizationDialog', () => {
  it('asks for a name only, then creates the team with only the chosen projects', async () => {
    const port = makePort();
    const onPromoted = jest.fn();
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onPromoted,
      onClose: jest.fn(),
    });

    const submit = byTestId<HTMLButtonElement>('invite-to-organization-submit');
    expect(
      byTestId('invite-to-organization-project-ws-a-input'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('Projects to include');
    expect(document.body.textContent).toContain(
      'Work together in one shared place.',
    );
    expect(byTestId('invite-to-organization-consent')).toBeNull();
    expect(byTestId('invite-to-organization-consent-section')).toBeNull();
    expect(submit?.disabled).toBe(true);

    typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
    click(byTestId('invite-to-organization-project-ws-b-input'));
    expect(submit?.disabled).toBe(false);
    expect(submit?.textContent).toContain('Create team');

    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(port.promote).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: PERSONAL_ID, name: 'Acme' }),
    );
    expect(port.convert).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIds: ['ws-a'] }),
    );
    expect(port.invite).not.toHaveBeenCalled();
    const team = byTestId('invite-to-organization-team-created');
    expect(team?.textContent).toContain('Created Acme');
    expect(team?.getAttribute('data-step-status')).toBe('completed');
    const projects = byTestId('invite-to-organization-projects-step');
    expect(projects?.textContent).toContain('Moved 1 project to Acme');
    expect(projects?.getAttribute('data-step-status')).toBe('completed');
    // A clean move lists no per-project rows.
    expect(byTestId('invite-to-organization-outcome-ws-a')).toBeNull();
    expect(onPromoted).toHaveBeenCalledTimes(1);
    expect(byTestId('invite-to-organization-submit')).toBeNull();
    expect(byTestId('invite-to-organization-manage')).toBeNull();
    expect(byTestId('invite-to-organization-done')).not.toBeNull();
  });

  it('spins on the team row while it is created, then checks it off', async () => {
    let resolvePromote: (
      value: PersonalOrganizationPromotionOutcome,
    ) => void = () => {};
    let operationId = '';
    const port = makePort({
      canBringProjects: false,
      promote: jest.fn((request: { operationId: string }) => {
        operationId = request.operationId;
        return new Promise<PersonalOrganizationPromotionOutcome>((resolve) => {
          resolvePromote = resolve;
        });
      }),
    });
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onClose: jest.fn(),
    });
    typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
    typeInto(byTestId('invite-to-organization-email'), 'pat@example.com');
    await act(async () => {
      byTestId('invite-to-organization-submit')?.click();
      await Promise.resolve();
    });
    const creating = byTestId('invite-to-organization-team-creating');
    expect(creating?.textContent).toContain('Creating Acme');
    expect(creating?.getAttribute('data-step-status')).toBe('active');
    expect(
      byTestId('invite-to-organization-invite-sending')?.getAttribute(
        'data-step-status',
      ),
    ).toBe('pending');
    await act(async () => {
      resolvePromote(promotion(operationId));
      await Promise.resolve();
    });
    expect(
      byTestId('invite-to-organization-team-created')?.getAttribute(
        'data-step-status',
      ),
    ).toBe('completed');
    const invite = byTestId('invite-to-organization-invite-outcome');
    expect(invite?.textContent).toContain('Invited pat@example.com');
    expect(invite?.getAttribute('data-step-status')).toBe('completed');
  });

  it('invites more people into the new team, one checklist row each', async () => {
    const port = makePort({ canBringProjects: false });
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onClose: jest.fn(),
    });
    expect(byTestId('invite-to-organization-invite-more')).toBeNull();
    typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
    await act(async () => {
      byTestId('invite-to-organization-submit')?.click();
      await Promise.resolve();
    });
    const more = byTestId<HTMLInputElement>(
      'invite-to-organization-invite-more-email',
    );
    const send = byTestId<HTMLButtonElement>(
      'invite-to-organization-invite-more-submit',
    );
    expect(send?.disabled).toBe(true);
    typeInto(more, 'sam@example.com');
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.click();
      await Promise.resolve();
    });
    expect(port.invite).toHaveBeenCalledWith(PERSONAL_ID, {
      email: 'sam@example.com',
    });
    const row = byTestId('invite-to-organization-more-invite-0');
    expect(row?.textContent).toContain('Invited sam@example.com');
    // Session replay never records the address.
    expect(row?.querySelector('.ph-no-capture')?.textContent).toBe(
      'Invited sam@example.com',
    );
    expect(row?.getAttribute('data-step-status')).toBe('completed');
    expect(more?.value).toBe('');
  });

  it('finishes with Manage, which opens the new team and closes', async () => {
    const port = makePort({ canBringProjects: false });
    const onManage = jest.fn();
    const onClose = jest.fn();
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onManage,
      onClose,
    });
    typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
    await act(async () => {
      byTestId('invite-to-organization-submit')?.click();
      await Promise.resolve();
    });
    expect(byTestId('invite-to-organization-done')).toBeNull();
    const manage = byTestId<HTMLButtonElement>('invite-to-organization-manage');
    expect(manage?.textContent).toBe('Manage');
    click(manage);
    expect(onManage).toHaveBeenCalledWith(PERSONAL_ID);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the desktop note instead of a project list when projects cannot be brought', async () => {
    const port = makePort({ canBringProjects: false });
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onClose: jest.fn(),
    });
    expect(
      byTestId('invite-to-organization-projects-unavailable'),
    ).not.toBeNull();
    expect(port.listProjects).not.toHaveBeenCalled();
  });

  it('keeps a failed project list distinct from an empty one and lets the person continue', async () => {
    const port = makePort({
      listProjects: jest.fn(() => Promise.reject(new Error('offline'))),
    });
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onClose: jest.fn(),
    });
    expect(byTestId('invite-to-organization-projects-error')).not.toBeNull();
    expect(byTestId('invite-to-organization-projects-empty')).toBeNull();
    typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
    expect(
      byTestId<HTMLButtonElement>('invite-to-organization-submit')?.disabled,
    ).toBe(true);
    click(
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Continue without projects',
      ) ?? null,
    );
    expect(
      byTestId<HTMLButtonElement>('invite-to-organization-submit')?.disabled,
    ).toBe(false);
  });

  it('reports a refused promotion without leaving the form', async () => {
    const port = makePort({
      canBringProjects: false,
      promote: jest.fn(() => Promise.reject(new Error('boom'))),
    });
    await render({
      target: personalTarget,
      port,
      accountKey: 'account-1',
      onClose: jest.fn(),
    });
    typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
    await act(async () => {
      byTestId('invite-to-organization-submit')?.click();
      await Promise.resolve();
    });
    expect(byTestId('invite-to-organization-error')?.textContent).toBe(
      "Couldn't create the team. Try again.",
    );
    expect(byTestId('invite-to-organization-team-name')).not.toBeNull();
  });

  it.each(['invite_refused', 'no_saved_card'] as const)(
    'reports a failed invite (%s) after a committed promotion and retries only the invite',
    async (code) => {
      const invite = jest
        .fn()
        .mockRejectedValueOnce(
          new OrganizationOperationFailure(
            code === 'no_saved_card' ? code : 'down',
            code,
            409,
          ),
        )
        .mockResolvedValueOnce({
          status: 'email-suppressed',
          inviteId: INVITE_ID,
        });
      const port = makePort({ canBringProjects: false, invite });
      await render({
        target: personalTarget,
        port,
        accountKey: 'account-1',
        inviteRequired: true,
        onClose: jest.fn(),
      });
      typeInto(byTestId('invite-to-organization-team-name'), 'Acme');
      typeInto(byTestId('invite-to-organization-email'), 'pat@example.com');
      expect(byTestId('invite-to-organization-submit')?.textContent).toContain(
        'Create team and invite',
      );
      await act(async () => {
        byTestId('invite-to-organization-submit')?.click();
        await Promise.resolve();
      });
      expect(byTestId('invite-to-organization-team-created')).not.toBeNull();
      expect(byTestId('invite-to-organization-invite-failed')).not.toBeNull();
      if (code === 'no_saved_card') {
        // Free access: the flow never talks about payment.
        const text =
          byTestId('invite-to-organization-invite-failed')?.textContent ?? '';
        expect(text).toContain("Couldn't invite pat@example.com.");
        expect(text).not.toMatch(/payment|card|billing|no_saved_card/i);
      }
      await act(async () => {
        Array.from(document.querySelectorAll('button'))
          .find((button) => button.textContent === 'Try the invite again')
          ?.click();
        await Promise.resolve();
      });
      expect(port.promote).toHaveBeenCalledTimes(1);
      expect(
        byTestId('invite-to-organization-invite-outcome')?.getAttribute(
          'data-status',
        ),
      ).toBe('email-suppressed');
    },
  );

  it('invites into an existing team as a checklist, one row per person, then Manage', async () => {
    const port = makePort();
    const onManage = jest.fn();
    const onClose = jest.fn();
    await render({
      target: {
        kind: 'team',
        organizationId: TEAM_ID,
        organizationName: 'Acme',
      },
      port,
      accountKey: 'account-1',
      onManage,
      onClose,
    });
    expect(byTestId('invite-to-organization-create-team')).toBeNull();
    expect(document.body.textContent).toContain('Invite your team');
    expect(document.body.textContent).toContain('Invite by email');
    expect(byTestId('invite-to-organization-more-invite-0')).toBeNull();
    const field = byTestId<HTMLInputElement>(
      'invite-to-organization-invite-more-email',
    );
    const emails = ['pat@example.com', 'sam@example.com'];
    for (let index = 0; index < emails.length; index += 1) {
      const email = emails[index] ?? '';
      typeInto(field, email);
      await act(async () => {
        byTestId('invite-to-organization-invite-more-submit')?.click();
        await Promise.resolve();
      });
      const row = byTestId(`invite-to-organization-more-invite-${index}`);
      expect(row?.textContent).toContain(`Invited ${email}`);
      expect(row?.getAttribute('data-step-status')).toBe('completed');
    }
    expect(port.promote).not.toHaveBeenCalled();
    expect(port.invite).toHaveBeenNthCalledWith(1, TEAM_ID, {
      email: 'pat@example.com',
    });
    expect(port.invite).toHaveBeenNthCalledWith(2, TEAM_ID, {
      email: 'sam@example.com',
    });
    expect(document.body.textContent).toContain('Invite more people');
    expect(byTestId('invite-to-organization-done')).toBeNull();
    click(byTestId('invite-to-organization-manage'));
    expect(onManage).toHaveBeenCalledWith(TEAM_ID);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ends with Done for an existing team when the host has no Manage', async () => {
    const port = makePort();
    await render({
      target: {
        kind: 'team',
        organizationId: TEAM_ID,
        organizationName: 'Acme',
      },
      port,
      accountKey: 'account-1',
      onClose: jest.fn(),
    });
    expect(byTestId('invite-to-organization-done')).toBeNull();
    typeInto(
      byTestId('invite-to-organization-invite-more-email'),
      'pat@example.com',
    );
    await act(async () => {
      byTestId('invite-to-organization-invite-more-submit')?.click();
      await Promise.resolve();
    });
    expect(byTestId('invite-to-organization-manage')).toBeNull();
    expect(byTestId('invite-to-organization-done')).not.toBeNull();
  });
});
