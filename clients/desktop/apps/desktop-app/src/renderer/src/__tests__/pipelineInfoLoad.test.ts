import type {
  IPCResult,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { mergeProjectPipelineInfos } from '../lib/pipelineInfoLoad';

function createPipelineInfo(
  id: string,
  source: PipelineInfo['source'],
): PipelineInfo {
  return {
    id,
    name: id,
    filename: `${id}.yaml`,
    description: '',
    icon: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source,
    readonly: source !== 'user',
    filePath:
      source === 'project'
        ? `/tmp/project/.canopy/pipelines/${id}.yaml`
        : undefined,
  };
}

describe('mergeProjectPipelineInfos', () => {
  it('preserves already-loaded pipelines when project discovery fails', () => {
    const infos = [
      createPipelineInfo('user-pipeline', 'user'),
      createPipelineInfo('bundled-pipeline', 'bundled'),
    ];
    const projectResult: IPCResult<PipelineInfo[]> = {
      success: false,
      error: 'EACCES: permission denied',
    };

    const result = mergeProjectPipelineInfos(infos, projectResult);

    expect(result.infos).toEqual(infos);
    expect(result.error).toBe('EACCES: permission denied');
  });

  it('appends discovered project pipelines when project discovery succeeds', () => {
    const infos = [createPipelineInfo('user-pipeline', 'user')];
    const projectPipeline = createPipelineInfo('project-pipeline', 'project');
    const projectResult: IPCResult<PipelineInfo[]> = {
      success: true,
      data: [projectPipeline],
    };

    const result = mergeProjectPipelineInfos(infos, projectResult);

    expect(result.infos).toEqual([...infos, projectPipeline]);
    expect(result.error).toBeNull();
  });
});
