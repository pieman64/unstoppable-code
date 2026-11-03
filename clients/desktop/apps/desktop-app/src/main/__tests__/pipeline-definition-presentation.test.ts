import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import {
  presentPipeline,
  presentedPipeline,
  withPipelinePresentation,
} from '../pipelines/pipeline-definition-presentation';

const info = (filePath: string): PipelineInfo => ({
  id: 'project--review.yaml',
  name: 'Review',
  filename: 'review.yaml',
  description: '',
  icon: '',
  createdAt: '',
  updatedAt: '',
  source: 'project',
  readonly: true,
  filePath,
});

describe('pipeline definition presentation', () => {
  it('keeps overlapping calls for the same id in separate worktrees apart', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = (filePath: string, wait: boolean): Promise<unknown> =>
      withPipelinePresentation(async (presentation) => {
        presentPipeline('listed', 'project', 'project--review.yaml', {
          kind: 'info',
          info: info(filePath),
        });
        if (wait) await gate;
        const row = presentation.pipeline(
          'listed',
          'project',
          'project--review.yaml',
        );
        return row?.kind === 'info' ? row.info.filePath : undefined;
      });
    const first = read('/a/review.yaml', true);
    const second = read('/b/review.yaml', false);
    expect(await second).toBe('/b/review.yaml');
    release();
    expect(await first).toBe('/a/review.yaml');
  });

  it('records nothing outside a call', () => {
    presentPipeline('read', 'curated', 'curated:x', {
      kind: 'info',
      info: info('/x'),
    });
    expect(presentedPipeline('read', 'curated', 'curated:x')).toBeUndefined();
  });
});
