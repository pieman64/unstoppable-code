import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { interpolateExpression } from '@canopy/desktop-shared/node/pipelines/executor/expression-evaluator';
import type { ExpressionContext } from '@canopy/desktop-shared/node/pipelines/executor/execution-context';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  getJob,
  getStep,
  loadPipelineFromFile,
} from './helpers/pipeline-test-utils';

const brand = (text: string): string =>
  text
    .split('{{BRAND_ENV_PREFIX}}')
    .join('CANOPY')
    .split('{{BRAND_OUTPUT_VARIABLE_NAME}}')
    .join('canopyOutput')
    .split('{{BRAND_PROJECT_CONFIG_DIR}}')
    .join('.canopy');

const REVIEWED_HEAD = 'a'.repeat(40);
const PR_HEAD = 'b'.repeat(40);

function context(): ExpressionContext {
  return {
    env: {},
    inputs: {},
    steps: {},
    needs: {},
    job: { is_retry: false, retry_count: 0, max_retries: 0 },
    canopy: {
      event_name: 'dispatch',
      event: {},
      project_id: '',
      task_id: '',
      owner: 'personal',
      initiator: { kind: 'user' },
    },
  };
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${file}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe.each(['claude', 'codex', 'multi-provider'])(
  'review completeness in bundled %s review',
  (variant) => {
    const { pipeline } = loadPipelineFromFile(
      path.resolve(
        __dirname,
        `../../../../../packages/desktop-shared/resources/pipelines/code-review-${variant}.yaml`,
      ),
    );
    // Built-in tracks are the jobs gated by an `enable_<job id>` input.
    const builtInTracks = Object.entries(pipeline.jobs)
      .filter(([jobId, job]) => job.if === `inputs.enable_${jobId} == true`)
      .map(([jobId]) => jobId);
    let temp: string;
    beforeEach(() => {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-completeness-'));
    });
    afterEach(() => {
      fs.rmSync(temp, { recursive: true, force: true });
    });

    function runStep(
      job: string,
      step: string,
      ctx: ExpressionContext,
      env: Record<string, string> = {},
    ): Record<string, string> {
      const definition = getStep(pipeline, job, step);
      expect(definition.shell).toBe('node');
      const script = path.join(temp, `${job}-${step}.mjs`);
      const output = `${script}.output`;
      fs.writeFileSync(output, '');
      fs.writeFileSync(
        script,
        brand(interpolateExpression(String(definition.run), ctx)),
      );
      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CANOPY_OUTPUT: output,
          CANOPY_OUTPUT_DIR: temp,
          ...env,
        },
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return Object.fromEntries(
        fs
          .readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const split = line.indexOf('=');
            return [line.slice(0, split), line.slice(split + 1)];
          }),
      );
    }

    function writeJson(name: string, value: unknown): string {
      const file = path.join(temp, name);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    }

    function reviewFile(
      id: string,
      overrides: Record<string, unknown> = {},
    ): string {
      return writeJson(`${id}-review.json`, {
        reviewer: id,
        model: '$fast',
        summary: id,
        riskScore: 10,
        verdict: 'pass',
        riskLevel: 'minimal',
        findings: [],
        threadActions: [],
        positiveFindings: [],
        ...overrides,
      });
    }

    function aggregationContext(): ExpressionContext {
      const ctx = context();
      for (const job of getJob(pipeline, 'synthesize_review').needs ?? []) {
        ctx.needs[job] = { result: 'skipped', outputs: {} };
      }
      ctx.needs.discover_review_tracks = {
        result: 'success',
        outputs: { reviewer_count: '0' },
      };
      ctx.needs.custom_review_tracks = {
        result: 'skipped',
        outputs: {},
        children: [],
      };
      ctx.needs.review_workspace_details = {
        result: 'success',
        outputs: {
          reviewed_head: REVIEWED_HEAD,
          reviewed_uncommitted: 'false',
          base_branch: 'develop',
          merge_base: 'c'.repeat(40),
        },
      };
      for (const track of builtInTracks) {
        ctx.inputs[`enable_${track}`] = true;
        ctx.needs[track] = {
          result: 'success',
          outputs: { review_file: reviewFile(track) },
        };
      }
      return ctx;
    }

    function withPullRequest(
      ctx: ExpressionContext,
      priorFindings: unknown[] | null,
    ): void {
      ctx.needs.pr_context = {
        result: 'success',
        outputs: { pr_status: 'found' },
      };
      ctx.needs.github_review_context = {
        result: 'success',
        outputs: {
          review_threads_file: writeJson('review-threads.json', []),
          last_ai_review_file: writeJson('last-ai-review.json', null),
        },
      };
      ctx.needs.verify_prior_findings = {
        result: 'success',
        outputs:
          priorFindings === null
            ? {}
            : {
                verification_file: writeJson('prior-verification.json', {
                  contextAvailable: true,
                  omittedCount: 0,
                  priorFindings,
                }),
              },
      };
    }

    function aggregate(ctx: ExpressionContext): Record<string, string> {
      return runStep('synthesize_review', 'prepare_aggregation', ctx, {
        UNIFIED_REVIEW_SCHEMA: String(pipeline.env?.UNIFIED_REVIEW_SCHEMA),
      });
    }

    function selectFinalReview(
      ctx: ExpressionContext,
      outputs: Record<string, string>,
      aggregateFile = '',
    ): Record<string, unknown> {
      ctx.steps.prepare_aggregation = { outputs };
      ctx.steps.aggregate = {
        outputs: aggregateFile ? { json_response_file: aggregateFile } : {},
      };
      return readJson(
        runStep('synthesize_review', 'select_review_output', ctx)
          .review_json_file,
      );
    }

    const confirmedPrior = {
      threadId: 'PRRT_open',
      commentId: 11,
      author: 'review-bot',
      filePath: 'src/cursor.ts',
      line: 12,
      title: 'Accepted cursor is ignored',
      status: 'confirmed',
      humanDisposition: '',
      evidence: 'src/cursor.ts:12 still drops the cursor argument.',
    };

    it('normalizes with the prior-finding verifier wired into aggregation', () => {
      expect(() => normalizePipeline(pipeline)).not.toThrow();
      expect(getJob(pipeline, 'verify_prior_findings').needs).toEqual([
        'review_workspace_details',
        'github_review_context',
        'review_intent_context',
      ]);
      expect(getJob(pipeline, 'synthesize_review').needs).toEqual(
        expect.arrayContaining([
          'pr_context',
          'review_workspace_details',
          'verify_prior_findings',
        ]),
      );
      expect(
        getStep(pipeline, 'verify_prior_findings', 'verify'),
      ).toMatchObject({
        if: "steps.collect.outputs.prior_finding_count != '0'",
        continue_on_error: true,
        with: {
          permission_preset: 'read_only',
          structured_output_schema:
            '${{ env.PRIOR_FINDING_VERIFICATION_SCHEMA }}',
        },
      });
    });

    it('blocks a clean pass when an enabled built-in track was skipped', () => {
      const ctx = aggregationContext();
      ctx.needs[builtInTracks[0]] = { result: 'skipped', outputs: {} };
      const review = readJson(aggregate(ctx).deterministic_review_file);
      expect(review).toMatchObject({ verdict: 'blocked', riskScore: 0 });
    });

    it('accepts a skipped track that the run disabled', () => {
      const ctx = aggregationContext();
      ctx.inputs[`enable_${builtInTracks[0]}`] = false;
      ctx.needs[builtInTracks[0]] = { result: 'skipped', outputs: {} };
      const outputs = aggregate(ctx);
      expect(readJson(outputs.deterministic_review_file)).toMatchObject({
        verdict: 'pass',
        riskScore: 10,
      });
      expect(selectFinalReview(ctx, outputs)).toMatchObject({
        verdict: 'pass',
        reviewedRevision: { head: REVIEWED_HEAD, uncommitted: false },
        completeness: { complete: true, problems: [] },
        priorFindings: [],
      });
    });

    it.each(['empty', 'finalized'])(
      'keeps an %s review with incomplete coverage unblocked and records the gap',
      (shape) => {
        for (const track of builtInTracks) {
          const candidates = writeJson(`${track}-candidates.json`, {
            issues: shape === 'empty' ? [] : [{ title: 'Rejected later' }],
            coverage: {
              complete: false,
              unreviewed: ['src/generated.ts'],
              notes: 'The diff artifact was truncated.',
            },
          });
          const outputs = runStep(track, 'select_review_output', context(), {
            REVIEW_CANDIDATES_FILE: candidates,
            FINAL_REVIEW_FILE: shape === 'empty' ? '' : reviewFile(track),
            REVIEWER_NAME: track,
            REVIEWER_MODEL: '$fast',
          });
          expect(readJson(outputs.review_file)).toMatchObject({
            verdict: 'pass',
            riskScore: 10,
            riskLevel: 'minimal',
            findings: [],
            coverage: { complete: false, unreviewed: ['src/generated.ts'] },
          });
        }
      },
    );

    it('keeps the cheap clean path for complete empty reviews', () => {
      const track = builtInTracks[0];
      const candidates = writeJson('candidates.json', {
        issues: [],
        coverage: { complete: true, unreviewed: [], notes: '' },
      });
      const outputs = runStep(track, 'select_review_output', context(), {
        REVIEW_CANDIDATES_FILE: candidates,
        REVIEWER_NAME: track,
        REVIEWER_MODEL: '$fast',
      });
      expect(readJson(outputs.review_file)).toMatchObject({
        verdict: 'pass',
        riskScore: 10,
        coverage: { complete: true },
      });
    });

    it('reports incomplete coverage as a note without blocking the pass', () => {
      const ctx = aggregationContext();
      ctx.needs[builtInTracks[0]].outputs = {
        review_file: reviewFile(builtInTracks[0], {
          coverage: {
            complete: false,
            unreviewed: ['src/generated.ts'],
            notes: 'Truncated.',
          },
        }),
      };
      const outputs = aggregate(ctx);
      expect(outputs.deterministic_review_file).not.toBe('');
      const review = selectFinalReview(ctx, outputs);
      expect(review).toMatchObject({
        verdict: 'pass',
        riskScore: 10,
        completeness: { complete: true, problems: [] },
      });
      expect(JSON.stringify(review.completeness)).toContain('src/generated.ts');
    });

    it('collects unresolved automated findings with their human replies', () => {
      const threads = writeJson('threads.json', [
        {
          reviewId: 77,
          author: 'developer',
          body: '[//]: # (ud-ai-review)\n## AI Code Review',
          threads: [
            {
              id: 'PRRT_open',
              commentId: 11,
              resolved: false,
              body: '**[Important]**: Accepted cursor is ignored',
              author: 'developer',
              path: 'src/cursor.ts',
              line: 12,
              replies: [{ author: 'maintainer', body: 'Intended for now.' }],
            },
            {
              id: 'PRRT_resolved',
              commentId: 12,
              resolved: true,
              body: 'Already fixed',
              author: 'developer',
              path: 'src/cursor.ts',
              line: 20,
              replies: [],
            },
          ],
        },
        {
          reviewId: 88,
          author: 'human-reviewer',
          body: 'Please take a look',
          threads: [
            {
              id: 'PRRT_human',
              commentId: 21,
              resolved: false,
              body: 'Human question',
              author: 'human-reviewer',
              path: 'src/other.ts',
              line: 1,
              replies: [],
            },
          ],
        },
        {
          reviewId: 99,
          author: 'copilot-pull-request-reviewer[bot]',
          body: 'Copilot reviewed 3 files',
          threads: [
            {
              id: 'PRRT_bot',
              commentId: 31,
              resolved: false,
              body: 'Missing schema entry',
              author: 'Copilot',
              path: 'src/schema.ts',
              line: 4,
              replies: [],
            },
          ],
        },
      ]);
      const outputs = runStep('verify_prior_findings', 'collect', context(), {
        REVIEW_THREADS_FILE: threads,
        LAST_AI_REVIEW_FILE: '',
      });
      expect(outputs.prior_finding_count).toBe('2');
      const collected = readJson(outputs.prior_findings_file);
      expect(collected).toMatchObject({
        contextAvailable: true,
        omittedCount: 0,
        priorFindings: [
          {
            threadId: 'PRRT_open',
            commentId: 11,
            filePath: 'src/cursor.ts',
            body: '**[Important]**: Accepted cursor is ignored',
            replies: [{ author: 'maintainer', body: 'Intended for now.' }],
          },
          { threadId: 'PRRT_bot', commentId: 31 },
        ],
      });
    });

    it('marks prior findings unverified when the verifier omits them', () => {
      const collected = writeJson('prior-findings.json', {
        contextAvailable: true,
        omittedCount: 0,
        priorFindings: [
          {
            threadId: 'PRRT_open',
            commentId: 11,
            author: 'developer',
            filePath: 'src/cursor.ts',
            line: 12,
            body: '**[Important]**: Accepted cursor is ignored',
            replies: [],
          },
          {
            threadId: 'PRRT_bot',
            commentId: 31,
            author: 'Copilot',
            filePath: 'src/schema.ts',
            line: 4,
            body: 'Missing schema entry',
            replies: [],
          },
        ],
      });
      const response = writeJson('verifier.json', {
        priorFindings: [
          {
            threadId: 'PRRT_open',
            commentId: 11,
            filePath: 'src/cursor.ts',
            title: 'Accepted cursor is ignored',
            status: 'rejected',
            humanDisposition: 'Maintainer declined it.',
            evidence: 'Reply 1 declines the finding.',
          },
        ],
      });
      for (const [responseFile, expectedFirst] of [
        [response, 'rejected'],
        ['', 'unverified'],
      ]) {
        const outputs = runStep(
          'verify_prior_findings',
          'select_output',
          context(),
          {
            PRIOR_FINDINGS_FILE: collected,
            VERIFICATION_RESPONSE_FILE: responseFile,
          },
        );
        expect(readJson(outputs.verification_file)).toMatchObject({
          priorFindings: [
            { threadId: 'PRRT_open', status: expectedFirst },
            { threadId: 'PRRT_bot', status: 'unverified' },
          ],
        });
      }
    });

    it('keeps a confirmed prior finding from passing and reports it separately', () => {
      const ctx = aggregationContext();
      withPullRequest(ctx, [confirmedPrior]);
      const outputs = aggregate(ctx);
      expect(readJson(outputs.deterministic_review_file)).toMatchObject({
        verdict: 'needs_changes',
        riskScore: 7,
        findings: [],
      });
      expect(
        fs.readFileSync(outputs.aggregation_prompt_file, 'utf8'),
      ).toContain('Prior finding verification');
      expect(selectFinalReview(ctx, outputs)).toMatchObject({
        verdict: 'needs_changes',
        findings: [],
        priorFindings: [{ threadId: 'PRRT_open', status: 'confirmed' }],
        completeness: { complete: true },
      });
    });

    it.each(['GitHub review context', 'prior-finding verification'])(
      'does not report a clean pass for a pull request without %s',
      (missing) => {
        const ctx = aggregationContext();
        withPullRequest(
          ctx,
          missing === 'prior-finding verification' ? null : [],
        );
        if (missing === 'GitHub review context') {
          ctx.needs.github_review_context.outputs = {};
        }
        const review = selectFinalReview(ctx, aggregate(ctx));
        expect(review).toMatchObject({
          verdict: 'blocked',
          riskScore: 7,
          completeness: { complete: false },
        });
      },
    );

    it('caps an aggregated pass when the review is incomplete', () => {
      const ctx = aggregationContext();
      withPullRequest(ctx, [{ ...confirmedPrior, status: 'unverified' }]);
      ctx.needs[builtInTracks[0]].outputs = {
        review_file: reviewFile(builtInTracks[0], {
          verdict: 'needs_changes',
          riskScore: 8,
          riskLevel: 'low',
          findings: [{ title: 'Minor issue' }],
        }),
      };
      const outputs = aggregate(ctx);
      expect(outputs.deterministic_review_file).toBe('');
      expect(
        fs.readFileSync(outputs.aggregation_prompt_file, 'utf8'),
      ).toContain('could not be verified');
      // Model output is stubbed at the provider boundary.
      const aggregateFile = writeJson('aggregate.json', {
        review: {
          summary: 'Looks fine',
          sourceModels: ['$fast'],
          riskScore: 10,
          riskLevel: 'minimal',
          verdict: 'pass',
          consensusNotes: '',
          positiveFindings: [],
          findings: [],
          threadActions: [],
        },
      });
      expect(selectFinalReview(ctx, outputs, aggregateFile)).toMatchObject({
        verdict: 'blocked',
        riskScore: 7,
        riskLevel: 'medium',
      });
    });

    it('records the reviewed revision from workspace details', () => {
      for (const hasUncommittedChanges of [false, true]) {
        const details = writeJson('workspace-details.json', {
          head: REVIEWED_HEAD,
          includeUncommitted: true,
          hasUncommittedChanges,
        });
        const outputs = runStep(
          'review_workspace_details',
          'identify_revision',
          context(),
          { WORKSPACE_DETAILS_FILE: details },
        );
        expect(outputs).toEqual({
          reviewed_head: REVIEWED_HEAD,
          reviewed_uncommitted: String(hasUncommittedChanges),
        });
      }
      expect(
        getJob(pipeline, 'review_workspace_details').outputs,
      ).toMatchObject({
        reviewed_head: '${{ steps.identify_revision.outputs.reviewed_head }}',
        reviewed_uncommitted:
          '${{ steps.identify_revision.outputs.reviewed_uncommitted }}',
      });
    });

    function finalReviewFile(head: string, uncommitted = false): string {
      return writeJson('final-review.json', {
        summary: 'No findings.',
        sourceModels: ['$fast'],
        riskScore: 10,
        riskLevel: 'minimal',
        verdict: 'pass',
        consensusNotes: '',
        positiveFindings: [],
        findings: [],
        threadActions: [],
        reviewedRevision: {
          head,
          uncommitted,
          baseBranch: 'develop',
          mergeBase: '',
        },
        completeness: {
          complete: false,
          problems: ['1 earlier finding could not be verified.'],
          coverageGaps: ['Reviewer A did not cover the full review diff.'],
          tracks: [],
        },
        priorFindings: [confirmedPrior],
      });
    }

    it('binds the posted review to the reviewed revision', () => {
      const payloadFor = (
        prHead: string,
        uncommitted = false,
      ): Record<string, unknown> & { body: string } => {
        const outputs = runStep(
          'post_github_review_comment',
          'prepare_payload',
          context(),
          {
            REVIEW_JSON_FILE: finalReviewFile(REVIEWED_HEAD, uncommitted),
            COMMIT_SHA: prHead,
            PR_URL: 'https://github.com/example/repository/pull/7',
            PR_NUMBER: '7',
            REVIEW_ATTEMPT: '2',
          },
        );
        const payload = readJson(outputs.review_comment_json_file);
        return { ...payload, body: String(payload.body) };
      };

      const matching = payloadFor(REVIEWED_HEAD);
      expect(matching.commit_id).toBe(REVIEWED_HEAD);
      expect(matching.body).toContain(
        `Reviewed commit: \`${REVIEWED_HEAD.slice(0, 12)}\``,
      );
      expect(matching.body).not.toContain('does not cover the PR head');
      expect(matching.body).toContain('Prior Findings (1)');
      expect(matching.body).toContain('Accepted cursor is ignored');
      expect(matching.body).toContain(
        '1 earlier finding could not be verified.',
      );
      expect(matching.body).toContain('Coverage Notes (1)');
      expect(matching.body).toContain(`"reviewed_head":"${REVIEWED_HEAD}"`);

      for (const mismatched of [
        payloadFor(PR_HEAD),
        payloadFor(REVIEWED_HEAD, true),
      ]) {
        expect(mismatched.body).toContain('does not cover the PR head');
        expect(mismatched.body).toContain('for the reviewed revision only');
        expect(mismatched.body).toContain('"revision_matches_pr_head":false');
      }
    });

    it('publishes the reviewed revision, completeness, and prior findings in the report', () => {
      const report = runStep(
        'publish_review_report',
        'prepare_report',
        context(),
        {
          REVIEW_JSON_FILE: finalReviewFile(REVIEWED_HEAD, true),
          CUSTOM_REVIEWER_COUNT: '0',
          CUSTOM_TRACK_COUNT: '0',
        },
      );
      const content: unknown = JSON.parse(report.report_content_json);
      expect(content).toContain(
        `Reviewed commit: ${REVIEWED_HEAD} (plus uncommitted changes)`,
      );
      expect(content).toContain('## Review Completeness');
      expect(content).toContain('1 earlier finding could not be verified.');
      expect(content).toContain(
        'Reviewer A did not cover the full review diff.',
      );
      expect(content).toContain('## Prior Findings');
      expect(content).toContain('Confirmed: Accepted cursor is ignored');
    });
  },
);
