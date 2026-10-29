import * as path from 'node:path';
import { resolvePipelineModelAlias } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  expectGitHubReviewContextCollector,
  expectInstructionScopeCollector,
  getDispatchInputs,
  getJob,
  getStep,
  loadPipelineFromFile,
  readBundledPipelineIndex,
} from './helpers/pipeline-test-utils';

const PIPELINE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/code-review-claude.yaml',
);
const INDEX_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/index.json',
);

function loadPipeline(): ReturnType<typeof loadPipelineFromFile> {
  return loadPipelineFromFile(PIPELINE_PATH);
}

describe('bundled code review claude pipeline', () => {
  it('is registered as a bundled dispatch pipeline', () => {
    const { pipeline } = loadPipeline();
    const entry = readBundledPipelineIndex(INDEX_PATH).pipelines.find(
      (pipeline) => pipeline.id === 'bundled-code-review-claude',
    );

    expect(entry).toEqual({
      id: 'bundled-code-review-claude',
      name: pipeline.name,
      filename: 'code-review-claude.yaml',
      description: pipeline.description,
      icon: '🔎',
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
      triggerTypes: ['dispatch'],
    });
    expect(pipeline.name).toBe('Code Review (Claude)');
  });

  it('retains resolved review threads and human dispositions from GitHub', () => {
    expectGitHubReviewContextCollector(loadPipeline().pipeline);
  });

  it('resolves instruction files when the repository path list exceeds 1 MiB', () => {
    expectInstructionScopeCollector(loadPipeline().pipeline);
  });

  it('keeps only the Claude reviewer tracks', () => {
    const { pipeline, raw } = loadPipeline();
    const inputs = getDispatchInputs(pipeline);
    const expectedReviewerJobs = [
      'repo_compliance_review_claude',
      'methodical_reviewer',
      'claude_security_review',
    ];
    const hiddenFileInputs = [
      'checkpoint_file',
      'plan_scope_file',
      'plan_contract_file',
      'qa_intent_summary_file',
    ];

    // Claude-only inputs are present.
    expect(inputs.enable_repo_compliance_review_claude).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.enable_methodical_reviewer).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.enable_claude_security_review).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.fail_on_existing_pending_review).toMatchObject({
      type: 'boolean',
      default: false,
    });
    for (const inputName of hiddenFileInputs) {
      expect(inputs[inputName]).toMatchObject({
        required: false,
        'hint-hide-ui-option': true,
      });
    }

    // The retired Bug Review A/B inputs are gone.
    expect(inputs.enable_opus_review_a).toBeUndefined();
    expect(inputs.enable_opus_review_b).toBeUndefined();

    // Codex inputs and the codex security plugin collection are gone.
    expect(inputs.enable_repo_compliance_review_codex).toBeUndefined();
    expect(inputs.enable_gpt_review_a).toBeUndefined();
    expect(inputs.enable_gpt_review_b).toBeUndefined();
    expect(inputs.enable_codex_security_review).toBeUndefined();
    expect(pipeline.plugin_collections).toBeUndefined();

    // Codex reviewer jobs are removed; Claude reviewer jobs remain.
    expect(pipeline.jobs.repo_compliance_review_codex).toBeUndefined();
    expect(pipeline.jobs.gpt_review_a).toBeUndefined();
    expect(pipeline.jobs.gpt_review_b).toBeUndefined();
    expect(pipeline.jobs.codex_security_review).toBeUndefined();

    // The Bug Review A/B jobs are renamed/dropped.
    expect(pipeline.jobs.opus_review_a).toBeUndefined();
    expect(pipeline.jobs.opus_review_b).toBeUndefined();
    for (const jobId of expectedReviewerJobs) {
      const configuredReviewModel = String(
        getStep(pipeline, jobId, 'review').with?.model,
      );
      const reviewModel = resolvePipelineModelAlias(configuredReviewModel);
      expect(getJob(pipeline, jobId).continue_on_error).not.toBe(true);
      expect(getJob(pipeline, jobId).outputs?.review_file).toBe(
        '${{ steps.select_review_output.outputs.review_file }}',
      );
      expect(getStep(pipeline, jobId, 'validate').if).toBe(
        'parseJson(steps.review.outputs.json_response).issues[0]',
      );
      expect(getStep(pipeline, jobId, 'finalize').if).toBe(
        'parseJson(steps.review.outputs.json_response).issues[0]',
      );
      expect(getStep(pipeline, jobId, 'select_review_output').if).toBe(
        'always()',
      );
      expect(configuredReviewModel).not.toBe('');
      expect(
        resolvePipelineModelAlias(
          String(
            getStep(pipeline, jobId, 'select_review_output').env
              ?.REVIEWER_MODEL,
          ),
        ),
      ).toBe(reviewModel);
      expect(
        String(getStep(pipeline, jobId, 'finalize').with?.prompt),
      ).toContain(`\`model\` to \`${reviewModel}\`.`);
      const selectReviewOutput = String(
        getStep(pipeline, jobId, 'select_review_output').run,
      );
      expect(selectReviewOutput).toContain(
        'process.env.{{BRAND_ENV_PREFIX}}_OUTPUT_DIR',
      );
      expect(selectReviewOutput).toContain(
        "reviewer.toLowerCase().replace(/[^a-z0-9]+/g, '-')",
      );
    }

    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'review').with,
    ).toMatchObject({
      model: '$cheap',
      setting_sources: '[]',
    });
    expect(
      getStep(pipeline, 'instruction_scope', 'find_instruction_files').run,
    ).toContain("fileName === 'CLAUDE.md' || fileName === 'AGENTS.md'");
    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'review').with?.prompt,
    ).toContain('clear `CLAUDE.md` or `AGENTS.md` violations only');
    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'review').with?.prompt,
    ).toContain('Then read every instruction file listed');
    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'review').with?.prompt,
    ).toContain('check compliance against both files');
    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'review').with?.prompt,
    ).toContain('`CLAUDE.md` or `AGENTS.md` files');
    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'validate').with
        ?.prompt,
    ).toContain('the relevant instruction files');
    expect(
      getStep(pipeline, 'methodical_reviewer', 'review').with,
    ).toMatchObject({
      model: 'opus',
    });
    expect(
      getStep(pipeline, 'claude_security_review', 'review').with,
    ).toMatchObject({
      model: 'opus',
      permission_preset: 'read_only',
    });

    // The methodical reviewer carries the full review methodology.
    const methodicalReviewPrompt = String(
      getStep(pipeline, 'methodical_reviewer', 'review').with?.prompt,
    );
    expect(methodicalReviewPrompt).toContain(
      'Review process — work through these steps:',
    );
    expect(methodicalReviewPrompt).toContain(
      'Review categories — for each changed file, analyze against these categories:',
    );

    // Every reviewer scoring step is given the risk level definitions.
    for (const jobId of expectedReviewerJobs) {
      expect(
        String(getStep(pipeline, jobId, 'finalize').with?.prompt),
      ).toContain('${{ env.RISK_LEVEL_DEFINITIONS }}');
    }
    expect(String(pipeline.env?.RISK_LEVEL_DEFINITIONS)).toContain(
      'Risk scoring criteria:',
    );
    expect(String(pipeline.env?.RISK_LEVEL_DEFINITIONS)).toContain(
      'Score 0-2: `critical`',
    );

    // Synthesis stays on a Claude model and only references the kept tracks.
    expect(getJob(pipeline, 'synthesize_review').needs).toEqual([
      'discover_review_tracks',
      'custom_review_tracks',
      ...expectedReviewerJobs,
      'linear_context',
      'github_review_context',
      'pr_context',
      'review_workspace_details',
      'verify_prior_findings',
    ]);
    expect(getJob(pipeline, 'synthesize_review').outputs).toMatchObject({
      review_json_file:
        '${{ steps.select_review_output.outputs.review_json_file }}',
    });
    const prepareAggregationRun = String(
      getStep(pipeline, 'synthesize_review', 'prepare_aggregation').run,
    );
    expect(prepareAggregationRun).toContain('${{ toJson(needs) }}');
    expect(prepareAggregationRun).not.toContain(
      '`${{ needs.methodical_reviewer.outputs.review_file }}`',
    );
    expect(prepareAggregationRun).toContain('deterministic_review_file');
    expect(prepareAggregationRun).toContain('missingSuccessfulReviewFile');
    expect(prepareAggregationRun).toContain(
      'Produce exactly one structured result whose only top-level property is review.',
    );
    expect(prepareAggregationRun).toContain(
      'Set review to the complete unified report object.',
    );
    expect(prepareAggregationRun).toContain(
      'Every required review property must be emitted as a real property of review.',
    );
    expect(prepareAggregationRun).toContain(
      'The nested review object must validate against this exact JSON Schema:',
    );
    expect(prepareAggregationRun).toContain('unifiedReviewSchema');
    expect(prepareAggregationRun).toContain("required: ['review']");
    expect(prepareAggregationRun).toContain('aggregation_schema=');
    expect(getStep(pipeline, 'synthesize_review', 'aggregate').if).toBe(
      "steps.prepare_aggregation.outputs.deterministic_review_file == ''",
    );
    expect(
      getStep(pipeline, 'synthesize_review', 'aggregate').with,
    ).toMatchObject({
      model: 'opus',
      thinking_effort: 'xhigh',
      permission_preset: 'none',
      setting_sources: '[]',
      structured_output_schema:
        '${{ steps.prepare_aggregation.outputs.aggregation_schema }}',
    });
    const selectReviewOutputRun = String(
      getStep(pipeline, 'synthesize_review', 'select_review_output').run,
    );
    expect(selectReviewOutputRun).toContain(
      '${{ toJson(steps.prepare_aggregation.outputs) }}',
    );
    expect(selectReviewOutputRun).toContain('parsedArtifact?.review');
    expect(selectReviewOutputRun).toContain('review_json_file=');
    expect(
      getStep(pipeline, 'post_github_review_comment', 'post').with?.diff_file,
    ).toBe('${{ needs.review_workspace_details.outputs.review_diff_file }}');
    expect(
      getStep(pipeline, 'post_github_review_comment', 'post').with
        ?.fail_on_existing_pending_review,
    ).toBe('${{ inputs.fail_on_existing_pending_review }}');
    for (const jobId of expectedReviewerJobs) {
      expect(
        String(getStep(pipeline, jobId, 'finalize').with?.prompt),
      ).toContain('smallest contiguous range inside one diff hunk');
    }

    // No Codex/security artifacts should leak into the Claude variant.
    expect(raw).not.toContain('gpt-5.5');
    expect(raw).not.toContain('codex-security');
    expect(raw).not.toContain('Use $codex-security:security-diff-scan');
    expect(raw).toContain('_Review by AI pipeline Code Review (Claude)');
    expect(raw).toContain('code-review-claude.json');
  });
});
