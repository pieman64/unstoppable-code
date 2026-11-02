import type {
  IPCResult,
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { getTriggerTypes } from '@canopy/desktop-shared/types/pipeline';
import type { PipelineHookSource } from '@canopy/desktop-shared/hooks';
import { pipelineSupportsExecutionScope } from './pipelineExecutionScope';
import { loadDisabledPipelineIdsBestEffort } from './pipelineEnablement';

/**
 * UI-friendly pipeline option for the hook-action editor pipeline picker.
 *
 * The `actionSource` / `actionId` pair maps directly to the `source` / `id`
 * fields persisted on a `PipelineHookAction`. For project pipelines we use
 * the relative YAML path under `.canopy/pipelines/` (matching the JSON
 * schema in `src/shared/hooks.ts`); for bundled and local pipelines we use
 * the stored pipeline id.
 */
export interface HookPipelineOption {
  actionSource: PipelineHookSource;
  actionId: string;
  data: PipelineData | { info: PipelineInfo; content?: undefined };
}

interface LoadHookPipelineOptionsArgs {
  /**
   * Repo cwd to use when discovering project pipelines. When undefined or
   * empty, only bundled and local pipelines are loaded.
   */
  cwd?: string;
}

function isPipelineDispatchCapable(content: PipelineData['content']): boolean {
  return getTriggerTypes(content.on).includes('dispatch');
}

function getActionSource(info: PipelineInfo): PipelineHookSource | null {
  if (info.source === 'curated') return 'curated';
  if (info.source === 'bundled') {
    return 'bundled';
  }
  if (info.source === 'user') {
    return 'local';
  }
  if (info.source === 'project') {
    return 'project';
  }
  return null;
}

function getActionId(info: PipelineInfo): string | null {
  // Project pipelines persist as relative `.canopy/pipelines/<file>.yaml`
  // paths, surfaced through `info.filename` when discovered against a cwd.
  if (info.source === 'project') {
    return info.filename || null;
  }
  return info.id;
}

async function loadPipelineData(
  info: PipelineInfo,
  cwd: string | undefined,
): Promise<PipelineData | null> {
  if (info.source === 'project' && info.filePath) {
    const result = await window.pipelines.get({
      id: info.id,
      cwd: cwd ?? '',
      filePath: info.filePath,
    });
    return result.success && result.data ? result.data : null;
  }

  const result = await window.pipelines.get({
    id: info.id,
    source:
      info.source === 'curated'
        ? 'curated'
        : info.source === 'bundled'
          ? 'bundled'
          : 'user',
  });
  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'This workflow is unavailable.');
  }
  return result.data;
}

/**
 * Load the dispatch-capable pipeline options for the hook-action editor.
 *
 * Combines bundled, local, and (when a `cwd` is provided) project pipelines.
 * Local options carry resolved `PipelineData`. Curated options retain only
 * listing metadata until selected, when the managed service resolves inputs.
 *
 * Pipelines that fail to load or do not declare a `dispatch` trigger are
 * filtered out so they never appear in the picker.
 */
export async function loadHookPipelineOptions(
  args: LoadHookPipelineOptionsArgs = {},
): Promise<HookPipelineOption[]> {
  const { cwd } = args;
  const emptyProjectList: IPCResult<PipelineInfo[]> = {
    success: true,
    data: [],
  };
  const projectListPromise: Promise<IPCResult<PipelineInfo[]>> =
    cwd && cwd.length > 0
      ? window.pipelines.discoverProject(cwd)
      : Promise.resolve(emptyProjectList);

  const [lists, disabledIds] = await Promise.all([
    Promise.all([window.pipelines.list(), projectListPromise]),
    loadDisabledPipelineIdsBestEffort(),
  ]);

  const infos: PipelineInfo[] = [];
  for (const list of lists) {
    if (list.success && list.data) {
      // Disabled pipelines must not appear in the hook pipeline picker.
      infos.push(...list.data.filter((info) => !disabledIds.has(info.id)));
    }
  }

  const options = await Promise.all(
    infos.map(async (info): Promise<HookPipelineOption | null> => {
      const actionSource = getActionSource(info);
      const actionId = getActionId(info);
      if (!actionSource || !actionId) {
        return null;
      }

      if (info.source === 'curated') {
        if (
          !info.triggerTypes?.includes('dispatch') ||
          !pipelineSupportsExecutionScope(info, 'worktree')
        )
          return null;
        return { actionSource, actionId, data: { info } };
      }

      let data: PipelineData | null = null;
      try {
        data = await loadPipelineData(info, cwd);
      } catch {
        data = null;
      }
      if (
        !data ||
        !isPipelineDispatchCapable(data.content) ||
        !pipelineSupportsExecutionScope(data.info, 'worktree')
      ) {
        return null;
      }

      return { actionSource, actionId, data };
    }),
  );

  return options.filter(
    (option): option is HookPipelineOption => option !== null,
  );
}

/** Resolve only the selected metadata row before editing its dispatch inputs. */
export async function resolveHookPipelineOption(
  option: HookPipelineOption,
): Promise<HookPipelineOption> {
  if (option.data.content) return option;
  const data = await loadPipelineData(option.data.info, undefined);
  if (
    !data ||
    !isPipelineDispatchCapable(data.content) ||
    !pipelineSupportsExecutionScope(data.info, 'worktree')
  ) {
    throw new Error(
      'This workflow is unavailable or no longer supports dispatch in a worktree.',
    );
  }
  return { ...option, data };
}
