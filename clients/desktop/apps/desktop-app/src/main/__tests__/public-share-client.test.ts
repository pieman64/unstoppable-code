const mockAgentContextEnabled = jest.fn(() => false);
const mockGetContextAgent = jest.fn();
jest.mock('../agents/resource-lanes', () => ({
  get agentResourceContextEnabled(): typeof mockAgentContextEnabled {
    return mockAgentContextEnabled;
  },
}));
jest.mock('../agents/canopy-server-client', () => ({
  get getSharedAgent(): typeof mockGetContextAgent {
    return mockGetContextAgent;
  },
}));
const mockSkillContextEnabled = jest.fn(() => false);
const mockGetContextSkill = jest.fn();
jest.mock('../skills/resource-lanes', () => ({
  get skillResourceContextEnabled(): typeof mockSkillContextEnabled {
    return mockSkillContextEnabled;
  },
}));
jest.mock('../skills/canopy-server-client', () => ({
  get getSharedSkill(): typeof mockGetContextSkill {
    return mockGetContextSkill;
  },
}));
const mockPipelineContextEnabled = jest.fn(() => false);
const mockGetContextPipeline = jest.fn();
jest.mock('../pipelines/resource-lanes', () => ({
  get pipelineResourceContextEnabled(): typeof mockPipelineContextEnabled {
    return mockPipelineContextEnabled;
  },
}));
jest.mock('../pipelines/canopy-server-client', () => ({
  get getSharedPipeline(): typeof mockGetContextPipeline {
    return mockGetContextPipeline;
  },
}));
import type * as CanopyCloudClientModule from '../canopy-cloud/client';

const requestPublicJson = jest.fn();
const requestAuthenticatedJson = jest.fn();

jest.mock('../canopy-cloud/client', () => {
  const actual = jest.requireActual<typeof CanopyCloudClientModule>(
    '../canopy-cloud/client',
  );
  return {
    ...actual,
    get requestCanopyCloudPublicJson(): typeof requestPublicJson {
      return requestPublicJson;
    },
    get requestCanopyCloudJson(): typeof requestAuthenticatedJson {
      return requestAuthenticatedJson;
    },
  };
});

import { ResourceContextUnavailableError } from '../lib/resource-context-error';
import { resolveShareSnapshot } from '../ipc/deep-link';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  getPublicAgentShareSnapshot,
  getPublicAutomationShareSnapshot,
  getPublicPipelineShareSnapshot,
  getPublicSkillShareSnapshot,
  getPublicWorkspaceTemplateSnapshot,
  getScopedAgentShareSnapshot,
  getScopedSkillShareSnapshot,
} from '../canopy-cloud/public-share-client';
import { listPublisherSkills } from '../canopy-cloud/publisher-skill-catalog';

import { PIPELINE_PACKAGE_CLIENT_VERSION } from '@canopy/protocol/pipelines';
import type {
  PublicSkillShareSnapshot,
  SharedSkillDetail,
} from '@canopy/protocol';

const CLIENT_VERSION = String(PIPELINE_PACKAGE_CLIENT_VERSION);

const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
const PUBLISHER_UUID = '2f0c9a1e-4b3d-5f6a-8c2e-1d5b7a9e0c4f';

const scopedSkill: SharedSkillDetail = {
  id: UUID,
  name: 'Team helper',
  description: 'Internal helper',
  rawSkill: '# Team helper',
  contentHash: 'skill-hash',
  shareScope: 'organization',
  owner: { type: 'organization', id: 'org-acme', name: 'Acme' },
  createdBy: { id: 'sharer', name: 'Lena Park', email: null },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
  publicShare: null,
};

describe('public share client scoped fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPipelineContextEnabled.mockReturnValue(false);
    mockSkillContextEnabled.mockReturnValue(false);
    mockAgentContextEnabled.mockReturnValue(false);
    requestPublicJson.mockReset();
    requestAuthenticatedJson.mockReset();
  });

  describe.each([false, true])('skill context flag %s', (enabled) => {
    beforeEach(() => {
      mockSkillContextEnabled.mockReturnValue(enabled);
    });

    it.each(['organization', 'team'] as const)(
      'forwards authenticated %s provenance through direct and public-fallback reads',
      async (shareScope) => {
        const detail: SharedSkillDetail = {
          ...scopedSkill,
          shareScope,
          owner:
            shareScope === 'team'
              ? {
                  type: 'team',
                  id: 'team-platform',
                  name: 'Platform',
                  organization: { id: 'org-acme', name: 'Acme' },
                }
              : scopedSkill.owner,
        };
        mockGetContextSkill.mockResolvedValue(detail);
        requestAuthenticatedJson.mockResolvedValue(detail);
        const snapshot = await getScopedSkillShareSnapshot(UUID);
        expect(snapshot).toMatchObject({
          scopedShare: true,
          authorUsername: null,
          sharedBy: {
            name: 'Lena Park',
            owner: detail.owner,
            shareScope,
          },
        });
        expect(snapshot.sourceRemoteId).toBe(enabled ? UUID : undefined);
        expect(requestPublicJson).not.toHaveBeenCalled();
        if (enabled) {
          expect(mockGetContextSkill).toHaveBeenCalledWith(UUID);
          expect(requestAuthenticatedJson).not.toHaveBeenCalled();
        } else {
          expect(mockGetContextSkill).not.toHaveBeenCalled();
          expect(requestAuthenticatedJson).toHaveBeenCalledWith(
            `/api/v1/desktop-app/skills/${UUID}`,
            { headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION } },
          );
        }
        requestPublicJson.mockRejectedValue(
          new CanopyCloudClientError('http-error', 'Not found', 404),
        );
        await expect(getPublicSkillShareSnapshot(UUID)).resolves.toEqual(
          snapshot,
        );
      },
    );

    it.each([null, '', '   '])(
      'preserves an unavailable sharer name %j',
      async (name) => {
        const detail: SharedSkillDetail = {
          ...scopedSkill,
          createdBy: { ...scopedSkill.createdBy, name },
        };
        mockGetContextSkill.mockResolvedValue(detail);
        requestAuthenticatedJson.mockResolvedValue(detail);
        await expect(getScopedSkillShareSnapshot(UUID)).resolves.toMatchObject({
          sharedBy: { name, owner: detail.owner, shareScope: 'organization' },
        });
      },
    );

    it('omits provenance whose owner predates the unified owner shape', async () => {
      // Servers before CAN-2961 sent a team owner without its organization;
      // the review must fall back rather than read through a missing parent.
      const detail = {
        ...scopedSkill,
        shareScope: 'team',
        owner: { type: 'team', id: 'team-platform', name: 'Platform' },
      };
      mockGetContextSkill.mockResolvedValue(detail);
      requestAuthenticatedJson.mockResolvedValue(detail);
      const snapshot = await getScopedSkillShareSnapshot(UUID);
      expect(snapshot).toMatchObject({ scopedShare: true, externalId: UUID });
      expect(snapshot).not.toHaveProperty('sharedBy');
    });

    it.each(['private', 'public', 'TEAM', '', undefined, null])(
      'rejects invalid scoped audience %j through the existing not-found paths',
      async (shareScope) => {
        const detail = { ...scopedSkill, shareScope };
        mockGetContextSkill.mockResolvedValue(detail);
        requestAuthenticatedJson.mockResolvedValue(detail);
        await expect(getScopedSkillShareSnapshot(UUID)).rejects.toMatchObject({
          code: 'http-error',
          status: 404,
        });
        const publicError = new CanopyCloudClientError(
          'http-error',
          'Not found',
          404,
        );
        requestPublicJson.mockRejectedValue(publicError);
        await expect(getPublicSkillShareSnapshot(UUID)).rejects.toMatchObject({
          code: 'http-error',
          status: 404,
        });
      },
    );
  });

  it('preserves public attribution and publisher fields without a scoped read', async () => {
    const snapshot: PublicSkillShareSnapshot = {
      entity: 'skill',
      externalId: UUID,
      name: scopedSkill.name,
      description: scopedSkill.description,
      rawSkill: scopedSkill.rawSkill,
      contentHash: scopedSkill.contentHash,
      dependencies: [],
      authorUsername: 'morgan',
      publisher: {
        name: 'Publisher',
        sourceUrl: 'https://example.com/skills',
        license: 'MIT',
        pluginName: 'Guide',
      },
      updatedAt: scopedSkill.updatedAt,
    };
    requestPublicJson.mockResolvedValue(snapshot);
    await expect(getPublicSkillShareSnapshot(UUID)).resolves.toBe(snapshot);
    expect(snapshot).not.toHaveProperty('sharedBy');
    expect(mockGetContextSkill).not.toHaveBeenCalled();
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it('loads publisher discovery anonymously without downloading skill contents', async () => {
    const row = {
      externalId: PUBLISHER_UUID,
      name: 'guide',
      description: 'A guide',
      publisher: 'Anthropic',
    };
    requestPublicJson.mockResolvedValue({ skills: [row] });
    await expect(listPublisherSkills()).resolves.toEqual([row]);
    expect(requestPublicJson).toHaveBeenCalledWith(
      '/api/v1/marketplace/skills',
    );
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { skills: 'invalid' },
    {
      skills: [
        {
          externalId: UUID,
          name: 'guide',
          description: 'A guide',
          publisher: 'Anthropic',
        },
      ],
    },
    {
      skills: [
        {
          externalId: '2f0c9a1e-4b3d-5f6a-7c2e-1d5b7a9e0c4f',
          name: 'guide',
          description: 'A guide',
          publisher: 'Anthropic',
        },
      ],
    },
    {
      skills: [
        {
          externalId: '../../escape',
          name: 'guide',
          description: '',
          publisher: 'Anthropic',
        },
      ],
    },
    {
      skills: [
        {
          externalId: UUID,
          name: 'guide',
          description: {},
          publisher: 'Anthropic',
        },
      ],
    },
  ])('rejects malformed publisher catalog responses: %j', async (response) => {
    requestPublicJson.mockResolvedValue(response);
    await expect(listPublisherSkills()).rejects.toThrow(
      'Invalid publisher skill catalog.',
    );
  });

  it('resolves a scoped agent through the checked client and carries its identity', async () => {
    mockAgentContextEnabled.mockReturnValue(true);
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    mockGetContextAgent.mockResolvedValue({
      id: UUID,
      shareScope: 'organization',
      agent: { id: 'agent_model_org' },
      contentHash: 'hash',
      updatedAt: 'today',
    });
    await expect(getPublicAgentShareSnapshot(UUID)).resolves.toMatchObject({
      sourceRemoteId: UUID,
      entity: 'agent',
    });
    expect(mockGetContextAgent).toHaveBeenCalledWith(UUID);
  });
  // The landing reviews a package only when the snapshot carries one, and the
  // install follows the scoped Agent, which brings its package along.
  it('carries a scoped agent package into the snapshot the landing reviews', async () => {
    const agentPackage = {
      version: 1,
      digest: `pp:v1:${'A'.repeat(43)}`,
      resources: [],
      environmentRequirements: [],
      totalFiles: 1,
      totalBytes: 12,
    };
    mockGetContextAgent.mockResolvedValue({
      id: UUID,
      shareScope: 'team',
      agent: { id: 'agent_model_team' },
      contentHash: 'hash',
      distributionMode: 'package',
      package: agentPackage,
      updatedAt: 'today',
    });
    await expect(getScopedAgentShareSnapshot(UUID)).resolves.toMatchObject({
      sourceRemoteId: UUID,
      entity: 'agent',
      distributionMode: 'package',
      package: agentPackage,
    });
    expect(requestPublicJson).not.toHaveBeenCalled();
  });
  it('refuses a scoped agent deep link when the main policy denies it', async () => {
    mockAgentContextEnabled.mockReturnValue(true);
    const unavailable = new CanopyCloudClientError(
      'http-error',
      'Not found',
      404,
    );
    requestPublicJson.mockRejectedValue(unavailable);
    const policyError = new ResourceContextUnavailableError('context-mismatch');
    mockGetContextAgent.mockRejectedValue(policyError);
    await expect(getPublicAgentShareSnapshot(UUID)).rejects.toBe(policyError);
    expect(mockGetContextAgent).toHaveBeenCalledWith(UUID);
  });
  it('refuses a scoped skill deep link when policy denies it', async () => {
    mockSkillContextEnabled.mockReturnValue(true);
    const unavailable = new CanopyCloudClientError(
      'http-error',
      'Not found',
      404,
    );
    requestPublicJson.mockRejectedValue(unavailable);
    const policyError = new ResourceContextUnavailableError('context-mismatch');
    mockGetContextSkill.mockRejectedValue(policyError);
    await expect(getPublicSkillShareSnapshot(UUID)).rejects.toBe(policyError);
    expect(mockGetContextSkill).toHaveBeenCalledWith(UUID);
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it('falls back to an authenticated team skill when no public snapshot exists', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    requestAuthenticatedJson.mockResolvedValue({
      ...scopedSkill,
      id: UUID,
      name: 'Team helper',
      description: 'Internal helper',
      rawSkill: '# Team helper',
      contentHash: 'skill-hash',
      shareScope: 'team',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    await expect(getPublicSkillShareSnapshot(UUID)).resolves.toMatchObject({
      entity: 'skill',
      externalId: UUID,
      name: 'Team helper',
      rawSkill: '# Team helper',
      contentHash: 'skill-hash',
    });
    expect(requestAuthenticatedJson).toHaveBeenCalledWith(
      `/api/v1/desktop-app/skills/${UUID}`,
      { headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION } },
    );
  });

  it('falls back to an authenticated organization pipeline when no public snapshot exists', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    requestAuthenticatedJson.mockResolvedValue({
      id: UUID,
      name: 'Release',
      description: 'Internal release',
      rawPipeline: 'pipeline:\n  name: Release',
      shareScope: 'organization',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    await expect(getPublicPipelineShareSnapshot(UUID)).resolves.toMatchObject({
      entity: 'pipeline',
      externalId: UUID,
      name: 'Release',
      rawPipeline: 'pipeline:\n  name: Release',
    });
    expect(requestAuthenticatedJson).toHaveBeenCalledWith(
      `/api/v1/desktop-app/pipelines/${UUID}`,
    );
  });

  it('refuses a scoped pipeline deep link when main context policy denies it', async () => {
    mockPipelineContextEnabled.mockReturnValue(true);
    const unavailable = new CanopyCloudClientError(
      'http-error',
      'Not found',
      404,
    );
    requestPublicJson.mockRejectedValue(unavailable);
    const policyError = new ResourceContextUnavailableError('context-mismatch');
    mockGetContextPipeline.mockRejectedValue(policyError);
    await expect(getPublicPipelineShareSnapshot(UUID)).rejects.toBe(
      policyError,
    );
    expect(mockGetContextPipeline).toHaveBeenCalledWith(UUID);
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it.each([
    ['pipeline', 'Workflow unavailable (context-mismatch)'],
    ['pipeline', 'Workflow unavailable (access-removed)'],
    ['skill', 'Skill unavailable (context-mismatch)'],
    ['agent', 'Agent unavailable (unknown-provenance)'],
  ] as const)(
    'resolves a %s lane refusal (%s) as an unavailable share',
    async (entity, message) => {
      mockPipelineContextEnabled.mockReturnValue(true);
      mockSkillContextEnabled.mockReturnValue(true);
      mockAgentContextEnabled.mockReturnValue(true);
      requestPublicJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Not found', 404),
      );
      const refusal = new Error(message);
      mockGetContextPipeline.mockRejectedValue(refusal);
      mockGetContextSkill.mockRejectedValue(refusal);
      mockGetContextAgent.mockRejectedValue(refusal);
      await expect(
        resolveShareSnapshot({
          entity,
          externalId: UUID,
          audience: 'ORGANIZATION',
        }),
      ).resolves.toEqual({ ok: false, reason: 'not-found' });
    },
  );

  it('retries a pipeline snapshot with version 1 when an older server requires it', async () => {
    requestPublicJson
      .mockRejectedValueOnce(
        Object.assign(
          new CanopyCloudClientError(
            'http-error',
            'Update the desktop app to install this pipeline package.',
            426,
            'pipeline_package_client_upgrade_required',
          ),
          { requiredPackageVersion: 1 },
        ),
      )
      .mockResolvedValueOnce({ entity: 'pipeline', externalId: UUID });

    await expect(getPublicPipelineShareSnapshot(UUID)).resolves.toMatchObject({
      entity: 'pipeline',
      externalId: UUID,
    });
    expect(requestPublicJson).toHaveBeenNthCalledWith(1, expect.any(String), {
      headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION },
    });
    expect(requestPublicJson).toHaveBeenNthCalledWith(2, expect.any(String), {
      headers: { 'X-Pipeline-Package-Version': '1' },
    });
  });

  it('does not fall back on a public endpoint transport failure', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('network-error', 'Offline'),
    );

    await expect(getPublicSkillShareSnapshot(UUID)).rejects.toMatchObject({
      code: 'network-error',
    });
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it('forwards the reviewed workspace-template hash to the public snapshot route', async () => {
    requestPublicJson.mockResolvedValue({ entity: 'workspace' });
    const hash = 'a'.repeat(64);

    await getPublicWorkspaceTemplateSnapshot(UUID, hash);

    // The version header rides the Blueprint read too: without it the route
    // serves the definition-only projection and drops `package`/`skillPackages`.
    expect(requestPublicJson).toHaveBeenCalledWith(
      `/api/v1/desktop-app/public-shares/workspaces/${UUID}?expectedWorkspaceTemplateContentHash=${hash}`,
      { headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION } },
    );
  });

  it('resolves an automation through the anonymous public snapshot route', async () => {
    requestPublicJson.mockResolvedValue({ entity: 'automation' });

    await getPublicAutomationShareSnapshot(UUID);

    // The version header rides every read, pinned or not. It used to be sent
    // only on the pinned branch, which left the one branch an older web deploy
    // rejects as the only branch with no downgrade path.
    expect(requestPublicJson).toHaveBeenCalledWith(
      `/api/v1/desktop-app/public-shares/automations/${UUID}`,
      { headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION } },
    );
  });

  it('retries an automation snapshot with the version an older server requires', async () => {
    const hash = 'a'.repeat(64);
    const upgrade = new CanopyCloudClientError(
      'http-error',
      'Upgrade required',
      426,
    );
    Object.assign(upgrade, {
      serverCode: 'pipeline_package_client_upgrade_required',
      requiredPackageVersion: 1,
    });
    requestPublicJson
      .mockRejectedValueOnce(upgrade)
      .mockResolvedValueOnce({ entity: 'automation' });

    await expect(
      getPublicAutomationShareSnapshot(UUID, hash),
    ).resolves.toMatchObject({ entity: 'automation' });

    expect(requestPublicJson).toHaveBeenNthCalledWith(
      2,
      `/api/v1/desktop-app/public-shares/automations/${UUID}?expectedAutomationContentHash=${hash}`,
      { headers: { 'X-Pipeline-Package-Version': '1' } },
    );
  });

  it('reads a skill share published before packages as definition-only', async () => {
    // Pinned; never edit the fixture. A share nobody can re-publish must keep
    // installing on every later build.
    const legacy: unknown = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../../../packages/protocol/src/__fixtures__/legacy-shares/skill/public-snapshot.2026-09-22.json',
        ),
        'utf8',
      ),
    );
    requestPublicJson.mockResolvedValueOnce(legacy);

    const snapshot = await getPublicSkillShareSnapshot(
      '5b2f6c1e-8d4a-4e3b-9f7a-2c1d0e9b8a76',
    );

    expect(snapshot).toEqual(legacy);
    expect(snapshot).not.toHaveProperty('package');
    expect(snapshot).not.toHaveProperty('sharedBy');
    expect(snapshot).not.toHaveProperty('distributionMode');
    // The fixture carries the hash the server really stored: the SHA-256 of
    // the exact SKILL.md bytes. Every import path compares against it.
    expect(snapshot.entity === 'skill' ? snapshot.contentHash : null).toBe(
      createHash('sha256')
        .update(snapshot.entity === 'skill' ? snapshot.rawSkill : '')
        .digest('hex'),
    );
  });

  it('reads an Agent share published before packages as definition-only', async () => {
    const legacy: unknown = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../../../packages/protocol/src/__fixtures__/legacy-shares/agent/public-snapshot.2026-09-22.json',
        ),
        'utf8',
      ),
    );
    requestPublicJson.mockResolvedValueOnce(legacy);

    const snapshot = await getPublicAgentShareSnapshot(
      '91582f59-c7c8-4a4d-93cf-0e7edb927a68',
    );

    expect(snapshot).toEqual(legacy);
    expect(snapshot).not.toHaveProperty('package');
    expect(snapshot).not.toHaveProperty('distributionMode');
    expect(snapshot.contentHash).toBe(
      createHash('sha256').update(JSON.stringify(snapshot.agent)).digest('hex'),
    );
  });

  it('retries a skill snapshot with the version an older server requires', async () => {
    const upgrade = new CanopyCloudClientError(
      'http-error',
      'Upgrade required',
      426,
    );
    Object.assign(upgrade, {
      serverCode: 'pipeline_package_client_upgrade_required',
      requiredPackageVersion: 1,
    });
    requestPublicJson
      .mockRejectedValueOnce(upgrade)
      .mockResolvedValueOnce({ entity: 'skill' });

    await expect(getPublicSkillShareSnapshot(UUID)).resolves.toMatchObject({
      entity: 'skill',
    });

    expect(requestPublicJson).toHaveBeenNthCalledWith(
      2,
      `/api/v1/desktop-app/public-shares/skills/${UUID}`,
      { headers: { 'X-Pipeline-Package-Version': '1' } },
    );
  });

  it('keeps a packaged skill packaged through the scoped fallback', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    const summary = { digest: 'pp:v1:abc', totalFiles: 2, totalBytes: 10 };
    requestAuthenticatedJson.mockResolvedValue({
      ...scopedSkill,
      id: UUID,
      name: 'Team helper',
      description: 'Internal helper',
      rawSkill: '# Team helper',
      contentHash: 'skill-hash',
      shareScope: 'team',
      distributionMode: 'package',
      package: summary,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    // Omitting these means definition-only by the snapshot type's contract, so
    // dropping them here silently stripped a packaged skill of its files.
    await expect(getPublicSkillShareSnapshot(UUID)).resolves.toMatchObject({
      distributionMode: 'package',
      package: summary,
      // Its package hangs off the skill, not a public share.
      scopedShare: true,
    });
    // The route only returns the packaged projection to a caller that
    // declares a package version; without this header the fields above are
    // never populated by a real server.
    expect(requestAuthenticatedJson).toHaveBeenCalledWith(
      `/api/v1/desktop-app/skills/${UUID}`,
      { headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION } },
    );
  });

  it('keeps package files on the policy-checked scoped skill fallback', async () => {
    mockSkillContextEnabled.mockReturnValue(true);
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    const summary = { digest: 'pp:v1:abc', totalFiles: 2, totalBytes: 10 };
    mockGetContextSkill.mockResolvedValue({
      ...scopedSkill,
      id: UUID,
      name: 'Team helper',
      description: 'Internal helper',
      rawSkill: '# Team helper',
      contentHash: 'skill-hash',
      shareScope: 'team',
      distributionMode: 'package',
      package: summary,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    // Omitting these means definition-only by the snapshot type's contract, so
    // dropping them here silently stripped a packaged skill of its files.
    await expect(getPublicSkillShareSnapshot(UUID)).resolves.toMatchObject({
      distributionMode: 'package',
      package: summary,
      // Its package hangs off the skill, not a public share.
      scopedShare: true,
    });
    expect(mockGetContextSkill).toHaveBeenCalledWith(UUID);
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it('forwards the reviewed automation hash with the package client version', async () => {
    requestPublicJson.mockResolvedValue({ entity: 'automation' });
    const hash = 'a'.repeat(64);

    await getPublicAutomationShareSnapshot(UUID, hash);

    expect(requestPublicJson).toHaveBeenCalledWith(
      `/api/v1/desktop-app/public-shares/automations/${UUID}?expectedAutomationContentHash=${hash}`,
      { headers: { 'X-Pipeline-Package-Version': CLIENT_VERSION } },
    );
  });

  describe.each([
    ['skill', false],
    ['skill', true],
    ['pipeline', false],
    ['pipeline', true],
    ['agent', true],
    ['workspace', false],
  ] as const)('%s scoped fallback (context %s)', (entity, enabled) => {
    const read = {
      skill: getPublicSkillShareSnapshot,
      pipeline: getPublicPipelineShareSnapshot,
      agent: getPublicAgentShareSnapshot,
      workspace: getPublicWorkspaceTemplateSnapshot,
    }[entity];

    beforeEach(() => {
      mockSkillContextEnabled.mockReturnValue(enabled);
      mockPipelineContextEnabled.mockReturnValue(enabled);
      mockAgentContextEnabled.mockReturnValue(enabled);
    });

    it.each([
      new CanopyCloudClientError('missing-api-key', 'No API key'),
      new CanopyCloudClientError('http-error', 'Expired session', 401),
      new CanopyCloudClientError('http-error', 'Forbidden', 403),
      new CanopyCloudClientError('network-error', 'Offline'),
      new CanopyCloudClientError('http-error', 'Scoped not found', 404),
      new ResourceContextUnavailableError('context-mismatch'),
    ])('propagates the exact scoped failure: %s', async (scopedError) => {
      requestPublicJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Public not found', 404),
      );
      requestAuthenticatedJson.mockRejectedValue(scopedError);
      mockGetContextSkill.mockRejectedValue(scopedError);
      mockGetContextPipeline.mockRejectedValue(scopedError);
      mockGetContextAgent.mockRejectedValue(scopedError);

      await expect(read(UUID)).rejects.toBe(scopedError);
    });

    it.each([401, 403, 500])(
      'does not fall back on public HTTP %s',
      async (status) => {
        const error = new CanopyCloudClientError(
          'http-error',
          'Public failure',
          status,
        );
        requestPublicJson.mockRejectedValue(error);
        await expect(read(UUID)).rejects.toBe(error);
        expect(requestAuthenticatedJson).not.toHaveBeenCalled();
        expect(mockGetContextSkill).not.toHaveBeenCalled();
        expect(mockGetContextPipeline).not.toHaveBeenCalled();
        expect(mockGetContextAgent).not.toHaveBeenCalled();
      },
    );
  });

  it('retains the public error when agent fallback is disabled', async () => {
    const error = new CanopyCloudClientError(
      'http-error',
      'Public not found',
      404,
    );
    requestPublicJson.mockRejectedValue(error);
    await expect(getPublicAgentShareSnapshot(UUID)).rejects.toBe(error);
    expect(mockGetContextAgent).not.toHaveBeenCalled();
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it.each([
    [
      new CanopyCloudClientError('http-error', 'Expired session', 401),
      'sign-in-required',
    ],
    [
      new CanopyCloudClientError('http-error', 'Forbidden', 403),
      'not-a-member',
    ],
    [
      new CanopyCloudClientError('network-error', 'Offline'),
      'cloud-unreachable',
    ],
  ])(
    'classifies the real public reader fallback in the resolver: %s',
    async (scopedError, reason) => {
      // Only the JSON transport is mocked: the resolver and public/scoped readers
      // compose exactly as they do for a public deep link.
      requestPublicJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Public not found', 404),
      );
      requestAuthenticatedJson.mockRejectedValue(scopedError);
      await expect(
        resolveShareSnapshot({ entity: 'skill', externalId: UUID }),
      ).resolves.toEqual({ ok: false, reason });
      expect(requestPublicJson).toHaveBeenCalledTimes(1);
      expect(requestAuthenticatedJson).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an authenticated private resource as an unresolved share', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    requestAuthenticatedJson.mockResolvedValue({
      id: UUID,
      name: 'Private helper',
      description: '',
      rawSkill: '# Private helper',
      contentHash: 'private-hash',
      shareScope: 'private',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });

    await expect(getPublicSkillShareSnapshot(UUID)).rejects.toMatchObject({
      code: 'http-error',
      status: 404,
    });
  });
});
