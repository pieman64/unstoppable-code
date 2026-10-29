/**
 * @jest-environment jsdom
 */

import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type {
  SharedSkillDetail,
  InstalledSkillInfo,
} from '@canopy/desktop-shared/types/skills';
import type { PublicSkillShareSnapshot } from '@canopy/protocol';
import legacyDetailJson from '../../../../../../../packages/protocol/src/__fixtures__/legacy-shares/skill/shared-skill-detail.2026-09-22.json';
import legacySnapshotJson from '../../../../../../../packages/protocol/src/__fixtures__/legacy-shares/skill/public-snapshot.2026-09-22.json';
import {
  describeSharedSkillImportNotice,
  importSharedSkill,
} from '../sharedSkillImport';

/**
 * Pinned compatibility: shares published before skills carried packages.
 * Nobody can re-publish them, so every later build must import them exactly
 * as before: the SKILL.md bytes, definition-only, with no package fetch and
 * no warning. Never edit the fixtures; see their README. That the stored hash
 * really is the SHA-256 of the bytes is asserted in the main-process
 * public-share client test, where Node crypto is available.
 */

function legacyDetail(): SharedSkillDetail {
  const detail: SharedSkillDetail = {
    ...legacyDetailJson,
    shareScope: 'team',
    owner: { type: 'team', id: 'team-1', name: 'Release team' },
    createdBy: { id: 'user-1', name: 'Publisher', email: null },
  };
  // Every key the fixture has must have been carried over; a field added to
  // the pre-package shape later would otherwise go untested.
  expect(Object.keys(detail).sort()).toEqual(
    Object.keys(legacyDetailJson).sort(),
  );
  return detail;
}

function legacySnapshot(): PublicSkillShareSnapshot {
  return {
    ...legacySnapshotJson,
    entity: 'skill',
    dependencies: legacySnapshotJson.dependencies.flatMap((dependency) =>
      dependency.kind === 'mcp' || dependency.kind === 'plugin'
        ? [{ kind: dependency.kind, name: dependency.name }]
        : [],
    ),
  };
}

describe('importing a skill shared before packages existed', () => {
  const loadSkills = jest.fn();
  const readRawSkill = jest.fn();
  const writeRawSkill = jest.fn();
  const installCapabilityPackage = jest.fn();

  beforeAll(() => {
    // The import compares content hashes with Web Crypto, which jsdom lacks.
    // The digest answers with the fixture's stored hash, so the comparison
    // runs against the value a pre-package share really carries.
    const stored = legacyDetailJson.contentHash
      .match(/../g)
      ?.map((hex) => parseInt(hex, 16));
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: {
          digest: (): Promise<ArrayBuffer> =>
            Promise.resolve(Uint8Array.from(stored ?? []).buffer),
        },
      },
    });
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: class {
        encode(input: string): Uint8Array {
          return Uint8Array.from(input, (character) => character.charCodeAt(0));
        }
      },
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Organization projects default on when LaunchDarkly is not configured;
    // this suite covers the legacy (context-free) paths.
    const flagSnapshot = getDefaultFeatureFlagSnapshot();
    flagSnapshot.values['canopy-shared-org-projects-enabled'] = false;
    useFeatureFlagsStore.setState({ snapshot: flagSnapshot });
    loadSkills.mockResolvedValue({ success: true, data: [] });
    readRawSkill.mockResolvedValue('');
    writeRawSkill.mockImplementation(({ skillName }: { skillName: string }) =>
      Promise.resolve({ skillId: `custom:app/${skillName}`, skillName }),
    );
    Object.assign(window, {
      skills: {
        loadSkills,
        readRawSkill,
        writeRawSkill,
        installCapabilityPackage,
      },
    });
  });

  it('installs a team share definition-only, byte for byte', async () => {
    const detail = legacyDetail();

    const result = await importSharedSkill(detail);

    expect(writeRawSkill).toHaveBeenCalledWith({
      skillName: 'release-notes',
      rawSkill: detail.rawSkill,
    });
    expect(installCapabilityPackage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skillName: 'release-notes',
      reused: false,
    });
    expect(describeSharedSkillImportNotice(result)).toBeNull();
  });

  // A public share names itself on the write so main can verify the origin
  // under context enforcement; a team share carries its owned source instead.
  it('installs a public share definition-only, byte for byte', async () => {
    const snapshot = legacySnapshot();

    const result = await importSharedSkill({
      name: snapshot.name,
      rawSkill: snapshot.rawSkill,
      contentHash: snapshot.contentHash,
      id: snapshot.externalId,
      fromPublicShare: true,
    });

    expect(writeRawSkill).toHaveBeenCalledWith({
      skillName: 'release-notes',
      rawSkill: snapshot.rawSkill,
      publicShare: {
        externalId: snapshot.externalId,
        contentHash: snapshot.contentHash,
      },
    });
    expect(installCapabilityPackage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skillName: 'release-notes',
      reused: false,
    });
    expect(describeSharedSkillImportNotice(result)).toBeNull();
  });

  it('recognizes an existing copy by its stored content hash', async () => {
    const detail = legacyDetail();
    const installed: InstalledSkillInfo = {
      name: 'release-notes',
      sourceId: 'custom:app',
      description: '',
      source: 'Custom',
      installedAt: '',
      updatedAt: '',
      updateAvailable: false,
    };
    loadSkills.mockResolvedValue({ success: true, data: [installed] });
    readRawSkill.mockResolvedValue(detail.rawSkill);

    const result = await importSharedSkill(detail);

    // A re-import must link to the copy the recipient already has, not write
    // a second one.
    expect(writeRawSkill).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skillName: 'release-notes', reused: true });
  });
});
