import { listDesktopPublisherSkills } from '../publisher-marketplace';
import * as skillInstallContext from '../skill-install-context';
const mockList = jest.fn();
const mockInstalls = jest.fn();
const mockLoad = jest.fn();
jest.mock('../../canopy-cloud/publisher-skill-catalog', () => ({
  listPublisherSkills: (): unknown => mockList(),
}));
jest.mock('../../pipelines/pipeline-package-install-store', () => ({
  listCapabilityPackageInstalls: (): unknown => mockInstalls(),
}));
jest.mock('../../lib/paths', () => ({
  getPipelinePackageInstallStorePath: (): string => '/unused',
}));
jest.mock('../skill-service', () => ({
  loadSkills: (): unknown => mockLoad(),
}));
const skill = {
  externalId: 'publisher-id',
  name: 'guide',
  publisher: 'Anthropic',
  description: 'Guide',
};
beforeEach(() => {
  jest
    .spyOn(skillInstallContext, 'filterStoredSkillContexts')
    .mockImplementation((rows) => Promise.resolve(rows));
  mockList.mockResolvedValue([skill]);
  mockInstalls.mockResolvedValue([]);
  mockLoad.mockReturnValue({
    success: true,
    data: [{ sourceId: 'custom:app', name: 'guide' }],
  });
});
afterEach(() => jest.restoreAllMocks());
it('does not mistake a same-name local skill for the publisher install', async () => {
  expect(await listDesktopPublisherSkills()).toEqual([skill]);
});
it('recognizes a renamed copy only with package provenance and a visible local skill', async () => {
  mockInstalls.mockResolvedValue([
    {
      owner: { kind: 'skill', localId: 'guide-2' },
      originExternalId: 'publisher-id',
      packageDigest: 'pp:v1:digest',
    },
  ]);
  mockLoad.mockReturnValue({
    success: true,
    data: [{ sourceId: 'custom:app', name: 'guide-2' }],
  });
  expect(await listDesktopPublisherSkills()).toEqual([
    {
      ...skill,
      installedSkillName: 'guide-2',
      installedPackageDigest: 'pp:v1:digest',
    },
  ]);
  jest
    .spyOn(skillInstallContext, 'filterStoredSkillContexts')
    .mockResolvedValue([]);
  expect(await listDesktopPublisherSkills()).toEqual([skill]);
});
it('does not report a partial install as a complete package', async () => {
  mockInstalls.mockResolvedValue([
    {
      owner: { kind: 'skill', localId: 'guide' },
      originExternalId: 'publisher-id',
      distributionMode: 'definition_only',
    },
  ]);
  expect(await listDesktopPublisherSkills()).toEqual([skill]);
});
it('keeps discovery available when local install-state loading fails', async () => {
  mockInstalls.mockRejectedValue(new Error('Cannot read local ledger'));
  expect(await listDesktopPublisherSkills()).toEqual([skill]);
});
