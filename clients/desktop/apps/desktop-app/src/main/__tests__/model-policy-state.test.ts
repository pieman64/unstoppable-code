import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';

const mockReadAccount = jest.fn<Promise<unknown>, []>();
const mockRecordAppDiagnostic = jest.fn();
const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockAtomicWrite = jest.fn<Promise<void>, [string, string, unknown]>();
let mockOrganizationProjectsEnabled = true;

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn((): Promise<void> => Promise.resolve()),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: (
    path: string,
    contents: string,
    options: unknown,
  ): Promise<void> => mockAtomicWrite(path, contents, options),
}));
jest.mock('../lib/paths', () => ({
  getModelPolicyMarkerFilePath: (): string =>
    '/mock/data-dir/model-policy-marker.json',
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> => mockReadAccount(),
  toPublicCanopyCloudAccountState: (entry: unknown): unknown => entry,
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: typeof mockRecordAppDiagnostic;
  } => ({ recordAppDiagnostic: mockRecordAppDiagnostic }),
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => mockOrganizationProjectsEnabled,
  }),
}));

import {
  isModelBlockedByCurrentPolicy,
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
  resetModelPolicyStateForTests,
  setCurrentModelPolicyAccount,
} from '../lib/model-policy-state';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const personal = { kind: 'personal' as const };
const owner = (organizationId: string): WorkOwner => ({
  kind: 'organization' as const,
  organizationId,
});

function account(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    organizations: [
      {
        id: ORG_A,
        name: 'Acme',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: ORG_B,
        name: 'Beta',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: ORG_C,
        name: 'Gamma',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    teams: [],
    storageAvailable: true,
    enforcedSettings: [
      {
        organizationId: ORG_A,
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-policy' as const,
            blockedModelIds: ['openai/blocked'],
            reviewedModelIds: ['openai/blocked'],
          },
        ],
      },
      {
        organizationId: ORG_B,
        organizationName: 'Beta',
        policies: [],
      },
    ],
  };
}

function marker(value: unknown): void {
  mockReadFile.mockResolvedValue(JSON.stringify(value));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrganizationProjectsEnabled = true;
  resetModelPolicyStateForTests();
  mockReadFile.mockRejectedValue(new Error('missing'));
  mockAtomicWrite.mockResolvedValue(undefined);
});

it('keeps unknown-owner checks conservative without diagnostics when organization projects are disabled', async () => {
  mockOrganizationProjectsEnabled = false;
  mockReadAccount.mockResolvedValue({ status: 'ok', entry: account() });

  await expect(isModelBlockedByStoredPolicy('openai/blocked')).resolves.toBe(
    true,
  );
  expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
});

it('applies a readable policy only to the owning organization', async () => {
  mockReadAccount.mockResolvedValue({ status: 'ok', entry: account() });
  await expect(
    isModelBlockedByStoredPolicy('openai/blocked', owner(ORG_A)),
  ).resolves.toBe(true);
  await expect(
    isModelBlockedByStoredPolicy('openai/blocked', owner(ORG_B)),
  ).resolves.toBe(false);
  await expect(
    isModelBlockedByStoredPolicy('openai/blocked', personal),
  ).resolves.toBe(false);
  await expect(isModelBlockedByStoredPolicy('openai/blocked')).resolves.toBe(
    true,
  );
});

it('rate-limits repeated unknown-owner diagnostics by call site', async () => {
  const nowSpy = jest.spyOn(Date, 'now');
  nowSpy.mockReturnValue(1_000);
  mockReadAccount.mockResolvedValue({ status: 'ok', entry: account() });

  await isModelBlockedByStoredPolicy('openai/model');
  await isModelBlockedByStoredPolicy('openai/model');
  nowSpy.mockReturnValue(301_001);
  await isModelBlockedByStoredPolicy('openai/model');

  expect(mockRecordAppDiagnostic.mock.calls).toEqual([
    [expect.objectContaining({ kind: 'model_enforcement_owner_unknown' })],
    [expect.objectContaining({ kind: 'model_enforcement_owner_unknown' })],
  ]);
  nowSpy.mockRestore();
});

it('writes an atomic v1 marker with governed and ungoverned org ids', async () => {
  mockReadAccount.mockResolvedValue({ status: 'ok', entry: account() });
  await isModelBlockedByStoredPolicy('openai/blocked', owner(ORG_A));
  expect(mockAtomicWrite).toHaveBeenCalledWith(
    '/mock/data-dir/model-policy-marker.json',
    expect.stringContaining(`"governedOrganizationIds": [\n    "${ORG_A}"`),
    expect.objectContaining({ encoding: 'utf8', mode: 0o600 }),
  );
  expect(mockAtomicWrite.mock.calls[0]?.[1]).toContain(
    `"ungovernedOrganizationIds": [\n    "${ORG_B}"`,
  );
  expect(mockAtomicWrite.mock.calls[0]?.[1]).toContain(`"${ORG_C}"`);
});

it('keeps a known organization without an enforced-settings row unrestricted after a read failure', async () => {
  mockReadAccount
    .mockResolvedValueOnce({ status: 'ok', entry: account() })
    .mockResolvedValueOnce({ status: 'unavailable' })
    .mockResolvedValueOnce({ status: 'unavailable' });

  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_C)),
  ).resolves.toBe(false);
  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_C)),
  ).resolves.toBe(false);
  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_D)),
  ).resolves.toBe(true);
});

it('uses the attributable degraded marker matrix', async () => {
  marker({
    version: 1,
    orgEnforced: true,
    governedOrganizationIds: [ORG_A],
    ungovernedOrganizationIds: [ORG_B],
  });
  mockReadAccount.mockResolvedValue({ status: 'unavailable' });

  await expect(
    isModelBlockedByStoredPolicy('openai/model', personal),
  ).resolves.toBe(false);
  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_B)),
  ).resolves.toBe(false);
  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_A)),
  ).resolves.toBe(true);
  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_C)),
  ).resolves.toBe(true);
  await expect(isModelBlockedByStoredPolicy('openai/model')).resolves.toBe(
    true,
  );
});

it('keeps legacy v1 markers closed for org-owned and unknown work', async () => {
  marker({ version: 1, orgEnforced: true });
  mockReadAccount.mockResolvedValue({ status: 'unavailable' });
  await expect(
    isModelBlockedByStoredPolicy('openai/model', personal),
  ).resolves.toBe(false);
  await expect(
    isModelBlockedByStoredPolicy('openai/model', owner(ORG_A)),
  ).resolves.toBe(true);
  await expect(isModelBlockedByStoredPolicy('openai/model')).resolves.toBe(
    true,
  );
});

it('never blocks Ollama and reports owner-scoped policy activity', async () => {
  mockReadAccount.mockResolvedValue({ status: 'ok', entry: account() });
  await expect(
    isModelBlockedByStoredPolicy('ollama-llama3', owner(ORG_A)),
  ).resolves.toBe(false);
  await expect(
    isOrgModelPolicyActiveForStoredAccount(owner(ORG_A)),
  ).resolves.toBe(true);
  await expect(
    isOrgModelPolicyActiveForStoredAccount(owner(ORG_B)),
  ).resolves.toBe(false);
});

it('projects the current policy by owner', () => {
  setCurrentModelPolicyAccount(account());
  expect(isModelBlockedByCurrentPolicy('openai/blocked', owner(ORG_A))).toBe(
    true,
  );
  expect(isModelBlockedByCurrentPolicy('openai/blocked', owner(ORG_B))).toBe(
    false,
  );
  expect(isModelBlockedByCurrentPolicy('openai/blocked', personal)).toBe(false);
});
