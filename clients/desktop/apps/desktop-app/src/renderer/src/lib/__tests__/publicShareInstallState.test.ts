/**
 * @jest-environment jsdom
 */

import { findInstalledPipelineByContent } from '../publicShareInstallState';
import { tryParseAndValidateYaml } from '../pipeline-yaml';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

const RAW_PIPELINE = `name: shared-e2e-pipeline\ndescription: Deterministic deep-link fixture pipeline\non:\n  dispatch: {}\njobs:\n  greet:\n    steps:\n      - name: Say hello\n        run: echo hello\n`;

const DIVERGED_PIPELINE = `name: shared-e2e-pipeline\ndescription: Deterministic deep-link fixture pipeline\non:\n  dispatch: {}\njobs:\n  greet:\n    steps:\n      - name: Say hello\n        run: echo goodbye\n`;

function parsePipeline(raw: string): Pipeline {
  const parsed = tryParseAndValidateYaml(raw);
  if (!parsed.success) {
    throw new Error(`Test fixture pipeline is invalid: ${parsed.error}`);
  }
  return parsed.pipeline;
}

const DIGEST_A = `pp:v1:${'A'.repeat(43)}`;
const DIGEST_B = `pp:v1:${'B'.repeat(43)}`;
const SHARE_A = 'share-a';
const SHARE_B = 'share-b';

describe('findInstalledPipelineByContent', () => {
  const list = jest.fn();
  const get = jest.fn();
  const listPackageInstalls = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(window, { pipelines: { list, get, listPackageInstalls } });
  });

  function matchingLocalCopy(): void {
    list.mockResolvedValue({
      success: true,
      data: [{ id: 'pipe-1', source: 'user', name: 'shared-e2e-pipeline' }],
    });
    get.mockResolvedValue({
      success: true,
      data: { content: parsePipeline(RAW_PIPELINE) },
    });
  }

  it('matches a user pipeline whose canonical YAML equals the snapshot', async () => {
    list.mockResolvedValue({
      success: true,
      data: [{ id: 'pipe-1', source: 'user', name: 'shared-e2e-pipeline' }],
    });
    get.mockResolvedValue({
      success: true,
      data: { content: parsePipeline(RAW_PIPELINE) },
    });

    await expect(findInstalledPipelineByContent(RAW_PIPELINE)).resolves.toEqual(
      { pipelineId: 'pipe-1' },
    );
    expect(get).toHaveBeenCalledWith({ id: 'pipe-1', source: 'user' });
  });

  it('narrows candidates by name: a renamed copy no longer matches', async () => {
    list.mockResolvedValue({
      success: true,
      data: [{ id: 'pipe-1', source: 'user', name: 'my-renamed-copy' }],
    });

    await expect(findInstalledPipelineByContent(RAW_PIPELINE)).resolves.toBe(
      null,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('ignores non-user pipeline sources even with a matching name', async () => {
    list.mockResolvedValue({
      success: true,
      data: [{ id: 'pipe-1', source: 'bundled', name: 'shared-e2e-pipeline' }],
    });

    await expect(findInstalledPipelineByContent(RAW_PIPELINE)).resolves.toBe(
      null,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a same-name pipeline whose content diverged', async () => {
    list.mockResolvedValue({
      success: true,
      data: [{ id: 'pipe-1', source: 'user', name: 'shared-e2e-pipeline' }],
    });
    get.mockResolvedValue({
      success: true,
      data: { content: parsePipeline(DIVERGED_PIPELINE) },
    });

    await expect(findInstalledPipelineByContent(RAW_PIPELINE)).resolves.toBe(
      null,
    );
  });

  it('reports a package share installed when the pinned digest matches', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({
      success: true,
      data: [
        {
          localPipelineId: 'pipe-1',
          originExternalId: SHARE_A,
          packageDigest: DIGEST_A,
        },
      ],
    });

    await expect(
      findInstalledPipelineByContent(RAW_PIPELINE, DIGEST_A, SHARE_A),
    ).resolves.toEqual({
      pipelineId: 'pipe-1',
      installedPackageDigest: DIGEST_A,
      updateAvailable: false,
    });
  });

  it('does not match an identical package installed from another share', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({
      success: true,
      data: [
        {
          localPipelineId: 'pipe-1',
          originExternalId: SHARE_A,
          packageDigest: DIGEST_A,
        },
      ],
    });

    await expect(
      findInstalledPipelineByContent(RAW_PIPELINE, DIGEST_A, SHARE_B),
    ).resolves.toBeNull();
  });

  it('reports an update when the author republished a new package', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({
      success: true,
      data: [{ localPipelineId: 'pipe-1', packageDigest: DIGEST_A }],
    });

    await expect(
      findInstalledPipelineByContent(RAW_PIPELINE, DIGEST_B),
    ).resolves.toEqual({
      pipelineId: 'pipe-1',
      installedPackageDigest: DIGEST_A,
      updateAvailable: true,
    });
  });

  it('treats a YAML-only local copy of a package share as not installed', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({ success: true, data: [] });

    await expect(
      findInstalledPipelineByContent(RAW_PIPELINE, DIGEST_A),
    ).resolves.toBeNull();
  });

  it('ignores the ledger entirely for a definition-only share', async () => {
    matchingLocalCopy();

    await expect(findInstalledPipelineByContent(RAW_PIPELINE)).resolves.toEqual(
      { pipelineId: 'pipe-1' },
    );
    expect(listPackageInstalls).not.toHaveBeenCalled();
  });

  it('requires same-share provenance for a definition-only share', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({ success: true, data: [] });

    await expect(
      findInstalledPipelineByContent(RAW_PIPELINE, undefined, SHARE_A),
    ).resolves.toBeNull();
    expect(listPackageInstalls).toHaveBeenCalled();
  });

  it('matches a definition-only install from the reviewed share', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({
      success: true,
      data: [
        {
          localPipelineId: 'pipe-1',
          originExternalId: SHARE_A,
          pipelineContentHash: 'reviewed-content-hash',
          distributionMode: 'definition_only',
        },
      ],
    });

    await expect(
      findInstalledPipelineByContent(
        RAW_PIPELINE,
        undefined,
        SHARE_A,
        'reviewed-content-hash',
      ),
    ).resolves.toEqual({ pipelineId: 'pipe-1' });
  });

  it('rejects definition-only provenance for a different YAML hash', async () => {
    matchingLocalCopy();
    listPackageInstalls.mockResolvedValue({
      success: true,
      data: [
        {
          localPipelineId: 'pipe-1',
          originExternalId: SHARE_A,
          pipelineContentHash: 'different-content-hash',
          distributionMode: 'definition_only',
        },
      ],
    });
    await expect(
      findInstalledPipelineByContent(
        RAW_PIPELINE,
        undefined,
        SHARE_A,
        'reviewed-content-hash',
      ),
    ).resolves.toBeNull();
  });

  it('returns null for an unparsable snapshot without listing pipelines', async () => {
    await expect(
      findInstalledPipelineByContent('not: [valid pipeline'),
    ).resolves.toBe(null);
    expect(list).not.toHaveBeenCalled();
  });
});
