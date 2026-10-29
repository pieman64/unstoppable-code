import {
  MAX_SHARED_SKILL_BYTES,
  SHARED_SKILL_API_VERSION,
  LEGACY_SKILL_SHARE_PATH_PREFIX,
  SKILL_SHARE_PATH_PREFIX,
  SKILL_SHARE_SCOPES,
  skillSharePath,
  type CreateSharedSkillRequest,
  type DeleteSharedSkillRequest,
  type ListSharedSkillsRequest,
  type ListSharedSkillsResponse,
  type PublishSharedSkillPublicShareRequest,
  type PublishSharedSkillPublicShareResponse,
  type RevokeSharedSkillPublicShareRequest,
  type SharedSkillDetail,
  type SharedSkillPublicShareInfo,
  type SharedSkillSavedFromInfo,
  type SharedSkillSummary,
  type SkillShareScope,
  type UpdateSharedSkillRequest,
} from '../index';

describe('shared-skill API contract', () => {
  it('pins version, scope set, and byte ceiling', () => {
    expect(SHARED_SKILL_API_VERSION).toBe(1);
    expect(MAX_SHARED_SKILL_BYTES).toBe(1024 * 1024);
    expect(SKILL_SHARE_SCOPES).toEqual(['private', 'team', 'organization']);
  });

  it('SkillShareScope union spans the scope tuple', () => {
    const cases: SkillShareScope[] = ['private', 'team', 'organization'];
    for (const value of cases) {
      expect(SKILL_SHARE_SCOPES).toContain(value);
    }
  });

  it('round-trips DTO shapes through JSON.stringify / parse', () => {
    const savedFrom: SharedSkillSavedFromInfo = {
      id: 'source-skill-1',
      name: 'original-commit-messages',
      createdByName: 'Bob',
    };
    const summary: SharedSkillSummary = {
      id: 'skill-1',
      name: 'commit-messages',
      description: 'generate a commit message',
      contentHash: 'sha256:abc',
      shareScope: 'team',
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Platform',
        slug: 'platform',
      },
      createdBy: {
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
      },
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T00:00:00Z',
      canUpdate: true,
      canDelete: false,
      publicShare: null,
      savedFrom,
    };

    const publicShare: SharedSkillPublicShareInfo = {
      externalId: 'share-1',
      pinnedContentHash: 'sha256:abc',
      upToDate: true,
      sharePath: '/s/skills/skill-1',
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T00:00:00Z',
    };

    const detail: SharedSkillDetail = {
      ...summary,
      publicShare,
      rawSkill: '---\nname: commit-messages\n---\nBody',
    };

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  it('keeps saved-copy lineage optional and nullable for wire compatibility', () => {
    const withoutLineage: SharedSkillSummary = {
      id: 'skill-1',
      name: 'helper',
      description: '',
      contentHash: 'sha256:abc',
      shareScope: 'private',
      owner: { type: 'user', id: 'user-1', name: 'Alice' },
      createdBy: {
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
      },
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T00:00:00Z',
      canUpdate: true,
      canDelete: true,
      publicShare: null,
    };
    const deletedSource: SharedSkillSummary = {
      ...withoutLineage,
      savedFrom: null,
    };

    expect(JSON.parse(JSON.stringify(withoutLineage))).toEqual(withoutLineage);
    expect(JSON.parse(JSON.stringify(deletedSource))).toEqual(deletedSource);
  });

  it('builds canonical share paths from the shared prefix', () => {
    // Renamed from `/s/skills` for CAN-2232: the storefront serves `/s/*`
    // (site search) at the `unstoppable.ai` apex Canopy web is taking over.
    // `apps/web/next.config.ts` keeps a permanent redirect from the old shape
    // because share links are capability URLs already handed out of band.
    expect(SKILL_SHARE_PATH_PREFIX).toBe('/portal/plugins/skills/shared');
    expect(skillSharePath('skill-1')).toBe(
      '/portal/plugins/skills/shared/skill-1',
    );
    expect(LEGACY_SKILL_SHARE_PATH_PREFIX).toBe('/s/skills');
  });

  it('keeps public-share publish / revoke requests serializable', () => {
    const publish: PublishSharedSkillPublicShareRequest = {
      serverId: 'srv-1',
      skillId: 'skill-1',
    };
    const revoke: RevokeSharedSkillPublicShareRequest = {
      serverId: 'srv-1',
      skillId: 'skill-1',
    };
    const published: PublishSharedSkillPublicShareResponse = {
      publicShare: {
        externalId: 'share-1',
        pinnedContentHash: 'sha256:abc',
        upToDate: false,
        sharePath: '/s/skills/skill-1',
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    };

    expect(JSON.parse(JSON.stringify(publish))).toEqual(publish);
    expect(JSON.parse(JSON.stringify(revoke))).toEqual(revoke);
    expect(JSON.parse(JSON.stringify(published))).toEqual(published);
  });

  it('keeps list / create / update / delete requests serializable', () => {
    const list: ListSharedSkillsRequest = {
      serverId: 'srv-1',
      limit: 25,
      cursor: 'cursor-token',
      query: 'commit',
      createdBy: 'me',
    };
    const create: CreateSharedSkillRequest = {
      serverId: 'srv-1',
      rawSkill: '---\nname: foo\n---\nBody',
      shareScope: 'organization',
      organizationId: 'org-1',
    };
    const update: UpdateSharedSkillRequest = {
      serverId: 'srv-1',
      skillId: 'skill-1',
      rawSkill: '---\nname: foo\n---\nBody updated',
      expectedContentHash: 'sha256:abc',
    };
    const del: DeleteSharedSkillRequest = {
      serverId: 'srv-1',
      skillId: 'skill-1',
    };

    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    expect(JSON.parse(JSON.stringify(create))).toEqual(create);
    expect(JSON.parse(JSON.stringify(update))).toEqual(update);
    expect(JSON.parse(JSON.stringify(del))).toEqual(del);
  });

  it('list response carries optional cursor', () => {
    const response: ListSharedSkillsResponse = {
      skills: [],
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);

    const withCursor: ListSharedSkillsResponse = {
      skills: [],
      nextCursor: 'opaque-token',
    };
    expect(JSON.parse(JSON.stringify(withCursor))).toEqual(withCursor);
  });
});
