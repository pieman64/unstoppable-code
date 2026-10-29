const mockAssertStoredSkill = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockFilterSkills = jest.fn((rows: unknown[]) => Promise.resolve(rows));
const mockAnnotateSkills = jest.fn((rows: unknown[]) => Promise.resolve(rows));
const mockWriteSkillRemoteMetadata = jest.fn();
const mockResolveCanopyCloudCredentialContext = jest.fn<Promise<unknown>, []>();
// Keep this real module non-virtual so Jest caches the same resolved ID across suites.
jest.mock('../skills/skill-install-context', () => ({
  assertStoredSkillContext: (id: string): Promise<void> =>
    mockAssertStoredSkill(id),
  filterStoredSkillContexts: (rows: unknown[]): Promise<unknown[]> =>
    mockFilterSkills(rows),
  annotateSharedSkillInstalls: (rows: unknown[]): Promise<unknown[]> =>
    mockAnnotateSkills(rows),
}));
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';

const registered = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (channel: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(channel, handler);
    },
  ),
}));

jest.mock('../canopy-cloud/client', () => ({
  // Share handlers classify failures against the real error class.
  CanopyCloudClientError: class CanopyCloudClientError extends Error {},
  assertCanopyCloudCapability: jest.fn(() => Promise.resolve()),
  resolveCanopyCloudCredentialContext: (): Promise<unknown> =>
    mockResolveCanopyCloudCredentialContext(),
}));

jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));

jest.mock('../skills/skill-service', () => ({
  checkUpdates: jest.fn(),
  fetchAvailable: jest.fn(),
  installSkills: jest.fn(),
  listSkillFiles: jest.fn(),
  loadSkills: jest.fn(),
  readRawSkill: jest.fn(),
  readSkillContent: jest.fn(),
  readSkillFile: jest.fn(),
  removeSkill: jest.fn(() => ({ success: true })),
  saveCustomSkill: jest.fn(),
  updateSkill: jest.fn(() => Promise.resolve({ success: true })),
  writeRawSkill: jest.fn(),
  writeRawSkillForContext: jest.fn(),
  writeSkillRemoteMetadata: mockWriteSkillRemoteMetadata,
  clearSkillRemoteMetadataByRemoteId: jest.fn(),
}));

jest.mock('../skills/skill-package-install', () => ({
  installSkillCapabilityPackage: jest.fn(() =>
    Promise.resolve({
      supportingFileCount: 1,
      installedDependencies: [],
      uninstalledResourceLabels: [],
      keptLocalFiles: [],
    }),
  ),
}));

jest.mock('../pipelines/pipeline-package-install-store', () => ({
  insertCapabilityPackageInstallIfAbsent: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../lib/paths', () => ({
  getPipelinePackageInstallStorePath: jest.fn(() => '/tmp/install-store.json'),
}));

jest.mock('../skills/canopy-server-client', () => ({
  createSharedSkill: jest.fn((request: unknown) => Promise.resolve(request)),
  deleteSharedSkill: jest.fn(() => Promise.resolve()),
  getSharedSkill: jest.fn((skillId: string) => Promise.resolve({ skillId })),
  listSharedSkills: jest.fn((request: unknown) => Promise.resolve(request)),
  publishSkillPublicShare: jest.fn((skillId: string) =>
    Promise.resolve({ skillId }),
  ),
  revokeSkillPublicShare: jest.fn(() => Promise.resolve()),
  updateSharedSkill: jest.fn((request: unknown) => Promise.resolve(request)),
}));

import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import { noteCloudWriteSent } from '../canopy-cloud/cloud-write-tracking';
import {
  checkUpdates,
  listSkillFiles,
  loadSkills,
  readSkillFile,
} from '../skills/skill-service';
import {
  createSharedSkill,
  deleteSharedSkill,
  publishSkillPublicShare,
  revokeSkillPublicShare,
  updateSharedSkill,
} from '../skills/canopy-server-client';
import { registerSkillHandlers } from '../skills/skill-handlers';
import { installSkillCapabilityPackage } from '../skills/skill-package-install';
import { insertCapabilityPackageInstallIfAbsent } from '../pipelines/pipeline-package-install-store';

describe('skill IPC handlers', () => {
  beforeEach(() => {
    registered.clear();
    jest.clearAllMocks();
    mockAssertStoredSkill.mockResolvedValue(undefined);
    mockWriteSkillRemoteMetadata.mockReset();
    mockResolveCanopyCloudCredentialContext.mockResolvedValue({
      baseUrl: 'https://cloud.test',
      apiKey: 'api-key',
      capabilities: ['skills-crud-v1'],
      account: { id: 'account-b' },
    });
  });

  it('lists only context-visible skills, annotated with their share origin', async () => {
    registerSkillHandlers();
    const skill = (name: string): InstalledSkillInfo => ({
      name,
      sourceId: 'custom:app',
      description: '',
      source: '',
      installedAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      updateAvailable: false,
    });
    const visible = skill('helper');
    const annotated: InstalledSkillInfo = {
      ...visible,
      installedFromShare: { remoteId: 'remote-a' },
    };
    jest.mocked(loadSkills).mockReturnValue({
      success: true,
      data: [visible, skill('hidden')],
    });
    mockFilterSkills.mockResolvedValueOnce([visible]);
    mockAnnotateSkills.mockResolvedValueOnce([annotated]);

    await expect(registered.get(SKILLS_CHANNELS.LOAD)?.(null)).resolves.toEqual(
      { success: true, data: [annotated] },
    );
    expect(mockAnnotateSkills).toHaveBeenCalledWith([visible]);
  });

  it('preserves a possibly deduplicated remote skill when local link persistence fails', async () => {
    jest.mocked(createSharedSkill).mockImplementationOnce(() => {
      // Model the real client's publication write before local persistence.
      noteCloudWriteSent();
      return Promise.resolve<SharedSkillDetail>({
        id: 'remote-skill',
        name: 'Helper',
        description: '',
        rawSkill: '# Helper',
        contentHash: 'hash-a',
        owner: { type: 'user', id: 'account-a', name: null },
        createdBy: { id: 'account-a', name: null, email: null },
        createdAt: '2026-09-25T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
        publicShare: null,
        shareScope: 'private',
        updatedAt: '2026-09-25T00:00:00.000Z',
      });
    });
    mockWriteSkillRemoteMetadata.mockImplementationOnce(() => {
      throw new Error('links are read-only');
    });
    registerSkillHandlers();

    const handler = registered.get(SKILLS_CHANNELS.SHARED_CREATE);
    await expect(
      handler?.(null, {
        sourceSkillId: 'custom:app/helper',
        rawSkill: '# Helper',
      }),
    ).resolves.toMatchObject({
      ok: false,
      // Publication succeeded before the local write failed. Preserve that
      // committed state without allowing a retry or exposing the local error.
      failure: {
        kind: 'unknown',
        stage: 'finish',
        commitState: 'committed',
        retryable: false,
        message: "Couldn't share. Try again.",
      },
    });

    expect(mockWriteSkillRemoteMetadata).toHaveBeenCalledWith(
      'custom:app/helper',
      expect.objectContaining({ remoteId: 'remote-skill' }),
    );
    expect(deleteSharedSkill).not.toHaveBeenCalled();
  });

  it('reports a failed capability check as not shared, before publication', async () => {
    jest
      .mocked(assertCanopyCloudCapability)
      .mockRejectedValueOnce(new Error('socket hang up'));
    registerSkillHandlers();

    const handler = registered.get(SKILLS_CHANNELS.SHARED_CREATE);
    await expect(
      handler?.(null, {
        sourceSkillId: 'custom:app/helper',
        rawSkill: '# Helper',
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'access', commitState: 'not-committed' },
    });
    expect(createSharedSkill).not.toHaveBeenCalled();
  });

  it('binds a deduplicated skill share to the initiating account', async () => {
    jest.mocked(createSharedSkill).mockResolvedValue({
      id: 'remote-skill',
      contentHash: 'hash-a',
      createdBy: { id: 'account-a' },
      canUpdate: true,
      shareScope: 'team',
      updatedAt: '2026-09-25T00:00:00.000Z',
    } as never);
    registerSkillHandlers();
    const request = {
      sourceSkillId: 'custom:app/helper',
      rawSkill: '# Helper',
      shareScope: 'team' as const,
      teamId: 'team-a',
    };

    await registered.get(SKILLS_CHANNELS.SHARED_CREATE)?.(null, request);

    expect(createSharedSkill).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ account: { id: 'account-b' } }),
    );
    expect(mockWriteSkillRemoteMetadata).toHaveBeenCalledWith(
      request.sourceSkillId,
      expect.objectContaining({ accountId: 'account-b' }),
    );
  });

  it('does not bind a deduplicated skill owned by another publisher', async () => {
    jest.mocked(createSharedSkill).mockResolvedValue({
      id: 'remote-skill',
      contentHash: 'hash-a',
      createdBy: { id: 'account-a' },
      canUpdate: false,
      shareScope: 'team',
      updatedAt: '2026-09-25T00:00:00.000Z',
    } as never);
    registerSkillHandlers();

    await registered.get(SKILLS_CHANNELS.SHARED_CREATE)?.(null, {
      sourceSkillId: 'custom:app/helper',
      rawSkill: '# Helper',
      shareScope: 'team',
      teamId: 'team-a',
    });

    expect(mockWriteSkillRemoteMetadata).not.toHaveBeenCalled();
  });

  it('reports a landed create whose local link failed as shared', async () => {
    jest.mocked(createSharedSkill).mockResolvedValueOnce({
      id: 'remote-skill',
      contentHash: 'hash-a',
      createdBy: { id: 'account-b' },
      canUpdate: true,
      shareScope: 'team',
      updatedAt: '2026-09-25T00:00:00.000Z',
    } as never);
    mockWriteSkillRemoteMetadata.mockImplementationOnce(() => {
      throw new Error('index is read-only');
    });
    registerSkillHandlers();

    await expect(
      registered.get(SKILLS_CHANNELS.SHARED_CREATE)?.(null, {
        sourceSkillId: 'custom:app/helper',
        rawSkill: '# Helper',
        shareScope: 'team',
        teamId: 'team-a',
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'finish', commitState: 'committed' },
    });
  });

  it('reports a landed update whose local link failed as shared', async () => {
    jest.mocked(updateSharedSkill).mockResolvedValueOnce({
      id: 'remote-skill',
      contentHash: 'hash-b',
      createdBy: { id: 'account-b' },
      canUpdate: true,
      shareScope: 'team',
      updatedAt: '2026-09-25T01:00:00.000Z',
    } as never);
    mockWriteSkillRemoteMetadata.mockImplementationOnce(() => {
      throw new Error('index is read-only');
    });
    registerSkillHandlers();

    await expect(
      registered.get(SKILLS_CHANNELS.SHARED_UPDATE)?.(null, {
        skillId: 'remote-skill',
        sourceSkillId: 'custom:app/helper',
        rawSkill: '# Helper',
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { stage: 'finish', commitState: 'committed' },
    });
  });

  it('gates shared skill calls by skills-crud-v1 capability', async () => {
    registerSkillHandlers();

    const handler = registered.get(SKILLS_CHANNELS.SHARED_UPDATE);
    const request = {
      skillId: 'skill-1',
      rawSkill: '# Skill',
    };
    await expect(handler?.(null, request)).resolves.toEqual({
      ok: true,
      value: request,
    });

    expect(assertCanopyCloudCapability).toHaveBeenCalledWith('skills-crud-v1');
    expect(updateSharedSkill).toHaveBeenCalledWith(request);
  });

  it('gates public skill share calls by skills-crud-v1 capability', async () => {
    registerSkillHandlers();

    const publishHandler = registered.get(
      SKILLS_CHANNELS.SHARED_PUBLISH_PUBLIC,
    );
    await expect(publishHandler?.(null, 'skill-1')).resolves.toEqual({
      skillId: 'skill-1',
    });
    expect(publishSkillPublicShare).toHaveBeenCalledWith('skill-1');

    const revokeHandler = registered.get(SKILLS_CHANNELS.SHARED_REVOKE_PUBLIC);
    await expect(revokeHandler?.(null, 'skill-1')).resolves.toBeUndefined();
    expect(revokeSkillPublicShare).toHaveBeenCalledWith('skill-1');

    expect(assertCanopyCloudCapability).toHaveBeenCalledTimes(2);
    expect(assertCanopyCloudCapability).toHaveBeenNthCalledWith(
      1,
      'skills-crud-v1',
    );
    expect(assertCanopyCloudCapability).toHaveBeenNthCalledWith(
      2,
      'skills-crud-v1',
    );
  });

  // A public skill link is anonymous end to end, like a public pipeline or
  // automation package: its package endpoints need no account. Requiring one
  // left a signed-out recipient with the SKILL.md but none of its files.
  it('installs a public share package without an account', async () => {
    registerSkillHandlers();
    const handler = registered.get(SKILLS_CHANNELS.PACKAGE_INSTALL);
    const request = {
      remoteId: '7c4e2a91-3b5d-4f6e-8a1c-9d0b2e4f6a83',
      skillName: 'release-notes',
      primaryRootName: 'release-notes',
      packageRef: { version: 1, digest: `pp:v1:${'A'.repeat(43)}` },
      publicShare: true,
    };

    await expect(handler?.(null, request)).resolves.toMatchObject({
      supportingFileCount: 1,
    });

    expect(assertCanopyCloudCapability).not.toHaveBeenCalled();
    expect(installSkillCapabilityPackage).toHaveBeenCalledWith(request);
  });

  it('still gates a team or organization package on the skills capability', async () => {
    registerSkillHandlers();
    const handler = registered.get(SKILLS_CHANNELS.PACKAGE_INSTALL);

    await handler?.(null, {
      remoteId: 'skill-1',
      skillName: 'helper',
      primaryRootName: 'helper',
      packageRef: { version: 1, digest: `pp:v1:${'A'.repeat(43)}` },
    });

    expect(assertCanopyCloudCapability).toHaveBeenCalledWith('skills-crud-v1');
  });

  it('atomically records a share origin only when local provenance is absent', async () => {
    registerSkillHandlers();
    const handler = registered.get(SKILLS_CHANNELS.RECORD_SHARE_ORIGIN);
    const request = {
      localId: 'helper',
      originExternalId: 'share-1',
      contentHash: 'a'.repeat(64),
    };

    await handler?.(null, request);
    expect(insertCapabilityPackageInstallIfAbsent).toHaveBeenCalledWith(
      '/tmp/install-store.json',
      expect.objectContaining({
        owner: { kind: 'skill', localId: 'helper' },
        originExternalId: 'share-1',
        pipelineContentHash: 'a'.repeat(64),
        distributionMode: 'definition_only',
      }),
    );
  });

  it('delegates skill file listing and reads to the service', async () => {
    registerSkillHandlers();

    const listHandler = registered.get(SKILLS_CHANNELS.LIST_FILES);
    await listHandler?.(null, 'custom:app', 'my-skill');
    expect(listSkillFiles).toHaveBeenCalledWith('custom:app', 'my-skill');

    const readHandler = registered.get(SKILLS_CHANNELS.READ_FILE);
    await readHandler?.(null, 'custom:app', 'my-skill', 'references/api.md');
    expect(readSkillFile).toHaveBeenCalledWith(
      'custom:app',
      'my-skill',
      'references/api.md',
    );
  });

  it('forwards skill update progress over the progress channel', async () => {
    registerSkillHandlers();

    const handler = registered.get(SKILLS_CHANNELS.CHECK_UPDATES);
    const sender = { send: jest.fn() };
    const event = { sender };
    const progress = {
      operation: 'check-updates' as const,
      status: 'running' as const,
      message: 'Checking installed skills for updates...',
    };

    await handler?.(event);

    const reporter = jest.mocked(checkUpdates).mock.calls[0]?.[0];
    if (!reporter) throw new Error('Expected progress reporter');
    reporter(progress);

    expect(sender.send).toHaveBeenCalledWith(
      SKILLS_CHANNELS.UPDATE_PROGRESS,
      progress,
    );
  });
  it.each([
    [SKILLS_CHANNELS.READ_CONTENT, ['custom:app', 'org-skill']],
    [SKILLS_CHANNELS.LIST_FILES, ['custom:app', 'org-skill']],
    [SKILLS_CHANNELS.READ_FILE, ['custom:app', 'org-skill', 'SKILL.md']],
    [SKILLS_CHANNELS.UPDATE, ['custom:app', 'org-skill']],
    [SKILLS_CHANNELS.REMOVE, ['custom:app', 'org-skill']],
  ])('rechecks stored origin at %s', async (channel, args) => {
    mockAssertStoredSkill.mockRejectedValue(
      new Error('Skill unavailable (context-mismatch)'),
    );
    registerSkillHandlers();
    await expect(
      Promise.resolve().then(() => registered.get(channel)?.(null, ...args)),
    ).rejects.toThrow('context-mismatch');
    expect(mockAssertStoredSkill).toHaveBeenCalledWith('custom:app/org-skill');
  });
});
