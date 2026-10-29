/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { shareEnvelope } from '@/test-utils/shareOperation';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedSkillDetail } from '@canopy/desktop-shared/types/skills';

const mockPostShareToast = jest.fn();
jest.mock('@/lib/share-toast', () => ({
  postShareToast: (toast: unknown): void => {
    mockPostShareToast(toast);
  },
}));

import { ShareSkillModal } from '../ShareSkillModal';
import { ResourceContextProvider } from '@canopy/ui-app/capability';

describe('ShareSkillModal', () => {
  let container: HTMLElement;
  let root: Root;
  const createShared = jest.fn(() => Promise.resolve({ id: 'shared-skill' }));
  const publishPublicShare = jest.fn(() =>
    Promise.resolve({
      sharePath: '/s/skills/public-skill',
    }),
  );
  const readRawSkill = jest.fn(() => Promise.resolve('# Raw skill'));
  const listFiles = jest.fn(() =>
    Promise.resolve({
      success: true,
      data: { files: ['SKILL.md'], truncated: false },
    }),
  );
  const removeSkill = jest.fn(() => Promise.resolve({ success: true }));
  // A skill with nothing extra to carry: the analysis is ready and empty, so
  // the share commits no package.
  const emptyAnalysis = (): {
    analysisId: string;
    state: 'ready';
    pipelineContentHash: string;
    manifest: {
      version: 1;
      pipelineContentHash: string;
      resources: never[];
      bindings: never[];
      environmentRequirements: never[];
      totalFiles: number;
      totalBytes: number;
    };
    blockers: never[];
    dismissedInvocations: never[];
    expiresAt: string;
  } => ({
    analysisId: 'skill-analysis',
    state: 'ready',
    pipelineContentHash: 'a'.repeat(64),
    manifest: {
      version: 1,
      pipelineContentHash: 'a'.repeat(64),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    blockers: [],
    dismissedInvocations: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const analyzeCapabilityPackage = jest.fn();
  const cancelCapabilityPackageAnalysis = jest.fn(() => Promise.resolve());
  const commitCapabilityPackage = jest.fn(() =>
    Promise.resolve({
      capabilityPackage: {
        version: 1 as const,
        digest: `pp:v1:${'A'.repeat(43)}`,
      },
      committedPackageUploadId: '00000000-0000-4000-8000-0000000000aa',
    }),
  );
  const loadCanopyCloudAccount = jest.fn();
  const onOpenAccountSettings = jest.fn();

  function readyAccount(): {
    hasApiKey: boolean;
    capabilities: string[];
    storageAvailable: boolean;
    account: { id: string; name: string; email: string; role: 'ADMIN' };
  } {
    return {
      hasApiKey: true,
      capabilities: ['skills-crud-v1'],
      storageAvailable: true,
      account: {
        id: 'acct-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    };
  }

  // This account has only Public available, so the dialog selects it and
  // displays its disclosure without a selector.
  function expectSolePublicAudience(): void {
    expect(
      document.querySelector('[data-testid="share-skill-scope"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-scope-description"]')
        ?.textContent,
    ).toContain('Anyone can view this skill');
  }

  function teamAccount(): ReturnType<typeof readyAccount> {
    return {
      ...readyAccount(),
      capabilities: ['skills-crud-v1', 'teams-v1'],
    };
  }

  const platformTeams = {
    success: true,
    data: {
      data: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Platform',
          organization: { id: 'org-1', name: 'Acme' },
        },
      ],
    },
  };

  beforeEach(() => {
    mockPostShareToast.mockClear();
    createShared.mockClear();
    publishPublicShare.mockReset();
    publishPublicShare.mockResolvedValue({
      sharePath: '/s/skills/public-skill',
    });
    // Reset, not clear, for the same reason as `analyzeCapabilityPackage`
    // below: a per-test rejection would otherwise stay in force for every
    // test that follows.
    readRawSkill.mockReset();
    readRawSkill.mockImplementation(() => Promise.resolve('# Raw skill'));
    listFiles.mockClear();
    listFiles.mockResolvedValue({
      success: true,
      data: { files: ['SKILL.md'], truncated: false },
    });
    removeSkill.mockClear();
    // Reset, not clear: a per-test `mockResolvedValue` would otherwise stay
    // in force for every test that follows.
    analyzeCapabilityPackage.mockReset();
    analyzeCapabilityPackage.mockImplementation(() =>
      Promise.resolve(emptyAnalysis()),
    );
    cancelCapabilityPackageAnalysis.mockClear();
    commitCapabilityPackage.mockClear();
    loadCanopyCloudAccount.mockReset();
    onOpenAccountSettings.mockReset();
    loadCanopyCloudAccount.mockResolvedValue(readyAccount());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount,
        getCanopyCloudBaseUrl: () =>
          Promise.resolve('https://cloud.example.test'),
      },
      skills: {
        createShared: shareEnvelope(createShared),
        publishPublicShare,
        readRawSkill,
        listFiles,
        removeSkill,
        analyzeCapabilityPackage,
        cancelCapabilityPackageAnalysis,
        commitCapabilityPackage: shareEnvelope(commitCapabilityPackage),
      },
      pipelines: {
        listSharedOrganizations: jest.fn(),
        listSharedTeams: jest.fn(),
      },
    });
  });

  it('offers no delete-local or consent choice for a custom skill', async () => {
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Sharing always keeps the local skill, and pressing Share is the
    // publication decision.
    expect(document.body.textContent).not.toContain('Delete local copy');
    expect(
      document.querySelector('[data-testid="share-skill-delete-local"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-consent"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-snapshot-note"]'),
    ).toBeNull();
  });

  it('atomically revokes the observed public link with a narrower update', async () => {
    const publicShare = {
      externalId: 'public-skill-id',
      pinnedContentHash: 'public-hash',
      upToDate: true,
      sharePath: '/portal/plugins/skills/shared/public-skill-id',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const detail: SharedSkillDetail = {
      id: 'shared-skill-id',
      name: 'helper',
      description: '',
      contentHash: 'server-hash',
      shareScope: 'private',
      owner: { type: 'user', id: 'acct-1' },
      createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      publicShare,
      rawSkill: '# Raw skill',
    };
    const getShared = jest.fn().mockResolvedValue(detail);
    const updateShared = jest
      .fn()
      .mockResolvedValue({ ...detail, publicShare: null });
    const revokePublicShare = jest.fn();
    Object.assign(window.skills, {
      getShared,
      updateShared: shareEnvelope(updateShared),
      revokePublicShare,
    });
    loadCanopyCloudAccount.mockResolvedValue(teamAccount());
    Object.assign(window.pipelines, {
      listSharedTeams: jest.fn().mockResolvedValue(platformTeams),
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{
            sourceId: 'custom:app',
            name: 'helper',
            remote: {
              remoteId: detail.id,
              contentHash: 'stale-local-hash',
              shareScope: detail.shareScope,
              sharedAt: detail.updatedAt,
            },
          }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    // The existing share is Public; narrowing it to a team revokes the link
    // in the same update instead of a separate unpublish call.
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="share-skill-scope-team"]')
        ?.click();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.includes('Platform'))
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="share-skill-submit"]')
        ?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(updateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: detail.id,
        expectedContentHash: detail.contentHash,
        shareScope: 'team',
        teamId: '11111111-1111-4111-8111-111111111111',
        revokePublicShare: {
          externalId: publicShare.externalId,
          updatedAt: publicShare.updatedAt,
        },
      }),
    );
    expect(revokePublicShare).not.toHaveBeenCalled();
    expect(publishPublicShare).not.toHaveBeenCalled();
  });

  it('shows snapshot semantics without delete-local controls for builtin skills', async () => {
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'builtin:app', name: 'review' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain(
      'Delete local copy after sharing',
    );
    expect(
      document.querySelector('[data-testid="share-skill-snapshot-note"]'),
    ).not.toBeNull();
  });

  it('shares builtin raw bytes without removing the bundled skill', async () => {
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'builtin:app', name: 'review' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expectSolePublicAudience();

    await act(async () => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Share',
      );
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readRawSkill).toHaveBeenCalledWith('builtin:app/review');
    expect(createShared).toHaveBeenCalledWith(
      expect.objectContaining({ rawSkill: '# Raw skill' }),
    );
    expect(removeSkill).not.toHaveBeenCalled();
  });

  // Supporting files used to be detected only to warn that they would be left
  // behind. They now travel, so the section discloses what is being copied.
  it('discloses packaged supporting files instead of warning they are dropped', async () => {
    analyzeCapabilityPackage.mockResolvedValueOnce({
      analysisId: 'skill-analysis',
      state: 'ready' as const,
      pipelineContentHash: 'a'.repeat(64),
      manifest: {
        version: 1 as const,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'resource-a',
            kind: 'standalone_skill' as const,
            displayName: 'review',
            sourceLabel: 'builtin:app',
            sourceVisibility: 'builtin' as const,
            invocationKeys: ['/review'],
            dependencyResourceIds: [],
            trees: [
              {
                provider: 'claude' as const,
                runtimeKind: 'standalone_skill' as const,
                rootName: 'review',
                entries: [
                  {
                    path: 'references/guide.md',
                    sha256: 'b'.repeat(64),
                    size: 4,
                    mode: 'read' as const,
                  },
                ],
              },
            ],
          },
        ],
        bindings: [{ target: 'subject' as const, resourceIds: ['resource-a'] }],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 4,
      },
      blockers: [],
      dismissedInvocations: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'builtin:app', name: 'review' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(analyzeCapabilityPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'builtin:app',
        skillName: 'review',
        rawSkill: '# Raw skill',
      }),
    );
    // The retired warning must not come back.
    expect(
      document.querySelector('[data-testid="share-skill-single-file-note"]'),
    ).toBeNull();
    // The dependency section renders, so the packaged file is disclosed
    // rather than the retired "not included" warning.
    expect(
      document.querySelector('[data-testid="share-skill-dependencies"]'),
    ).not.toBeNull();
    // The section discloses the resource and its file count rather than
    // individual paths, so assert on what it actually renders.
    expect(document.body.textContent).toContain('1 file');
  });

  // The pipeline and automation share dialogs are the approved layout: the
  // scope comes first, then its team or organization picker, then what the
  // share carries, then local options. The skill dialog follows it.
  it('lays out scope, dependencies, and the footer like the pipeline dialog', async () => {
    analyzeCapabilityPackage.mockResolvedValueOnce({
      analysisId: 'skill-analysis',
      state: 'ready' as const,
      pipelineContentHash: 'a'.repeat(64),
      manifest: {
        version: 1 as const,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'resource-a',
            kind: 'standalone_skill' as const,
            displayName: '/my-skill',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local' as const,
            invocationKeys: ['/my-skill'],
            dependencyResourceIds: [],
            trees: [
              {
                provider: 'claude' as const,
                runtimeKind: 'standalone_skill' as const,
                rootName: 'my-skill',
                entries: [
                  {
                    path: 'references/guide.md',
                    sha256: 'b'.repeat(64),
                    size: 4,
                    mode: 'read' as const,
                  },
                ],
              },
            ],
          },
        ],
        bindings: [{ target: 'subject' as const, resourceIds: ['resource-a'] }],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 4,
      },
      blockers: [],
      dismissedInvocations: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'my-skill' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Public is the only usable audience, so its disclosure takes the
    // selector's place before the dependency review.
    expectSolePublicAudience();

    const scope = document.querySelector(
      '[data-testid="share-skill-scope-description"]',
    );
    const dependencies = document.querySelector(
      '[data-testid="share-skill-dependencies"]',
    );
    const footer = document.querySelector('[data-testid="share-skill-footer"]');
    expect(scope).not.toBeNull();
    expect(dependencies).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-consent"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('Delete local copy');
    const follows = (earlier: Node, later: Node): boolean =>
      (earlier.compareDocumentPosition(later) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0;
    expect(scope && dependencies && follows(scope, dependencies)).toBe(true);
    expect(dependencies && footer && follows(dependencies, footer)).toBe(true);
    // Same width as the pipeline and automation dialogs.
    expect(
      document
        .querySelector('[data-testid="share-skill-modal"]')
        ?.className.includes('max-w-lg'),
    ).toBe(true);
  });

  it('sends the reviewed optional selection without another acknowledgment', async () => {
    analyzeCapabilityPackage.mockResolvedValue({
      analysisId: 'skill-analysis',
      state: 'ready' as const,
      pipelineContentHash: 'a'.repeat(64),
      manifest: {
        version: 1 as const,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'resource-a',
            kind: 'standalone_skill' as const,
            displayName: 'helper',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local' as const,
            invocationKeys: ['/helper'],
            dependencyResourceIds: [],
            trees: [
              {
                provider: 'claude' as const,
                runtimeKind: 'standalone_skill' as const,
                rootName: 'helper',
                entries: [
                  {
                    path: 'SKILL.md',
                    sha256: 'b'.repeat(64),
                    size: 4,
                    mode: 'read' as const,
                  },
                  // A supporting file: without one the package carries
                  // nothing beyond the SKILL.md the share already sends.
                  {
                    path: 'references/guide.md',
                    sha256: 'c'.repeat(64),
                    size: 5,
                    mode: 'read' as const,
                  },
                ],
              },
            ],
          },
          {
            id: 'optional-resource',
            kind: 'standalone_skill' as const,
            displayName: 'optional helper',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local' as const,
            invocationKeys: ['/optional-helper'],
            dependencyResourceIds: [],
            trees: [],
          },
        ],
        bindings: [{ target: 'subject' as const, resourceIds: ['resource-a'] }],
        environmentRequirements: [],
        totalFiles: 2,
        totalBytes: 9,
      },
      blockers: [],
      dismissedInvocations: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    loadCanopyCloudAccount.mockResolvedValue(teamAccount());
    Object.assign(window.pipelines, {
      listSharedTeams: jest.fn().mockResolvedValue(platformTeams),
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Details are optional; open them only to opt in to the optional file.
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-dependencies-toggle"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="share-skill-dependencies-item-optional-resource"] input',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-scope-public"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(false);
    const shareButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Share',
    );
    await act(async () => {
      shareButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(commitCapabilityPackage).toHaveBeenCalledWith({
      analysisId: 'skill-analysis',
      selectedOptionalResourceIds: ['optional-resource'],
    });
    expect(createShared).toHaveBeenCalledWith(
      expect.objectContaining({
        rawSkill: '# Raw skill',
        capabilityPackage: {
          version: 1,
          digest: `pp:v1:${'A'.repeat(43)}`,
        },
        committedPackageUploadId: '00000000-0000-4000-8000-0000000000aa',
      }),
    );
  });

  // The analysis always binds the skill itself, so this SKILL.md-only
  // manifest is what every single-file custom skill produces. It must share
  // without a package: committing one hid the plain share and made a
  // teammate's re-share of a pre-package skill look like a package change.
  it('shares a SKILL.md-only skill without a package', async () => {
    analyzeCapabilityPackage.mockResolvedValue({
      analysisId: 'skill-analysis',
      state: 'ready' as const,
      pipelineContentHash: 'a'.repeat(64),
      manifest: {
        version: 1 as const,
        pipelineContentHash: 'a'.repeat(64),
        resources: [
          {
            id: 'resource-a',
            kind: 'standalone_skill' as const,
            displayName: 'helper',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local' as const,
            invocationKeys: ['/helper'],
            dependencyResourceIds: [],
            trees: [
              {
                provider: 'claude' as const,
                runtimeKind: 'standalone_skill' as const,
                rootName: 'helper',
                entries: [
                  {
                    path: 'SKILL.md',
                    // The skill itself: its SKILL.md is what the content hash
                    // covers.
                    sha256: 'a'.repeat(64),
                    size: 4,
                    mode: 'read' as const,
                  },
                ],
              },
            ],
          },
        ],
        bindings: [{ target: 'subject' as const, resourceIds: ['resource-a'] }],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 4,
      },
      blockers: [],
      dismissedInvocations: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expectSolePublicAudience();

    const shareButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-submit"]',
    );
    await act(async () => {
      shareButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(commitCapabilityPackage).not.toHaveBeenCalled();
    expect(createShared).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(createShared.mock.calls[0])).not.toContain(
      'capabilityPackage',
    );
    expect(
      document.querySelector('[data-testid="share-skill-dependencies"]'),
    ).not.toBeNull();
  });

  it('translates a policy refusal during supporting-file preparation before sharing', async () => {
    const analysis = emptyAnalysis();
    analyzeCapabilityPackage.mockResolvedValue({
      ...analysis,
      manifest: {
        ...analysis.manifest,
        resources: [
          {
            id: 'helper',
            kind: 'standalone_skill',
            displayName: 'helper',
            sourceLabel: 'custom:app',
            sourceVisibility: 'local',
            invocationKeys: ['/helper'],
            dependencyResourceIds: [],
            trees: [
              {
                provider: 'claude',
                runtimeKind: 'standalone_skill',
                rootName: 'helper',
                entries: [
                  {
                    path: 'SKILL.md',
                    sha256: 'a'.repeat(64),
                    size: 4,
                    mode: 'read',
                  },
                  {
                    path: 'reference.txt',
                    sha256: 'b'.repeat(64),
                    size: 4,
                    mode: 'read',
                  },
                ],
              },
            ],
          },
        ],
        bindings: [{ target: 'subject', resourceIds: ['helper'] }],
        totalFiles: 2,
        totalBytes: 8,
      },
    });
    commitCapabilityPackage.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'skills:capability-package:commit': ResourceContextUnavailableError: Resource unavailable (access-removed)",
      ),
    );
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="share-skill-submit"]')
        ?.click();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    expect(commitCapabilityPackage).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="share-skill-error"]')?.textContent,
    ).toBe('Failed to share skill. You no longer have access to this share.');
    expect(createShared).not.toHaveBeenCalled();
  });

  it('keeps a skill with nothing extra to carry on the plain share', async () => {
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'builtin:app', name: 'single-file' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Assert on the dependencies section itself: the recipient-setup testid
    // only renders when there are environment requirements, so it is absent
    // in every state and asserting on it would pass even if the section
    // regressed back to always rendering.
    expect(
      document.querySelector('[data-testid="share-skill-dependencies"]'),
    ).not.toBeNull();
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-dependencies-toggle"]',
        )
        ?.click();
    });
    expect(
      document.querySelector('[data-testid="share-skill-dependencies-empty"]'),
    ).not.toBeNull();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('builds share payloads from readRawSkill bytes', async () => {
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
    });
    expectSolePublicAudience();

    await act(async () => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Share',
      );
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(readRawSkill).toHaveBeenCalledWith('custom:app/helper');
    expect(createShared).toHaveBeenCalledWith(
      expect.objectContaining({
        rawSkill: '# Raw skill',
      }),
    );
    expect(createShared).toHaveBeenCalledTimes(1);
    const payload = createShared.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('serverId');
  });

  it('shows the empty-account state when Canopy Cloud is not configured', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: false,
      capabilities: [],
      storageAvailable: true,
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      'No Canopy Cloud account configured.',
    );
    expect(document.querySelector('select')).toBeNull();

    await act(async () => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) =>
          candidate.textContent?.trim() === 'Open account settings',
      );
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenAccountSettings).toHaveBeenCalled();
  });

  it('hides the share form when the Cloud account lacks skills-crud-v1', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      ...readyAccount(),
      capabilities: ['pipelines-crud-v1'],
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:canopy', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      'This Canopy Cloud account does not support shared skills.',
    );
  });

  it('keeps the local custom skill after sharing it', async () => {
    const onShared = jest.fn();

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={onShared}
        />,
      );
      await Promise.resolve();
    });
    expectSolePublicAudience();

    await act(async () => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Share',
      );
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(removeSkill).not.toHaveBeenCalled();
    expect(mockPostShareToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Skill is now public',
      link: 'https://cloud.example.test/s/skills/public-skill',
    });
    expect(onShared).toHaveBeenCalledWith({ id: 'shared-skill' });
  });

  it('publishes a private-owned skill and renders its public copy link', async () => {
    const onShared = jest.fn();
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={onShared}
        />,
      );
      await Promise.resolve();
    });

    expectSolePublicAudience();
    expect(document.body.textContent).toContain(
      'Anyone can view this skill. It may appear in public discovery and search.',
    );
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(false);

    await act(async () => {
      const shareButton = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Share',
      );
      shareButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createShared).toHaveBeenCalledWith({
      rawSkill: '# Raw skill',
      shareScope: 'private',
      sourceSkillId: 'custom:app/helper',
    });
    expect(publishPublicShare).toHaveBeenCalledWith('shared-skill');
    expect(mockPostShareToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Skill is now public',
      link: 'https://cloud.example.test/s/skills/public-skill',
    });
    expect(onShared).toHaveBeenCalledWith({ id: 'shared-skill' });
  });

  it('renders a copyable member-only link after sharing with a team', async () => {
    const onShared = jest.fn();
    loadCanopyCloudAccount.mockResolvedValue({
      ...readyAccount(),
      capabilities: ['skills-crud-v1', 'teams-v1'],
    });
    Object.assign(window.pipelines, {
      listSharedTeams: jest.fn().mockResolvedValue({
        success: true,
        data: {
          data: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              name: 'Platform',
              organization: { id: 'org-1', name: 'Acme' },
            },
          ],
        },
      }),
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={onShared}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === 'Team')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.includes('Platform'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === 'Share')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createShared).toHaveBeenCalledWith(
      expect.objectContaining({
        shareScope: 'team',
        teamId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    expect(mockPostShareToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Skill shared with Platform',
      link: 'https://cloud.example.test/portal/plugins/skills/shared/shared-skill',
    });
    expect(onShared).toHaveBeenCalledWith({ id: 'shared-skill' });
  });

  it('shows a degraded success when public publishing fails after create', async () => {
    publishPublicShare.mockRejectedValue(new Error('Publish failed'));

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector('[data-testid="share-skill-scope-public"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      const shareButton = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Share',
      );
      shareButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "Skill saved, but the public link couldn't be created.",
    );
  });

  // A blocked analysis must not fall through to a share without its package:
  // the dialog is showing the publisher a list of files it says will travel.
  it('blocks Share while the analysis has blockers', async () => {
    analyzeCapabilityPackage.mockResolvedValue({
      ...emptyAnalysis(),
      state: 'blocked' as const,
      blockers: [
        {
          code: 'UNRESOLVED_INVOCATION',
          message: 'Required invocation /missing could not be resolved.',
          occurrences: [],
        },
      ],
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // With an audience chosen, only the blocked analysis holds Share back.
    expectSolePublicAudience();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-submit"]',
    );
    expect(confirm?.disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="share-skill-definition-only"]'),
    ).toBeNull();
    expect(createShared).not.toHaveBeenCalled();
  });

  it.each([
    ['a custom skill', 'custom:app', true],
    ['a read-only skill', 'builtin', false],
  ])('offers Fix it with AI for %s only', async (_label, sourceId, offered) => {
    analyzeCapabilityPackage.mockResolvedValue({
      ...emptyAnalysis(),
      state: 'blocked' as const,
      blockers: [
        {
          code: 'UNRESOLVED_INVOCATION',
          message: 'Required invocation /missing could not be resolved.',
          occurrences: [],
        },
      ],
    });

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId, name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-skill-dependency-problems"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="share-skill-dependency-problems-fix-with-ai"]',
      ) !== null,
    ).toBe(offered);
  });

  // The state where the publisher knows least about what would travel must
  // block too, or the share quietly completes without its package behind an
  // error panel the user never had to act on.
  it('blocks Share when the analysis failed outright', async () => {
    analyzeCapabilityPackage.mockRejectedValue(new Error('analysis exploded'));

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(true);
    expect(createShared).not.toHaveBeenCalled();
  });

  it('explains a failed SKILL.md read instead of just disabling Share', async () => {
    readRawSkill.mockRejectedValue(new Error('read exploded'));

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Share is blocked, which is correct — we cannot know what would travel.
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(true);
    // ...but the publisher must be told why and offered a way out. This used to
    // render a bare greyed-out button with no panel, no message and no Retry.
    expect(
      document.querySelector('[data-testid="share-skill-dependencies"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-dependencies-retry"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Couldn't check the included files. Try again.",
    );
  });

  it('retries the SKILL.md read, not just the analysis', async () => {
    readRawSkill.mockRejectedValueOnce(new Error('read exploded'));

    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expectSolePublicAudience();
    expect(readRawSkill).toHaveBeenCalledTimes(1);

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-dependencies-retry"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Retrying only the analysis could never clear a failed read, so Share
    // would stay disabled forever.
    expect(readRawSkill).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      )?.disabled,
    ).toBe(false);
  });

  it('leaves Share enabled for a ready analysis', async () => {
    await act(async () => {
      root.render(
        <ShareSkillModal
          skill={{ sourceId: 'custom:app', name: 'helper' }}
          onClose={() => {}}
          onOpenAccountSettings={onOpenAccountSettings}
          onShared={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expectSolePublicAudience();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="share-skill-submit"]',
    );
    expect(confirm?.disabled).toBe(false);
  });

  function sharedSkillDetail(
    overrides: Partial<SharedSkillDetail> = {},
  ): SharedSkillDetail {
    return {
      id: 'shared-skill-id',
      name: 'helper',
      description: '',
      contentHash: 'server-hash',
      shareScope: 'private',
      owner: { type: 'user', id: 'acct-1' },
      createdBy: { id: 'acct-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      publicShare: null,
      rawSkill: '# Raw skill',
      ...overrides,
    };
  }

  async function renderSharedSkill(
    detail: SharedSkillDetail,
    resourceContext?: {
      readonly context: { kind: 'organization'; organizationId: string };
      readonly personalOrganizationId: string;
    },
  ): Promise<void> {
    const modal = (
      <ShareSkillModal
        skill={{
          sourceId: 'custom:app',
          name: 'helper',
          remote: {
            remoteId: detail.id,
            contentHash: detail.contentHash,
            shareScope: detail.shareScope,
            sharedAt: detail.updatedAt,
          },
        }}
        onClose={() => {}}
        onOpenAccountSettings={onOpenAccountSettings}
        onShared={() => {}}
      />
    );
    await act(async () => {
      root.render(
        resourceContext ? (
          <ResourceContextProvider {...resourceContext}>
            {modal}
          </ResourceContextProvider>
        ) : (
          modal
        ),
      );
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
  }

  it('removes the public link of an existing public share behind a confirm', async () => {
    const detail = sharedSkillDetail({
      publicShare: {
        externalId: 'public-skill-id',
        pinnedContentHash: 'server-hash',
        upToDate: true,
        sharePath: '/portal/plugins/skills/shared/public-skill-id',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
    });
    const revokePublicShare = jest.fn().mockResolvedValue(undefined);
    const updateShared = jest.fn();
    Object.assign(window.skills, {
      getShared: jest.fn().mockResolvedValue(detail),
      updateShared: shareEnvelope(updateShared),
      revokePublicShare,
    });

    await renderSharedSkill(detail);

    const removeButton = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-remove-public-link"]',
      );
    const confirmDialog = (): Element | null =>
      document.querySelector(
        '[data-testid="share-skill-remove-public-link-confirm"]',
      );
    expect(removeButton()).not.toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-copy-link"]'),
    ).not.toBeNull();

    // Cancel closes the confirm without touching the share.
    await act(async () => {
      removeButton()?.click();
      await Promise.resolve();
    });
    expect(confirmDialog()).not.toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-remove-public-link-cancel"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(confirmDialog()).toBeNull();
    expect(revokePublicShare).not.toHaveBeenCalled();

    await act(async () => {
      removeButton()?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-remove-public-link-confirm-action"]',
        )
        ?.click();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });

    expect(revokePublicShare).toHaveBeenCalledTimes(1);
    expect(revokePublicShare).toHaveBeenCalledWith(detail.id);
    expect(updateShared).not.toHaveBeenCalled();
    expect(publishPublicShare).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
    expect(mockPostShareToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Public link removed',
    });
    expect(removeButton()).toBeNull();
  });

  // `private` with no public share is the owner's Personal copy, not an
  // audience anyone picked, so the dialog treats the skill as unshared.
  it('opens a private share without a public link as a first share', async () => {
    const detail = sharedSkillDetail();
    const updateShared = jest
      .fn()
      .mockResolvedValue({ ...detail, id: 'shared-skill-id' });
    Object.assign(window.skills, {
      getShared: jest.fn().mockResolvedValue(detail),
      updateShared: shareEnvelope(updateShared),
      revokePublicShare: jest.fn(),
    });

    await renderSharedSkill(detail);

    const submit = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="share-skill-submit"]',
      );
    expect(submit()?.textContent?.trim()).toBe('Share');
    // The stored `private` value is not an audience to restore. Public is
    // selected because it is the one scope this account can use.
    expectSolePublicAudience();
    expect(
      document.querySelector('[data-testid="share-skill-scope-private"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="share-skill-remove-public-link"]'),
    ).toBeNull();

    await act(async () => {
      submit()?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(updateShared).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: detail.id, shareScope: 'private' }),
    );
    expect(publishPublicShare).toHaveBeenCalledWith(detail.id);
    expect(mockPostShareToast).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Skill is now public',
      link: 'https://cloud.example.test/s/skills/public-skill',
    });
  });

  // CAN-3009: a team share that also has a public link reads as Public. An
  // An explicit Public Update normalizes its owner to a personal copy.
  // CAN-3844: a team share belongs to its organization, so under context
  // policy it can't move to the personal owner Public needs.
  it.each([false, true])(
    'disables Public for a team-owned skill and preserves its legacy link (%s)',
    async (legacy) => {
      const detail = sharedSkillDetail({
        shareScope: 'team',
        owner: {
          type: 'team',
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Platform',
          organization: { id: 'org-1', name: 'Acme' },
        },
        ...(legacy
          ? {
              publicShare: {
                externalId: 'public-skill-id',
                pinnedContentHash: 'server-hash',
                upToDate: false,
                sharePath: '/portal/plugins/skills/shared/public-skill-id',
                createdAt: '2026-08-30T00:00:00.000Z',
                updatedAt: '2026-08-30T00:00:00.000Z',
              },
            }
          : {}),
      });
      const updateShared = jest
        .fn<
          ReturnType<typeof window.skills.updateShared>,
          Parameters<typeof window.skills.updateShared>
        >()
        .mockResolvedValue(detail);
      Object.assign(window.skills, {
        getShared: jest.fn().mockResolvedValue(detail),
        updateShared: shareEnvelope(updateShared),
        revokePublicShare: jest.fn(),
      });
      loadCanopyCloudAccount.mockResolvedValue(teamAccount());
      Object.assign(window.pipelines, {
        listSharedTeams: jest.fn().mockResolvedValue(platformTeams),
      });

      await renderSharedSkill(detail, {
        context: { kind: 'organization', organizationId: 'org-1' },
        personalOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });

      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-testid="share-skill-scope-public"]',
        )?.disabled,
      ).toBe(true);
      expect(
        document.querySelector('[data-testid="share-skill-public-locked-hint"]')
          ?.textContent,
      ).toBe("Organization shares can't be made public yet.");
      expect(
        document
          .querySelector('[data-testid="share-skill-scope-team"]')
          ?.getAttribute('aria-checked'),
      ).toBe('true');

      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="share-skill-submit"]',
          )
          ?.click();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      });
      expect(updateShared).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: detail.id,
          shareScope: 'team',
          teamId: '11111111-1111-4111-8111-111111111111',
        }),
      );
      expect(publishPublicShare).not.toHaveBeenCalled();
      expect(updateShared.mock.calls[0]?.[0]).not.toHaveProperty(
        'revokePublicShare',
      );
    },
  );

  it('keeps a refused existing-share load blocked with the plain reason', async () => {
    const detail = sharedSkillDetail();
    Object.assign(window.skills, {
      getShared: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'skills:shared:get': ResourceContextUnavailableError: Skill unavailable (access-removed)",
          ),
        ),
    });
    await renderSharedSkill(detail);
    expect(document.body.textContent).toContain(
      'Failed to share skill. You no longer have access to this share.',
    );
    expect(
      document.querySelector('[data-testid="share-skill-submit"]'),
    ).toBeNull();
    expect(createShared).not.toHaveBeenCalled();
  });

  it('normalizes a legacy team owner on explicit Public update', async () => {
    const publicShare = {
      externalId: 'public-skill-id',
      pinnedContentHash: 'server-hash',
      upToDate: true,
      sharePath: '/portal/plugins/skills/shared/public-skill-id',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    const detail = sharedSkillDetail({
      shareScope: 'team',
      owner: {
        type: 'team',
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Platform',
        organization: { id: 'org-1', name: 'Acme' },
      },
      publicShare,
    });
    const updateShared = jest.fn().mockResolvedValue(detail);
    Object.assign(window.skills, {
      getShared: jest.fn().mockResolvedValue(detail),
      updateShared: shareEnvelope(updateShared),
      revokePublicShare: jest.fn(),
    });
    loadCanopyCloudAccount.mockResolvedValue(teamAccount());
    Object.assign(window.pipelines, {
      listSharedTeams: jest.fn().mockResolvedValue(platformTeams),
    });

    await renderSharedSkill(detail);

    expect(
      document
        .querySelector('[data-testid="share-skill-scope-public"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      document.querySelector('[data-testid="share-skill-remove-public-link"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="share-skill-submit"]')
        ?.click();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(updateShared).toHaveBeenCalledTimes(1);
    expect(updateShared).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: detail.id,
        shareScope: 'private',
      }),
    );
    // The public link stays: nothing asks the update to revoke it.
    expect(updateShared).not.toHaveBeenCalledWith(
      expect.objectContaining({
        revokePublicShare: {
          externalId: publicShare.externalId,
          updatedAt: publicShare.updatedAt,
        },
      }),
    );
    expect(publishPublicShare).toHaveBeenCalledWith(detail.id);
  });
});
