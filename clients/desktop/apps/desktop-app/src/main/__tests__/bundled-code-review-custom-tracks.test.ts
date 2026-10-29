import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  interpolateExpression,
  evaluateTemplateValue,
} from '@canopy/desktop-shared/node/pipelines/executor/expression-evaluator';
import type { ExpressionContext } from '@canopy/desktop-shared/node/pipelines/executor/execution-context';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  expandStaticMatrix,
  resolveMatrixDefinition,
} from '@canopy/desktop-shared/pipelines/matrix';
import {
  getDispatchInputs,
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

function context(): ExpressionContext {
  return {
    env: {},
    inputs: {},
    steps: {},
    needs: {},
    job: { is_retry: false, retry_count: 0, max_retries: 0 },
    canopy: { event_name: 'dispatch', event: {} },
  };
}

describe.each(['claude', 'codex', 'multi-provider'])(
  'custom tracks in bundled %s review',
  (variant) => {
    const { pipeline } = loadPipelineFromFile(
      path.resolve(
        __dirname,
        `../../../../../packages/desktop-shared/resources/pipelines/code-review-${variant}.yaml`,
      ),
    );
    let temp: string;
    beforeEach(() => {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-review-pipeline-'));
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

    function reviewFile(id: string, findings: unknown[] = []): string {
      const file = path.join(temp, `${id}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          reviewer: id,
          model: '$fast',
          summary: id,
          riskScore: findings.length ? 5 : 10,
          verdict: findings.length ? 'needs_changes' : 'pass',
          riskLevel: findings.length ? 'medium' : 'minimal',
          findings,
          threadActions: [],
          positiveFindings: [],
        }),
      );
      return file;
    }

    function prepareReviewInput(
      ctx: ExpressionContext,
    ): Record<string, string> {
      const inputs = getStep(pipeline, 'custom_review_tracks', 'review').with;
      if (typeof inputs?.prompt_file === 'string') {
        ctx.steps.prepare_prompt = {
          outputs: runStep('custom_review_tracks', 'prepare_prompt', ctx, {
            CANOPY_OUTPUT_DIR: '',
          }),
        };
        return {
          INPUT_PROMPT_FILE: interpolateExpression(inputs.prompt_file, ctx),
        };
      }
      return {
        INPUT_PROMPT: interpolateExpression(String(inputs?.prompt), ctx),
      };
    }

    it('isolates repository and user settings for every custom reviewer phase', () => {
      for (const step of ['review', 'validate', 'finalize']) {
        expect(
          getStep(pipeline, 'custom_review_tracks', step).with,
        ).toMatchObject({
          permission_preset: 'read_only',
          setting_sources: '[]',
        });
      }
    });

    it('launches with a valid near-limit custom prompt without exceeding the environment limit', () => {
      const ctx = context();
      ctx.matrix = {
        id: 'custom-track-1',
        name: 'Large review',
        file: 'large.md',
        model: 'sonnet',
        prompt:
          'Review transaction boundaries.\n' + 'a'.repeat(1024 * 1024 - 1024),
      };
      const inputs = prepareReviewInput(ctx);
      const launch = spawnSync(
        process.execPath,
        [
          '-e',
          "process.stdout.write(String(process.env.INPUT_PROMPT ? process.env.INPUT_PROMPT.length : require('node:fs').readFileSync(process.env.INPUT_PROMPT_FILE, 'utf8').length))",
        ],
        { encoding: 'utf8', env: { ...process.env, ...inputs } },
      );
      expect(launch.error).toBeUndefined();
      expect(launch.status).toBe(0);
      expect(Number(launch.stdout)).toBeGreaterThan(1024 * 1024 - 1024);
      expect(inputs.INPUT_PROMPT).toBeUndefined();
      expect(fs.readFileSync(inputs.INPUT_PROMPT_FILE, 'utf8')).toContain(
        ctx.matrix.prompt,
      );
    });

    function aggregationContext(count: number): ExpressionContext {
      const ctx = context();
      for (const job of getJob(pipeline, 'synthesize_review').needs ?? []) {
        ctx.needs[job] = { result: 'skipped', outputs: {} };
      }
      ctx.needs.discover_review_tracks = {
        result: 'success',
        outputs: { reviewer_count: String(count) },
      };
      ctx.needs.custom_review_tracks = {
        result: count ? 'success' : 'skipped',
        outputs: {},
        children: [],
      };
      return ctx;
    }

    it('keeps empty review artifacts separate for each model and rejects missing finalized findings', () => {
      const candidates = path.join(temp, 'candidates.json');
      fs.writeFileSync(candidates, JSON.stringify({ issues: [] }));
      const paths = ['custom-track-1', 'custom-track-2'].map(
        (id) =>
          runStep('custom_review_tracks', 'select_review_output', context(), {
            REVIEW_CANDIDATES_FILE: candidates,
            REVIEWER_NAME: id,
            REVIEWER_MODEL: '$fast',
          }).review_file,
      );
      expect(new Set(paths).size).toBe(2);
      for (const file of paths) expect(fs.existsSync(file)).toBe(true);
      fs.writeFileSync(
        candidates,
        JSON.stringify({ issues: [{ title: 'Real candidate' }] }),
      );
      expect(() =>
        runStep('custom_review_tracks', 'select_review_output', context(), {
          REVIEW_CANDIDATES_FILE: candidates,
          REVIEWER_NAME: 'custom-track-1',
          REVIEWER_MODEL: '$fast',
        }),
      ).toThrow('Missing finalized review file');
    });

    it('normalizes the real pipeline and resolves the supported dynamic matrix', () => {
      expect(() => normalizePipeline(pipeline)).not.toThrow();
      const job = getJob(pipeline, 'custom_review_tracks');
      const ctx = context();
      ctx.needs.discover_review_tracks = {
        outputs: {
          matrix: JSON.stringify({
            include: [
              { id: 'one', model: '$fast' },
              { id: 'two', model: '$default-codex' },
            ],
          }),
        },
      };
      const template = job.strategy?.matrix;
      if (typeof template !== 'string')
        throw new Error('Expected dynamic matrix');
      const resolved = evaluateTemplateValue(template, ctx);
      expect(
        expandStaticMatrix('custom_review_tracks', {
          matrix: resolveMatrixDefinition('custom_review_tracks', resolved),
          dynamic: false,
        }),
      ).toHaveLength(2);
      expect(
        getStep(pipeline, 'discover_review_tracks', 'discover').with
          ?.repository_root,
      ).toBe('${{ needs.workspace_details.outputs.repo_root }}');
    });

    it('adds custom content to baseline context without recursively evaluating it or replacing safeguards', () => {
      const ctx = context();
      ctx.env = Object.fromEntries(
        Object.entries(pipeline.env ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
      ctx.env.SECRET = 'must-not-be-injected';
      for (const job of [
        'review_workspace_details',
        'pr_context',
        'linear_context',
        'github_review_context',
        'change_summary',
        'instruction_scope',
        'review_intent_context',
      ]) {
        ctx.needs[job] = {
          outputs: {
            review_diff_file: '/review.diff',
            review_intent_prompt: 'APPROVED INTENT',
            instruction_files_file: '/instructions.json',
          },
        };
      }
      ctx.matrix = {
        id: 'one',
        name: 'Atomicity',
        model: '$fast',
        file: 'atomicity.md',
        prompt: 'CUSTOM focus: ${\u007b env.SECRET }} `quotes`\nsecond line',
      };
      const input = prepareReviewInput(ctx);
      const prompt =
        input.INPUT_PROMPT ?? fs.readFileSync(input.INPUT_PROMPT_FILE, 'utf8');
      expect(prompt).toContain('CUSTOM focus: ${\u007b env.SECRET }}');
      expect(prompt).not.toContain('must-not-be-injected');
      for (const expected of [
        '/review.diff',
        '/instructions.json',
        'APPROVED INTENT',
        'Review process',
        'HIGH SIGNAL',
        'Do not post comments yourself',
      ])
        expect(prompt).toContain(expected);
      for (const step of ['review', 'validate', 'finalize']) {
        expect(
          getStep(pipeline, 'custom_review_tracks', step).with,
        ).toMatchObject({
          model: '${{ matrix.model }}',
          permission_preset: 'read_only',
        });
      }
      expect(getStep(pipeline, 'custom_review_tracks', 'validate').if).toBe(
        'parseJson(steps.review.outputs.json_response).issues[0]',
      );
      expect(
        String(
          getStep(pipeline, 'custom_review_tracks', 'finalize').with?.prompt,
        ),
      ).toContain('Use only candidates where `validated` is `true`');
    });

    it('keeps every custom finding in aggregation and publishes the unified findings', () => {
      const ctx = aggregationContext(2);
      const finding = {
        title: 'Lost transaction',
        severity: 'important',
        category: 'correctness',
        filePath: 'src/db.ts',
        lineStart: 4,
        lineEnd: 4,
        problem: 'Lost transaction',
        impact: 'Lost data',
        recommendation: 'Commit atomically',
        confidence: 'high',
        sourceEvidence: 'diff',
        reportedBy: ['Custom atomicity'],
      };
      ctx.needs.custom_review_tracks.children = ['one', 'two'].map((id) => ({
        job_id: id,
        matrix: { name: id, model: '$fast' },
        status: 'success',
        result: 'success',
        outputs: {
          review_file: reviewFile(id, [
            { ...finding, title: `${finding.title} ${id}` },
          ]),
        },
      }));
      const outputs = runStep('synthesize_review', 'prepare_aggregation', ctx, {
        UNIFIED_REVIEW_SCHEMA: String(pipeline.env?.UNIFIED_REVIEW_SCHEMA),
      });
      expect(outputs.deterministic_review_file).toBe('');
      const sources: unknown = JSON.parse(
        fs.readFileSync(outputs.source_reviews_file, 'utf8'),
      );
      expect(sources).toMatchObject([{ jobId: 'one' }, { jobId: 'two' }]);
      const prompt = fs.readFileSync(outputs.aggregation_prompt_file, 'utf8');
      expect(prompt).toContain('Lost transaction one');
      expect(prompt).toContain('Lost transaction two');
      // Model output is stubbed at the provider boundary; execute real output selection and reporting.
      const aggregateFile = path.join(temp, 'aggregate.json');
      fs.writeFileSync(
        aggregateFile,
        JSON.stringify({
          review: {
            summary: 'Custom finding',
            sourceModels: ['$fast'],
            riskScore: 5,
            riskLevel: 'medium',
            verdict: 'needs_changes',
            consensusNotes: '',
            positiveFindings: [],
            findings: [finding],
            threadActions: [],
          },
        }),
      );
      ctx.steps.prepare_aggregation = { outputs };
      ctx.steps.aggregate = { outputs: { json_response_file: aggregateFile } };
      const selected = runStep(
        'synthesize_review',
        'select_review_output',
        ctx,
      );
      const report = runStep('publish_review_report', 'prepare_report', ctx, {
        REVIEW_JSON_FILE: selected.review_json_file,
        CUSTOM_REVIEWER_COUNT: '2',
        CUSTOM_TRACK_COUNT: '1',
      });
      expect(JSON.parse(report.report_content_json)).toContain(
        'Lost transaction',
      );
      expect(JSON.parse(report.report_content_json)).toContain(
        '1 custom review tracks (2 reviewers)',
      );
    });

    it('publishes explicit setup guidance for zero matches while built-in reviews still pass', () => {
      const ctx = aggregationContext(0);
      const builtin =
        variant === 'multi-provider'
          ? 'gpt_methodical_reviewer'
          : 'methodical_reviewer';
      ctx.needs[builtin] = {
        result: 'success',
        outputs: { review_file: reviewFile('builtin') },
      };
      const outputs = runStep('synthesize_review', 'prepare_aggregation', ctx, {
        UNIFIED_REVIEW_SCHEMA: String(pipeline.env?.UNIFIED_REVIEW_SCHEMA),
      });
      const review: unknown = JSON.parse(
        fs.readFileSync(outputs.deterministic_review_file, 'utf8'),
      );
      expect(review).toMatchObject({ verdict: 'pass' });
      const report = runStep('publish_review_report', 'prepare_report', ctx, {
        REVIEW_JSON_FILE: outputs.deterministic_review_file,
        CUSTOM_REVIEWER_COUNT: '0',
        CUSTOM_TRACK_COUNT: '0',
      });
      const content: unknown = JSON.parse(report.report_content_json);
      expect(content).toContain('No custom reviewers were found');
      expect(content).toContain('.canopy/review-tracks/*.md');
    });

    it('declares an enabled-by-default input that gates discovery and its matrix', () => {
      expect(
        getDispatchInputs(pipeline).enable_custom_review_tracks,
      ).toMatchObject({ type: 'boolean', default: true, required: false });
      expect(getJob(pipeline, 'discover_review_tracks').if).toBe(
        'inputs.enable_custom_review_tracks == true',
      );
      // Without its own condition, the dynamic matrix is skipped before
      // expansion whenever discovery does not succeed.
      expect(getJob(pipeline, 'custom_review_tracks').if).toBeUndefined();
      expect(getJob(pipeline, 'custom_review_tracks').needs).toContain(
        'discover_review_tracks',
      );
    });

    it('passes with built-in reviews and reports disabled custom tracks when the input is false', () => {
      const ctx = aggregationContext(0);
      ctx.inputs = { enable_custom_review_tracks: false };
      ctx.needs.discover_review_tracks = { result: 'skipped', outputs: {} };
      const builtin =
        variant === 'multi-provider'
          ? 'gpt_methodical_reviewer'
          : 'methodical_reviewer';
      ctx.needs[builtin] = {
        result: 'success',
        outputs: { review_file: reviewFile('builtin') },
      };
      const outputs = runStep('synthesize_review', 'prepare_aggregation', ctx, {
        UNIFIED_REVIEW_SCHEMA: String(pipeline.env?.UNIFIED_REVIEW_SCHEMA),
      });
      const review: unknown = JSON.parse(
        fs.readFileSync(outputs.deterministic_review_file, 'utf8'),
      );
      expect(review).toMatchObject({ verdict: 'pass' });
      const reportEnv = getStep(
        pipeline,
        'publish_review_report',
        'prepare_report',
      ).env;
      const report = runStep('publish_review_report', 'prepare_report', ctx, {
        REVIEW_JSON_FILE: outputs.deterministic_review_file,
        CUSTOM_REVIEW_TRACKS_ENABLED: interpolateExpression(
          String(reportEnv?.CUSTOM_REVIEW_TRACKS_ENABLED),
          ctx,
        ),
        CUSTOM_REVIEWER_COUNT: '',
        CUSTOM_TRACK_COUNT: '',
      });
      const content: unknown = JSON.parse(report.report_content_json);
      expect(content).toContain('Custom review tracks were turned off');
      expect(content).not.toContain('did not complete successfully');
    });

    it.each([
      'discovery',
      'skipped discovery',
      'expansion',
      'child',
      'missing output',
    ])('blocks a clean pass on %s failure', (failure) => {
      const ctx = aggregationContext(1);
      if (failure === 'discovery')
        ctx.needs.discover_review_tracks.result = 'failure';
      if (failure === 'skipped discovery') {
        ctx.inputs = { enable_custom_review_tracks: true };
        ctx.needs.discover_review_tracks.result = 'skipped';
        ctx.needs.custom_review_tracks.result = 'skipped';
      }
      if (failure === 'expansion')
        ctx.needs.custom_review_tracks.result = 'failure';
      if (failure === 'child' || failure === 'missing output')
        ctx.needs.custom_review_tracks.children = [
          {
            job_id: 'one',
            matrix: { name: 'one' },
            status: 'success',
            result: failure === 'child' ? 'failure' : 'success',
            outputs: {},
          },
        ];
      const outputs = runStep('synthesize_review', 'prepare_aggregation', ctx, {
        UNIFIED_REVIEW_SCHEMA: String(pipeline.env?.UNIFIED_REVIEW_SCHEMA),
      });
      const review: unknown = JSON.parse(
        fs.readFileSync(outputs.deterministic_review_file, 'utf8'),
      );
      expect(review).toMatchObject({ verdict: 'blocked' });
    });
  },
);
