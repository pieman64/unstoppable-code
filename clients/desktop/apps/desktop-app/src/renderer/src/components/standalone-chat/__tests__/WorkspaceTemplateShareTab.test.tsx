/** @jest-environment jsdom */
import { shareEnvelope } from '@/test-utils/shareOperation';
import { act } from 'react';
import { ResourceContextProvider } from '@canopy/ui-app/capability';
import { createRoot, type Root } from 'react-dom/client';
import { WorkspaceTemplateShareTab } from '../WorkspaceTemplateShareTab';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/lib/share-links', () => ({
  resolveSharedSkillUrl: jest.fn((path: string) =>
    Promise.resolve(`https://cloud.test${path}`),
  ),
  createShareLinkResolver: jest.fn(
    (
      scopedPath: (id: string) => string,
      resolve: (path: string) => Promise<string>,
    ) => ({
      resolveLink: async (source: {
        kind: 'public' | 'scoped';
        sharePath?: string;
        id?: string;
      }): Promise<{ url: string; kind: 'public' | 'scoped' }> => {
        const path =
          source.kind === 'public'
            ? (source.sharePath ?? '')
            : scopedPath(source.id ?? '');
        return { url: await resolve(path), kind: source.kind };
      },
      linkFromDetail: jest.fn(() => Promise.resolve(null)),
    }),
  ),
}));

const templateDocument = {
  version: 2 as const,
  name: 'Biology 101',
  description: 'Course project',
  instructions: 'Tutor patiently.',
  plugins: [],
  customSkills: [],
  starterPrompts: [],
};
const templateDraft = {
  name: 'Biology 101',
  description: 'Course project',
  instructions: 'Tutor patiently.',
  defaultPluginSelections: {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  },
};

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

describe('WorkspaceTemplateShareTab', () => {
  let container: HTMLDivElement;
  let root: Root;
  const publishTemplateShare = jest.fn();
  const revokeTemplateShare = jest.fn();
  const getTemplateShare = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    publishTemplateShare.mockReset().mockResolvedValue({
      externalId: 'share-id',
      sharePath: '/share/project-templates/share-id',
      pinnedContentHash: 'hash',
      upToDate: true,
      audience: 'TEAM',
      owner: { type: 'team', id: 'team-1', name: 'Growth' },
    });
    revokeTemplateShare.mockReset().mockResolvedValue(undefined);
    getTemplateShare.mockReset().mockResolvedValue(null);
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          capabilities: [
            'workspace-templates-v1',
            'teams-v1',
            'organizations-v1',
          ],
          storageAvailable: true,
          account: { id: 'account-1' },
        }),
        chatProject: {
          buildTemplate: jest.fn().mockResolvedValue({
            document: templateDocument,
            omitted: { mcpServers: true, unresolvedRefs: [] },
          }),
          getTemplateShare,
          publishTemplateShare: shareEnvelope(publishTemplateShare),
          revokeTemplateShare,
          analyzeTemplateCapabilityPackage: jest.fn().mockResolvedValue({
            analysisId: 'analysis-1',
            state: 'ready',
            blockers: [],
            manifest: {
              version: 1,
              pipelineContentHash: 'a'.repeat(64),
              resources: [],
              bindings: [],
              environmentRequirements: [],
              totalFiles: 0,
              totalBytes: 0,
            },
          }),
          cancelTemplateCapabilityPackageAnalysis: jest
            .fn()
            .mockResolvedValue(undefined),
          commitTemplateCapabilityPackage: shareEnvelope(jest.fn()),
        },
      },
      pipelines: {
        listSharedTeams: jest.fn().mockResolvedValue({
          success: true,
          data: {
            data: [
              {
                id: 'team-1',
                name: 'Growth',
                organization: { id: 'org-1', name: 'Acme' },
              },
            ],
          },
        }),
        listSharedOrganizations: jest.fn().mockResolvedValue({
          success: true,
          data: { data: [{ id: 'org-1', name: 'Acme' }] },
        }),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    personalOrganizationId: string | null = null,
  ): Promise<void> {
    act(() => {
      root.render(
        <ResourceContextProvider
          context={{ kind: 'personal' }}
          personalOrganizationId={personalOrganizationId}
        >
          <WorkspaceTemplateShareTab
            projectId="project-1"
            draft={templateDraft}
          />
        </ResourceContextProvider>,
      );
    });
    await settle();
  }

  it('keeps settings compact and opens the common three-audience dialog', async () => {
    await render();
    expect(container.textContent).toContain('MCP servers on this device');
    expect(
      container.querySelector(
        '[data-testid="workspace-template-share-included"]',
      ),
    ).toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-template-share-open"]',
        )
        ?.click();
    });
    await settle();

    expect(
      document.body.querySelector(
        '[data-testid="share-project-template-scope-team"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="share-project-template-scope-organization"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="share-project-template-scope-public"]',
      ),
    ).not.toBeNull();
  });

  it('publishes the reviewed draft to the selected team', async () => {
    await render();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-template-share-open"]',
        )
        ?.click();
    });
    await settle();
    act(() => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="share-project-template-team-picker-option-team-1"]',
        )
        ?.click();
    });
    await settle();
    act(() => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-project-template-submit"]',
        )
        ?.click();
    });
    await settle();

    expect(publishTemplateShare).toHaveBeenCalledWith({
      projectId: 'project-1',
      document: templateDocument,
      audience: 'TEAM',
      teamId: 'team-1',
      capabilityPackage: null,
    });
    expect(
      container.querySelector(
        '[data-testid="workspace-template-share-audience"]',
      )?.textContent,
    ).toBe('Team: Growth');
  });

  it('labels an existing Personal organization template with its canonical identity', async () => {
    getTemplateShare.mockResolvedValue({
      externalId: 'share-id',
      sharePath: '/share/project-templates/share-id',
      pinnedContentHash: 'hash',
      upToDate: true,
      audience: 'ORGANIZATION',
      owner: {
        type: 'organization',
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Stored owner',
      },
    });
    await render('11111111-1111-4111-8111-111111111111');
    expect(
      container.querySelector(
        '[data-testid="workspace-template-share-audience"]',
      )?.textContent,
    ).toBe('Personal');
  });

  it('removes an existing public template only after confirmation', async () => {
    getTemplateShare.mockResolvedValue({
      externalId: 'share-id',
      sharePath: '/share/project-templates/share-id',
      pinnedContentHash: 'hash',
      upToDate: true,
      audience: 'PUBLIC',
      owner: { type: 'user', id: 'account-1', name: 'Alice' },
    });
    await render();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-template-share-open"]',
        )
        ?.click();
    });
    await settle();
    act(() => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="share-project-template-remove-public-link"]',
        )
        ?.click();
    });
    expect(revokeTemplateShare).not.toHaveBeenCalled();
    act(() => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Remove link')
        ?.click();
    });
    await settle();
    expect(revokeTemplateShare).toHaveBeenCalledWith({
      projectId: 'project-1',
    });
  });
});
