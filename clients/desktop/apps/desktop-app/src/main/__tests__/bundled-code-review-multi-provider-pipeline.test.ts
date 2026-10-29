import * as path from 'node:path';
import { resolvePipelineModelAlias } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  expectGitHubReviewContextCollector,
  expectInstructionScopeCollector,
  getDispatchInputs,
  getJob,
  getStep,
  loadPipelineFromFile,
  parseJsonObject,
  readBundledPipelineIndex,
  requiredStringArray,
  schemaPropertyItems,
} from './helpers/pipeline-test-utils';

const PIPELINE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/code-review-multi-provider.yaml',
);
const INDEX_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/index.json',
);

function loadPipeline(): ReturnType<typeof loadPipelineFromFile> {
  return loadPipelineFromFile(PIPELINE_PATH);
}

function expectComplianceReviewUsesInstructionFiles(
  pipeline: ReturnType<typeof loadPipelineFromFile>['pipeline'],
  jobId: string,
): void {
  expect(getStep(pipeline, jobId, 'review').with?.prompt).toContain(
    'clear `CLAUDE.md` or `AGENTS.md` violations only',
  );
  expect(getStep(pipeline, jobId, 'review').with?.prompt).toContain(
    'Then read every instruction file listed',
  );
  expect(getStep(pipeline, jobId, 'review').with?.prompt).toContain(
    'check compliance against both files',
  );
  expect(getStep(pipeline, jobId, 'review').with?.prompt).toContain(
    '`CLAUDE.md` or `AGENTS.md` files',
  );
  expect(getStep(pipeline, jobId, 'validate').with?.prompt).toContain(
    'the relevant instruction files',
  );
}

describe('bundled code review multi-provider pipeline', () => {
  it('is registered as a bundled dispatch pipeline', () => {
    const { pipeline } = loadPipeline();
    const entry = readBundledPipelineIndex(INDEX_PATH).pipelines.find(
      (pipeline) => pipeline.id === 'bundled-code-review-multi-provider',
    );

    expect(entry).toEqual({
      id: 'bundled-code-review-multi-provider',
      name: pipeline.name,
      filename: 'code-review-multi-provider.yaml',
      description: pipeline.description,
      icon: '🔎',
      createdAt: '2026-06-17T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
      triggerTypes: ['dispatch'],
    });
  });

  it('retains resolved review threads and human dispositions from GitHub', () => {
    expectGitHubReviewContextCollector(loadPipeline().pipeline);
  });

  it('resolves instruction files when the repository path list exceeds 1 MiB', () => {
    expectInstructionScopeCollector(loadPipeline().pipeline);
  });

  it('keeps the multi-track code-review reviewer approach', () => {
    const { pipeline, raw } = loadPipeline();
    const inputs = getDispatchInputs(pipeline);
    const reviewIntentContext = getJob(pipeline, 'review_intent_context');
    const writeContext = getStep(
      pipeline,
      'review_intent_context',
      'write_context',
    );
    const githubReviewContext = getJob(pipeline, 'github_review_context');
    const linearContext = getJob(pipeline, 'linear_context');
    const expectedReviewerJobs = [
      'repo_compliance_review_claude',
      'repo_compliance_review_codex',
      'opus_methodical_reviewer',
      'gpt_methodical_reviewer',
      'codex_security_review',
      'claude_security_review',
    ];
    const expectedReviewIntentReviewerJobs = [
      'opus_methodical_reviewer',
      'gpt_methodical_reviewer',
      'codex_security_review',
      'claude_security_review',
    ];
    const hiddenFileInputs = [
      'checkpoint_file',
      'plan_scope_file',
      'plan_contract_file',
      'qa_intent_summary_file',
    ];

    expect(inputs.enable_repo_compliance_review_claude).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.fail_on_existing_pending_review).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(inputs.enable_repo_compliance_review_codex).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.enable_codex_security_review).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.enable_claude_security_review).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.enable_opus_methodical_reviewer).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.enable_gpt_methodical_reviewer).toMatchObject({
      type: 'boolean',
      default: true,
    });
    for (const inputName of hiddenFileInputs) {
      expect(inputs[inputName]).toMatchObject({
        required: false,
        'hint-hide-ui-option': true,
      });
    }

    // The retired Bug Review A/B inputs and jobs are gone.
    expect(inputs.enable_opus_review_a).toBeUndefined();
    expect(inputs.enable_opus_review_b).toBeUndefined();
    expect(inputs.enable_gpt_review_a).toBeUndefined();
    expect(inputs.enable_gpt_review_b).toBeUndefined();
    expect(pipeline.jobs.opus_review_a).toBeUndefined();
    expect(pipeline.jobs.opus_review_b).toBeUndefined();
    expect(pipeline.jobs.gpt_review_a).toBeUndefined();
    expect(pipeline.jobs.gpt_review_b).toBeUndefined();
    expect(pipeline.plugin_collections?.[0]).toMatchObject({
      id: 'codex_security_review',
      name: 'Security Review',
      defaults: [
        {
          type: 'plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'builtin-security',
          required: true,
        },
      ],
    });
    expect(reviewIntentContext.outputs?.review_intent_context_file).toBe(
      '${{ steps.write_context.outputs.review_intent_context_file }}',
    );
    expect(reviewIntentContext.outputs?.review_intent_prompt).toBe(
      '${{ steps.write_context.outputs.review_intent_prompt }}',
    );
    expect(writeContext.env).toEqual({
      PLAN_CONTRACT_FILE: '${{ inputs.plan_contract_file }}',
      QA_INTENT_SUMMARY_FILE: '${{ inputs.qa_intent_summary_file }}',
    });
    expect(writeContext.run).toContain('const reviewIntentPrompt =');
    expect(writeContext.run).toContain('const hasReviewIntentContext =');
    expect(writeContext.run).toContain('hasReviewIntentContext\n');
    expect(writeContext.run).toContain('Read the review intent context');
    expect(writeContext.run).toContain('review_intent_prompt=');
    expect(writeContext.run).toContain(
      'A plan contract path was provided but the file was not found',
    );
    expect(writeContext.run).toContain(
      'A QA intent summary path was provided but the file was not found',
    );
    expect(writeContext.run).not.toContain(
      'No QA intent summary file was provided.',
    );
    expect(writeContext.run).toContain(
      'Use it as secondary context; the plan contract wins if they conflict.',
    );
    expect(getJob(pipeline, 'opus_methodical_reviewer').needs).toContain(
      'review_intent_context',
    );
    expect(getJob(pipeline, 'opus_methodical_reviewer').needs).toContain(
      'linear_context',
    );
    expect(getJob(pipeline, 'opus_methodical_reviewer').needs).toContain(
      'github_review_context',
    );
    expect(getJob(pipeline, 'codex_security_review').needs).toContain(
      'review_intent_context',
    );
    expect(getJob(pipeline, 'claude_security_review').needs).toContain(
      'review_intent_context',
    );
    for (const reviewerJobId of expectedReviewIntentReviewerJobs) {
      expect(getJob(pipeline, reviewerJobId).needs).toContain(
        'review_intent_context',
      );
    }
    expect(githubReviewContext.needs).toEqual(['pr_context']);
    expect(githubReviewContext.continue_on_error).toBe(true);
    expect(githubReviewContext.outputs?.review_threads_file).toBe(
      '${{ steps.gather.outputs.review_threads_file }}',
    );
    expect(githubReviewContext.outputs?.attempt).toBe(
      '${{ steps.gather.outputs.attempt }}',
    );
    expect(getStep(pipeline, 'github_review_context', 'gather').run).toContain(
      'reviewThreads(first: 100',
    );
    expect(getStep(pipeline, 'github_review_context', 'gather').run).toContain(
      'previous-review-node-ids.json',
    );
    expect(linearContext.needs).toEqual([
      'pr_context',
      'review_workspace_details',
    ]);
    expect(getStep(pipeline, 'linear_context', 'gather').uses).toBe(
      'builtin/gather-linear-context',
    );
    expect(getStep(pipeline, 'linear_context', 'gather').with).toMatchObject({
      current_branch:
        '${{ needs.review_workspace_details.outputs.current_branch }}',
      pr_json_file: '${{ needs.pr_context.outputs.pr_json_file }}',
      max_tickets: '3',
    });
    expect(
      getStep(pipeline, 'repo_compliance_review_claude', 'review').with,
    ).toMatchObject({
      model: '$cheap',
      structured_output_schema: '${{ env.REVIEW_CANDIDATES_SCHEMA }}',
      setting_sources: '[]',
    });
    expect(
      getStep(pipeline, 'repo_compliance_review_codex', 'review').with,
    ).toMatchObject({
      model: '$luna',
      structured_output_schema: '${{ env.REVIEW_CANDIDATES_SCHEMA }}',
    });
    expect(
      getStep(pipeline, 'instruction_scope', 'find_instruction_files').run,
    ).toContain("fileName === 'CLAUDE.md' || fileName === 'AGENTS.md'");
    expectComplianceReviewUsesInstructionFiles(
      pipeline,
      'repo_compliance_review_claude',
    );
    expectComplianceReviewUsesInstructionFiles(
      pipeline,
      'repo_compliance_review_codex',
    );
    expect(
      getStep(pipeline, 'codex_security_review', 'review').with,
    ).toMatchObject({
      model: '$sol',
      plugin_collection_id: 'codex_security_review',
    });
    expect(
      getStep(pipeline, 'claude_security_review', 'review').with,
    ).toMatchObject({
      model: '$opus',
      permission_preset: 'read_only',
    });
    for (const reviewerJobId of expectedReviewerJobs) {
      const configuredReviewModel = String(
        getStep(pipeline, reviewerJobId, 'review').with?.model,
      );
      const reviewModel = resolvePipelineModelAlias(configuredReviewModel);
      expect(getJob(pipeline, reviewerJobId).continue_on_error).not.toBe(true);
      expect(getJob(pipeline, reviewerJobId).outputs?.review_file).toBe(
        '${{ steps.select_review_output.outputs.review_file }}',
      );
      expect(getStep(pipeline, reviewerJobId, 'validate').if).toBe(
        'parseJson(steps.review.outputs.json_response).issues[0]',
      );
      expect(getStep(pipeline, reviewerJobId, 'finalize').if).toBe(
        'parseJson(steps.review.outputs.json_response).issues[0]',
      );
      expect(getStep(pipeline, reviewerJobId, 'select_review_output').if).toBe(
        'always()',
      );
      expect(configuredReviewModel).not.toBe('');
      expect(
        resolvePipelineModelAlias(
          String(
            getStep(pipeline, reviewerJobId, 'select_review_output').env
              ?.REVIEWER_MODEL,
          ),
        ),
      ).toBe(reviewModel);
      expect(
        String(getStep(pipeline, reviewerJobId, 'finalize').with?.prompt),
      ).toContain(`\`model\` to \`${reviewModel}\`.`);
      const selectReviewOutput = String(
        getStep(pipeline, reviewerJobId, 'select_review_output').run,
      );
      expect(selectReviewOutput).toContain(
        'process.env.{{BRAND_ENV_PREFIX}}_OUTPUT_DIR',
      );
      expect(selectReviewOutput).toContain(
        "reviewer.toLowerCase().replace(/[^a-z0-9]+/g, '-')",
      );
      expect(getStep(pipeline, reviewerJobId, 'finalize').with).toMatchObject({
        structured_output_schema: '${{ env.REVIEW_OUTPUT_SCHEMA }}',
      });
      expect(
        getStep(pipeline, reviewerJobId, 'finalize').with?.prompt,
      ).toContain('${{ env.SCORING_RUBRIC }}');
      expect(
        getStep(pipeline, reviewerJobId, 'finalize').with?.prompt,
      ).toContain('${{ env.RISK_LEVEL_DEFINITIONS }}');
    }
    for (const solReviewerJobId of [
      'gpt_methodical_reviewer',
      'codex_security_review',
    ]) {
      expect(getStep(pipeline, solReviewerJobId, 'review').with?.model).toBe(
        '$sol',
      );
      expect(getStep(pipeline, solReviewerJobId, 'validate').with?.model).toBe(
        '$sol',
      );
    }
    expect(
      getStep(pipeline, 'gpt_methodical_reviewer', 'finalize').with?.model,
    ).toBe('$luna');
    expect(
      getStep(pipeline, 'codex_security_review', 'finalize').with?.model,
    ).toBe('$luna');
    expect(String(pipeline.env?.RISK_LEVEL_DEFINITIONS)).toContain(
      'Risk scoring criteria:',
    );
    expect(String(pipeline.env?.RISK_LEVEL_DEFINITIONS)).toContain(
      'Score 0-2: `critical`',
    );
    for (const methodicalJobId of [
      'opus_methodical_reviewer',
      'gpt_methodical_reviewer',
    ]) {
      const reviewPrompt = String(
        getStep(pipeline, methodicalJobId, 'review').with?.prompt,
      );
      expect(reviewPrompt).toContain(
        'Review process — work through these steps:',
      );
      expect(reviewPrompt).toContain(
        'Review categories — for each changed file, analyze against these categories:',
      );
    }
    expect(String(pipeline.env?.SCORING_RUBRIC)).toContain(
      'Use high numbers for high confidence and low risk',
    );
    expect(String(pipeline.env?.SCORING_RUBRIC)).toContain(
      '10 is a perfect passing score',
    );
    expect(String(pipeline.env?.SCORING_RUBRIC)).toContain(
      '0 is the lowest possible failing score',
    );
    expect(String(pipeline.env?.SCORING_RUBRIC)).toContain(
      '`minimal` for the safest/highest-score reviews and `critical` for the riskiest/lowest-score reviews',
    );
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
      source_reviews_file:
        '${{ steps.prepare_aggregation.outputs.source_reviews_file }}',
    });
    const prepareAggregationRun = String(
      getStep(pipeline, 'synthesize_review', 'prepare_aggregation').run,
    );
    expect(prepareAggregationRun).toContain('${{ toJson(needs) }}');
    expect(prepareAggregationRun).not.toContain(
      '`${{ needs.gpt_methodical_reviewer.outputs.review_file }}`',
    );
    expect(prepareAggregationRun).toContain('source-reviews.json');
    expect(prepareAggregationRun).toContain(
      'Merge identical or substantially similar issues',
    );
    expect(prepareAggregationRun).toContain(
      'Produce threadActions for existing review threads',
    );
    expect(prepareAggregationRun).toContain(
      'Treat lower riskScore values as worse outcomes',
    );
    expect(prepareAggregationRun).toContain('deterministic_review_file');
    expect(prepareAggregationRun).toContain('missingSuccessfulReviewFile');
    expect(prepareAggregationRun).toContain(
      'All enabled reviewer tracks completed successfully',
    );
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
      model: '$opus',
      thinking_effort: 'xhigh',
      permission_preset: 'none',
      setting_sources: '[]',
      structured_output_schema:
        '${{ steps.prepare_aggregation.outputs.aggregation_schema }}',
      prompt_file:
        '${{ steps.prepare_aggregation.outputs.aggregation_prompt_file }}',
    });
    const selectReviewOutputRun = String(
      getStep(pipeline, 'synthesize_review', 'select_review_output').run,
    );
    expect(selectReviewOutputRun).toContain(
      '${{ toJson(steps.prepare_aggregation.outputs) }}',
    );
    expect(selectReviewOutputRun).toContain('parsedArtifact?.review');
    expect(selectReviewOutputRun).toContain(
      'Aggregate reviewer output is missing the required review object',
    );
    expect(selectReviewOutputRun).toContain('review_json_file=');
    const reviewOutputSchema = parseJsonObject(
      String(pipeline.env?.REVIEW_OUTPUT_SCHEMA),
    );
    const unifiedReviewSchema = parseJsonObject(
      String(pipeline.env?.UNIFIED_REVIEW_SCHEMA),
    );
    expect(requiredStringArray(reviewOutputSchema, 'required')).toEqual([
      'reviewer',
      'model',
      'summary',
      'positiveFindings',
      'riskScore',
      'riskLevel',
      'verdict',
      'findings',
      'threadActions',
    ]);
    expect(
      requiredStringArray(
        schemaPropertyItems(reviewOutputSchema, 'findings'),
        'required',
      ),
    ).toContain('sourceEvidence');
    expect(requiredStringArray(unifiedReviewSchema, 'required')).toEqual([
      'summary',
      'sourceModels',
      'riskScore',
      'riskLevel',
      'verdict',
      'consensusNotes',
      'positiveFindings',
      'findings',
      'threadActions',
    ]);
    expect(
      requiredStringArray(
        schemaPropertyItems(unifiedReviewSchema, 'findings'),
        'required',
      ),
    ).toContain('reportedBy');
    expect(
      requiredStringArray(
        schemaPropertyItems(unifiedReviewSchema, 'threadActions'),
        'required',
      ),
    ).toEqual([
      'threadId',
      'commentId',
      'action',
      'body',
      'reason',
      'reportedBy',
    ]);
    expect(raw).toContain('${{ env.REVIEW_ARTIFACT_SCOPE_RULES }}');
    expect(raw).toContain(
      'needs.review_intent_context.outputs.review_intent_prompt',
    );
    expect(raw).toContain('Use $builtin-security:security-diff-scan');
    expect(raw).not.toContain('SYNTHESIZED_ISSUES_SCHEMA');
    expect(raw).not.toContain('local_fast_path');
    expect(raw).not.toContain('No QA intent summary file was provided.');
    expect(raw).not.toContain('is non-empty');
  });

  it('uses the multi-agent PR comment and report handling pattern', () => {
    const { pipeline, raw } = loadPipeline();
    const inputs = getDispatchInputs(pipeline);
    const postJob = getJob(pipeline, 'post_github_review_comment');
    const minimizeJob = getJob(pipeline, 'minimize_previous_ai_reviews');
    const publishJob = getJob(pipeline, 'publish_review_report');
    const lookupPr = getStep(pipeline, 'post_github_review_comment', 'lookup');
    const preparePayload = getStep(
      pipeline,
      'post_github_review_comment',
      'prepare_payload',
    );
    const postReview = getStep(pipeline, 'post_github_review_comment', 'post');
    const prepareReport = getStep(
      pipeline,
      'publish_review_report',
      'prepare_report',
    );
    const publishReport = getStep(
      pipeline,
      'publish_review_report',
      'publish_report',
    );

    expect(inputs.post_pr_comment).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(inputs.post_pr_comment.description).toBe('Post PR comment.');
    expect(postJob.if).toBe('inputs.post_pr_comment == true');
    expect(postJob.needs).toEqual([
      'review_workspace_details',
      'github_review_context',
      'synthesize_review',
    ]);
    expect(postJob.outputs?.review_comment_id).toBe(
      '${{ steps.post.outputs.review_comment_id }}',
    );
    expect(postJob.outputs?.review_url).toBe(
      '${{ steps.post.outputs.review_url }}',
    );
    expect(postJob.outputs?.thread_resolve_count).toBe(
      '${{ steps.post.outputs.thread_resolve_count }}',
    );
    expect(lookupPr.uses).toBe('builtin/github-fetch-branch-pr');
    expect(lookupPr.with?.branch).toBe(
      '${{ needs.review_workspace_details.outputs.current_branch }}',
    );
    expect(postReview.with?.diff_file).toBe(
      '${{ needs.review_workspace_details.outputs.review_diff_file }}',
    );
    expect(preparePayload.if).toBe("steps.lookup.outputs.has_pr == 'true'");
    expect(preparePayload.run).toContain('github-review-comment.json');
    expect(preparePayload.run).toContain('[//]: # (ud-ai-review)');
    expect(preparePayload.run).toContain('## 🤖 AI Code Review');
    expect(preparePayload.run).toContain('<!-- AI_REVIEW_DATA:');
    expect(preparePayload.run).toContain(
      'const findings = Array.isArray(parsed.findings)',
    );
    expect(preparePayload.run).toContain(
      'const threadActions = Array.isArray(parsed.threadActions)',
    );
    expect(preparePayload.run).toContain('const replies = [];');
    expect(preparePayload.run).toContain("action: shouldResolve ? 'resolve'");
    expect(preparePayload.run).toContain(
      'previous_review_node_ids: previousReviewNodeIds',
    );
    expect(preparePayload.run).toContain(
      '**Review Attempt ${String(metadata.attempt)}**',
    );
    expect(preparePayload.run).toContain(
      "score <= 3\n    ? '🔴'\n    : score <= 6\n      ? '🟠'\n      : score <= 8\n        ? '🟡'\n        : '🟢'",
    );
    expect(preparePayload.run).not.toContain('adaptReview');
    expect(preparePayload.run).toContain(
      '**Score: ${scoreEmoji} ${String(score)}/10**',
    );
    expect(preparePayload.run).toContain('📊 Risk Assessment');
    expect(preparePayload.run).toContain('🚨 Critical Issues');
    expect(preparePayload.run).toContain('⚠️ Important Issues');
    expect(preparePayload.run).toContain('## Consensus Notes');
    expect(preparePayload.run).toContain(
      '_Review by AI pipeline Code Review (Multi-Provider)',
    );
    expect(preparePayload.run).not.toContain(
      '_Review by AI ud-code-reviewer-multi-model',
    );
    expect(preparePayload.run).toContain('commit_id');
    expect(preparePayload.run).toContain('comments.push');
    expect(preparePayload.env?.REVIEW_JSON_FILE).toBe(
      '${{ needs.synthesize_review.outputs.review_json_file }}',
    );
    expect(preparePayload.env?.REVIEW_THREADS_FILE).toBe(
      '${{ needs.github_review_context.outputs.review_threads_file }}',
    );
    expect(preparePayload.env?.REVIEW_ATTEMPT).toBe(
      '${{ needs.github_review_context.outputs.attempt }}',
    );
    expect(postReview.if).toBe("steps.lookup.outputs.has_pr == 'true'");
    expect(postReview.uses).toBe('builtin/github-post-review-comment');
    expect(postReview.with?.pr_identifier).toBe(
      '${{ steps.lookup.outputs.pr_url }}',
    );
    expect(postReview.with?.review_json_file).toBe(
      '${{ steps.prepare_payload.outputs.review_comment_json_file }}',
    );
    expect(postReview.with?.fail_on_existing_pending_review).toBe(
      '${{ inputs.fail_on_existing_pending_review }}',
    );
    expect(minimizeJob.needs).toEqual([
      'post_github_review_comment',
      'github_review_context',
    ]);
    expect(minimizeJob.continue_on_error).toBe(true);
    expect(
      getStep(pipeline, 'minimize_previous_ai_reviews', 'minimize').run,
    ).toContain('dismissPullRequestReview(input: {pullRequestReviewId:');
    expect(publishJob.if).toBe(
      "always() && needs.synthesize_review.result == 'success'",
    );
    expect(publishJob.needs).toEqual([
      'discover_review_tracks',
      'review_workspace_details',
      'synthesize_review',
      'post_github_review_comment',
    ]);
    expect(prepareReport.env?.GITHUB_REVIEW_URL).toBe(
      '${{ needs.post_github_review_comment.outputs.review_url }}',
    );
    expect(prepareReport.run).toContain('GitHub PR comment submitted');
    expect(prepareReport.run).toContain(
      '`${JSON.stringify(parsed, null, 2)}\\n`',
    );
    expect(prepareReport.run).not.toContain('adaptReview');
    expect(prepareReport.run).toContain('# Multi-Agent Code Review');
    expect(prepareReport.run).toContain('Risk score:');
    expect(prepareReport.run).toContain('## Consensus Notes');
    expect(prepareReport.run).toContain('code-review-multi-provider.json');
    expect(publishReport.uses).toBe('builtin/{{BRAND_REPORT_ACTION_ID}}');
    expect(raw).not.toContain('gh api');
  });
});
