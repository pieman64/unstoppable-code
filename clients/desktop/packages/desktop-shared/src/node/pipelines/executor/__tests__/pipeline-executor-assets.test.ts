import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import { brandEnvName } from '../../../../brand/env';
import { buildExpressionContext } from '../execution-context';
import { interpolateExpression } from '../expression-evaluator';
import { loadExecutionState } from '../execution-state';
import { executePipeline } from '../pipeline-executor';
import { buildPipelineAssetEnvValues } from '../step-runner';
import type { ExecutionRuntime, ResolvePipelineTargetResult } from '../types';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
    resolvePipelineTarget: (): Promise<ResolvePipelineTargetResult> =>
      Promise.reject(new Error('Unexpected target resolution')),
  };
}

function writeRunPipelineAction(runtime: ExecutionRuntime): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'run-pipeline');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(
      __dirname,
      '../../../../../resources/actions/run-pipeline/action.yml',
    ),
    path.join(actionDir, 'action.yml'),
  );
}

/** The brand alias root that `buildExpressionContext` adds next to `canopy`. */
const brandExpressionRoot = BRAND.internalName
  .split(/[-_]+/)
  .filter(Boolean)
  .map((part, index) =>
    index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
  )
  .join('');

/**
 * Writes the asset expression, both data-dir spellings and the three env
 * vars into `<file>`, one per line.
 */
function reportPipeline(file: string): Pipeline {
  return {
    name: 'Asset reader',
    on: 'dispatch',
    jobs: {
      read: {
        steps: [
          {
            id: 'report',
            run: [
              `printf '%s\\n' '\${{ assets.specialists.path }}' > ${file}`,
              `printf '%s\\n' '\${{ canopy.pipeline_data_dir }}' >> ${file}`,
              `printf '%s\\n' '\${{ ${brandExpressionRoot}.pipeline_data_dir }}' >> ${file}`,
              `printf '%s\\n' "$${brandEnvName('ASSET_SPECIALISTS')}" >> ${file}`,
              `printf '%s\\n' "$${brandEnvName('PIPELINE_DATA_DIR')}" >> ${file}`,
              `printf '%s\\n' "$${brandEnvName('ASSETS_DIR')}" >> ${file}`,
            ].join('\n'),
          },
        ],
      },
    },
  };
}

function readReport(file: string): string[] {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n');
}

describe('pipeline asset context', () => {
  let tempDir: string;
  let runDir: string;
  let runtime: ExecutionRuntime;
  let specialistsDir: string;
  let dataDir: string;
  let assetsDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-assets-')),
    );
    runDir = path.join(tempDir, 'run');
    specialistsDir = path.join(tempDir, 'assets', 'specialists');
    dataDir = path.join(tempDir, 'pipeline-data', 'key', 'state');
    assetsDir = path.join(tempDir, 'pipeline-data', 'key', 'assets');
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(specialistsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    runtime = createRuntime(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads assets through the expression root without special-casing', () => {
    const context = buildExpressionContext({
      assets: { specialists: { path: '/data/specialists' } },
    });
    expect(
      interpolateExpression('${{ assets.specialists.path }}', context),
    ).toBe('/data/specialists');
    expect(interpolateExpression('${{ assets.missing.path }}', context)).toBe(
      '',
    );
    expect(
      interpolateExpression(
        '${{ assets.specialists.path }}',
        buildExpressionContext({}),
      ),
    ).toBe('');
  });

  it('interpolates assets, the data dir and its brand alias, and sets env vars', async () => {
    const report = path.join(runDir, 'report.txt');
    const state = await (
      await executePipeline(reportPipeline(report), {
        cwd: runDir,
        runtime,
        pipelineId: 'asset-reader',
        assetPaths: { specialists: specialistsDir },
        pipelineDataDir: dataDir,
        assetsDir,
      })
    ).waitForCompletion();

    expect(state.status).toBe('success');
    expect(readReport(report)).toEqual([
      specialistsDir,
      dataDir,
      dataDir,
      specialistsDir,
      dataDir,
      assetsDir,
    ]);
    expect(state.pipeline_assets).toEqual({
      asset_paths: { specialists: specialistsDir },
      pipeline_data_dir: dataDir,
      assets_dir: assetsDir,
    });
  });

  it('leaves the context empty for a run without resolved assets', async () => {
    const report = path.join(runDir, 'report.txt');
    const state = await (
      await executePipeline(reportPipeline(report), {
        cwd: runDir,
        runtime,
        pipelineId: 'asset-reader',
      })
    ).waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.pipeline_assets).toBeUndefined();
    expect(readReport(report).every((line) => line === '')).toBe(true);
  });

  it('gives a child run the root run assets and data dir', async () => {
    writeRunPipelineAction(runtime);
    const report = path.join(runDir, 'child-report.txt');
    const parent: Pipeline = {
      name: 'Entry',
      on: 'dispatch',
      jobs: {
        run_worker: {
          steps: [
            {
              id: 'worker',
              uses: 'builtin/run-pipeline',
              with: { pipeline_yaml: JSON.stringify(reportPipeline(report)) },
            },
          ],
        },
      },
    };

    const state = await (
      await executePipeline(parent, {
        cwd: runDir,
        runtime,
        pipelineId: 'entry',
        assetPaths: { specialists: specialistsDir },
        pipelineDataDir: dataDir,
        assetsDir,
      })
    ).waitForCompletion();

    expect(state.status).toBe('success');
    expect(readReport(report)).toEqual([
      specialistsDir,
      dataDir,
      dataDir,
      specialistsDir,
      dataDir,
      assetsDir,
    ]);
    const childId = state.jobs.run_worker.steps.worker.child_execution_id;
    if (childId === undefined) throw new Error('Expected a child execution');
    const child = await loadExecutionState(childId, runtime.executionsDir);
    expect(child?.pipeline_assets).toEqual(state.pipeline_assets);
  });

  it('omits unresolved dirs from step env', () => {
    expect(
      buildPipelineAssetEnvValues({
        asset_paths: { specialists: '/a', notes: '' },
      }),
    ).toEqual({ ASSET_SPECIALISTS: '/a', ASSET_NOTES: '' });
    expect(buildPipelineAssetEnvValues(undefined)).toEqual({});
  });
});
