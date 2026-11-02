import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import {
  formatShareTargetError,
  loadSharedOrganizations,
  loadSharedTeams,
  ORGANIZATIONS_LOAD_FAILED,
  TEAMS_LOAD_FAILED,
} from '../share-targets';
import { SHARED_RESOURCE_ERROR_COPY } from '../sharedResourceErrors';

const org: CanopyOrganizationSummary = {
  id: 'org-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const team: CanopyTeamSummary = {
  id: 'team-1',
  name: 'Platform',
  organization: org,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const listSharedTeams = jest.fn();
const listSharedOrganizations = jest.fn();

beforeEach(() => {
  listSharedTeams.mockReset();
  listSharedOrganizations.mockReset();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { pipelines: { listSharedTeams, listSharedOrganizations } },
  });
});

describe('loadSharedTeams', () => {
  it('omits the query when none is given and returns the team rows', async () => {
    listSharedTeams.mockResolvedValue({
      success: true,
      data: { serverId: 's', data: [team] },
    });
    await expect(loadSharedTeams()).resolves.toEqual([team]);
    expect(listSharedTeams).toHaveBeenCalledWith({});
  });

  it('passes a non-empty query through', async () => {
    listSharedTeams.mockResolvedValue({
      success: true,
      data: { serverId: 's', data: [] },
    });
    await loadSharedTeams('plat');
    expect(listSharedTeams).toHaveBeenCalledWith({ q: 'plat' });
  });

  it('rejects with the IPC error on failure', async () => {
    listSharedTeams.mockResolvedValue({ success: false, error: 'HTTP 403' });
    await expect(loadSharedTeams()).rejects.toThrow('HTTP 403');
  });

  it('rejects with failure copy, not the empty state, when the failure has no message', async () => {
    listSharedTeams.mockResolvedValue({ success: false });
    await expect(loadSharedTeams()).rejects.toThrow(TEAMS_LOAD_FAILED);
  });
});

describe('loadSharedOrganizations', () => {
  it('returns the organization rows', async () => {
    listSharedOrganizations.mockResolvedValue({
      success: true,
      data: { serverId: 's', data: [org] },
    });
    await expect(loadSharedOrganizations('ac')).resolves.toEqual([org]);
    expect(listSharedOrganizations).toHaveBeenCalledWith({ q: 'ac' });
  });

  it('rejects when the IPC result carries no data', async () => {
    listSharedOrganizations.mockResolvedValue({ success: true });
    await expect(loadSharedOrganizations()).rejects.toThrow(
      ORGANIZATIONS_LOAD_FAILED,
    );
  });
});

describe('formatShareTargetError', () => {
  it('maps loader rejections to the canonical shared-resource copy', async () => {
    listSharedTeams.mockResolvedValue({ success: false, error: 'HTTP 403' });
    const error: unknown = await loadSharedTeams().catch(
      (cause: unknown) => cause,
    );
    expect(formatShareTargetError(error)).toBe(
      SHARED_RESOURCE_ERROR_COPY.PERMISSION_DENIED,
    );
  });
});
