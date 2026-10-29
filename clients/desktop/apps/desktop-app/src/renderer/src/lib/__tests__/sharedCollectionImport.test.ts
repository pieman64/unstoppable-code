/** @jest-environment jsdom */

import type { SharedCollectionDetail } from '@canopy/desktop-shared/types/collections';
import { importSharedSkill } from '../sharedSkillImport';
import { resolveSharedCollectionImport } from '../sharedCollectionImport';

jest.mock('../sharedSkillImport', () => ({
  importSharedSkill: jest.fn(),
}));

describe('resolveSharedCollectionImport', () => {
  it('keeps successful members when another member fails', async () => {
    Object.assign(window, {
      skills: {
        installSkills: jest.fn().mockResolvedValue({
          success: false,
          error: 'Repository unavailable',
        }),
      },
    });
    const detail = {
      collection: {
        items: [
          {
            type: 'skill',
            source: { type: 'github', repo: 'acme/missing' },
            skill_name: 'missing',
            required: true,
          },
          {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'research',
          },
        ],
      },
      customSkills: [],
    } as unknown as SharedCollectionDetail;

    await expect(resolveSharedCollectionImport(detail)).resolves.toEqual({
      skills: [{ sourceId: 'builtin:app', skillName: 'research' }],
      plugins: [],
      failures: [
        {
          label: 'missing',
          required: true,
          message: 'Repository unavailable',
        },
      ],
    });
  });

  it('imports custom skill members as collection members', async () => {
    const customSkill = {
      id: 'remote-skill',
      name: 'helper',
      rawSkill: '# Helper',
      contentHash: 'hash',
    };
    jest.mocked(importSharedSkill).mockResolvedValue({
      skillId: 'custom:app/helper',
      skillName: 'helper',
      reused: false,
    });
    const detail = {
      collection: {
        items: [
          {
            type: 'custom_skill',
            skillId: 'remote-skill',
            skill_name: 'helper',
          },
        ],
      },
      customSkills: [customSkill],
    } as unknown as SharedCollectionDetail;

    await expect(resolveSharedCollectionImport(detail)).resolves.toEqual({
      skills: [{ sourceId: 'custom:app', skillName: 'helper' }],
      plugins: [],
      failures: [],
    });
    expect(importSharedSkill).toHaveBeenCalledWith({
      ...customSkill,
      inCollection: true,
    });
  });
});
