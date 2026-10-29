/**
 * @jest-environment jsdom
 */
import { pipelineSharePath } from '@canopy/protocol/pipelines';
import { sharedContainerLinkPath } from '@canopy/protocol/shared-containers';
import {
  createShareLinkResolver,
  resolveSharedAutomationUrl,
  resolveSharedContainerLinkUrl,
  resolveSharedPipelineUrl,
  resolveSharedPlanUrl,
  resolveSharedRunUrl,
  resolveSharedSkillUrl,
} from '@/lib/share-links';

function installBaseUrl(
  value: string | null | (() => Promise<string | null>),
): void {
  const getCanopyCloudBaseUrl =
    typeof value === 'function' ? value : jest.fn().mockResolvedValue(value);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getCanopyCloudBaseUrl },
  });
}

function clearApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: undefined,
  });
}

afterEach(() => {
  clearApi();
});

describe('resolveSharedRunUrl', () => {
  it('joins the base URL with the run route', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(resolveSharedRunUrl('run-123')).resolves.toBe(
      'https://cloud.example.test/runs/run-123',
    );
  });

  it('strips trailing slashes from the base URL', async () => {
    installBaseUrl('https://cloud.example.test/');
    await expect(resolveSharedRunUrl('run-123')).resolves.toBe(
      'https://cloud.example.test/runs/run-123',
    );
  });

  it('url-encodes the id segment', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(resolveSharedRunUrl('a b/c')).resolves.toBe(
      'https://cloud.example.test/runs/a%20b%2Fc',
    );
  });

  it('returns null when the base URL is not configured', async () => {
    installBaseUrl(null);
    await expect(resolveSharedRunUrl('run-123')).resolves.toBeNull();
  });

  it('returns null when the base URL lookup throws', async () => {
    installBaseUrl(() => Promise.reject(new Error('boom')));
    await expect(resolveSharedRunUrl('run-123')).resolves.toBeNull();
  });

  it('returns null when the api is unavailable', async () => {
    clearApi();
    await expect(resolveSharedRunUrl('run-123')).resolves.toBeNull();
  });
});

describe('resolveSharedPlanUrl', () => {
  it('joins the base URL with the plan route', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(resolveSharedPlanUrl('plan-abc')).resolves.toBe(
      'https://cloud.example.test/plans/plan-abc',
    );
  });

  it('returns null when the base URL is empty', async () => {
    installBaseUrl('');
    await expect(resolveSharedPlanUrl('plan-abc')).resolves.toBeNull();
  });
});

/**
 * The renderer never constructs a pipeline share path — it concatenates the
 * cloud base URL with the `sharePath` the server minted. These cover that
 * opacity, which is why moving the prefix off the storefront-owned `/s/*`
 * segment onto `/share/pipelines` needed no desktop change at all. The
 * expectation is DERIVED from `pipelineSharePath` rather than re-literalized,
 * so it follows the protocol constant instead of pinning a stale shape.
 */
describe('resolveSharedPipelineUrl', () => {
  it('joins the base URL with the server-minted share path', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(
      resolveSharedPipelineUrl(pipelineSharePath('pipeline-abc')),
    ).resolves.toBe(
      'https://cloud.example.test/portal/plugins/pipelines/shared/pipeline-abc',
    );
  });

  it('does not route the copy link through the storefront-owned /s segment', async () => {
    installBaseUrl('https://cloud.example.test');
    const url = await resolveSharedPipelineUrl(
      pipelineSharePath('pipeline-abc'),
    );
    expect(url).not.toBeNull();
    expect(new URL(url ?? '').pathname.split('/')[1]).not.toBe('s');
  });

  it('passes an arbitrary server path through untouched', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(
      resolveSharedPipelineUrl('/some/future/prefix/xyz'),
    ).resolves.toBe('https://cloud.example.test/some/future/prefix/xyz');
  });

  it('normalizes a share path that arrives without a leading slash', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(
      resolveSharedPipelineUrl('portal/plugins/pipelines/shared/xyz'),
    ).resolves.toBe(
      'https://cloud.example.test/portal/plugins/pipelines/shared/xyz',
    );
  });

  it('returns null when the base URL is not configured', async () => {
    installBaseUrl(null);
    await expect(
      resolveSharedPipelineUrl(pipelineSharePath('pipeline-abc')),
    ).resolves.toBeNull();
  });
});

describe('resolveSharedSkillUrl', () => {
  it('normalizes a share path without a leading slash', async () => {
    installBaseUrl('https://cloud.example.test');
    await expect(
      resolveSharedSkillUrl('portal/plugins/skills/shared/skill-1'),
    ).resolves.toBe(
      'https://cloud.example.test/portal/plugins/skills/shared/skill-1',
    );
  });

  it('returns null when the base URL is not configured', async () => {
    installBaseUrl(null);
    await expect(
      resolveSharedSkillUrl('/portal/plugins/skills/shared/skill-1'),
    ).resolves.toBeNull();
  });
});

describe('resolveSharedAutomationUrl', (): void => {
  it('preserves an opaque server-provided path', async (): Promise<void> => {
    installBaseUrl('https://cloud.example.test/');
    await expect(
      resolveSharedAutomationUrl('/future/public/resource'),
    ).resolves.toBe('https://cloud.example.test/future/public/resource');
  });

  it('returns null without a configured base URL', async (): Promise<void> => {
    installBaseUrl(null);
    await expect(
      resolveSharedAutomationUrl('/future/public/resource'),
    ).resolves.toBeNull();
  });
});

describe('createShareLinkResolver', () => {
  const scopedPath = (id: string): string => `/share/resources/${id}`;

  it('prefers a public link and derives the same scoped route used by share', async () => {
    const resolve = jest.fn((path: string) =>
      Promise.resolve(`https://cloud.test${path}`),
    );
    const links = createShareLinkResolver(scopedPath, resolve);

    await expect(
      links.linkFromDetail({
        id: 'resource-1',
        shareScope: 'team',
        publicShare: { sharePath: '/public/resource-1' },
      }),
    ).resolves.toEqual({
      url: 'https://cloud.test/public/resource-1',
      kind: 'public',
    });
    await expect(
      links.linkFromDetail({ id: 'resource-1', shareScope: 'team' }),
    ).resolves.toEqual({
      url: 'https://cloud.test/share/resources/resource-1',
      kind: 'scoped',
    });
  });

  it('does not expose a path-only existing link before URL resolution', async () => {
    const links = createShareLinkResolver(scopedPath, () =>
      Promise.resolve(null),
    );
    await expect(
      links.linkFromDetail({ id: 'resource-1', shareScope: 'organization' }),
    ).resolves.toBeNull();
    await expect(
      links.resolveLink({ kind: 'scoped', id: 'resource-1' }),
    ).resolves.toEqual({
      url: '/share/resources/resource-1',
      kind: 'scoped',
    });
  });
});

describe('resolveSharedContainerLinkUrl', () => {
  const token = `${'a'.repeat(42)}A`;

  it('projects the server-returned link path onto the cloud origin', async () => {
    installBaseUrl('https://cloud.example.test/');
    await expect(
      resolveSharedContainerLinkUrl(sharedContainerLinkPath(token)),
    ).resolves.toBe(`https://cloud.example.test/share/view/${token}`);
  });

  it('returns null when the base URL is not configured', async () => {
    installBaseUrl(null);
    await expect(
      resolveSharedContainerLinkUrl(sharedContainerLinkPath(token)),
    ).resolves.toBeNull();
  });
});
