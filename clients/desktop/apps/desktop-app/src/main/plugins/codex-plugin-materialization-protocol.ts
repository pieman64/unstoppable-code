import type { PluginDetails } from '@canopy/execution-engine/types/plugins';

export interface CodexPluginMaterializationPlugin {
  pluginName: string;
  pluginPath: string;
  marketplaceId: string;
  category: string;
  provider: 'claude' | 'codex';
  mode: 'native' | 'compat';
  removeMcpServers: boolean;
  includeMcpServers?: boolean;
  scanDetails?: boolean;
}

export interface CodexPluginMaterializationSkill {
  name: string;
  description: string;
  sourceDir: string;
  skillMdPath: string;
}

export interface MaterializedCodexPlugin {
  pluginName: string;
  category: string;
  cacheDir: string;
  details?: PluginDetails;
}

export interface CodexPluginMaterializationResult {
  selectedPlugins: MaterializedCodexPlugin[];
  warnings: string[];
}

export type CodexPluginMaterializationRequest =
  | {
      type: 'materialize';
      requestId: string;
      nativeProjectionRoot: string;
      plugins: CodexPluginMaterializationPlugin[];
      skills: CodexPluginMaterializationSkill[];
    }
  | { type: 'shutdown' };

export type CodexPluginMaterializationResponse =
  | {
      type: 'result';
      requestId: string;
      result: CodexPluginMaterializationResult;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'shutdown-complete' };
