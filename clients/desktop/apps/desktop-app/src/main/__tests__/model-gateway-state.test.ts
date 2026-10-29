import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CanopyOrgEnforcedSettings } from '@canopy/desktop-shared/types';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn((): Promise<void> => Promise.resolve()),
  readFile: jest.fn(),
}));
jest.mock('../lib/atomic-file', () => ({ writeFileAtomically: jest.fn() }));
jest.mock('../lib/paths', () => ({
  getModelGatewayMarkerFilePath: (): string =>
    '/mock/model-gateway-marker.json',
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));

const mockAccountRead = jest.fn<Promise<unknown>, []>();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> => mockAccountRead(),
  toPublicCanopyCloudAccountState: (entry: unknown): unknown => entry,
}));
const mockCatalogUpdate = jest.fn<void, [unknown]>();
jest.mock('../lib/model-config', () => ({
  updateOrgGatewayModelCatalog: (gateways: unknown): void =>
    mockCatalogUpdate(gateways),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: jest.Mock } => ({
    recordAppDiagnostic: jest.fn(),
  }),
}));

import { readFile } from 'node:fs/promises';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  initAiGatewayModels,
  initClaudeModels,
} from '@canopy/desktop-shared/types';
import {
  checkModelGatewayRoute,
  getModelGatewayRequirementForOwner,
  resolveHelperModelForEnforcedGateway,
  resetModelGatewayStateForTests,
  setCurrentModelGatewayAccount,
} from '../lib/model-gateway-state';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const personal = { kind: 'personal' as const };
const owner = (organizationId: string): WorkOwner => ({
  kind: 'organization' as const,
  organizationId,
});

function org(
  organizationId: string,
  enforced: boolean,
  unavailable = false,
): CanopyOrgEnforcedSettings {
  return {
    organizationId,
    organizationName: organizationId === ORG_A ? 'Acme' : 'Beta',
    ...(unavailable
      ? { modelGatewayEnforcementUnavailable: true as const }
      : {}),
    policies: [
      {
        kind: 'model-gateway' as const,
        baseUrl: `https://${organizationId}.example.test`,
        models: [
          {
            id: `${organizationId}-model`,
            gatewayId: `${organizationId}/model`,
            label: 'Org model',
            harness: 'claude' as const,
            contextWindow: 100_000,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard' as const,
          },
        ],
        enforced,
        promptCachePassthrough: true,
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetModelGatewayStateForTests();
  jest.mocked(writeFileAtomically).mockResolvedValue(undefined);
  jest.mocked(readFile).mockRejectedValue(new Error('missing'));
});

it('publishes every available organization gateway and reports changed org ids', () => {
  const result = setCurrentModelGatewayAccount({
    enforcedSettings: [org(ORG_A, true), org(ORG_B, false)],
  });
  expect(result).toEqual({
    changed: true,
    changedOrganizationIds: [ORG_A, ORG_B],
  });
  expect(mockCatalogUpdate).toHaveBeenCalledWith([
    expect.objectContaining({ organizationId: ORG_A }),
    expect.objectContaining({ organizationId: ORG_B }),
  ]);
});

it('scopes readable requirements to A, B, and Personal', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { enforcedSettings: [org(ORG_A, true), org(ORG_B, false)] },
  });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_A)),
  ).resolves.toEqual({
    kind: 'enforced',
    organizationIds: [ORG_A],
  });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_B)),
  ).resolves.toEqual({
    kind: 'unrestricted',
  });
  await expect(getModelGatewayRequirementForOwner(personal)).resolves.toEqual({
    kind: 'unrestricted',
  });
});

it('blocks only the affected org for attributable unavailability', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: {
      enforcedSettings: [org(ORG_A, false, true), org(ORG_B, false)],
    },
  });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_A)),
  ).resolves.toEqual({
    kind: 'blocked',
    reason: 'organization-unavailable',
  });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_B)),
  ).resolves.toEqual({
    kind: 'unrestricted',
  });
  await expect(getModelGatewayRequirementForOwner(personal)).resolves.toEqual({
    kind: 'unrestricted',
  });
});

it('keeps a known organization without an enforced-settings row unrestricted after a read failure', async () => {
  mockAccountRead
    .mockResolvedValueOnce({
      status: 'ok',
      entry: {
        organizations: [
          {
            id: ORG_A,
            name: 'Acme',
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
        enforcedSettings: [org(ORG_A, true)],
      },
    })
    .mockResolvedValueOnce({ status: 'unavailable' });

  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_C)),
  ).resolves.toEqual({ kind: 'unrestricted' });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_C)),
  ).resolves.toEqual({ kind: 'unrestricted' });
});

it('keeps every known organization closed after an account-level outage becomes unreadable', async () => {
  setCurrentModelGatewayAccount({
    enforcedSettings: [org(ORG_A, true), org(ORG_B, false)],
    modelGatewayEnforcementUnavailable: true,
  });
  mockAccountRead.mockResolvedValue({ status: 'unavailable' });

  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_A)),
  ).resolves.toEqual({
    kind: 'blocked',
    reason: 'organization-unavailable',
  });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_B)),
  ).resolves.toEqual({
    kind: 'blocked',
    reason: 'organization-unavailable',
  });
  await expect(getModelGatewayRequirementForOwner(personal)).resolves.toEqual({
    kind: 'unrestricted',
  });
});

it('keeps a legacy marker closed for org and unknown work but open for Personal', async () => {
  jest
    .mocked(readFile)
    .mockResolvedValue(JSON.stringify({ version: 1, orgEnforced: true }));
  mockAccountRead.mockResolvedValue({ status: 'unavailable' });
  await expect(
    getModelGatewayRequirementForOwner(owner(ORG_A)),
  ).resolves.toMatchObject({
    kind: 'blocked',
  });
  resetModelGatewayStateForTests();
  jest
    .mocked(readFile)
    .mockResolvedValue(JSON.stringify({ version: 1, orgEnforced: true }));
  await expect(getModelGatewayRequirementForOwner(personal)).resolves.toEqual({
    kind: 'unrestricted',
  });
});

it('refuses another org route and substitutes helpers only from the owner org', async () => {
  initClaudeModels([{ id: 'opus', label: 'Opus' }]);
  initAiGatewayModels(
    [ORG_A, ORG_B].map((organizationId) => ({
      id: `${organizationId}-model`,
      label: 'Org model',
      supportedThinkingLevels: [],
    })),
    [ORG_A, ORG_B].map((organizationId) => ({
      modelId: `${organizationId}-model`,
      gatewayId: `${organizationId}/model`,
      family: 'custom',
      recommendedHarness: 'claude',
      gatewayOnly: true,
      contextWindow: 100_000,
      supportsPromptCaching: true,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard',
      origin: 'org-gateway',
      baseUrl: `https://${organizationId}.example.test`,
      organizationId,
      promptCachePassthrough: true,
    })),
  );
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { enforcedSettings: [org(ORG_A, true), org(ORG_B, true)] },
  });
  await expect(
    checkModelGatewayRoute(`${ORG_B}-model`, owner(ORG_A)),
  ).resolves.toEqual({
    ok: false,
    message: "This model belongs to another organization's gateway.",
  });
  await expect(
    resolveHelperModelForEnforcedGateway('opus', owner(ORG_A)),
  ).resolves.toBe(`${ORG_A}-model`);
});

it('does not name a guessed organization when multiple gateways enforce unknown work', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { enforcedSettings: [org(ORG_A, true), org(ORG_B, true)] },
  });

  await expect(checkModelGatewayRoute('opus', undefined)).resolves.toEqual({
    ok: false,
    message:
      'Your organization requires model traffic to use its configured gateway.',
  });
});
