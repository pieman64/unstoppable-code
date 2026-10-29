import {
  automationDefinitionResource,
  isContextOwnedInstall,
} from '../activity-owner';

describe('curated Automation ownership', () => {
  it('treats curated and public installs as context-owned', () => {
    const curated = {
      remoteId: 'daily-review',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-09-30T12:00:00.000Z',
      sourceKind: 'curated' as const,
    };
    expect(isContextOwnedInstall(curated)).toBe(true);
    expect(
      automationDefinitionResource({
        id: 'local-automation',
        installedFrom: curated,
        publicInstallContext: undefined,
      }),
    ).toEqual({ owner: { shareScope: 'private' } });
  });

  it('keeps team-shared installs host-authorized', () => {
    const shared = {
      remoteId: '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-09-30T12:00:00.000Z',
      sourceKind: 'shared' as const,
    };
    expect(isContextOwnedInstall(shared)).toBe(false);
    expect(
      automationDefinitionResource({
        id: 'local-automation',
        installedFrom: shared,
        publicInstallContext: undefined,
      }),
    ).toMatchObject({ requiresHostAuthorization: true });
  });
});
