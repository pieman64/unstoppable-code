import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import {
  getTriggerInputDefs,
  type Job,
  type Pipeline,
  type PipelineInputDef,
  type Step,
} from '@canopy/desktop-shared/types/pipeline';

export interface BundledPipelineIndex {
  pipelines: Array<{
    id: string;
    name: string;
    filename: string;
    description: string;
    icon: string;
    createdAt: string;
    updatedAt: string;
    triggerTypes?: string[];
  }>;
}

export interface GitHubReviewContextFixtureResult {
  status: number | null;
  stderr: string;
  context: unknown;
  reviewThreads: unknown;
  summary: string;
}

function renderCanopyBrandTemplate(content: string): string {
  return content.split('{{BRAND_ENV_PREFIX}}').join('CANOPY');
}

export function runGitHubReviewContextFixture(
  pipeline: Pipeline,
  graphQlResponse: unknown,
): GitHubReviewContextFixtureResult {
  const script = getStep(pipeline, 'github_review_context', 'gather').run;
  if (typeof script !== 'string') {
    throw new Error('Missing github_review_context.gather script');
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-github-review-context-'),
  );
  try {
    const binDir = path.join(tempDir, 'bin');
    const ghPath = path.join(binDir, 'gh');
    const outputFile = path.join(tempDir, 'canopy-output.txt');
    const prFile = path.join(tempDir, 'pr.json');
    const scriptFile = path.join(tempDir, 'gather.mjs');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args[1] ?? '';
let response;
if (endpoint === 'graphql') {
  const fs = await import('node:fs');
  const countFile = 'graphql-request-count';
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  if (count > 0) throw new Error('Unexpected repeated GraphQL request');
  fs.writeFileSync(countFile, String(count + 1));
  response = JSON.parse(process.env.FAKE_GRAPHQL_RESPONSE ?? '{}');
} else if (endpoint.includes('/reviews/77/comments')) {
  response = [[{
    id: 7001,
    path: 'src/auth.ts',
    line: 42,
    start_line: null,
    body: 'AI finding: remove this check',
    created_at: '2026-09-25T12:00:00Z'
  }]];
} else if (endpoint.includes('/reviews?')) {
  response = [[{
    id: 77,
    node_id: 'PRR_previous_ai_review',
    body: '[//]: # (ud-ai-review)\\n<!-- AI_REVIEW_DATA: {"attempt":1} -->',
    state: 'COMMENTED',
    submitted_at: '2026-09-25T12:00:00Z',
    commit_id: 'abc123'
  }]];
} else if (endpoint.includes('/issues/')) {
  response = [[]];
} else {
  throw new Error('Unexpected gh request: ' + args.join(' '));
}
process.stdout.write(JSON.stringify(response));
`,
      'utf8',
    );
    fs.chmodSync(ghPath, 0o755);
    fs.writeFileSync(
      prFile,
      `${JSON.stringify({
        pr: { url: 'https://github.com/example/repository/pull/123' },
      })}\n`,
      'utf8',
    );
    fs.writeFileSync(scriptFile, renderCanopyBrandTemplate(script), 'utf8');

    const result = spawnSync(process.execPath, [scriptFile], {
      cwd: tempDir,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        CANOPY_OUTPUT: outputFile,
        CANOPY_OUTPUT_DIR: tempDir,
        PR_JSON_FILE: prFile,
        PR_STATUS: 'found',
        FAKE_GRAPHQL_RESPONSE: JSON.stringify(graphQlResponse),
      },
      encoding: 'utf8',
    });

    const readJson = (filename: string): unknown => {
      const filePath = path.join(tempDir, filename);
      return fs.existsSync(filePath)
        ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
        : undefined;
    };
    const summaryPath = path.join(tempDir, 'github-review-context.md');
    return {
      status: result.status,
      stderr: result.stderr,
      context: readJson('github-review-context.json'),
      reviewThreads: readJson('review-threads.json'),
      summary: fs.existsSync(summaryPath)
        ? fs.readFileSync(summaryPath, 'utf8')
        : '',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function expectGitHubReviewContextCollector(pipeline: Pipeline): void {
  const aiReviewBody =
    '[//]: # (ud-ai-review)\n<!-- AI_REVIEW_DATA: {"attempt":1} -->';
  const expectedReviewThreads = [
    {
      reviewId: 77,
      author: 'review-bot',
      state: 'COMMENTED',
      body: aiReviewBody,
      submittedAt: '2026-09-25T12:00:00Z',
      threads: [
        {
          id: 'PRRT_resolved_finding',
          commentId: 7001,
          resolved: true,
          body: 'AI finding: remove this check',
          author: 'review-bot',
          path: 'src/auth.ts',
          line: 42,
          replies: [
            {
              body: 'Rejected: this check is intentional and required.',
              author: 'human-reviewer',
            },
          ],
        },
      ],
    },
  ];
  const result = runGitHubReviewContextFixture(pipeline, {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'PRRT_resolved_finding',
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      databaseId: 7001,
                      body: 'AI finding: remove this check',
                      author: { login: 'review-bot' },
                      path: 'src/auth.ts',
                      line: 42,
                      pullRequestReview: {
                        databaseId: 77,
                        author: { login: 'review-bot' },
                        state: 'COMMENTED',
                        body: aiReviewBody,
                        submittedAt: '2026-09-25T12:00:00Z',
                      },
                    },
                    {
                      databaseId: 7002,
                      body: 'Rejected: this check is intentional and required.',
                      author: { login: 'human-reviewer' },
                      path: 'src/auth.ts',
                      line: 42,
                      pullRequestReview: {
                        databaseId: 77,
                        author: { login: 'review-bot' },
                        state: 'COMMENTED',
                        body: aiReviewBody,
                        submittedAt: '2026-09-25T12:00:00Z',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });

  expect(result.status).toBe(0);
  expect(result.reviewThreads).toEqual(expectedReviewThreads);
  expect(result.context).toMatchObject({
    attempt: 2,
    previousReviewId: 77,
    reviewThreads: expectedReviewThreads,
  });
  expect(result.summary).toContain('- Review threads: 1 (0 unresolved)');

  const malformed = runGitHubReviewContextFixture(pipeline, {
    data: { repository: { pullRequest: {} } },
  });
  expect(malformed.status).not.toBe(0);
  expect(malformed.stderr).toContain(
    'Unexpected GitHub GraphQL reviewThreads response shape',
  );

  for (const endCursor of [null, '']) {
    const missingCursor = runGitHubReviewContextFixture(pipeline, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor },
              nodes: [],
            },
          },
        },
      },
    });
    expect(missingCursor.status).not.toBe(0);
    expect(missingCursor.stderr).toContain(
      'Unexpected GitHub GraphQL reviewThreads response shape',
    );
    expect(missingCursor.stderr).not.toContain(
      'Unexpected repeated GraphQL request',
    );
  }
}

export interface InstructionScopeFixtureResult {
  status: number | null;
  stderr: string;
  instructionFiles: unknown;
}

function runGit(cwd: string, args: string[], input?: string): void {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

// Runs the instruction-scope step in a repository whose index lists more
// than 1 MiB of paths — past Node's default execFileSync maxBuffer, which
// the Canopy repository itself outgrew.
export function runInstructionScopeFixture(
  pipeline: Pipeline,
  includeUncommitted: boolean,
): InstructionScopeFixtureResult {
  const script = getStep(
    pipeline,
    'instruction_scope',
    'find_instruction_files',
  ).run;
  if (typeof script !== 'string') {
    throw new Error('Missing instruction_scope.find_instruction_files script');
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'canopy-instruction-scope-'),
  );
  try {
    const repoDir = path.join(tempDir, 'repo');
    const outputDir = path.join(tempDir, 'output');
    const scriptFile = path.join(tempDir, 'find-instruction-files.mjs');
    fs.mkdirSync(path.join(repoDir, 'packages', 'app'), { recursive: true });
    fs.mkdirSync(outputDir);
    runGit(repoDir, ['init', '--quiet']);
    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'root\n', 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'packages', 'app', 'AGENTS.md'),
      'nested\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'packages', 'NOT-CLAUDE.md'),
      'decoy\n',
      'utf8',
    );
    runGit(repoDir, [
      'add',
      'CLAUDE.md',
      'packages/app/AGENTS.md',
      'packages/NOT-CLAUDE.md',
    ]);
    runGit(repoDir, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'Baseline instruction files',
    ]);

    // Index-only entries stress the uncommitted path listing without writing
    // thousands of files to disk.
    const blobId = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoDir,
      input: 'generated\n',
      encoding: 'utf8',
    }).stdout.trim();
    const indexInfo = Array.from(
      { length: 20_000 },
      (_, index) =>
        `100644 ${blobId}\tgenerated/module-${String(index).padStart(5, '0')}/source-file-with-a-long-name.ts\n`,
    ).join('');
    runGit(repoDir, ['update-index', '--index-info'], indexInfo);
    fs.writeFileSync(
      path.join(repoDir, 'packages', 'CLAUDE.md'),
      'untracked\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoDir, 'packages', 'app', 'CLAUDE.md'),
      'staged\n',
      'utf8',
    );
    runGit(repoDir, ['add', 'packages/app/CLAUDE.md']);

    fs.writeFileSync(scriptFile, renderCanopyBrandTemplate(script), 'utf8');
    const outputFile = path.join(outputDir, 'canopy-output.txt');
    const result = spawnSync(process.execPath, [scriptFile], {
      cwd: repoDir,
      env: {
        ...process.env,
        CANOPY_OUTPUT: outputFile,
        CANOPY_OUTPUT_DIR: outputDir,
        INPUT_INCLUDE_UNCOMMITTED: String(includeUncommitted),
      },
      encoding: 'utf8',
    });

    const instructionFilesPath = path.join(outputDir, 'instruction-files.json');
    return {
      status: result.status,
      stderr: result.stderr,
      instructionFiles: fs.existsSync(instructionFilesPath)
        ? JSON.parse(fs.readFileSync(instructionFilesPath, 'utf8'))
        : undefined,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function expectInstructionScopeCollector(pipeline: Pipeline): void {
  const withUncommitted = runInstructionScopeFixture(pipeline, true);
  expect(withUncommitted.stderr.includes('ENOBUFS')).toBe(false);
  expect(withUncommitted.status).toBe(0);
  expect(withUncommitted.instructionFiles).toEqual({
    instructionFiles: [
      'CLAUDE.md',
      'packages/app/AGENTS.md',
      'packages/app/CLAUDE.md',
      'packages/CLAUDE.md',
    ],
  });

  const committedOnly = runInstructionScopeFixture(pipeline, false);
  expect(committedOnly.status).toBe(0);
  expect(committedOnly.instructionFiles).toEqual({
    instructionFiles: ['CLAUDE.md', 'packages/app/AGENTS.md'],
  });
}

export function loadPipelineFromFile(filePath: string): {
  raw: string;
  pipeline: Pipeline;
} {
  const raw = fs.readFileSync(filePath, 'utf8');
  return {
    raw,
    pipeline: parsePipelineText(raw),
  };
}

export function getJob(pipeline: Pipeline, jobId: string): Job {
  const job = pipeline.jobs[jobId];
  if (!job) {
    throw new Error(`Missing job "${jobId}"`);
  }
  return job;
}

export function getStep(
  pipeline: Pipeline,
  jobId: string,
  stepId: string,
): Step {
  const step = getJob(pipeline, jobId).steps.find(
    (candidate) => candidate.id === stepId,
  );
  if (!step) {
    throw new Error(`Missing step "${jobId}.${stepId}"`);
  }
  return step;
}

export function getDispatchInputs(
  pipeline: Pipeline,
): Record<string, PipelineInputDef> {
  const inputs = getTriggerInputDefs(pipeline.on, 'dispatch');
  if (!inputs) {
    throw new Error('Missing dispatch inputs');
  }
  return inputs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Invalid bundled pipeline index entry: ${key}`);
  }
  return value;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected object at ${key}`);
  }
  return value;
}

export function requiredStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error(`Expected string array at ${key}`);
  }
  return value;
}

export function schemaPropertyItems(
  schema: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  return requiredRecord(
    requiredRecord(requiredRecord(schema, 'properties'), propertyName),
    'items',
  );
}

export function readBundledPipelineIndex(
  indexPath: string,
): BundledPipelineIndex {
  const parsed: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.pipelines)) {
    throw new Error('Invalid bundled pipeline index');
  }

  return {
    pipelines: parsed.pipelines.map((entry) => {
      if (!isRecord(entry)) {
        throw new Error('Invalid bundled pipeline index entry');
      }
      const triggerTypes = Array.isArray(entry.triggerTypes)
        ? entry.triggerTypes.filter((value) => typeof value === 'string')
        : undefined;
      return {
        id: requiredString(entry, 'id'),
        name: requiredString(entry, 'name'),
        filename: requiredString(entry, 'filename'),
        description: requiredString(entry, 'description'),
        icon: requiredString(entry, 'icon'),
        createdAt: requiredString(entry, 'createdAt'),
        updatedAt: requiredString(entry, 'updatedAt'),
        ...(triggerTypes ? { triggerTypes } : {}),
      };
    }),
  };
}
