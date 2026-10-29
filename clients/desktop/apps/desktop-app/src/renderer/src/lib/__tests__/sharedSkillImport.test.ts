/**
 * @jest-environment jsdom
 */

let mockResourceContextEnabled = false;
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: {
    getState: (): { isEnabled: () => boolean } => ({
      isEnabled: (): boolean => mockResourceContextEnabled,
    }),
  },
}));

import {
  describeSharedSkillImportNotice,
  findInstalledSharedSkill,
  findInstalledSkillByContentHash,
  importSharedSkill,
} from '../sharedSkillImport';
import { resolveSharedResourceErrorMessage } from '../sharedResourceErrors';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';

const matchingHash =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const mockDigest = jest.fn((): Promise<ArrayBuffer> => {
  const bytes = matchingHash.match(/../g)?.map((hex) => parseInt(hex, 16));
  return Promise.resolve(Uint8Array.from(bytes ?? []).buffer);
});
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { subtle: { digest: mockDigest } },
});
Object.defineProperty(globalThis, 'TextEncoder', {
  configurable: true,
  value: class {
    encode(input: string): Uint8Array {
      const bytes = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        bytes[i] = input.charCodeAt(i);
      }
      return bytes;
    }
  },
});

const rawSkill = '---\nname: helper\n---\nExact body\n';

function makeSharedSkill(
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail {
  return {
    id: 'shared-skill-1',
    name: 'helper',
    description: '',
    rawSkill,
    contentHash:
      '0000000000000000000000000000000000000000000000000000000000000000',
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: null },
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    ...overrides,
  };
}

describe('importSharedSkill', () => {
  const loadSkills = jest.fn();
  const readRawSkill = jest.fn();
  const writeRawSkill = jest.fn();
  const installCapabilityPackage = jest.fn();
  const recordShareOrigin = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockResourceContextEnabled = false;
    loadSkills.mockResolvedValue({ success: true, data: [] });
    readRawSkill.mockResolvedValue('');
    writeRawSkill.mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
    });
    installCapabilityPackage.mockResolvedValue({
      supportingFileCount: 2,
      installedDependencies: [{ name: 'sibling', localName: 'sibling-2' }],
      uninstalledResourceLabels: [],
    });
    recordShareOrigin.mockResolvedValue(undefined);
    Object.assign(window, {
      skills: {
        loadSkills,
        readRawSkill,
        writeRawSkill,
        installCapabilityPackage,
        recordShareOrigin,
      },
    });
  });

  const packaged = (): Parameters<typeof importSharedSkill>[0] => ({
    ...makeSharedSkill(),
    distributionMode: 'package',
    package: {
      digest: `pp:v1:${'A'.repeat(43)}`,
      version: 1,
      resources: [],
      environmentRequirements: [],
      totalFiles: 2,
      totalBytes: 8,
    },
  });

  it('installs the packaged supporting files beside the written SKILL.md', async () => {
    const result = await importSharedSkill(packaged());

    expect(installCapabilityPackage).toHaveBeenCalledWith({
      remoteId: 'shared-skill-1',
      skillName: 'helper',
      primaryRootName: 'helper',
      packageRef: { version: 1, digest: `pp:v1:${'A'.repeat(43)}` },
    });
    expect(result.packageInstall).toMatchObject({ supportingFileCount: 2 });
  });

  it('installs supporting files after the policy-checked scoped write', async () => {
    mockResourceContextEnabled = true;
    const result = await importSharedSkill(packaged());
    expect(writeRawSkill).toHaveBeenCalledWith({
      skillName: 'helper',
      rawSkill,
      sourceRemoteId: 'shared-skill-1',
    });
    expect(installCapabilityPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: 'shared-skill-1',
        skillName: 'helper',
      }),
    );
    expect(result.packageInstall).toMatchObject({ supportingFileCount: 2 });
  });

  it('marks a collection member so main leaves it to the collection subscription', async () => {
    mockResourceContextEnabled = true;
    await importSharedSkill({ ...packaged(), inCollection: true });
    expect(writeRawSkill).toHaveBeenCalledWith({
      skillName: 'helper',
      rawSkill,
      sourceRemoteId: 'shared-skill-1',
      inCollection: true,
    });
  });

  // A public share has no owned source to receipt, so the write names the
  // share instead and main verifies that origin itself before writing.
  it('keeps public package imports public when context enforcement is enabled', async () => {
    mockResourceContextEnabled = true;
    await importSharedSkill({ ...packaged(), fromPublicShare: true });
    expect(writeRawSkill).toHaveBeenCalledWith({
      skillName: 'helper',
      rawSkill,
      publicShare: {
        externalId: 'shared-skill-1',
        contentHash:
          '0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    expect(installCapabilityPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteId: 'shared-skill-1',
        publicShare: true,
      }),
    );
  });

  // Under enforcement main decides whether an identical copy may be reused
  // (a copy an install receipt binds to a team must not be), so the renderer
  // must not short-circuit on content it can see.
  it('lets main decide identical-copy reuse for a public share under enforcement', async () => {
    mockResourceContextEnabled = true;
    loadSkills.mockResolvedValue({
      success: true,
      data: [
        {
          name: 'helper',
          sourceId: 'custom:app',
          description: '',
          source: 'Custom',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          contentHash: matchingHash,
        },
      ],
    });
    readRawSkill.mockResolvedValue(rawSkill);
    writeRawSkill.mockResolvedValue({
      skillId: 'custom:app/helper-2',
      skillName: 'helper-2',
    });
    const result = await importSharedSkill({
      ...makeSharedSkill({ contentHash: matchingHash }),
      fromPublicShare: true,
    });
    expect(writeRawSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        publicShare: {
          externalId: 'shared-skill-1',
          contentHash: matchingHash,
        },
      }),
    );
    expect(result).toMatchObject({ skillName: 'helper-2', reused: false });
  });

  it('routes a public-share import to the public package endpoint', async () => {
    await importSharedSkill({ ...packaged(), fromPublicShare: true });

    expect(installCapabilityPackage).toHaveBeenCalledWith(
      expect.objectContaining({ publicShare: true }),
    );
  });

  // A recipient who took the definition-only version before the publisher
  // added a package must still get the files when they re-import.
  it('installs the package on the reused path too', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [
        {
          name: 'helper',
          sourceId: 'custom:app',
          description: '',
          source: 'Custom',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          custom: true,
        },
      ],
    });
    readRawSkill.mockResolvedValue(rawSkill);

    const result = await importSharedSkill({
      ...packaged(),
      contentHash: matchingHash,
    });

    expect(result.reused).toBe(true);
    expect(installCapabilityPackage).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'helper' }),
    );
  });

  it('leaves a definition-only share untouched', async () => {
    const result = await importSharedSkill(makeSharedSkill());

    expect(installCapabilityPackage).not.toHaveBeenCalled();
    expect(result.packageInstall).toBeUndefined();
    expect(recordShareOrigin).toHaveBeenCalledWith({
      localId: 'helper',
      originExternalId: 'shared-skill-1',
      contentHash:
        '0000000000000000000000000000000000000000000000000000000000000000',
    });
  });

  // The skill itself is already written and usable. Unwinding it because the
  // supporting files could not be fetched would be strictly worse than the
  // definition-only import every skill got before packaging existed.
  it('keeps the imported skill when the package cannot be installed', async () => {
    installCapabilityPackage.mockRejectedValue(new Error('offline'));

    const result = await importSharedSkill(packaged());

    expect(result.skillName).toBe('helper');
    expect(result.packageInstall).toBeUndefined();
    // Partial success must be reported, not swallowed: the recipient would
    // otherwise believe they received the whole skill.
    expect(result.packageInstallError).toBe('offline');
    expect(recordShareOrigin).toHaveBeenCalledWith({
      localId: 'helper',
      originExternalId: 'shared-skill-1',
      contentHash:
        '0000000000000000000000000000000000000000000000000000000000000000',
    });
  });

  it('reports a failed install in words, not as an IPC stack', async () => {
    installCapabilityPackage.mockRejectedValue(
      new Error(
        "Error invoking remote method 'skills:package-install': CanopyCloudClientError: Package not found.",
      ),
    );

    const result = await importSharedSkill(packaged());

    expect(result.packageInstallError).toBe('Package not found.');
  });

  it('writes the server rawSkill bytes exactly through writeRawSkill', async () => {
    const result = await importSharedSkill(makeSharedSkill());

    expect(writeRawSkill).toHaveBeenCalledWith({
      skillName: 'helper',
      rawSkill,
    });
    expect(result).toEqual({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
    });
  });

  it('reuses an existing custom skill when the content hash matches', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [
        {
          name: 'helper',
          sourceId: 'custom:app',
          description: '',
          source: 'Custom',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          custom: true,
        },
      ],
    });
    readRawSkill.mockResolvedValue(rawSkill);

    const result = await importSharedSkill(
      makeSharedSkill({ contentHash: matchingHash }),
    );

    expect(readRawSkill).toHaveBeenCalledWith('custom:app/helper');
    expect(writeRawSkill).not.toHaveBeenCalled();
    expect(result).toEqual({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: true,
    });
    expect(recordShareOrigin).toHaveBeenCalledWith({
      localId: 'helper',
      originExternalId: 'shared-skill-1',
      contentHash: matchingHash,
    });
  });

  it('suffixes the imported name when same-name content differs', async () => {
    writeRawSkill
      .mockRejectedValueOnce(new Error('Skill already exists'))
      .mockResolvedValueOnce({
        skillId: 'custom:app/helper-2',
        skillName: 'helper-2',
      });

    const result = await importSharedSkill(makeSharedSkill());

    expect(writeRawSkill).toHaveBeenNthCalledWith(1, {
      skillName: 'helper',
      rawSkill,
    });
    expect(writeRawSkill).toHaveBeenNthCalledWith(2, {
      skillName: 'helper-2',
      rawSkill,
    });
    expect(result).toEqual({
      skillId: 'custom:app/helper-2',
      skillName: 'helper-2',
      reused: false,
    });
  });

  it('threads the matched sourceId through findInstalledSkillByContentHash', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [
        {
          name: 'plugin-twin',
          sourceId: 'plugin:some-pack',
          description: '',
          source: 'Plugin',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          custom: false,
        },
        {
          name: 'helper',
          sourceId: 'custom:app',
          description: '',
          source: 'Custom',
          installedAt: '',
          updatedAt: '',
          updateAvailable: false,
          custom: true,
        },
      ],
    });
    readRawSkill.mockResolvedValue(rawSkill);

    await expect(
      findInstalledSkillByContentHash(matchingHash),
    ).resolves.toEqual({
      skillId: 'custom:app/helper',
      sourceId: 'custom:app',
      skillName: 'helper',
    });
    // Non-custom sources are never install targets, so they are not scanned
    // even when a same-content twin exists there.
    expect(readRawSkill).toHaveBeenCalledTimes(1);
    expect(readRawSkill).toHaveBeenCalledWith('custom:app/helper');
  });

  it('maps shared skill delete conflicts to the required Collection copy', () => {
    expect(
      resolveSharedResourceErrorMessage(
        { status: 409 },
        {
          deleteConflictMessage:
            'This skill is used by one or more collections. Remove it from those collections before deleting it.',
        },
      ),
    ).toBe(
      'This skill is used by one or more collections. Remove it from those collections before deleting it.',
    );
  });
});

describe('describeSharedSkillImportNotice', () => {
  const complete = {
    supportingFileCount: 1,
    installedDependencies: [],
    uninstalledResourceLabels: [],
    keptLocalFiles: [],
  };

  it('is null for a complete import', () => {
    expect(describeSharedSkillImportNotice({ packageInstall: complete })).toBe(
      null,
    );
    expect(describeSharedSkillImportNotice({})).toBe(null);
  });

  // One wording for this failure on every surface.
  it('names files that did not install, with the reason', () => {
    expect(
      describeSharedSkillImportNotice({ packageInstallError: 'disk full' }),
    ).toBe(
      'Skill added, but its supporting files could not be installed. disk full',
    );
  });

  // The imported skill still calls `/helper`, which now runs the recipient's
  // own skill rather than the shared one — they have to be told.
  it('names a dependency that was installed under a different name', () => {
    expect(
      describeSharedSkillImportNotice({
        packageInstall: {
          ...complete,
          installedDependencies: [
            { name: 'helper', localName: 'helper-2' },
            { name: 'sibling', localName: 'sibling' },
          ],
        },
      }),
    ).toBe(
      'Skill added. Its helper skill was added as helper-2, because you already have a different helper.',
    );
  });

  it('names packaged items that belong to a plugin and were not added', () => {
    expect(
      describeSharedSkillImportNotice({
        packageInstall: {
          ...complete,
          uninstalledResourceLabels: ['/deploy', 'reviewer'],
        },
      }),
    ).toBe(
      'Skill added. It also uses /deploy and reviewer, which come from a plugin and were not added.',
    );
  });

  it('names files kept because the recipient already had their own', () => {
    expect(
      describeSharedSkillImportNotice({
        packageInstall: { ...complete, keptLocalFiles: ['helper/a.md'] },
      }),
    ).toBe(
      'Skill added. You already had one of its files, so your version was kept.',
    );
  });
});

describe('findInstalledSharedSkill', () => {
  const loadSkills = jest.fn();
  const readRawSkill = jest.fn();
  const packageDigest = `pp:v1:${'B'.repeat(43)}`;

  function localSkill(
    name: string,
    installedFromShare?: InstalledSkillInfo['installedFromShare'],
  ): InstalledSkillInfo {
    return {
      name,
      sourceId: 'custom:app',
      description: '',
      source: '',
      installedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      updateAvailable: false,
      ...(installedFromShare ? { installedFromShare } : {}),
    };
  }

  const share = makeSharedSkill({ contentHash: matchingHash });
  const packagedShare = makeSharedSkill({
    contentHash: matchingHash,
    distributionMode: 'package',
    package: {
      digest: packageDigest,
      version: 1,
      resources: [],
      environmentRequirements: [],
      totalFiles: 2,
      totalBytes: 8,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResourceContextEnabled = true;
    readRawSkill.mockResolvedValue(rawSkill);
    Object.assign(window, { skills: { loadSkills, readRawSkill } });
  });

  it('finds the copy receipted to this share when its bytes still match', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [
        localSkill('helper'),
        localSkill('helper-2', { remoteId: share.id }),
      ],
    });

    await expect(findInstalledSharedSkill(share)).resolves.toBe('helper-2');
    expect(readRawSkill).toHaveBeenCalledTimes(1);
    expect(readRawSkill).toHaveBeenCalledWith('custom:app/helper-2');
  });

  it('checks every copy receipted to this share, as main reuses any of them', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [
        localSkill('release', { remoteId: share.id }),
        localSkill('release-2', { remoteId: share.id }),
      ],
    });
    // The first alias was edited locally; the second still matches.
    mockDigest.mockImplementationOnce(() =>
      Promise.resolve(new Uint8Array(32).buffer),
    );

    await expect(findInstalledSharedSkill(share)).resolves.toBe('release-2');
    expect(readRawSkill).toHaveBeenNthCalledWith(1, 'custom:app/release');
    expect(readRawSkill).toHaveBeenNthCalledWith(2, 'custom:app/release-2');
  });

  it('ignores an identical copy that no receipt binds to this share', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [localSkill('helper'), localSkill('other', { remoteId: 'other' })],
    });

    await expect(findInstalledSharedSkill(share)).resolves.toBeNull();
    expect(readRawSkill).not.toHaveBeenCalled();
  });

  it('does not count a receipted copy whose bytes changed', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [localSkill('helper', { remoteId: share.id })],
    });

    await expect(
      findInstalledSharedSkill({ ...share, contentHash: '0'.repeat(64) }),
    ).resolves.toBeNull();
  });

  it('requires the share package to have installed', async () => {
    loadSkills.mockResolvedValue({
      success: true,
      data: [localSkill('helper', { remoteId: share.id })],
    });
    await expect(findInstalledSharedSkill(packagedShare)).resolves.toBeNull();

    loadSkills.mockResolvedValue({
      success: true,
      data: [
        localSkill('helper', {
          remoteId: share.id,
          packageDigest: `pp:v1:${'C'.repeat(43)}`,
        }),
      ],
    });
    await expect(findInstalledSharedSkill(packagedShare)).resolves.toBeNull();

    loadSkills.mockResolvedValue({
      success: true,
      data: [localSkill('helper', { remoteId: share.id, packageDigest })],
    });
    await expect(findInstalledSharedSkill(packagedShare)).resolves.toBe(
      'helper',
    );
  });

  it('matches identical content without enforcement, where imports reuse it', async () => {
    mockResourceContextEnabled = false;
    loadSkills.mockResolvedValue({
      success: true,
      data: [localSkill('helper')],
    });

    await expect(findInstalledSharedSkill(share)).resolves.toBe('helper');
    // A package cannot be confirmed without a receipt, so Add stays offered.
    await expect(findInstalledSharedSkill(packagedShare)).resolves.toBeNull();
  });
});
