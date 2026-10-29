import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

const CREATE_TASK_IMPLEMENTATION_PLAN_PIPELINE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/create-task-implementation-plan.yaml',
);

function loadCreateTaskImplementationPlanPipeline(): Pipeline {
  const raw = fs.readFileSync(
    CREATE_TASK_IMPLEMENTATION_PLAN_PIPELINE_PATH,
    'utf8',
  );
  return parsePipelineText(raw);
}

describe('bundled create task implementation plan pipeline', () => {
  it('uses task_ready, exposes a model selector, and publishes the generated proposed plan', () => {
    const pipeline = loadCreateTaskImplementationPlanPipeline();
    const planJob = pipeline.jobs.plan;
    const summaryJob = pipeline.jobs.summary;

    expect(pipeline.on).toEqual({
      task_ready: {
        inputs: {
          model: {
            type: 'choice',
            description: 'Choose the planning model.',
            options: ['opus', '$fast', '$default-codex'],
            default: '$default-codex',
          },
        },
      },
    });
    expect(planJob?.steps.find((step) => step.id === 'create_plan')?.uses).toBe(
      'builtin/agent-prompt',
    );
    expect(
      planJob?.steps.find((step) => step.id === 'create_plan')?.with?.model,
    ).toBe('${{ inputs.model }}');
    expect(
      planJob?.steps.find((step) => step.id === 'create_plan')?.with
        ?.thinking_effort,
    ).toBe('xhigh');
    expect(
      planJob?.steps.find((step) => step.id === 'create_plan')?.with
        ?.permission_preset,
    ).toBe('plan');
    expect(
      planJob?.steps.find((step) => step.id === 'create_plan')?.with
        ?.prompt_file,
    ).toBe('${{ {{BRAND_EXPRESSION_ROOT}}.event.task_ready.task_path }}');

    const publishPlanStep = planJob?.steps.find(
      (step) => step.id === 'publish_plan',
    );
    expect(publishPlanStep?.shell).toBe('node');
    expect(publishPlanStep?.env?.SOURCE_PLAN).toBe(
      '${{ steps.create_plan.outputs.proposed_plan_file }}',
    );
    expect(publishPlanStep?.env?.TARGET_PLAN).toBe(
      '${{ {{BRAND_EXPRESSION_ROOT}}.event.task_ready.plan_path }}',
    );
    expect(publishPlanStep?.run).toContain('fs.copyFileSync');

    expect(
      summaryJob?.steps.find((step) => step.id === 'summarize')?.uses,
    ).toBe('builtin/agent-prompt');
    expect(
      summaryJob?.steps.find((step) => step.id === 'prepare_report')?.shell,
    ).toBe('node');
    expect(
      summaryJob?.steps.find((step) => step.id === 'prepare_report')?.run,
    ).toContain('toJson(steps.summarize.outputs)');
    expect(
      summaryJob?.steps.find((step) => step.id === 'prepare_report')?.run,
    ).not.toContain('`${{ steps.summarize.outputs.text_response_file }}`');
    expect(
      summaryJob?.steps.find((step) => step.id === 'prepare_report')?.run,
    ).toContain('report_content_json=');
    expect(
      summaryJob?.steps.find((step) => step.id === 'publish_report')?.uses,
    ).toBe('builtin/{{BRAND_REPORT_ACTION_ID}}');
    expect(
      summaryJob?.steps.find((step) => step.id === 'publish_report')?.with
        ?.format,
    ).toBe('text');
    expect(
      summaryJob?.steps.find((step) => step.id === 'publish_report')?.with
        ?.content,
    ).toBe(
      '${{ parseJson(steps.prepare_report.outputs.report_content_json) }}',
    );
  });

  it('routes the summary through an explicit host-supported model and keeps summary failures non-blocking', () => {
    const pipeline = loadCreateTaskImplementationPlanPipeline();
    const planJob = pipeline.jobs.plan;
    const summaryJob = pipeline.jobs.summary;

    const summarizeStep = summaryJob?.steps.find(
      (step) => step.id === 'summarize',
    );

    expect(summaryJob?.continue_on_error).toBe(true);
    expect(summarizeStep?.with?.model).toBe('${{ inputs.model }}');
    expect(summarizeStep?.with?.permission_preset).toBe('read_only');
    expect(planJob?.continue_on_error).not.toBe(true);
  });

  it('summarizes on the same harness the plan was drafted with', () => {
    // The summary must not hard-pin a provider. `inputs.model` offers both a
    // Claude option (`opus`) and Codex options (`$fast`, `$default-codex`), so
    // pinning either harness here strands whichever cohort did not choose it:
    // a Claude-only user selecting `opus` would be forced into a Codex session
    // for the summary, and `continue_on_error: true` would then report that
    // run as a success with no summary and no published report.
    const pipeline = loadCreateTaskImplementationPlanPipeline();
    const planJob = pipeline.jobs.plan;
    const summaryJob = pipeline.jobs.summary;

    const createPlanStep = planJob?.steps.find(
      (step) => step.id === 'create_plan',
    );
    const summarizeStep = summaryJob?.steps.find(
      (step) => step.id === 'summarize',
    );

    expect(summarizeStep?.with?.model).toBe(createPlanStep?.with?.model);
  });
});
