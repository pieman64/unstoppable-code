import type { ParentPort } from 'electron';
import { projectCodexPluginWithoutMcpServers } from '@canopy/execution-engine/node/plugins/codex-plugin-projection';
import {
  buildCodexQualifiedReferenceMap,
  BUILTIN_APP_PLUGIN_NAME,
  ensureAggregateCodexCompatiblePlugin,
  ensureCodexCompatibleClaudePlugin,
  readClaudePluginCompatibilitySource,
  type AggregateSkillSource,
} from './codex-plugin-compat';
import type {
  CodexPluginMaterializationRequest,
  CodexPluginMaterializationResponse,
  CodexPluginMaterializationResult,
} from './codex-plugin-materialization-protocol';
import { scanPluginDetails } from './plugin-scanner';

type MaterializeRequest = Extract<
  CodexPluginMaterializationRequest,
  { type: 'materialize' }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequest(value: unknown): value is CodexPluginMaterializationRequest {
  if (!isRecord(value)) return false;
  if (value.type === 'shutdown') return true;
  return value.type === 'materialize' && typeof value.requestId === 'string';
}

export function materializeCodexPluginCapabilities(
  request: MaterializeRequest,
): CodexPluginMaterializationResult {
  const warnings: string[] = [];
  const selectedPlugins: CodexPluginMaterializationResult['selectedPlugins'] =
    [];

  for (const plugin of request.plugins) {
    if (plugin.provider !== 'codex' || plugin.mode !== 'native') continue;
    const cacheDir = plugin.removeMcpServers
      ? projectCodexPluginWithoutMcpServers({
          sourcePluginPath: plugin.pluginPath,
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          projectionRootDir: request.nativeProjectionRoot,
          warnings,
        })
      : plugin.pluginPath;
    if (cacheDir) {
      selectedPlugins.push({
        pluginName: plugin.pluginName,
        category: plugin.category,
        cacheDir,
      });
    }
  }

  const compatibilityPlugins = request.plugins.filter(
    (plugin) => !(plugin.provider === 'codex' && plugin.mode === 'native'),
  );
  if (compatibilityPlugins.length > 0) {
    const sources = compatibilityPlugins.map((plugin) => ({
      plugin,
      source: readClaudePluginCompatibilitySource({
        pluginName: plugin.pluginName,
        pluginPath: plugin.pluginPath,
        marketplaceId: plugin.marketplaceId,
        category: plugin.category,
      }),
    }));
    const qualifiedReferenceMap = buildCodexQualifiedReferenceMap(
      sources.map(({ source }) => source),
    );
    for (const { plugin, source } of sources) {
      const compatiblePlugin = ensureCodexCompatibleClaudePlugin(
        source,
        qualifiedReferenceMap,
        { includeMcpServers: plugin.includeMcpServers === true },
      );
      selectedPlugins.push({
        pluginName: compatiblePlugin.pluginName,
        category: compatiblePlugin.category,
        cacheDir: compatiblePlugin.cacheDir,
        ...(plugin.scanDetails
          ? {
              details: scanPluginDetails(compatiblePlugin.cacheDir, {
                manifestKind: 'codex',
              }),
            }
          : {}),
      });
      warnings.push(...compatiblePlugin.warnings);
    }
  }

  if (request.skills.length > 0) {
    const aggregatePlugin = ensureAggregateCodexCompatiblePlugin({
      pluginName: BUILTIN_APP_PLUGIN_NAME,
      category: 'Development',
      skills: request.skills.map<AggregateSkillSource>((skill) => ({
        name: skill.name,
        description: skill.description,
        sourceDir: skill.sourceDir,
        skillMdPath: skill.skillMdPath,
      })),
      mcpServers: {},
    });
    selectedPlugins.push({
      pluginName: aggregatePlugin.pluginName,
      category: aggregatePlugin.category,
      cacheDir: aggregatePlugin.cacheDir,
    });
    warnings.push(...aggregatePlugin.warnings);
  }

  return { selectedPlugins, warnings };
}

export function startCodexPluginMaterializationWorker(
  parentPort: ParentPort,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): void {
  parentPort.on('message', (event: unknown): void => {
    const payload =
      isRecord(event) && 'data' in event && !isRequest(event)
        ? event.data
        : event;
    if (!isRequest(payload)) return;
    if (payload.type === 'shutdown') {
      parentPort.postMessage({
        type: 'shutdown-complete',
      } satisfies CodexPluginMaterializationResponse);
      exitProcess(0);
      return;
    }
    try {
      parentPort.postMessage({
        type: 'result',
        requestId: payload.requestId,
        result: materializeCodexPluginCapabilities(payload),
      } satisfies CodexPluginMaterializationResponse);
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        requestId: payload.requestId,
        message: error instanceof Error ? error.message : String(error),
      } satisfies CodexPluginMaterializationResponse);
    }
  });
}

const workerParentPort: ParentPort | undefined = process.parentPort;
if (workerParentPort) {
  startCodexPluginMaterializationWorker(workerParentPort);
}
