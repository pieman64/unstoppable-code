import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CODEX_MODEL,
  getGatewayModelEntries,
} from '@canopy/desktop-shared/types';
import { getCodexRuntimeService } from './runtime-service';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildGatewayCompatibleCodexCatalog(
  bundledCatalog: unknown,
  gatewayEntries = getGatewayModelEntries(),
): JsonRecord | null {
  if (!isRecord(bundledCatalog) || !Array.isArray(bundledCatalog.models)) {
    throw new Error('Bundled Codex model catalog has an invalid shape');
  }

  const bundledModels = bundledCatalog.models.filter(isRecord);
  const bundledBySlug = new Map<string, JsonRecord>();
  for (const model of bundledModels) {
    if (typeof model.slug === 'string') {
      bundledBySlug.set(model.slug, model);
    }
  }

  const gatewayAliases: JsonRecord[] = [];
  const includedGatewayIds = new Set<string>();
  const fallbackProfile =
    bundledBySlug.get(DEFAULT_CODEX_MODEL) ?? bundledModels[0];
  for (const gateway of gatewayEntries) {
    if (includedGatewayIds.has(gateway.gatewayId)) {
      continue;
    }
    const bundledModel =
      bundledBySlug.get(gateway.modelId) ??
      (gateway.gatewayOnly ? fallbackProfile : undefined);
    if (!bundledModel) {
      // Managed routes require their native profile. API-only routes use the
      // standard bundled fallback when one is available.
      continue;
    }
    includedGatewayIds.add(gateway.gatewayId);
    gatewayAliases.push({
      ...bundledModel,
      slug: gateway.gatewayId,
      display_name:
        typeof bundledModel.display_name === 'string'
          ? bundledModel.display_name
          : gateway.modelId,
      context_window: gateway.contextWindow,
      use_responses_lite: false,
      tool_mode: null,
    });
  }

  if (gatewayAliases.length === 0) {
    return null;
  }
  return {
    ...bundledCatalog,
    models: [...bundledModels, ...gatewayAliases],
  };
}

const catalogPathPromises = new Map<string, Promise<string | undefined>>();
const catalogDirectoryPaths = new Set<string>();

function gatewayRouteRevision(
  gatewayEntries: ReturnType<typeof getGatewayModelEntries>,
): string {
  return JSON.stringify(gatewayEntries);
}

/**
 * Materialize a process-local Codex catalog that preserves bundled model
 * metadata while giving AI Gateway IDs a portable standard-Responses profile.
 */
export function ensureGatewayCompatibleCodexCatalog(): Promise<
  string | undefined
> {
  const gatewayEntries = getGatewayModelEntries();
  const revision = gatewayRouteRevision(gatewayEntries);
  let catalogPathPromise = catalogPathPromises.get(revision);
  if (!catalogPathPromise) {
    const pending = (async (): Promise<string | undefined> => {
      const bundledCatalog =
        await getCodexRuntimeService().getBundledModelCatalog();
      const catalog = buildGatewayCompatibleCodexCatalog(
        bundledCatalog,
        gatewayEntries,
      );
      if (!catalog) {
        return undefined;
      }
      const directoryPath = await mkdtemp(
        join(tmpdir(), 'canopy-codex-gateway-models-'),
      );
      try {
        const catalogPath = join(directoryPath, 'models.json');
        await writeFile(catalogPath, JSON.stringify(catalog), {
          encoding: 'utf8',
          mode: 0o600,
        });
        catalogDirectoryPaths.add(directoryPath);
        return catalogPath;
      } catch (error) {
        await rm(directoryPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    })();
    const guarded = pending.catch((error: unknown) => {
      if (catalogPathPromises.get(revision) === guarded) {
        catalogPathPromises.delete(revision);
      }
      process.emitWarning(
        `Failed to materialize the Codex AI Credits model catalog: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'CANOPY_CODEX_GATEWAY_CATALOG' },
      );
      return undefined;
    });
    catalogPathPromise = guarded;
    catalogPathPromises.set(revision, guarded);
  }
  return catalogPathPromise;
}

/** Remove the process-local catalog after every app-server has stopped. */
export async function cleanupGatewayCompatibleCodexCatalog(): Promise<void> {
  const pending = Array.from(catalogPathPromises.values());
  catalogPathPromises.clear();
  await Promise.all(pending);
  const directoryPaths = Array.from(catalogDirectoryPaths);
  catalogDirectoryPaths.clear();
  await Promise.all(
    directoryPaths.map((directoryPath) =>
      rm(directoryPath, { recursive: true, force: true }),
    ),
  );
}
