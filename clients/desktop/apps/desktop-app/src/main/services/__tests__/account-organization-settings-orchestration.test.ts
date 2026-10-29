import { z } from 'zod';
import {
  SETTINGS_OPERATIONS,
  SettingsOperationError,
  defineSettingsWrite,
  settingsAcknowledgementSchema,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import { CanopyCloudClientError } from '../../canopy-cloud/client';
import type { PersonalOrganizationUpgradeService } from '../personal-organization-upgrade';
import {
  createSettingsOrchestratedOperations,
  createSettingsWriteFollowUps,
} from '../account-organization-settings-orchestration';

const mockRefreshMembership = jest.fn(() => Promise.resolve(false));
const mockWorkspaceIdle = jest.fn(() => Promise.resolve());
jest.mock('../../ipc/settings', () => ({
  reprobeAndApplyCanopyCloudEnforcedSettings: (): Promise<boolean> =>
    mockRefreshMembership(),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): { whenIdle(): Promise<void> } => ({
    whenIdle: mockWorkspaceIdle,
  }),
}));

const ORGANIZATION_ID = '6f1b8a36-5a1e-4c3c-9c51-1f7b5a8f0c11';
const OPERATION_ID = '9b2f3c4d-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

const promotionInput = z.strictObject({
  organizationId: z.string(),
  name: z.string(),
  operationId: z.string(),
});

const TEST_OPERATIONS = {
  'test.promote': defineSettingsWrite({
    transport: 'backend',
    input: promotionInput,
    result: z.looseObject({ organizationId: z.string() }),
    request: (input) => ({
      method: 'POST',
      path: `/api/account/organizations/${encodeURIComponent(input.organizationId)}/upgrade`,
      body: input,
    }),
  }),
  'test.rename': defineSettingsWrite({
    transport: 'backend',
    input: promotionInput,
    result: settingsAcknowledgementSchema,
    request: (input) => ({
      method: 'PATCH',
      path: `/api/account/organizations/${encodeURIComponent(input.organizationId)}`,
      body: input,
    }),
  }),
};

// The real organization entries, installed under their own names until the
// organization table is merged into SETTINGS_OPERATIONS.
const INSTALLED_OPERATIONS: Record<string, unknown> = {
  ...TEST_OPERATIONS,
  'organization.promote':
    ORGANIZATION_SETTINGS_OPERATIONS['organization.promote'],
  'organization.members.invite':
    ORGANIZATION_SETTINGS_OPERATIONS['organization.members.invite'],
};
const added: string[] = [];

beforeAll(() => {
  for (const [name, operation] of Object.entries(INSTALLED_OPERATIONS)) {
    if (Object.prototype.hasOwnProperty.call(SETTINGS_OPERATIONS, name))
      continue;
    Object.defineProperty(SETTINGS_OPERATIONS, name, {
      value: operation,
      configurable: true,
      enumerable: true,
    });
    added.push(name);
  }
});

afterAll(() => {
  for (const name of added) Reflect.deleteProperty(SETTINGS_OPERATIONS, name);
});

function operationName(name: string): SettingsOperationName {
  // The test entries are installed at runtime; the shipped table's names are
  // a closed union.
  return name as SettingsOperationName;
}

function service(
  promote: PersonalOrganizationUpgradeService['promote'],
): PersonalOrganizationUpgradeService {
  return { promote } as PersonalOrganizationUpgradeService;
}

const input = {
  organizationId: ORGANIZATION_ID,
  name: 'Team',
  operationId: OPERATION_ID,
};

describe('settings orchestration for existing desktop flows', () => {
  it('routes a promotion entry through the personal organization upgrade service', async () => {
    const promotion = {
      organizationId: ORGANIZATION_ID,
      name: 'Team',
      operationId: OPERATION_ID,
    };
    const promote = jest.fn().mockResolvedValue({
      promotion,
      warnings: [],
      contextSwitched: true,
    });
    const resolve = createSettingsOrchestratedOperations(() =>
      Promise.resolve(service(promote)),
    );
    const operation = resolve(operationName('test.promote'), input);
    expect(operation).not.toBeNull();
    await expect(operation?.()).resolves.toBe(promotion);
    expect(promote).toHaveBeenCalledWith(input);
  });

  it('routes the shipped organization.promote entry through the service', async () => {
    const promote = jest.fn().mockResolvedValue({
      promotion: { organizationId: ORGANIZATION_ID },
      warnings: [],
      contextSwitched: false,
    });
    const resolve = createSettingsOrchestratedOperations(() =>
      Promise.resolve(service(promote)),
    );
    await expect(
      resolve(operationName('organization.promote'), input)?.(),
    ).resolves.toEqual({ organizationId: ORGANIZATION_ID });
    expect(promote).toHaveBeenCalledWith(input);
    // Invitations keep the session route: their reply shape differs from the
    // upgrade service's, and no desktop orchestration follows them.
    expect(
      resolve(operationName('organization.members.invite'), {
        organizationId: ORGANIZATION_ID,
        email: 'new@example.com',
      }),
    ).toBeNull();
  });

  it('leaves other entries to the bridge session', () => {
    const resolve = createSettingsOrchestratedOperations(() =>
      Promise.resolve(service(jest.fn())),
    );
    expect(resolve(operationName('test.rename'), input)).toBeNull();
    expect(resolve('settings.bootstrap', {})).toBeNull();
  });

  it('maps a server refusal to a settings error', async () => {
    const promote = jest
      .fn()
      .mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Forbidden', 403, 'not_owner'),
      );
    const resolve = createSettingsOrchestratedOperations(() =>
      Promise.resolve(service(promote)),
    );
    const failure: unknown = await resolve(
      operationName('test.promote'),
      input,
    )?.().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SettingsOperationError);
    expect(failure).toMatchObject({
      code: 'forbidden',
      status: 403,
      serverCode: 'not_owner',
    });
  });

  it('reports the service identity fence as expired', async () => {
    const promote = jest.fn().mockRejectedValue(new Error('account-changed'));
    const resolve = createSettingsOrchestratedOperations(() =>
      Promise.resolve(service(promote)),
    );
    await expect(
      resolve(operationName('test.promote'), input)?.(),
    ).rejects.toMatchObject({ code: 'expired' });
  });
});

describe('settings membership write follow-ups', () => {
  it.each([
    ['organization.create', { name: 'Team' }],
    ['organization.delete', { organizationId: ORGANIZATION_ID }],
    ['organization.leave', { organizationId: ORGANIZATION_ID }],
    [
      'organization.invitations.respond',
      { inviteId: OPERATION_ID, action: 'accept' },
    ],
  ] as const)('refreshes membership for %s', async (name, input) => {
    const refresh = jest.fn(() => Promise.resolve());
    const followUp = createSettingsWriteFollowUps(refresh)(name, input);
    expect(followUp).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    await followUp?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'organization.invitations.respond',
      { inviteId: OPERATION_ID, action: 'decline' },
    ],
    ['organization.invitations.respond', { action: 'accept' }],
    ['organization.rename', { organizationId: ORGANIZATION_ID, name: 'Team' }],
    [
      'organization.members.invite',
      { organizationId: ORGANIZATION_ID, email: 'new@example.com' },
    ],
    ['organization.promote', input],
    ['settings.bootstrap', {}],
  ] as const)('does not add a refresh for %s', (name, input) => {
    expect(createSettingsWriteFollowUps(jest.fn())(name, input)).toBeNull();
  });
});

it('the production follow-up awaits account synchronization before workspace context idle', async () => {
  let finish!: (refreshed: boolean) => void;
  mockRefreshMembership.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  mockWorkspaceIdle.mockClear();
  const followUp = createSettingsWriteFollowUps()('organization.create', {
    name: 'Team',
  });
  const pending = followUp?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockRefreshMembership).toHaveBeenCalledTimes(1);
  expect(mockWorkspaceIdle).not.toHaveBeenCalled();
  finish(true);
  await pending;
  expect(mockWorkspaceIdle).toHaveBeenCalledTimes(1);
});
