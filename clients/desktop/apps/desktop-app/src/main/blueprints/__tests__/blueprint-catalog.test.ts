const readFile = jest.fn();
const writeFile = jest.fn();
const mkdir = jest.fn();
const requestPublicJson = jest.fn();

jest.mock('node:fs/promises', () => ({
  get readFile(): typeof readFile {
    return readFile;
  },
  get writeFile(): typeof writeFile {
    return writeFile;
  },
  get mkdir(): typeof mkdir {
    return mkdir;
  },
}));
jest.mock('../../canopy-cloud/client', () => ({
  requestCanopyCloudPublicJson: (...args: unknown[]): Promise<unknown> =>
    requestPublicJson(...args) as Promise<unknown>,
}));
jest.mock('../../lib/paths', () => ({
  getBlueprintCatalogCacheFilePath: (): string => '/data/blueprints.json',
}));

import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
} from '@canopy/protocol/pipelines';
import {
  BLUEPRINT_CATALOG_MAX_AGE_MS,
  listBlueprints,
  refreshBlueprints,
  resolveBlueprintsForSeeding,
} from '../blueprint-catalog';

const DOCUMENT = {
  version: 2,
  name: 'Marketing',
  description: 'Plan a campaign',
  instructions: 'Use the brand voice.',
  plugins: [],
  customSkills: [],
  starterPrompts: [{ id: 'campaign', text: 'Draft a campaign brief.' }],
};

describe('Blueprint catalog cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
  });

  // "Could not reach the cloud" and "verified empty" are different answers:
  // only the former earns the picker's retry affordance, so `available` has to
  // carry the distinction out of here.
  it('reports unavailable for a cold or corrupt cache when cloud is unavailable', async () => {
    readFile.mockRejectedValueOnce(new Error('missing'));
    requestPublicJson.mockRejectedValueOnce(new Error('offline'));
    await expect(
      listBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual({ blueprints: [], available: false });

    readFile.mockResolvedValueOnce('{"cacheSchemaVersion":99}');
    requestPublicJson.mockRejectedValueOnce(new Error('offline'));
    await expect(
      listBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual({ blueprints: [], available: false });
  });

  it('serves a stale cache rather than claiming the catalog is unavailable', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        cacheSchemaVersion: 1,
        apiVersion: 2,
        fetchedAt: new Date(
          Date.now() - BLUEPRINT_CATALOG_MAX_AGE_MS - 1,
        ).toISOString(),
        blueprints: [
          {
            externalId: '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17',
            contentHash: 'a'.repeat(64),
            document: DOCUMENT,
          },
        ],
      }),
    );
    requestPublicJson.mockRejectedValue(new Error('offline'));
    const result = await listBlueprints(new Date('2026-09-11T12:00:00Z'));
    expect(result.available).toBe(true);
    expect(result.blueprints).toHaveLength(1);
  });

  it('uses a fresh cache without fetching', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        cacheSchemaVersion: 1,
        apiVersion: 2,
        fetchedAt: '2026-09-11T11:59:00Z',
        blueprints: [
          {
            externalId: '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17',
            contentHash: 'a'.repeat(64),
            document: DOCUMENT,
          },
        ],
      }),
    );
    await expect(
      listBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual({
      blueprints: [expect.objectContaining({ document: DOCUMENT })],
      available: true,
    });
    expect(requestPublicJson).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['garbage', 'not-a-date'],
    ['expired', '2026-09-10T11:59:59Z'],
  ])('refreshes when fetchedAt is %s', async (_label, fetchedAt) => {
    readFile.mockResolvedValue(
      JSON.stringify({
        cacheSchemaVersion: 1,
        apiVersion: 2,
        ...(fetchedAt === undefined ? {} : { fetchedAt }),
        blueprints: [
          {
            externalId: '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17',
            contentHash: 'a'.repeat(64),
            document: DOCUMENT,
          },
        ],
      }),
    );
    requestPublicJson.mockResolvedValue({ blueprints: [] });

    await expect(
      listBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual({ blueprints: [], available: true });
    expect(requestPublicJson).toHaveBeenCalledWith(
      '/api/v1/public-shares/blueprints/curated',
    );
  });

  it('refreshes every entry so package-only changes are not hidden', async () => {
    readFile.mockResolvedValue(
      JSON.stringify({
        cacheSchemaVersion: 1,
        apiVersion: 2,
        fetchedAt: new Date(
          Date.now() - BLUEPRINT_CATALOG_MAX_AGE_MS - 1,
        ).toISOString(),
        blueprints: [
          {
            externalId: '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17',
            contentHash: 'a'.repeat(64),
            document: DOCUMENT,
          },
        ],
      }),
    );
    requestPublicJson
      .mockResolvedValueOnce({
        blueprints: [
          {
            externalId: '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17',
            contentHash: 'a'.repeat(64),
            name: 'Marketing',
            description: 'Plan',
            color: '#22c55e',
          },
          {
            externalId: '0e9a1700-7b5e-44ad-8a41-bbc991964561',
            contentHash: 'b'.repeat(64),
            name: 'Product',
            description: 'Build',
            color: '#3366ff',
          },
        ],
      })
      .mockResolvedValueOnce({
        entity: 'workspace',
        externalId: '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17',
        contentHash: 'a'.repeat(64),
        template: DOCUMENT,
        authorUsername: null,
        updatedAt: '2026-09-11T12:00:00Z',
      })
      .mockResolvedValueOnce({
        entity: 'workspace',
        externalId: '0e9a1700-7b5e-44ad-8a41-bbc991964561',
        contentHash: 'b'.repeat(64),
        template: { ...DOCUMENT, name: 'Product' },
        package: {
          environmentRequirements: [
            {
              id: 'linear',
              kind: 'mcp',
              displayName: 'Linear',
              required: true,
              affectedSteps: [],
              setupHint: 'Connect Linear.',
            },
          ],
        },
        authorUsername: null,
        updatedAt: '2026-09-11T12:00:00Z',
      });

    await expect(
      refreshBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual([
      expect.objectContaining({ contentHash: 'a'.repeat(64) }),
      expect.objectContaining({
        contentHash: 'b'.repeat(64),
        requirements: [expect.objectContaining({ displayName: 'Linear' })],
      }),
    ]);
    expect(requestPublicJson).toHaveBeenCalledTimes(3);
    expect(requestPublicJson).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '/public-shares/workspaces/0e9a1700-7b5e-44ad-8a41-bbc991964561',
      ),
      {
        headers: {
          [PIPELINE_PACKAGE_VERSION_HEADER]: String(
            PIPELINE_PACKAGE_CLIENT_VERSION,
          ),
        },
      },
    );
  });

  it('refreshes same-document package metadata and aggregates per-skill requirements', async () => {
    const externalId = '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17';
    readFile.mockResolvedValue(
      JSON.stringify({
        cacheSchemaVersion: 1,
        apiVersion: 2,
        fetchedAt: '2026-09-10T11:59:59Z',
        blueprints: [
          {
            externalId,
            contentHash: 'a'.repeat(64),
            document: DOCUMENT,
            requirements: [],
          },
        ],
      }),
    );
    requestPublicJson
      .mockResolvedValueOnce({
        blueprints: [
          {
            externalId,
            contentHash: 'a'.repeat(64),
            name: 'Marketing',
            description: 'Plan',
          },
        ],
      })
      .mockResolvedValueOnce({
        entity: 'workspace',
        externalId,
        contentHash: 'a'.repeat(64),
        template: DOCUMENT,
        skillPackages: [
          {
            clientKey: 'custom:app/helper',
            package: {
              environmentRequirements: [
                {
                  id: 'slack',
                  kind: 'mcp',
                  displayName: 'Slack',
                  required: true,
                  affectedSteps: [],
                  setupHint: 'Connect Slack.',
                },
              ],
            },
          },
        ],
      });

    await expect(
      refreshBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId,
        requirements: [expect.objectContaining({ displayName: 'Slack' })],
      }),
    ]);
    expect(requestPublicJson).toHaveBeenCalledTimes(2);
  });

  it('verifies a successfully refreshed catalog when the stale cache cannot be rewritten', async () => {
    const externalId = '5ddccf1b-4344-4c79-81e5-b84ce9ea4e17';
    readFile.mockResolvedValue(
      JSON.stringify({
        cacheSchemaVersion: 1,
        apiVersion: 2,
        fetchedAt: '2026-09-10T11:59:59Z',
        blueprints: [
          {
            externalId,
            contentHash: 'a'.repeat(64),
            document: DOCUMENT,
          },
        ],
      }),
    );
    requestPublicJson
      .mockResolvedValueOnce({
        blueprints: [
          {
            externalId,
            contentHash: 'b'.repeat(64),
            name: 'Marketing',
            description: 'Plan',
          },
        ],
      })
      .mockResolvedValueOnce({
        entity: 'workspace',
        externalId,
        contentHash: 'b'.repeat(64),
        template: DOCUMENT,
        authorUsername: null,
        updatedAt: '2026-09-11T12:00:00Z',
      });
    writeFile.mockRejectedValueOnce(new Error('read-only cache'));

    await expect(
      refreshBlueprints(new Date('2026-09-11T12:00:00Z')),
    ).resolves.toEqual([
      expect.objectContaining({ externalId, contentHash: 'b'.repeat(64) }),
    ]);
    await expect(resolveBlueprintsForSeeding()).resolves.toEqual({
      status: 'verified',
      blueprints: [
        expect.objectContaining({ externalId, contentHash: 'b'.repeat(64) }),
      ],
    });

    requestPublicJson.mockRejectedValueOnce(new Error('offline'));
    await expect(
      listBlueprints(new Date('2026-09-11T12:01:00Z')),
    ).resolves.toEqual({
      available: true,
      blueprints: [
        expect.objectContaining({ externalId, contentHash: 'b'.repeat(64) }),
      ],
    });

    await expect(
      listBlueprints(new Date('2026-09-12T12:00:01Z')),
    ).resolves.toEqual({
      available: true,
      blueprints: [
        expect.objectContaining({ externalId, contentHash: 'b'.repeat(64) }),
      ],
    });
  });
});
