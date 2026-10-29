import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getJob,
  getStep,
  loadPipelineFromFile,
  readBundledPipelineIndex,
} from './helpers/pipeline-test-utils';

const PIPELINE_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/implementation-autopilot.yaml',
);
const INDEX_PATH = path.resolve(
  __dirname,
  '../../../../../packages/desktop-shared/resources/pipelines/index.json',
);

function loadPipeline(): ReturnType<typeof loadPipelineFromFile> {
  return loadPipelineFromFile(PIPELINE_PATH);
}

function readObjectProperty(value: unknown, property: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return Reflect.get(value, property);
}

function renderCanopyBrandTemplate(content: string): string {
  return content
    .split('{{BRAND_ENV_PREFIX}}')
    .join('CANOPY')
    .split('{{BRAND_EXPRESSION_ROOT}}')
    .join('canopy')
    .split('{{BRAND_OUTPUT_VARIABLE_NAME}}')
    .join('brandOutput');
}

describe('bundled implementation autopilot pipeline', () => {
  it('is registered as a bundled plan and task implementation pipeline', () => {
    const { pipeline } = loadPipeline();
    const entry = readBundledPipelineIndex(INDEX_PATH).pipelines.find(
      (pipeline) => pipeline.id === 'bundled-implementation-autopilot',
    );

    expect(entry).toEqual({
      id: 'bundled-implementation-autopilot',
      name: pipeline.name,
      filename: 'implementation-autopilot.yaml',
      description: pipeline.description,
      icon: '▶',
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      triggerTypes: ['plan_ready', 'task_ready'],
    });
    expect(pipeline.name).toBe('Implementation (Autopilot)');
    expect(pipeline.scope).toBe('worktree');
  });

  it('keeps implementation loops but makes gate failures report-only', () => {
    const { pipeline, raw } = loadPipeline();
    const triggerConfig =
      typeof pipeline.on === 'object' && pipeline.on !== null
        ? pipeline.on
        : undefined;
    const planReadyInputs = triggerConfig?.plan_ready?.inputs;
    const taskReadyInputs = triggerConfig?.task_ready?.inputs;

    expect(planReadyInputs).toEqual({
      push_and_create_prs: {
        description:
          'Commit, push, and open pull requests when the run completes, even if unresolved issues are recorded.',
        type: 'boolean',
        default: false,
      },
      complexity: {
        description:
          'Auto is recommended. Lower complexities result in fewer repeated phase iterations and lower token usage, but may result in lower quality outcomes if the complexity setting is lower than the actual task complexity.',
        type: 'choice',
        options: ['auto', 'trivial', 'low', 'medium', 'high', 'xhigh'],
        default: 'auto',
      },
    });
    expect(taskReadyInputs).toEqual(planReadyInputs);

    expect(getJob(pipeline, 'commit_and_push').if).toBe(
      "inputs.push_and_create_prs == true && needs.final_solution_gate.result == 'success' && needs.final_solution_gate.outputs.passed == 'true'",
    );
    expect(raw).not.toContain('inputs.continue_on_');
    expect(raw).toContain('Unresolved issues that may need attention');
    expect(getJob(pipeline, 'refine').max_iterations).toBe(
      '${{ needs.complexity_analysis.outputs.planning_max_iterations }}',
    );
    expect(
      getJob(pipeline, 'implementation_completion_loop').max_iterations,
    ).toBe(
      '${{ needs.complexity_analysis.outputs.completion_validation_max_iterations }}',
    );
    expect(getJob(pipeline, 'qa_fix_loop').max_iterations).toBe(
      '${{ needs.complexity_analysis.outputs.qa_max_iterations }}',
    );
    expect(getJob(pipeline, 'refine_gate').name).toBe(
      'Refine Acceptance Review',
    );
    expect(getJob(pipeline, 'final_solution_gate').name).toBe(
      'Autopilot Attention Review',
    );

    expect(
      getStep(pipeline, 'refine_gate', 'evaluate_refine_gate').env
        ?.CONTINUE_ON_REFINE_GATE_FAIL,
    ).toBe('true');
    expect(
      getStep(pipeline, 'plan_contract', 'validate_plan_contract').env
        ?.CONTINUE_ON_PLAN_CONTRACT_FAIL,
    ).toBe('true');
    expect(
      getStep(
        pipeline,
        'implementation_completion_loop',
        'capture_completion_iteration_limit_state',
      ).env?.CONTINUE_ON_COMPLETION_LOOP_FAIL,
    ).toBe('true');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'capture_iteration_limit_state').env
        ?.CONTINUE_ON_QA_LOOP_FAIL,
    ).toBe('true');
    expect(
      getStep(pipeline, 'final_solution_gate', 'evaluate_final_solution').env,
    ).toMatchObject({
      CONTINUE_ON_REFINE_GATE_FAIL: 'true',
      CONTINUE_ON_PLAN_CONTRACT_FAIL: 'true',
      CONTINUE_ON_COMPLETION_LOOP_FAIL: 'true',
      CONTINUE_ON_QA_LOOP_FAIL: 'true',
      CONTINUE_ON_FINAL_SOLUTION_GATE_FAIL: 'true',
    });
    expect(
      getStep(pipeline, 'qa_fix_loop', 'prepare_code_review_inputs').run,
    ).toContain('post_pr_comment: false');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain('Array.isArray(parsed.findings)');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain('issues: parsed.findings.map(normalizeFindingToIssue)');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain('const normalizeFindingCategory = (record) =>');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain('category: normalizeFindingCategory(record)');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain("return 'plan_conflict'");
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain("return 'project_compliance'");
    expect(
      getStep(pipeline, 'qa_fix_loop', 'synthesize_review_results').run,
    ).toContain("return 'bug'");
    expect(
      getStep(pipeline, 'final_solution_gate', 'evaluate_final_solution').run,
    ).not.toContain('if (!passed)');
    expect(
      getStep(pipeline, 'final_solution_gate', 'evaluate_final_solution').run,
    ).not.toContain('Final solution gate failed');
    expect(
      getStep(pipeline, 'final_solution_gate', 'evaluate_final_solution').run,
    ).not.toContain('Autopilot attention review found');
    expect(getStep(pipeline, 'summary', 'summarize').run).toContain(
      'Unresolved issues that may need attention',
    );
    expect(getStep(pipeline, 'summary', 'prepare_report').shell).toBe('node');
    expect(getStep(pipeline, 'summary', 'prepare_report').run).toContain(
      'toJson(steps.summarize.outputs)',
    );
    expect(getStep(pipeline, 'summary', 'prepare_report').run).toContain(
      "String(summarizeOutputs.text_response_file ?? '').trim()",
    );
    expect(getStep(pipeline, 'summary', 'prepare_report').run).not.toContain(
      '`${{ steps.summarize.outputs.text_response_file }}`',
    );
  });

  it('runs explicit scenario detail commands and skips scenarios without commands', () => {
    const { pipeline } = loadPipeline();
    const script = getStep(
      pipeline,
      'qa_fix_loop',
      'run_verification_commands',
    ).run;
    expect(typeof script).toBe('string');
    if (typeof script !== 'string') {
      return;
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-implementation-verification-'),
    );
    try {
      const outputFile = path.join(tempDir, 'canopy-output.txt');
      const commandsFile = path.join(tempDir, 'checks.json');
      const scriptFile = path.join(tempDir, 'run-verification.mjs');
      fs.mkdirSync(path.join(tempDir, 'scripts', 'vm', 'linux'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(tempDir, 'scripts', 'lib'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          scripts: {
            'test:dev-scripts': 'node -e "console.log(\'dev-suite-pass\')"',
            'test:dev':
              'node -e "console.log(\'verification-lifecycle-pass\')"',
          },
        }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'scripts', 'run-guarded-dev-script.mjs'),
        "console.log('guarded-pass');\n",
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'scripts', 'vm', 'linux', 'build.sh'),
        '#!/usr/bin/env bash\ntrue\n',
        'utf8',
      );
      fs.writeFileSync(
        commandsFile,
        `${JSON.stringify(
          {
            checks: [
              {
                id: 'VC-001',
                type: 'scenario',
                description: 'Run `node -e "console.log(\'vc-pass\')"`',
                command: '',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['vc-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-002',
                type: 'scenario',
                description:
                  'Verify the targeted regression behavior described by this check.',
                command: '',
                expectedExitCode: 0,
                expectedStdoutIncludes: [],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-003',
                type: 'scenario',
                description:
                  'Run scenario detail command. Scenario details from the plan: node -e "console.log(\'scenario-details-pass\')"',
                command: '',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['scenario-details-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'MAN-001',
                type: 'manual',
                description: 'Inspect the affected UI manually.',
                command: '',
                expectedExitCode: 0,
                expectedStdoutIncludes: [],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-004',
                type: 'command',
                description: 'Run VM tests through the guarded dev runner.',
                command:
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- node --test scripts/lib/vm-linux-wip.test.mjs',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['guarded-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-005',
                type: 'command',
                description: 'Run the dev-script test suite.',
                command: 'npm run test:dev-scripts',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['dev-suite-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-006',
                type: 'command',
                description: 'Check Linux build script syntax.',
                command: 'bash -n scripts/vm/linux/build.sh',
                expectedExitCode: 0,
                expectedStdoutIncludes: [],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-007',
                type: 'command',
                description: 'Run the focused Linux build-runner test.',
                command:
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- node --test scripts/lib/vm-linux-build-runner.test.mjs',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['guarded-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-065',
                type: 'command',
                description:
                  'Run an allowed lifecycle test through the guarded dev runner.',
                command:
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['guarded-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-081',
                type: 'command',
                description:
                  'Allow the non-bypass guard wait option through the guarded runner.',
                command:
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --no-guard-wait',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['guarded-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-008',
                type: 'command',
                description: 'Do not run a development server.',
                command: 'npm run dev',
                expectedExitCode: 0,
                expectedStdoutIncludes: [],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              ...[
                ['VC-009', 'npm run "publish"'],
                ['VC-010', "npm run 'deploy'"],
                ['VC-011', 'npm run "dev"'],
                ['VC-012', 'npm run app:dev'],
                ['VC-013', 'npm run web:start'],
                ['VC-014', 'npm run prod:deploy'],
                ['VC-015', 'bash -c "exit 0"'],
                ['VC-018', 'bash'],
                ['VC-019', 'bash -i'],
                ['VC-020', 'bash -n /tmp/build.sh'],
                ['VC-021', 'bash -n ../build.sh'],
                ['VC-022', 'bash -n scripts/../build.sh'],
                ['VC-023', 'bash -n scripts/vm/linux/build.txt'],
                ['VC-024', 'npm run d\\ev'],
                ['VC-025', 'npm run publ\\ish'],
                ['VC-026', 'npm run dep\\loy'],
                ['VC-027', "npm run d$'ev'"],
                ['VC-028', 'npm run --silent app:dev'],
                ['VC-029', 'npm --silent run app:dev'],
                ['VC-030', 'pnpm --filter web run app:dev'],
                ['VC-031', 'yarn --silent app:dev'],
                ['VC-032', 'npm run deploy-prod'],
                ['VC-033', 'pnpm run release-please'],
                ['VC-034', 'yarn publish-package'],
                ['VC-035', 'bun run dev-server'],
                ['VC-036', 'npm run deploy_prod'],
                ['VC-037', 'pnpm run release.please'],
                ['VC-038', 'npm run test:watch'],
                ['VC-039', 'pnpm run test-watch'],
                ['VC-040', 'yarn test_watch'],
                ['VC-041', 'bun run test.watch'],
                ['VC-042', 'npm run test:deploy'],
                ['VC-043', 'pnpm run lint:publish'],
                ['VC-044', 'yarn verify:release'],
                ['VC-045', 'bun run check:start'],
                ['VC-046', 'npm run test:serve'],
                ['VC-047', 'pnpm run lint:storybook'],
                ['VC-048', 'npm run deploy/prod'],
                ['VC-049', 'pnpm run release@please'],
                ['VC-050', 'yarn publish+package'],
                ['VC-051', 'bun run dev=server'],
                [
                  'VC-052',
                  'npm run test:dev-scripts&touch background-operator-no-space',
                ],
                [
                  'VC-053',
                  'npm run test:dev-scripts &touch background-operator-leading-space',
                ],
                ['VC-054', './scripts/deploy.sh'],
                ['VC-055', 'turbo run deploy-prod'],
                ['VC-056', 'nx run web:deploy'],
                ['VC-057', 'make deploy-prod'],
                ['VC-058', 'node scripts/publish-release.mjs'],
                ['VC-059', 'node scripts/web/start-local-e2e.mjs'],
                ['VC-060', './scripts/dev-test.sh'],
                ['VC-061', 'node scripts/dev-test.mjs'],
                [
                  'VC-062',
                  'node ./scripts/run-guarded-dev-script.mjs --suite unit -- node --test scripts/lib/example.test.mjs',
                ],
                [
                  'VC-063',
                  'node scripts/run-guarded-dev-script.mjs.evil --suite unit',
                ],
                [
                  'VC-064',
                  'node scripts/sub/run-guarded-dev-script.mjs --suite unit',
                ],
                [
                  'VC-066',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run dev-server',
                ],
                [
                  'VC-067',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run development-server',
                ],
                [
                  'VC-068',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- node scripts/dev-test.mjs',
                ],
                [
                  'VC-069',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- node scripts/development-test.mjs',
                ],
                [
                  'VC-070',
                  'node scripts/run-guarded-dev-script.mjs --suite other -- node --test scripts/lib/example.test.mjs',
                ],
                [
                  'VC-071',
                  'node scripts/run-guarded-dev-script.mjs --suite unit --',
                ],
                [
                  'VC-072',
                  'node scripts/run-guarded-dev-script.mjs --suite unit node --test scripts/lib/example.test.mjs',
                ],
                [
                  'VC-073',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- bash -c true',
                ],
                [
                  'VC-074',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- test -f package.json',
                ],
                [
                  'VC-075',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety-lock',
                ],
                [
                  'VC-076',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-memory-pressure-safety-check',
                ],
                [
                  'VC-077',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- --danger-skip-concurrency-safety-lock npm run test:dev',
                ],
                [
                  'VC-078',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- --danger-skip-memory-pressure-safety-check npm run test:dev',
                ],
                [
                  'VC-079',
                  `${'node scripts/run-guarded-dev-script.mjs --suite unit -- '.repeat(5)}node --test scripts/lib/example.test.mjs`,
                ],
                ['VC-080', `node --test ${'a'.repeat(4096)}`],
                [
                  'VC-082',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety\\-lock',
                ],
                [
                  'VC-083',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-{concurrency-safety-lock,memory-pressure-safety-check}',
                ],
                [
                  'VC-084',
                  "node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety-$'lock'",
                ],
                [
                  'VC-085',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety^-lock',
                ],
                [
                  'VC-086',
                  'node scripts/run-guarded-dev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety-%BYPASS%',
                ],
                [
                  'VC-087',
                  "node 'scripts/run-guarded-dev-script.mjs' --suite unit -- npm run test:dev",
                ],
                [
                  'VC-088',
                  "node 'scripts/run-guarded-dev-script.mjs' --suite unit -- npm run test:dev --danger-skip-{concurrency-safety-lock,memory-pressure-safety-check}",
                ],
                [
                  'VC-089',
                  'node scripts/run-guarded-d\\ev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety\\-lock',
                ],
                [
                  'VC-090',
                  'node scripts/run-guarded-d^ev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety^-lock',
                ],
                [
                  'VC-091',
                  'node scripts/run-guarded-d${EMPTY}ev-script.mjs --suite unit -- npm run test:dev --danger-skip-concurrency-safety-${EMPTY}lock',
                ],
              ].map(([id, command]) => ({
                id,
                type: 'command',
                description: `Reject unsafe verification command: ${command}`,
                command,
                expectedExitCode: 0,
                expectedStdoutIncludes: [],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              })),
              {
                id: 'VC-016',
                type: 'command',
                description:
                  'Allow a verification-scoped lifecycle script segment.',
                command: 'npm run test:dev',
                expectedExitCode: 0,
                expectedStdoutIncludes: ['verification-lifecycle-pass'],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
              {
                id: 'VC-017',
                type: 'command',
                description: 'Allow a repo-relative Bash syntax check.',
                command: 'bash -n ./scripts/vm/linux/build.sh',
                expectedExitCode: 0,
                expectedStdoutIncludes: [],
                expectedStderrIncludes: [],
                expectedOutputIncludes: [],
              },
            ],
            commands: [],
            source: 'test',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      fs.writeFileSync(scriptFile, renderCanopyBrandTemplate(script), 'utf8');

      execFileSync(process.execPath, [scriptFile], {
        cwd: tempDir,
        env: {
          ...process.env,
          CANOPY_OUTPUT: outputFile,
          CANOPY_OUTPUT_DIR: tempDir,
          DISCOVERED_COMMANDS_FILE: commandsFile,
        },
        stdio: 'pipe',
      });

      const parsed: unknown = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, 'verification-results.json'),
          'utf8',
        ),
      );
      const resultsValue = readObjectProperty(parsed, 'results');
      const results = Array.isArray(resultsValue) ? resultsValue : [];
      const findResult = (id: string): unknown =>
        results.find((result) => readObjectProperty(result, 'id') === id);
      const vc001 = findResult('VC-001');
      const vc002 = findResult('VC-002');
      const vc003 = findResult('VC-003');
      const vc005 = findResult('VC-005');
      const vc006 = findResult('VC-006');
      const manual = findResult('MAN-001');

      expect(readObjectProperty(vc001, 'status')).toBe('passed');
      expect(readObjectProperty(vc001, 'type')).toBe('command');
      expect(readObjectProperty(vc001, 'command')).toBe(
        'node -e "console.log(\'vc-pass\')"',
      );
      expect(readObjectProperty(vc002, 'status')).toBe('skipped');
      expect(readObjectProperty(vc002, 'skippedReason')).toBe('scenario_check');
      expect(readObjectProperty(vc003, 'status')).toBe('passed');
      expect(readObjectProperty(vc003, 'type')).toBe('command');
      expect(readObjectProperty(vc003, 'command')).toBe(
        'node -e "console.log(\'scenario-details-pass\')"',
      );
      for (const commandResult of [
        findResult('VC-004'),
        vc005,
        vc006,
        findResult('VC-007'),
        findResult('VC-065'),
        findResult('VC-081'),
        findResult('VC-016'),
        findResult('VC-017'),
      ]) {
        expect(readObjectProperty(commandResult, 'status')).toBe('passed');
      }
      for (const id of [
        'VC-008',
        'VC-009',
        'VC-010',
        'VC-011',
        'VC-012',
        'VC-013',
        'VC-014',
        'VC-015',
        'VC-018',
        'VC-019',
        'VC-020',
        'VC-021',
        'VC-022',
        'VC-023',
        'VC-024',
        'VC-025',
        'VC-026',
        'VC-027',
        'VC-028',
        'VC-029',
        'VC-030',
        'VC-031',
        'VC-032',
        'VC-033',
        'VC-034',
        'VC-035',
        'VC-036',
        'VC-037',
        'VC-038',
        'VC-039',
        'VC-040',
        'VC-041',
        'VC-042',
        'VC-043',
        'VC-044',
        'VC-045',
        'VC-046',
        'VC-047',
        'VC-048',
        'VC-049',
        'VC-050',
        'VC-051',
        'VC-054',
        'VC-055',
        'VC-056',
        'VC-057',
        'VC-058',
        'VC-059',
        'VC-060',
        'VC-061',
        'VC-062',
        'VC-063',
        'VC-064',
        'VC-066',
        'VC-067',
        'VC-068',
        'VC-069',
        'VC-070',
        'VC-071',
        'VC-072',
        'VC-073',
        'VC-074',
        'VC-075',
        'VC-076',
        'VC-077',
        'VC-078',
        'VC-079',
        'VC-080',
        'VC-082',
        'VC-083',
        'VC-084',
        'VC-085',
        'VC-086',
        'VC-087',
        'VC-088',
        'VC-089',
        'VC-090',
        'VC-091',
      ]) {
        expect(readObjectProperty(findResult(id), 'status')).toBe('invalid');
      }
      for (const id of ['VC-052', 'VC-053']) {
        const backgroundOperatorResult = findResult(id);
        expect(readObjectProperty(backgroundOperatorResult, 'status')).toBe(
          'skipped',
        );
        expect(
          readObjectProperty(backgroundOperatorResult, 'skippedReason'),
        ).toBe('scenario_check');
      }
      expect(
        fs.existsSync(path.join(tempDir, 'background-operator-no-space')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(tempDir, 'background-operator-leading-space')),
      ).toBe(false);
      expect(readObjectProperty(manual, 'status')).toBe('skipped');
      expect(readObjectProperty(manual, 'skippedReason')).toBe('manual_check');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps focused npm test verification checks runnable', () => {
    const { pipeline } = loadPipeline();
    const safeShellRecipePattern =
      /^(?:test\b|\[)|(?:^|\s)(?:echo|rm|mkdir|ln|grep)\b|[\r\n<>;&|]|&&|\|\||(?:^|\s)&(?:\s|$)|\$\(|\$\?|`/;

    expect(
      safeShellRecipePattern.test(
        'npm test -- --runTestsByPath apps/desktop-app/src/main/__tests__/invocable-inventory-service.test.ts',
      ),
    ).toBe(false);
    expect(safeShellRecipePattern.test('npm run test -- --watch=false')).toBe(
      false,
    );
    expect(safeShellRecipePattern.test('test -f package.json')).toBe(true);
    expect(safeShellRecipePattern.test('[ -f package.json ]')).toBe(true);
    expect(
      safeShellRecipePattern.test('npm test -- --runInBand && npm run lint'),
    ).toBe(true);
    expect(
      safeShellRecipePattern.test(
        'npm test -- --runTestsByPath `touch /tmp/canopy-pwned`',
      ),
    ).toBe(true);
    expect(
      safeShellRecipePattern.test(
        'npm test -- --runTestsByPath apps/desktop-app/src/main/__tests__/invocable-inventory-service.test.ts\nnpm run lint',
      ),
    ).toBe(true);

    const expectedRecipePattern =
      '/^(?:test\\b|\\[)|(?:^|\\s)(?:echo|rm|mkdir|ln|grep)\\b|[\\r\\n<>;&|]|&&|\\|\\||(?:^|\\s)&(?:\\s|$)|\\$\\(|\\$\\?|`/';
    const expectedCommandToolPattern = String.raw`/\b(?:npm|pnpm|yarn|bun|npx|pnpx|pytest|python3?|uv|poetry|cargo|node|bash|vitest|jest|tsx|tsc|eslint|turbo|nx|mvn|gradle|phpunit|ruff|dotnet)\b/i`;
    const stepsToCheck = [
      getStep(pipeline, 'plan_contract', 'validate_plan_contract'),
      getStep(pipeline, 'qa_fix_loop', 'derive_verification_commands'),
      getStep(pipeline, 'qa_fix_loop', 'run_verification_commands'),
    ];
    const packageScriptPolicyFragments = stepsToCheck.map((step) => {
      const constants = step.run.match(
        /const packageManagerCommandPattern =[\s\S]*?(?=const bashSyntaxCheckPattern =)/,
      );
      const predicate = step.run.match(
        /const isDisallowedCommand =[\s\S]*?const isSafeCommand = \(value, guardedWrapperDepth = 0\) =>[\s\S]*?!shellRecipePattern\.test\(value\);/,
      );
      expect(constants).not.toBeNull();
      expect(predicate).not.toBeNull();
      return `${constants?.[0] ?? ''}${predicate?.[0] ?? ''}`;
    });

    for (const step of stepsToCheck) {
      expect(step.run).toContain(expectedRecipePattern);
      expect(step.run).toContain(expectedCommandToolPattern);
      expect(step.run).not.toContain(
        String.raw`/(?:^|\s)(?:test|echo|rm|mkdir|ln|grep)\b`,
      );
    }
    for (const policyFragment of packageScriptPolicyFragments.slice(1)) {
      expect(policyFragment).toBe(packageScriptPolicyFragments[0]);
    }

    expect(
      getStep(pipeline, 'plan_contract', 'validate_plan_contract').run,
    ).not.toContain('targetedVerificationIdPattern.test(id) ||');
    expect(
      getStep(pipeline, 'qa_fix_loop', 'run_verification_commands').run,
    ).not.toContain('targetedVerificationIdPattern.test(id) ||');
  });
});
