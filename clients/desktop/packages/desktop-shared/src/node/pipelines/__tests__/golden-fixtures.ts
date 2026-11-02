// CAN-5061 golden fixtures, shared by the executor, desktop and CLI pipeline
// goldens. Definitions use shell steps only, so no golden calls a model, and
// they avoid host-specific shell syntax beyond POSIX `sh`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One bundled pipeline, pinned through `CANOPY_BUNDLED_RESOURCES_DIR`. */
export const GOLDEN_BUNDLED_PIPELINE_ID = 'bundled-golden-review';

export const GOLDEN_BUNDLED_PIPELINE_YAML = [
  'pipeline:',
  '  name: Golden bundled review',
  '  description: Bundled golden fixture',
  '  icon: "🔎"',
  '  on:',
  '    dispatch:',
  '      inputs:',
  '        focus:',
  '          type: string',
  '          default: all',
  '  scope: [directory, worktree]',
  '  jobs:',
  '    review:',
  '      name: Review',
  '      steps:',
  '        - id: say',
  '          name: Say',
  '          run: echo "bundled review $FOCUS"',
  '          env:',
  '            FOCUS: ${{ inputs.focus }}',
  '',
].join('\n');

export const GOLDEN_USER_PIPELINE_YAML = [
  'pipeline:',
  '  name: Golden user pipeline',
  '  description: User golden fixture',
  '  on:',
  '    dispatch:',
  '      inputs:',
  '        greeting:',
  '          type: string',
  '          required: true',
  '    plan_ready: {}',
  '  jobs:',
  '    build:',
  '      name: Build',
  '      steps:',
  '        - id: greet',
  '          name: Greet',
  '          run: echo "$GREETING"',
  '          env:',
  '            GREETING: ${{ inputs.greeting }}',
  '    report:',
  '      name: Report',
  '      needs: [build]',
  '      steps:',
  '        - id: done',
  '          name: Done',
  '          run: echo done',
  '',
].join('\n');

export const GOLDEN_PROJECT_PIPELINE_YAML = [
  'pipeline:',
  '  name: Golden project pipeline',
  '  description: Project golden fixture',
  '  on: dispatch',
  '  scope: [worktree]',
  '  jobs:',
  '    check:',
  '      name: Check',
  '      steps:',
  '        - id: lint',
  '          name: Lint',
  '          run: echo lint',
  '',
].join('\n');

/** A bundled composite action, the only `uses:` target the goldens name. */
export const GOLDEN_BUNDLED_ACTION_ID = 'golden-echo';

const GOLDEN_BUNDLED_ACTION_YAML = [
  'name: Golden echo',
  'description: Echo a message and record it as an output.',
  'inputs:',
  '  message:',
  '    description: Message to echo.',
  '    default: hello',
  'runs:',
  '  using: composite',
  '  steps:',
  '    - id: echo',
  '      run: |',
  '        echo "$INPUT_MESSAGE"',
  '        echo "echoed=$INPUT_MESSAGE" >> "$CANOPY_OUTPUT"',
  '',
].join('\n');

/** Agent-authored definitions may not run shell; this one only uses actions. */
export const GOLDEN_AGENT_INVALID_PIPELINE_YAML = [
  'pipeline:',
  '  name: Golden agent invalid',
  '  on: dispatch',
  '  jobs:',
  '    a:',
  '      needs: [missing]',
  '      steps:',
  `        - uses: ${GOLDEN_BUNDLED_ACTION_ID}`,
  '',
].join('\n');

/** A YAML document that does not parse. */
export const GOLDEN_UNPARSEABLE_YAML = 'pipeline:\n  name: [unclosed\n';

/** Parses, but fails normalization: a job needs one that does not exist. */
export const GOLDEN_INVALID_PIPELINE_YAML = [
  'pipeline:',
  '  name: Golden invalid',
  '  on: dispatch',
  '  jobs:',
  '    a:',
  '      needs: [missing]',
  '      steps:',
  '        - run: echo a',
  '',
].join('\n');

/** Parses and normalizes, but declares no jobs. */
export const GOLDEN_NO_JOBS_YAML = [
  'pipeline:',
  '  name: Golden empty',
  '  on: dispatch',
  '  jobs: {}',
  '',
].join('\n');

/**
 * Write a bundled resources root holding only the golden bundled pipeline
 * and action.
 * Real bundled pipelines change with the product catalog; the goldens pin
 * how each caller serves a bundled source, not the catalog's contents.
 */
export function writeGoldenBundledResources(root: string): string {
  const pipelinesDir = join(root, 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });
  const actionDir = join(root, 'actions', GOLDEN_BUNDLED_ACTION_ID);
  mkdirSync(actionDir, { recursive: true });
  writeFileSync(join(actionDir, 'action.yml'), GOLDEN_BUNDLED_ACTION_YAML);
  writeFileSync(
    join(pipelinesDir, 'golden-review.yaml'),
    GOLDEN_BUNDLED_PIPELINE_YAML,
  );
  writeFileSync(
    join(pipelinesDir, 'index.json'),
    `${JSON.stringify(
      {
        pipelines: [
          {
            id: GOLDEN_BUNDLED_PIPELINE_ID,
            name: 'Golden bundled review',
            filename: 'golden-review.yaml',
            description: 'Bundled golden fixture',
            icon: '🔎',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-02T00:00:00.000Z',
            triggerTypes: ['dispatch'],
            scopes: ['directory', 'worktree'],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

export interface GoldenReplacement {
  /** Literal text to replace, such as a temporary root. */
  value: string;
  token: string;
}

const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const UTC_TIMESTAMP = /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\b/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Make text host-neutral: temporary roots become tokens, path separators
 * become `/`, CRLF becomes LF, and timestamps and UUIDs become placeholders.
 * Longer replacements run first so a nested root keeps its own token.
 */
export function normalizeGoldenText(
  text: string,
  replacements: readonly GoldenReplacement[],
): string {
  let result = text.replace(/\r\n/g, '\n');
  const ordered = [...replacements]
    .filter((entry) => entry.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
  for (const { value, token } of ordered) {
    result = result.split(value).join(token);
    const posix = value.split('\\').join('/');
    if (posix !== value) result = result.split(posix).join(token);
  }
  return result
    .replace(/<([a-z-]+)>\\/g, '<$1>/')
    .replace(ISO_TIMESTAMP, '<timestamp>')
    .replace(UTC_TIMESTAMP, '<timestamp>')
    .replace(UUID, '<uuid>');
}

/** {@link normalizeGoldenText} applied to every string in a JSON value. */
export function normalizeGoldenValue(
  value: unknown,
  replacements: readonly GoldenReplacement[],
): unknown {
  const normalized: unknown = JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'string'
        ? normalizeGoldenText(entry, replacements)
        : entry,
    ),
  );
  return normalized;
}
