const mockAgentContextEnabled = jest.fn(() => false);
const mockGetContextAgent = jest.fn();
jest.mock('../agents/resource-lanes', () => ({
  agentResourceContextEnabled: mockAgentContextEnabled,
}));
jest.mock('../agents/canopy-server-client', () => ({
  getSharedAgent: mockGetContextAgent,
}));
const mockSkillContextEnabled = jest.fn(() => false);
const mockGetContextSkill = jest.fn();
jest.mock('../skills/resource-lanes', () => ({
  skillResourceContextEnabled: mockSkillContextEnabled,
}));
jest.mock('../skills/canopy-server-client', () => ({
  getSharedSkill: mockGetContextSkill,
}));
const mockPipelineContextEnabled = jest.fn(() => false);
const mockGetContextPipeline = jest.fn();
jest.mock('../pipelines/resource-lanes', () => ({
  pipelineResourceContextEnabled: mockPipelineContextEnabled,
}));
jest.mock('../pipelines/canopy-server-client', () => ({
  getSharedPipeline: mockGetContextPipeline,
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
    requestCanopyCloudPublicJson: requestPublicJson,
    requestCanopyCloudJson: requestAuthenticatedJson,
  };
});

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
} from '../canopy-cloud/public-share-client';
import { listPublisherSkills } from '../canopy-cloud/publisher-skill-catalog';

import { PIPELINE_PACKAGE_CLIENT_VERSION } from '@canopy/protocol/pipelines';

const CLIENT_VERSION = String(PIPELINE_PACKAGE_CLIENT_VERSION);

const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
const PUBLISHER_UUID = '2f0c9a1e-4b3d-5f6a-8c2e-1d5b7a9e0c4f';

describe('public share client scoped fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPipelineContextEnabled.mockReturnValue(false);
    mockSkillContextEnabled.mockReturnValue(false);
    mockAgentContextEnabled.mockReturnValue(false);
    requestPublicJson.mockReset();
    requestAuthenticatedJson.mockReset();
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
    mockGetContextAgent.mockRejectedValue(
      new Error('Agent unavailable (context-mismatch)'),
    );
    await expect(getPublicAgentShareSnapshot(UUID)).rejects.toBe(unavailable);
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
    mockGetContextSkill.mockRejectedValue(
      new Error('Skill unavailable (context-mismatch)'),
    );
    await expect(getPublicSkillShareSnapshot(UUID)).rejects.toBe(unavailable);
    expect(mockGetContextSkill).toHaveBeenCalledWith(UUID);
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

  it('falls back to an authenticated team skill when no public snapshot exists', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    requestAuthenticatedJson.mockResolvedValue({
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
    mockGetContextPipeline.mockRejectedValue(
      new Error('Pipeline unavailable (context-mismatch)'),
    );
    await expect(getPublicPipelineShareSnapshot(UUID)).rejects.toBe(
      unavailable,
    );
    expect(mockGetContextPipeline).toHaveBeenCalledWith(UUID);
    expect(requestAuthenticatedJson).not.toHaveBeenCalled();
  });

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

  it.each([
    new CanopyCloudClientError('missing-api-key', 'No API key'),
    new CanopyCloudClientError('http-error', 'Forbidden', 403),
  ])(
    'preserves the public 404 when the scoped skill fallback fails (%s)',
    async (fallbackError) => {
      requestPublicJson.mockRejectedValue(
        new CanopyCloudClientError('http-error', 'Not found', 404),
      );
      requestAuthenticatedJson.mockRejectedValue(fallbackError);

      await expect(getPublicSkillShareSnapshot(UUID)).rejects.toMatchObject({
        code: 'http-error',
        status: 404,
      });
    },
  );

  it('preserves the public 404 when the scoped pipeline fallback fails', async () => {
    requestPublicJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    requestAuthenticatedJson.mockRejectedValue(
      new CanopyCloudClientError('missing-api-key', 'No API key'),
    );

    await expect(getPublicPipelineShareSnapshot(UUID)).rejects.toMatchObject({
      code: 'http-error',
      status: 404,
    });
  });

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
