import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePipeline } from '@canopy/desktop-shared/node/pipelines/executor';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

const REFINE_PLAN_PIPELINE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/refine-plan.yaml',
);

function loadBundledRefinePlanPipeline(): Pipeline {
  const raw = fs.readFileSync(REFINE_PLAN_PIPELINE_PATH, 'utf8');
  return parsePipelineText(raw);
}

describe('bundled refine plan pipeline', () => {
  it('declares max_iterations as a plan_ready input and uses it for refine iterations', () => {
    const pipeline = loadBundledRefinePlanPipeline();
    const normalized = normalizePipeline(pipeline);

    expect(normalized.trigger_inputs?.plan_ready?.max_iterations.default).toBe(
      2,
    );
    expect(normalized.trigger_inputs?.plan_ready?.max_iterations.type).toBe(
      'number',
    );
    expect(normalized.jobs.refine.max_iterations_expression).toBe(
      '${{ inputs.max_iterations }}',
    );
  });
});
