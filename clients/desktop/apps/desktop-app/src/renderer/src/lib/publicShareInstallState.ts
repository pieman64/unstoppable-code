import type { PipelinePackageInstallRecordV1 } from '@canopy/desktop-shared/types/pipeline';
import {
  serializePipelineToYaml,
  tryParseAndValidateYaml,
} from './pipeline-yaml';

/**
 * Installed-state detection for the deep-link landing (CAN-2361 v2): a local
 * user pipeline counts as "this share, installed" when its canonical YAML
 * serialization equals the pinned snapshot's. Candidates are narrowed by
 * name first — the landing's own install path saves under the pinned
 * pipeline name, so a user-renamed copy intentionally stops matching (it has
 * diverged from the share's identity).
 *
 * Self-contained package shares tighten that further: identity is the share,
 * the YAML hash, AND the package digest together, so republished dependency
 * content is reported as an available update rather than as already installed.
 */
export interface InstalledPipelineMatch {
  pipelineId: string;
  /** Set when a package install ledger entry exists for this pipeline. */
  installedPackageDigest?: string;
  /**
   * True when the local copy's YAML matches but its packaged dependencies are
   * pinned to an older digest than the share being reviewed.
   */
  updateAvailable?: boolean;
}

export async function findInstalledPipelineByContent(
  rawPipeline: string,
  expectedPackageDigest?: string,
  expectedOriginExternalId?: string,
  expectedPipelineContentHash?: string,
): Promise<InstalledPipelineMatch | null> {
  const parsed = tryParseAndValidateYaml(rawPipeline);
  if (!parsed.success) return null;
  const canonical = serializePipelineToYaml(parsed.pipeline);

  const listed = await window.pipelines.list();
  if (!listed.success || !listed.data) return null;
  const candidates = listed.data.filter(
    (info) => info.source === 'user' && info.name === parsed.pipeline.name,
  );

  for (const candidate of candidates) {
    try {
      const loaded = await window.pipelines.get({
        id: candidate.id,
        source: 'user',
      });
      if (!loaded.success || !loaded.data) continue;
      if (serializePipelineToYaml(loaded.data.content) !== canonical) continue;

      if (
        expectedPackageDigest === undefined &&
        expectedOriginExternalId === undefined
      ) {
        return { pipelineId: candidate.id };
      }
      const installRecord = await readInstalledPackageRecord(candidate.id);
      if (expectedPackageDigest === undefined) {
        if (
          installRecord?.distributionMode !== 'definition_only' ||
          installRecord.originExternalId !== expectedOriginExternalId ||
          (expectedPipelineContentHash !== undefined &&
            installRecord.pipelineContentHash !== expectedPipelineContentHash)
        ) {
          continue;
        }
        return { pipelineId: candidate.id };
      }
      if (!installRecord?.packageDigest) continue;
      if (
        expectedOriginExternalId !== undefined &&
        installRecord.originExternalId !== expectedOriginExternalId
      ) {
        continue;
      }
      const installedPackageDigest = installRecord.packageDigest;
      return {
        pipelineId: candidate.id,
        installedPackageDigest,
        updateAvailable: installedPackageDigest !== expectedPackageDigest,
      };
    } catch {
      // Unreadable candidate — treat as not-matched.
    }
  }
  return null;
}

/**
 * Reads the local package-install ledger entry for a pipeline. Resolves to
 * null on any app build without the package install store. Legacy callers
 * without a share id still use content-based detection; share-aware callers
 * require provenance instead of reporting a false installed state.
 */
async function readInstalledPackageRecord(
  pipelineId: string,
): Promise<PipelinePackageInstallRecordV1 | null> {
  const listInstalls = window.pipelines.listPackageInstalls?.bind(
    window.pipelines,
  );
  if (!listInstalls) return null;
  try {
    const result = await listInstalls();
    if (!result.success || !result.data) return null;
    const record = result.data.find(
      (entry: PipelinePackageInstallRecordV1) =>
        entry.localPipelineId === pipelineId,
    );
    return record ?? null;
  } catch {
    return null;
  }
}
