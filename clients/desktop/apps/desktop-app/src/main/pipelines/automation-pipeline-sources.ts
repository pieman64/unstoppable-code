import * as path from 'node:path';
import {
  normalizePipelineAssets,
  normalizePipelineLocalState,
} from '@canopy/pipeline-interop/assets';
import {
  automationPipelineKey,
  type AutomationPipelineInventoryEntry,
} from '@canopy/desktop-shared/node/pipelines/automation-pipeline-references';
import { expandPipelineAssetPath } from '@canopy/desktop-shared/node/pipelines/pipeline-assets';
import type { FileAssetPortableInput } from '@canopy/desktop-shared/node';
import type {
  Pipeline,
  PipelinePackageAnalysisBlocker,
} from '@canopy/desktop-shared/types/pipeline';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getPipelinePackageInstallStorePath } from '../lib/paths';
import { listPipelinePackageInstalls } from './pipeline-package-install-store';
import * as localPipelineService from './pipeline-service';
import { discoverProjectPipelines } from './project-pipeline-discovery';

/**
 * Host-side inputs for an automation share's packaged pipelines: which
 * pipelines a prompt or dependency list may name, the asset directories the
 * packaged ones declare, and the asset blockers the analyzer leaves to the
 * host. Electron-main compatibility path for `core.initiatedWork` packaging.
 */

/**
 * Every user pipeline, plus the project pipelines of `repoPath` when the
 * share has a worktree. A pipeline with its own installed capability package
 * is listed with `hasInstalledPackage`, so naming it blocks the share.
 */
export async function buildAutomationPipelineInventory(input: {
  repoPath?: string;
}): Promise<AutomationPipelineInventoryEntry[]> {
  const packagedPipelineIds = new Set(
    (await listPipelinePackageInstalls(getPipelinePackageInstallStorePath()))
      .filter((record) => record.distributionMode !== 'definition_only')
      .map((record) => record.localPipelineId),
  );
  const inventory: AutomationPipelineInventoryEntry[] = [];
  const listed = localPipelineService.listPipelines();
  for (const pipeline of listed.success ? (listed.data ?? []) : []) {
    if (pipeline.source !== 'user') continue;
    const filePath = localPipelineService.getPipelinePath(pipeline.id);
    if (!filePath.success || !filePath.data) continue;
    inventory.push({
      key: automationPipelineKey({
        source: 'user',
        pipelineId: pipeline.id,
        path: filePath.data,
      }),
      pipelineId: pipeline.id,
      name: pipeline.name,
      source: 'user',
      path: filePath.data,
      hasInstalledPackage: packagedPipelineIds.has(pipeline.id),
    });
  }
  if (input.repoPath) {
    let projectPipelines: Awaited<ReturnType<typeof discoverProjectPipelines>>;
    try {
      projectPipelines = await discoverProjectPipelines(input.repoPath);
    } catch (error) {
      // Project pipelines are optional here: a requested one that can't be
      // listed is reported by the analysis as a missing dependency.
      logMainProcessWarn(
        '[pipeline-packages] could not list project pipelines for an automation share',
        error,
      );
      projectPipelines = [];
    }
    for (const pipeline of projectPipelines) {
      if (!pipeline.filePath) continue;
      inventory.push({
        key: automationPipelineKey({
          source: 'project',
          pipelineId: pipeline.id,
          path: pipeline.filePath,
        }),
        pipelineId: pipeline.id,
        name: pipeline.name,
        source: 'project',
        path: pipeline.filePath,
        hasInstalledPackage: false,
      });
    }
  }
  return inventory;
}

/** A pipeline an automation share packages, as parsed for its assets. */
export interface PackagedAutomationPipeline {
  key: string;
  name: string;
  pipeline: Pipeline;
}

/**
 * The asset directories a packaged pipeline declares, with `~` expanded
 * against `homedir`. A malformed declaration is a blocker rather than a
 * silently dropped asset.
 */
export function packagedPipelineFileAssets(
  packaged: PackagedAutomationPipeline,
  homedir: string,
):
  | { ok: true; assets: FileAssetPortableInput[] }
  | { ok: false; blocker: PipelinePackageAnalysisBlocker } {
  let assets: ReturnType<typeof normalizePipelineAssets>;
  let localState: ReturnType<typeof normalizePipelineLocalState>;
  try {
    assets = normalizePipelineAssets(packaged.pipeline.assets);
    localState = normalizePipelineLocalState(packaged.pipeline.local_state);
  } catch (error) {
    return {
      ok: false,
      blocker: {
        code: 'INVALID_PACKAGE',
        subject: packaged.name,
        message: `"${packaged.name}" declares its assets incorrectly: ${
          error instanceof Error ? error.message : String(error)
        }`,
        occurrences: [],
      },
    };
  }
  const expand = (declared: string): string =>
    expandPipelineAssetPath(declared, homedir) ?? declared;
  const expandedLocalState = (localState ?? []).map(expand);
  return {
    ok: true,
    assets: (assets ?? []).map((asset) => ({
      pipelineKey: packaged.key,
      assetId: asset.id,
      sourcePath: expand(asset.path),
      required: asset.required,
      installMode: asset.install,
      localState: expandedLocalState,
    })),
  };
}

/** Assets are kept to Team and Organization shares in v1. */
export function publicAudienceAssetsBlockers(
  audience: 'private' | 'team' | 'organization' | 'public' | undefined,
  packaged: readonly PackagedAutomationPipeline[],
): PipelinePackageAnalysisBlocker[] {
  if (audience !== 'public') return [];
  return packaged
    .filter(
      ({ pipeline }) =>
        Array.isArray(pipeline.assets) && pipeline.assets.length > 0,
    )
    .map(({ name }) => ({
      code: 'ASSETS_NOT_ALLOWED_FOR_PUBLIC',
      subject: name,
      message: `"${name}" includes files, which aren't available for Public shares. Share with a team or organization instead.`,
      occurrences: [],
    }));
}

/** The directory children of a stored or project pipeline resolve from. */
export function pipelineFileDir(
  filePath: string | undefined,
): string | undefined {
  return filePath ? path.dirname(filePath) : undefined;
}
