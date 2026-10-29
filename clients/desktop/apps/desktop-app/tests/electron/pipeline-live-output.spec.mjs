import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closePipelineRunPanels,
  configureGlobalPipelineSecret,
  expectPipelineRunPanel,
  reopenCompletedStep,
  showPipelineJobList,
} from './pipelineUi.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

// Live pipeline output is intentionally exercised with real child processes,
// persisted log sidecars, main-to-renderer output events, and the production
// Pipeline Runs UI. Each fixture stops at a filesystem barrier so assertions
// can distinguish the partial live stream from the completed persisted log.
//
// This suite protects all user-visible seams affected by pipeline process
// isolation:
//   - the Pipeline Runs card and DAG progress dot update while a job is active;
//   - the open run panel receives new output without being reopened;
//   - raw output has an exact, duplicate-free marker set both live and after
//     the running -> terminal transition, then still does after reopening;
//   - agent-shaped JSONL can switch between Rich and Raw while running and
//     after completion without losing the tail of the persisted transcript;
//   - an active run can be cancelled from its panel and retried in place.

const WORKTREE_BRANCH = 'demo-main';
const FIXTURE_DIR = path.join('.canopy', 'e2e-pipeline-live-output');
const ACTION_DIR = path.join('.canopy', 'actions', 'e2e-agent-stream');
const PLAIN_PIPELINE_NAME = 'E2E Live Plain Output';
const CANCEL_PIPELINE_NAME = 'E2E Cancel And Retry';
const AGENT_PIPELINE_NAME = 'E2E Live Agent Output';

// Dedicated one-shot fixture (no filesystem release-barrier phases) for the
// pipeline-secret masking test. It deliberately does not share the
// two-phase AGENT_PIPELINE_NAME fixture: configuring a real pipeline secret
// makes the redaction layer hold back a non-zero window of trailing
// characters per configured value while it confirms no match spans a chunk
// boundary (see `SecretValueRedactor`'s class doc comment), which shifts the
// live output's exact interleaving of writes and reads closely enough to
// occasionally race the existing multi-phase suite's exact-marker-count
// live-stream assertions. Running to completion in one shot with no
// mid-run exact-count assertions sidesteps that unrelated timing
// sensitivity entirely while still exercising the real end-to-end path.
const SECRET_PROBE_ACTION_DIR = path.join(
  '.canopy',
  'actions',
  'e2e-agent-secret-probe',
);
const SECRET_PROBE_PIPELINE_NAME = 'E2E Secret Probe';

// A record past the 8 MiB retention threshold whose line starts with
// whitespace. The retained head of a spilled record is a fixed-size probe, and
// 14 or more leading spaces filled it with nothing but whitespace: the record
// was then routed to the raw matcher, which spliced the configured `nABCDE`
// through the `\n` escape of an ordinary value.
const WHITESPACE_RECORD_ACTION_DIR = path.join(
  '.canopy',
  'actions',
  'e2e-whitespace-record',
);
const WHITESPACE_RECORD_PIPELINE_NAME = 'E2E Whitespace Record';
const WHITESPACE_RECORD_LINE =
  ' '.repeat(40) +
  JSON.stringify({
    wscanary: 'E2E_WHITESPACE_HEAD_CANARY',
    escaped: '\nABCDE',
    filler: 'w'.repeat(9 * 1024 * 1024),
  }) +
  '\n';

// Configured through the real Environments UI so the redaction path under
// test is the one production pipeline runs actually use (resolved via the
// seeded "Pipeline" default environment, `resolveEnvironmentForRuntime`'s
// global runtime default), not a fixture-only shortcut. The embedded quote
// characters are deliberate: `JSON.stringify` escapes them to `\"` in the
// action's agent-shaped stdout line, so a redactor that only matches the raw
// (unescaped) configured value against that already-serialized text can
// never find this secret — the same class of gap closed for transcript/
// summary redaction elsewhere in this pipeline.
const SECRET_ENV_KEY = 'E2E_PIPELINE_SECRET_PROBE';
const SECRET_VALUE = 'e2e-secret-"quoted"-payload-97531';
// `JSON.stringify` only escapes the quote character itself, so these
// plain alphanumeric/hyphen segments flanking it appear byte-identical
// whether the secret is embedded raw or JSON-escaped. Asserting on
// `SECRET_VALUE` directly (with its literal, unescaped quote) would pass
// vacuously against escaped JSON text regardless of whether redaction ever
// ran, since that exact substring never appears there either way.
const SECRET_LEAK_MARKERS = ['e2e-secret-', 'payload-97531'];

// Two more configured values, chosen because they collide with the
// SERIALIZED form of ordinary agent records rather than with anything in the
// data. `COLLIDING_ESCAPE_SECRET` matches the `n` of a `\n` escape plus the
// text after it; `COLLIDING_DELIMITER_SECRET` matches the punctuation
// between two adjacent fields. A byte-level matcher masks both and destroys
// records that never contained a secret — the exact corruption the
// controller reproduced against the durable writer. Neither appears in any
// decoded value, so correct masking leaves the canary record untouched.
const COLLIDING_ESCAPE_KEY = 'E2E_PIPELINE_SECRET_ESCAPE';
const COLLIDING_ESCAPE_SECRET = 'nABCDE';
const COLLIDING_DELIMITER_KEY = 'E2E_PIPELINE_SECRET_DELIMITER';
const COLLIDING_DELIMITER_SECRET = '","subtype":';
// A configured value that the agent emits as an object KEY, in a record that
// ALSO already contains a literal `***` key. Masking the first without
// accounting for the second produced two identical keys, and re-reading the
// persisted transcript then dropped a field — silent data loss in the durable
// artifact, found by both independent reviewers.
const KEY_SECRET_ENV = 'E2E_PIPELINE_SECRET_KEY_NAME';
const KEY_SECRET = 'E2E_KEYSECRET_VALUE';

/** The canary record the probe action emits, exactly as authored. */
const CANARY_RECORD = {
  type: 'result',
  subtype: 'success',
  result: '\nABCDE',
  canary: 'E2E_SECRET_PROBE_CANARY',
};

/**
 * A record emitted after a bare `' '` write, in a LATER chunk. A leading
 * whitespace-only chunk is not evidence the line is not a document, but it was
 * read that way, which committed the rest of the line to the byte matcher and
 * corrupted a record identical to one that survives when unsplit.
 */
const WHITESPACE_CANARY_RECORD = {
  type: 'result',
  subtype: 'success',
  result: '\nABCDE',
  canary: 'E2E_SECRET_WHITESPACE_CANARY',
};

/**
 * A single valid record delivered as deterministically PACED chunks, with its
 * closing syntax in its own final write, through the real subprocess pipe.
 *
 * Chunk framing must not change the answer: this record has to arrive
 * byte-identical to the same record delivered whole. Pacing is driven by the
 * pipe's own `drain` rather than a timer, so the writer actually waits for
 * backpressure instead of the writes coalescing into one `data` event — which
 * is what made earlier attempts at a realistic reproduction test nothing.
 */
const PACED_CANARY_VALUE = 'p'.repeat(240_000);
const PACED_CANARY_RECORD = {
  type: 'result',
  subtype: 'paced',
  canary: 'E2E_SECRET_PACED_CANARY',
  value: PACED_CANARY_VALUE,
};

const waitForActivityPanel = async (window) => {
  await expect(
    window.getByTestId('panel-content-activity-section'),
  ).toBeVisible();
};

// Mirrors the real user flow in environments.spec.mjs: open Environments from
// the sidebar "More" popover, select the seeded "Pipeline" default
// environment (id `default-pipeline`, the seeded global default for the
// `pipeline` runtime — see `DEFAULT_ENVIRONMENT_IDS`/`DEFAULT_GLOBAL_RUNTIMES`
// in `packages/desktop-shared/src/lib/user-environment.ts`), add one
// key/value row, mark it secret, and save. Every dispatched pipeline in this
// fresh app instance resolves its `secretEnv` from this environment, so this
// is the same path a real user configuring a pipeline secret would take.

function writeFixtureFile(worktreePath, relativePath, contents) {
  const filePath = path.join(worktreePath, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function seedLiveOutputFixtures({ userDataDir, worktreePath }) {
  const waitHelper = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const wait = (milliseconds) =>',
    '  new Promise((resolve) => setTimeout(resolve, milliseconds));',
    `const fixtureDir = path.join(process.cwd(), ${JSON.stringify(FIXTURE_DIR)});`,
  ].join('\n');

  writeFixtureFile(
    worktreePath,
    path.join(FIXTURE_DIR, 'plain-stream.cjs'),
    [
      waitHelper,
      "const releaseFile = path.join(fixtureDir, 'plain.release');",
      '(async () => {',
      '  for (let index = 0; index < 16; index += 1) {',
      "    console.log(`E2E_PLAIN_LINE_${String(index).padStart(3, '0')}`);",
      '    await wait(35);',
      '  }',
      "  console.log('E2E_PLAIN_PHASE_ONE_READY');",
      '  while (!fs.existsSync(releaseFile)) {',
      '    await wait(25);',
      '  }',
      '  for (let index = 16; index < 32; index += 1) {',
      "    console.log(`E2E_PLAIN_LINE_${String(index).padStart(3, '0')}`);",
      '    await wait(35);',
      '  }',
      "  console.log('E2E_PLAIN_COMPLETE');",
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
  );

  writeFixtureFile(
    worktreePath,
    path.join(FIXTURE_DIR, 'cancel-retry.cjs'),
    [
      waitHelper,
      "const retryFile = path.join(fixtureDir, 'retry-success');",
      '(async () => {',
      '  if (!fs.existsSync(retryFile)) {',
      '    let index = 0;',
      '    while (true) {',
      "      console.log(`E2E_CANCEL_LIVE_${String(index).padStart(3, '0')}`);",
      '      index += 1;',
      '      await wait(50);',
      '    }',
      '  }',
      '  for (let index = 0; index < 16; index += 1) {',
      "    console.log(`E2E_RETRY_LINE_${String(index).padStart(3, '0')}`);",
      '    await wait(35);',
      '  }',
      "  console.log('E2E_RETRY_COMPLETE');",
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
  );

  writeFixtureFile(
    worktreePath,
    path.join(ACTION_DIR, 'action.yml'),
    [
      'name: E2E Agent Stream',
      'description: Deterministic agent-shaped JSONL for pipeline UI automation.',
      'log_format_hint: agent',
      'inputs: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.cjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join(ACTION_DIR, 'index.cjs'),
    [
      waitHelper,
      "const releaseFile = path.join(fixtureDir, 'agent.release');",
      'const emitMessage = (index) => {',
      "  const marker = `E2E_AGENT_MESSAGE_${String(index).padStart(3, '0')}`;",
      '  console.log(',
      '    JSON.stringify({',
      "      type: 'assistant',",
      '      message: {',
      "        content: [{ type: 'text', text: marker }],",
      '      },',
      '    }),',
      '  );',
      '};',
      '(async () => {',
      '  for (let index = 0; index < 8; index += 1) {',
      '    emitMessage(index);',
      '    await wait(45);',
      '  }',
      "  console.log(JSON.stringify({ type: 'system', subtype: 'phase_one_ready' }));",
      '  while (!fs.existsSync(releaseFile)) {',
      '    await wait(25);',
      '  }',
      '  for (let index = 8; index < 16; index += 1) {',
      '    emitMessage(index);',
      '    await wait(45);',
      '  }',
      '  console.log(',
      '    JSON.stringify({',
      "      type: 'result',",
      '      is_error: false,',
      "      result: 'E2E_AGENT_COMPLETE',",
      '      usage: {',
      '        input_tokens: 16,',
      '        output_tokens: 16,',
      '        cache_read_input_tokens: 0,',
      '        cache_creation_input_tokens: 0,',
      '      },',
      '    }),',
      '  );',
      '})().catch((error) => {',
      '  console.error(error);',
      '  process.exitCode = 1;',
      '});',
      '',
    ].join('\n'),
  );

  seedStoredPipeline({
    userDataDir,
    id: 'e2e-live-plain-output',
    name: PLAIN_PIPELINE_NAME,
    yaml: [
      `name: ${PLAIN_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  stream:',
      '    name: Plain Stream',
      '    steps:',
      '      - id: emit',
      '        name: Emit plain output',
      `        run: node ${FIXTURE_DIR}/plain-stream.cjs`,
      '',
    ].join('\n'),
  });
  seedStoredPipeline({
    userDataDir,
    id: 'e2e-cancel-retry',
    name: CANCEL_PIPELINE_NAME,
    yaml: [
      `name: ${CANCEL_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  controllable:',
      '    name: Controllable',
      '    steps:',
      '      - id: work',
      '        name: Controllable work',
      `        run: node ${FIXTURE_DIR}/cancel-retry.cjs`,
      '',
    ].join('\n'),
  });
  // Agent actions require a repository-backed pipeline so dispatch supplies
  // repoPath and the project action resolver stays inside `.canopy/actions`.
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'pipelines', 'e2e-live-agent-output.yml'),
    [
      `name: ${AGENT_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  review:',
      '    name: Agent Review',
      '    steps:',
      '      - id: agent',
      '        name: Stream agent transcript',
      '        uses: project/e2e-agent-stream',
      '',
    ].join('\n'),
  );

  writeFixtureFile(
    worktreePath,
    path.join(SECRET_PROBE_ACTION_DIR, 'action.yml'),
    [
      'name: E2E Agent Secret Probe',
      'description: One-shot agent-shaped JSONL that echoes a configured pipeline secret verbatim.',
      'log_format_hint: agent',
      'inputs: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.cjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join(SECRET_PROBE_ACTION_DIR, 'index.cjs'),
    [
      "const secret = process.env.E2E_PIPELINE_SECRET_PROBE ?? '';",
      'console.log(',
      '  JSON.stringify({',
      "    type: 'assistant',",
      '    message: {',
      '      content: [',
      '        {',
      "          type: 'text',",
      '          text: `E2E_SECRET_PROBE_BEGIN ${secret} E2E_SECRET_PROBE_END`,',
      '        },',
      '      ],',
      '    },',
      '  }),',
      ');',
      // The corruption canary: this record contains NO configured secret,
      // but its SERIALIZED form contains both collision shapes — the
      // literal `","subtype":` between two ordinary fields, and the `\n`
      // escape immediately followed by `ABCDE`, which a raw byte matcher
      // configured with `nABCDE` splices straight through. It must survive
      // byte-for-byte.
      'console.log(',
      '  JSON.stringify({',
      "    type: 'result',",
      "    subtype: 'success',",
      "    result: '\\nABCDE',",
      "    canary: 'E2E_SECRET_PROBE_CANARY',",
      '  }),',
      ');',
      'console.log(',
      '  JSON.stringify({',
      "    type: 'result',",
      "    subtype: 'keys',",
      "    '***': 'already-a-mask',",
      "    E2E_KEYSECRET_VALUE: 'masked-key-value',",
      "    keycanary: 'E2E_SECRET_KEY_CANARY',",
      '  }),',
      ');',
      // A 1.1 MB record, held whole (under the 8 MiB spill threshold), whose
      // DISTINCT keys are a configured secret, filler, and a literal `***`.
      // Masking the first must not make the record ambiguous: all three
      // fields have to survive re-reading the file.
      'console.log(',
      '  JSON.stringify({',
      "    rowcanary: 'E2E_SECRET_KEYORDER_CANARY',",
      "    E2E_KEYSECRET_VALUE: 'sensitive-key-value',",
      "    filler: 'q'.repeat(1_100_000),",
      "    '***': 'ordinary-key-value',",
      '  }),',
      ');',
      // About 1.3 MB of rows, also held whole. It contains no secret at all:
      // every row is ordinary data. Both independent reviewers and the
      // controller found rows losing fields here: the scope stack leaked one
      // entry per object whose last member is a string value, and ordinary keys
      // were eventually renamed. Every row must come back intact.
      'const bigRows = [];',
      'for (let index = 0; index < 6000; index += 1) {',
      "  bigRows.push({ id: index, name: 'row-' + index, note: 'z'.repeat(180) });",
      '}',
      'console.log(',
      '  JSON.stringify({',
      "    type: 'result',",
      "    subtype: 'rows',",
      "    rowcanary: 'E2E_SECRET_ROWS_CANARY',",
      '    results: bigRows,',
      '  }),',
      ');',
      // Emitted in LATER chunks, on purpose. The framing is the thing under
      // test: a bare whitespace write before an ordinary record, and a
      // configured multi-line value whose continuation is a JSON-shaped line.
      // The timers are what make them separate `data` events rather than one
      // coalesced write.
      'setTimeout(() => {',
      "  process.stdout.write(' ');",
      '  setTimeout(() => {',
      '    process.stdout.write(',
      '      JSON.stringify({',
      "        type: 'result',",
      "        subtype: 'success',",
      "        result: '\\nABCDE',",
      "        canary: 'E2E_SECRET_WHITESPACE_CANARY',",
      "      }) + '\\n',",
      '    );',
      // One valid record, delivered as PACED 4,096-character writes with its
      // closing syntax in its own final write. The writer waits on the pipe's
      // own `drain`, so this exercises backpressure through the real
      // subprocess seam rather than coalescing into a single `data` event.
      '    const pacedRecord = JSON.stringify({',
      "      type: 'result',",
      "      subtype: 'paced',",
      "      canary: 'E2E_SECRET_PACED_CANARY',",
      "      value: 'p'.repeat(240000),",
      '    });',
      '    let pacedIndex = 0;',
      '    const writePaced = () => {',
      '      while (pacedIndex < pacedRecord.length) {',
      '        const next = pacedRecord.slice(pacedIndex, pacedIndex + 4096);',
      '        pacedIndex += 4096;',
      '        if (!process.stdout.write(next)) {',
      "          process.stdout.once('drain', writePaced);",
      '          return;',
      '        }',
      '      }',
      "      process.stdout.write('\\n');",
      '      console.log(',
      '        JSON.stringify({',
      "          type: 'result',",
      '          is_error: false,',
      "          result: 'E2E_SECRET_PROBE_COMPLETE',",
      '          usage: {',
      '            input_tokens: 4,',
      '            output_tokens: 4,',
      '            cache_read_input_tokens: 0,',
      '            cache_creation_input_tokens: 0,',
      '          },',
      '        }),',
      '      );',
      '      writeHuge();',
      '    };',
      // The last thing this action writes, and it carries three properties at
      // once that only the stored path has: it is past the 8 MiB retention
      // threshold, it contains an astral character next to the configured
      // value, and it has NO trailing newline. Written as BYTE slices, so the
      // host's own decoder has to reassemble the character — a string slice
      // can never split a surrogate pair and so can never reach the boundary.
      '    const hugeRecord = Buffer.from(',
      '      JSON.stringify({',
      "        hugecanary: 'E2E_SECRET_HUGE_CANARY',",
      "        E2E_KEYSECRET_VALUE: 'huge-masked-key-value',",
      "        filler: 'h'.repeat(9 * 1024 * 1024),",
      "        astral: '\\u{1F600}' + 'E2E_SECRET_ASTRAL_EDGE' + '\\u{1F600}',",
      "        '***': 'huge-ordinary-value',",
      '      }),',
      "      'utf8',",
      '    );',
      '    let hugeIndex = 0;',
      '    const writeHuge = () => {',
      '      while (hugeIndex < hugeRecord.length) {',
      '        const next = hugeRecord.subarray(hugeIndex, hugeIndex + 4096);',
      '        hugeIndex += 4096;',
      '        if (!process.stdout.write(next)) {',
      "          process.stdout.once('drain', writeHuge);",
      '          return;',
      '        }',
      '      }',
      '    };',
      '    writePaced();',
      '  }, 60);',
      '}, 60);',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'pipelines', 'e2e-secret-probe.yml'),
    [
      `name: ${SECRET_PROBE_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  probe:',
      '    name: Secret Probe',
      '    steps:',
      '      - id: agent',
      '        name: Echo configured secret',
      '        uses: project/e2e-agent-secret-probe',
      // Explicit and identical on every revision this spec is run against.
      // A budget difference between revisions would make a RED/GREEN pair
      // prove nothing, and a test-runner timeout would not exercise the
      // step deadline at all.
      '        timeout_minutes: 4',
      '',
    ].join('\n'),
  );
}

function seedWhitespaceRecordFixture(worktreePath) {
  writeFixtureFile(
    worktreePath,
    path.join(WHITESPACE_RECORD_ACTION_DIR, 'action.yml'),
    [
      'name: E2E Whitespace Record',
      'description: One record past the retention threshold, with a whitespace head.',
      'inputs: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.cjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join(WHITESPACE_RECORD_ACTION_DIR, 'index.cjs'),
    [
      // Written as paced 4,096-byte slices that wait on the pipe's own
      // `drain`, so the record reaches the host as many chunks and spills.
      // Built here exactly as WHITESPACE_RECORD_LINE is built above.
      'const record = Buffer.from(',
      "  ' '.repeat(40) +",
      '    JSON.stringify({',
      "      wscanary: 'E2E_WHITESPACE_HEAD_CANARY',",
      "      escaped: '\\nABCDE',",
      "      filler: 'w'.repeat(9 * 1024 * 1024),",
      '    }) +',
      "    '\\n',",
      "  'utf8',",
      ');',
      'let index = 0;',
      'const write = () => {',
      '  while (index < record.length) {',
      '    const next = record.subarray(index, index + 4096);',
      '    index += 4096;',
      '    if (!process.stdout.write(next)) {',
      "      process.stdout.once('drain', write);",
      '      return;',
      '    }',
      '  }',
      '};',
      'write();',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'pipelines', 'e2e-whitespace-record.yml'),
    [
      `name: ${WHITESPACE_RECORD_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  record:',
      '    name: Whitespace Record',
      '    steps:',
      '      - id: emit',
      '        name: Emit a whitespace-headed record',
      '        uses: project/e2e-whitespace-record',
      // Pinned and identical on every revision this spec is run against, so
      // a RED/GREEN pair differs only in the code under test.
      '        timeout_minutes: 4',
      '',
    ].join('\n'),
  );
}

// A configured value with a quote and a backslash, printed JSON-escaped by
// the action: once (an echo of a JSON list) and again nested inside another
// JSON string. After the record is decoded neither is the value itself.
const ESCAPED_PIPELINE_NAME = 'E2E Escaped Secret Record';
const ESCAPED_SECRET_KEY = 'E2E_ESCAPED_SECRET';
const ESCAPED_SECRET = 'SYNTH"ESC\\CANARY-EE-4412';
const ESCAPED_CANARY = 'E2E_ESCAPED_CANARY';

function seedEscapedRecordFixture(worktreePath) {
  const actionDir = path.join('.canopy', 'actions', 'e2e-escaped-record');
  writeFixtureFile(
    worktreePath,
    path.join(actionDir, 'action.yml'),
    [
      'name: E2E Escaped Secret Record',
      'description: One record holding a configured value escaped once and twice.',
      'inputs: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.cjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join(actionDir, 'index.cjs'),
    [
      `const value = process.env[${JSON.stringify(ESCAPED_SECRET_KEY)}] ?? '';`,
      'const list = JSON.stringify([value]);',
      'console.log(',
      '  JSON.stringify({',
      `    ecanary: ${JSON.stringify(ESCAPED_CANARY)},`,
      "    note: 'once=' + list + ' twice=' + JSON.stringify(list),",
      '  }),',
      ');',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'pipelines', 'e2e-escaped-record.yml'),
    [
      `name: ${ESCAPED_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  record:',
      '    name: Escaped Record',
      '    steps:',
      '      - id: emit',
      '        name: Emit an escaped configured value',
      '        uses: project/e2e-escaped-record',
      '        timeout_minutes: 4',
      '',
    ].join('\n'),
  );
}

// A valid JSON record past the default 8 MiB storage threshold whose string
// value and property name are a configured database URL, while the URL's
// password is configured too. Whole-record masking masks the URL as one span;
// the stored path must give the same bytes.
const CONTAINED_PIPELINE_NAME = 'E2E Contained Secret Record';
const CONTAINED_URL = 'postgres://admin:S3cretPass@db.internal:5432/app';
const CONTAINED_PASSWORD = 'S3cretPass';
const CONTAINED_CANARY = 'E2E_CONTAINED_CANARY';
const CONTAINED_FILLER = 9 * 1024 * 1024;

function seedContainedRecordFixture(worktreePath) {
  const actionDir = path.join('.canopy', 'actions', 'e2e-contained-record');
  writeFixtureFile(
    worktreePath,
    path.join(actionDir, 'action.yml'),
    [
      'name: E2E Contained Secret Record',
      'description: One stored record holding a URL whose password is also configured.',
      'inputs: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.cjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join(actionDir, 'index.cjs'),
    [
      // Paced 4,096-byte writes, so the record arrives as many chunks.
      `const url = ${JSON.stringify(CONTAINED_URL)};`,
      'const record = Buffer.from(',
      '  JSON.stringify({',
      `    ccanary: ${JSON.stringify(CONTAINED_CANARY)},`,
      "    note: 'DB is ' + url + ' ok',",
      '    [url]: 17,',
      `    filler: 'c'.repeat(${CONTAINED_FILLER}),`,
      "  }) + '\\n',",
      "  'utf8',",
      ');',
      'let index = 0;',
      'const write = () => {',
      '  while (index < record.length) {',
      '    const next = record.subarray(index, index + 4096);',
      '    index += 4096;',
      '    if (!process.stdout.write(next)) {',
      "      process.stdout.once('drain', write);",
      '      return;',
      '    }',
      '  }',
      '};',
      'write();',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'pipelines', 'e2e-contained-record.yml'),
    [
      `name: ${CONTAINED_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  record:',
      '    name: Contained Record',
      '    steps:',
      '      - id: emit',
      '        name: Emit a stored record with contained values',
      '        uses: project/e2e-contained-record',
      '        timeout_minutes: 4',
      '',
    ].join('\n'),
  );
}

// A step stopped while a spilled record is being replayed. The record is
// malformed JSON (so it is retained and spilled at the default 8 MiB
// threshold, then masked by the raw matcher) and places the configured value
// so its first eight characters end the replay's first 64 KiB chunk. The E2E
// build's replay gate (`CANOPY_E2E_REPLAY_GATE_DIR`) pauses the replay right
// there, with that prefix held back, while the child writes more output and
// the user cancels.
const REPLAY_PIPELINE_NAME = 'E2E Replay Cancel';
const REPLAY_SECRET_KEY = 'E2E_REPLAY_SECRET';
const REPLAY_SECRET = 'SECRET-TOKEN-123456';
const REPLAY_CANARY = 'E2E_REPLAY_CANARY';
const REPLAY_TAIL = 9 * 1024 * 1024;
const replayHead = () =>
  `{${REPLAY_CANARY}${'a'.repeat(65_536 - 1 - REPLAY_CANARY.length - 8)}`;
const replayLateLines = () =>
  Array.from({ length: 20 }, (_, n) => `late output line ${n}\n`).join('');

function seedReplayCancelFixture(worktreePath) {
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'actions', 'e2e-replay-record', 'action.yml'),
    [
      'name: E2E Replay Record',
      'description: One spilled raw-routed record, then late output on request.',
      'inputs: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.cjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'actions', 'e2e-replay-record', 'index.cjs'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const control = path.join(process.cwd(), ${JSON.stringify(path.join('.canopy', 'e2e-replay'))});`,
      `const secret = process.env.${REPLAY_SECRET_KEY} ?? '';`,
      `const head = '{' + ${JSON.stringify(REPLAY_CANARY)} + 'a'.repeat(${65_536 - 1 - REPLAY_CANARY.length - 8});`,
      `const record = head + secret + 'b'.repeat(${REPLAY_TAIL}) + '\\n';`,
      'let index = 0;',
      'const send = () => {',
      '  while (index < record.length) {',
      '    const next = record.slice(index, index + 4096);',
      '    index += 4096;',
      "    if (!process.stdout.write(next)) return process.stdout.once('drain', send);",
      '  }',
      '};',
      'send();',
      // Late output only once the test asks for it, then an exit only once
      // the test asks for that too.
      'const late = setInterval(() => {',
      "  if (!fs.existsSync(path.join(control, 'go'))) return;",
      '  clearInterval(late);',
      "  for (let n = 0; n < 20; n += 1) process.stdout.write('late output line ' + n + '\\n');",
      "  fs.writeFileSync(path.join(control, 'late-written'), 'yes');",
      '  const finish = setInterval(() => {',
      "    if (fs.existsSync(path.join(control, 'finish'))) process.exit(0);",
      '  }, 10);',
      '}, 10);',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    worktreePath,
    path.join('.canopy', 'pipelines', 'e2e-replay-cancel.yml'),
    [
      `name: ${REPLAY_PIPELINE_NAME}`,
      'on: dispatch',
      'jobs:',
      '  replay:',
      '    name: Replay',
      '    steps:',
      '      - id: record',
      '        name: Emit a spilled record',
      '        uses: project/e2e-replay-record',
      '        timeout_minutes: 4',
      '',
    ].join('\n'),
  );
}

async function waitForPath(file, timeout = 120_000) {
  await expect
    .poll(() => existsSync(file), { timeout, intervals: [25] })
    .toBe(true);
}

async function launchFixtureApp(prefix, env = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedLiveOutputFixtures({ userDataDir, worktreePath });
  seedWhitespaceRecordFixture(worktreePath);
  seedReplayCancelFixture(worktreePath);
  seedContainedRecordFixture(worktreePath);
  seedEscapedRecordFixture(worktreePath);

  const { electronApp } = await launchCanopy({ userDataDir, env });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await waitForActivityPanel(window);
  return { electronApp, userDataDir, window, worktreePath };
}

async function dispatchPipeline(window, pipelineName) {
  await new CanopyAppDriver(window).openPipelineDispatchModal(pipelineName);
  const runButton = window.getByTestId('pipeline-trigger-modal-run');
  await expect(runButton).toBeEnabled();
  await runButton.click();

  const runCard = window
    .locator('[data-testid^="pipeline-run-card-"]')
    .filter({ hasText: pipelineName })
    .first();
  await expect(runCard).toBeVisible({ timeout: 30_000 });
  const testId = await runCard.getAttribute('data-testid');
  expect(testId).toMatch(/^pipeline-run-card-.+/);
  return {
    executionId: testId.slice('pipeline-run-card-'.length),
    runCard,
  };
}

async function openRunningJob(window, runCard, jobId, jobName) {
  await expect(runCard).toContainText('running', { timeout: 30_000 });
  const jobDot = runCard.locator(`[data-job-id="${jobId}"]`);
  await expect(jobDot).toHaveAttribute('aria-label', `${jobName}: running`, {
    timeout: 30_000,
  });
  await jobDot.click();
  // The job link opens the run's panel at that job.
  await expectPipelineRunPanel(
    window,
    (await runCard.getAttribute('data-testid')).replace(
      'pipeline-run-card-',
      '',
    ),
  );
  await showPipelineJobList(window, { timeout: 15_000 });
  await expect(window.getByTestId(`pipeline-job-view-${jobId}`)).toBeVisible();
  return jobDot;
}

async function closeDetails(window) {
  await closePipelineRunPanels(window);
}

function expectedMarkers(prefix, count) {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(3, '0')}`,
  );
}

async function expectExactMarkers(locator, prefix, count) {
  const expected = expectedMarkers(prefix, count);
  await expect
    .poll(
      async () => {
        const text = (await locator.textContent()) ?? '';
        return text.match(new RegExp(`${prefix}\\d{3}`, 'g')) ?? [];
      },
      {
        message: `expected exactly ${String(count)} ordered ${prefix} markers`,
        timeout: 30_000,
      },
    )
    .toEqual(expected);
}

/**
 * The persisted step log `readPersistedStepLog` reads, as BYTES.
 *
 * Reading it as a string reconstructs whatever the encoder produced, so a
 * surrogate pair encoded as two separate halves comes back as two replacement
 * characters — the corruption is only visible in the bytes.
 */
function readPersistedStepLogBytes(userDataDir, executionId, marker) {
  const matches = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!directory.endsWith(path.join(executionId, 'logs'))) continue;
      const contents = readFileSync(entryPath);
      if (contents.includes(marker)) matches.push(contents);
    }
  };
  walk(userDataDir);
  expect(
    matches.length,
    `expected one persisted step log under ${executionId} containing ${marker}`,
  ).toBeGreaterThan(0);
  return Buffer.concat(matches);
}

/**
 * Reads the step's DURABLE log file off disk, rather than inferring its
 * contents from the rendered DOM. The parent process is the writer of this
 * file for generic builtin steps, so it is the artifact a corrupted redaction
 * actually damages; a DOM-only assertion can pass while the persisted record
 * on disk is unparseable. Locates it by walking the execution's `logs`
 * directory under the app's data dir (`<executionsDir>/<executionId>/logs`).
 */
function readPersistedStepLog(userDataDir, executionId, marker) {
  const matches = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!directory.endsWith(path.join(executionId, 'logs'))) continue;
      const contents = readFileSync(entryPath, 'utf8');
      if (contents.includes(marker)) matches.push(contents);
    }
  };
  walk(userDataDir);
  expect(
    matches.length,
    `expected one persisted step log under ${executionId} containing ${marker}`,
  ).toBeGreaterThan(0);
  return matches.join('');
}

// Asserts the configured secret never reaches the rendered surface (live or
// reopened) AND that the underlying persisted log stayed valid, parseable
// JSONL — a masking fix that corrupts the log's own structure would pass a
// pure "no secret substring" check while still failing this one.
//
// Raw mode (`AnsiOutput`, `@canopy/ui-shared`) renders each persisted line as
// its own sibling `<div data-testid="ansi-output"> > div` with no literal
// newline character joining them in the DOM, so `locator.textContent()`
// concatenates every line with zero separator — splitting that on `\n` would
// silently merge multiple JSON objects into one unparseable blob regardless
// of whether redaction corrupted anything. Reading each line's own element
// individually restores the real line boundaries the persisted file has.
async function assertSecretMaskedAndLogIntact(locator, leakMarkers) {
  const lines = await locator
    .locator('[data-testid="ansi-output"] > div')
    .allTextContents();
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    for (const marker of leakMarkers) {
      expect(line).not.toContain(marker);
    }
    expect(() => JSON.parse(line)).not.toThrow();
  }
}

test.describe('live pipeline output and controls', () => {
  test('streams complete raw output to progress and details during and after execution', async () => {
    test.setTimeout(180_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-live-plain-',
    );
    const { electronApp, userDataDir, window, worktreePath } = fixture;

    try {
      const { runCard } = await dispatchPipeline(window, PLAIN_PIPELINE_NAME);
      const jobDot = await openRunningJob(
        window,
        runCard,
        'stream',
        'Plain Stream',
      );
      const output = window.getByTestId('pipeline-step-log-output-emit');

      await expect(output).toContainText('E2E_PLAIN_PHASE_ONE_READY', {
        timeout: 30_000,
      });
      await expectExactMarkers(output, 'E2E_PLAIN_LINE_', 16);

      writeFixtureFile(
        worktreePath,
        path.join(FIXTURE_DIR, 'plain.release'),
        'release\n',
      );

      // The already-open panel receives the second phase live. The same
      // transition also forces a fresh persisted-log read at completion.
      await expect(output).toContainText('E2E_PLAIN_COMPLETE', {
        timeout: 30_000,
      });
      await expectExactMarkers(output, 'E2E_PLAIN_LINE_', 32);
      await expect(runCard).toContainText('success', { timeout: 30_000 });
      await expect(jobDot).toHaveAttribute(
        'aria-label',
        'Plain Stream: success',
      );
      await expectExactMarkers(output, 'E2E_PLAIN_LINE_', 32);

      await closeDetails(window);
      const reopened = await reopenCompletedStep(
        window,
        runCard,
        'stream',
        'emit',
      );
      await expectExactMarkers(
        reopened.getByTestId('pipeline-step-log-output-emit'),
        'E2E_PLAIN_LINE_',
        32,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('cancels a live run from details and retries it to success in place', async () => {
    test.setTimeout(180_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-cancel-retry-',
    );
    const { electronApp, userDataDir, window, worktreePath } = fixture;

    try {
      const { executionId, runCard } = await dispatchPipeline(
        window,
        CANCEL_PIPELINE_NAME,
      );
      await openRunningJob(window, runCard, 'controllable', 'Controllable');

      const liveOutput = window
        .getByTestId('pipeline-step-log-output-work')
        .last();
      await expect(liveOutput).toContainText('E2E_CANCEL_LIVE_005', {
        timeout: 30_000,
      });

      const cancelButton = window.getByTestId(
        `pipeline-detail-cancel-${executionId}`,
      );
      await expect(cancelButton).toBeEnabled();
      await cancelButton.click();
      await expect(runCard).toContainText('cancelled', { timeout: 30_000 });

      const retryButton = window.getByTestId(
        `pipeline-detail-retry-${executionId}`,
      );
      await expect(retryButton).toBeEnabled({ timeout: 15_000 });
      writeFixtureFile(
        worktreePath,
        path.join(FIXTURE_DIR, 'retry-success'),
        'retry\n',
      );
      await retryButton.click();

      // Retry reuses the execution id and keeps the panel open. Verify the
      // second process streams into that live surface before it terminates.
      await expect(runCard).toContainText('running', { timeout: 30_000 });
      const retryOutput = window
        .getByTestId('pipeline-step-log-output-work')
        .last();
      await expect(retryOutput).toContainText('E2E_RETRY_LINE_005', {
        timeout: 30_000,
      });
      await expect(retryOutput).toContainText('E2E_RETRY_COMPLETE', {
        timeout: 30_000,
      });
      await expectExactMarkers(retryOutput, 'E2E_RETRY_LINE_', 16);
      await expect(runCard).toContainText('success', { timeout: 30_000 });
      await expect(
        runCard.locator('[data-job-id="controllable"]'),
      ).toHaveAttribute('aria-label', 'Controllable: success');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps agent Rich and Raw output complete live, terminal, and reopened', async () => {
    test.setTimeout(180_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-live-agent-',
    );
    const { electronApp, userDataDir, window, worktreePath } = fixture;

    try {
      const { runCard } = await dispatchPipeline(window, AGENT_PIPELINE_NAME);
      const jobDot = await openRunningJob(
        window,
        runCard,
        'review',
        'Agent Review',
      );
      const rawButton = window.getByTestId('pipeline-step-log-mode-raw-agent');
      const richButton = window.getByTestId(
        'pipeline-step-log-mode-rich-agent',
      );
      const output = window.getByTestId('pipeline-step-log-output-agent');

      await expect(richButton).toHaveAttribute('aria-pressed', 'true', {
        timeout: 30_000,
      });
      await expect(output).toContainText('E2E_AGENT_MESSAGE_007', {
        timeout: 30_000,
      });

      await rawButton.click();
      await expect(rawButton).toHaveAttribute('aria-pressed', 'true');
      await expectExactMarkers(output, 'E2E_AGENT_MESSAGE_', 8);
      await richButton.click();
      await expect(richButton).toHaveAttribute('aria-pressed', 'true');

      writeFixtureFile(
        worktreePath,
        path.join(FIXTURE_DIR, 'agent.release'),
        'release\n',
      );

      // Stay in Rich mode through the terminal transition. This specifically
      // verifies the persisted rich sidecar is re-read instead of reverting
      // to the partial snapshot captured when the panel first opened.
      await expect(output).toContainText('E2E_AGENT_MESSAGE_015', {
        timeout: 30_000,
      });
      await expect(runCard).toContainText('success', { timeout: 30_000 });
      await expect(jobDot).toHaveAttribute(
        'aria-label',
        'Agent Review: success',
      );
      await expect(output).toContainText('E2E_AGENT_MESSAGE_000');
      await expect(output).toContainText('E2E_AGENT_MESSAGE_015');

      await rawButton.click();
      await expectExactMarkers(output, 'E2E_AGENT_MESSAGE_', 16);

      await closeDetails(window);
      await reopenCompletedStep(window, runCard, 'review', 'agent');
      const reopenedOutput = window.getByTestId(
        'pipeline-step-log-output-agent',
      );
      const reopenedRich = window.getByTestId(
        'pipeline-step-log-mode-rich-agent',
      );
      const reopenedRaw = window.getByTestId(
        'pipeline-step-log-mode-raw-agent',
      );

      await expect(reopenedRich).toHaveAttribute('aria-pressed', 'true', {
        timeout: 30_000,
      });
      await expect(reopenedOutput).toContainText('E2E_AGENT_MESSAGE_000');
      await expect(reopenedOutput).toContainText('E2E_AGENT_MESSAGE_015');
      await reopenedRaw.click();
      await expectExactMarkers(reopenedOutput, 'E2E_AGENT_MESSAGE_', 16);
    } finally {
      rmSync(path.join(worktreePath, FIXTURE_DIR, 'agent.release'), {
        force: true,
      });
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('masks a configured pipeline secret from agent output without corrupting the persisted transcript', async () => {
    // Long because this fixture now emits a record past the 8 MiB retention
    // threshold, and that record genuinely takes time to stream, store, mask
    // and persist. The STEP's own budget is pinned in the pipeline YAML
    // (`timeout_minutes: 4`) and is identical on every revision this spec is
    // run against — the runner allowance below only has to be long enough for
    // that budget to be the thing that decides the outcome.
    test.setTimeout(420_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-secret-probe-',
    );
    const { electronApp, userDataDir, window } = fixture;

    try {
      const app = new CanopyAppDriver(window);
      await configureGlobalPipelineSecret(window, SECRET_ENV_KEY, SECRET_VALUE);
      // Two further configured values that collide with the serialized form
      // of ordinary records rather than with any data in them.
      await configureGlobalPipelineSecret(
        window,
        COLLIDING_ESCAPE_KEY,
        COLLIDING_ESCAPE_SECRET,
      );
      await configureGlobalPipelineSecret(
        window,
        COLLIDING_DELIMITER_KEY,
        COLLIDING_DELIMITER_SECRET,
      );
      await configureGlobalPipelineSecret(window, KEY_SECRET_ENV, KEY_SECRET);
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await waitForActivityPanel(window);

      const { executionId, runCard } = await dispatchPipeline(
        window,
        SECRET_PROBE_PIPELINE_NAME,
      );
      await expect(runCard).toContainText('success', { timeout: 300_000 });

      const stepDetail = await reopenCompletedStep(
        window,
        runCard,
        'probe',
        'agent',
      );
      const output = stepDetail.getByTestId('pipeline-step-log-output-agent');
      await expect(output).toContainText('E2E_SECRET_PROBE_BEGIN', {
        timeout: 30_000,
      });
      for (const marker of SECRET_LEAK_MARKERS) {
        await expect(output).not.toContainText(marker);
      }

      await stepDetail.getByTestId('pipeline-step-log-mode-raw-agent').click();
      // The marker text around the secret survives, the secret itself never
      // does, and the redaction did not corrupt the JSONL structure it
      // operated on.
      await assertSecretMaskedAndLogIntact(output, SECRET_LEAK_MARKERS);

      await closeDetails(window);
      const reopenedDetail = await reopenCompletedStep(
        window,
        runCard,
        'probe',
        'agent',
      );
      const reopenedOutput = reopenedDetail.getByTestId(
        'pipeline-step-log-output-agent',
      );
      await reopenedDetail
        .getByTestId('pipeline-step-log-mode-raw-agent')
        .click();
      // Reopening re-reads the persisted log from a fresh detail view (no
      // reuse of in-memory state from the run that just completed) — the
      // secret must still be masked and the file still valid JSONL.
      await assertSecretMaskedAndLogIntact(reopenedOutput, SECRET_LEAK_MARKERS);

      // The durable artifact itself, read off disk rather than inferred from
      // the DOM. The parent process wrote this file, so it is what a
      // corrupted redaction actually damages.
      const persisted = readPersistedStepLog(
        userDataDir,
        executionId,
        'E2E_SECRET_PROBE_CANARY',
      );
      const records = persisted
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          expect(() => JSON.parse(line)).not.toThrow();
          return JSON.parse(line);
        });
      for (const marker of SECRET_LEAK_MARKERS) {
        expect(persisted).not.toContain(marker);
      }
      // The record carrying both collision shapes contained no secret, so it
      // must survive byte-for-byte — same fields, same values, `\nABCDE`
      // intact rather than spliced through its own escape sequence.
      expect(
        records.find((record) => record?.canary === 'E2E_SECRET_PROBE_CANARY'),
      ).toEqual(CANARY_RECORD);
      // Same record, but written after a bare whitespace chunk. Chunk framing
      // must not change whether a record survives: every line above already
      // had to parse, and this one has to carry the same values.
      expect(
        records.find(
          (record) => record?.canary === 'E2E_SECRET_WHITESPACE_CANARY',
        ),
      ).toEqual(WHITESPACE_CANARY_RECORD);
      // The paced record: 240,000 characters delivered as ~59 backpressured
      // writes with the closing brace and newline in their own final write.
      // Splitting a record must not change a single byte of it.
      expect(
        records.find((record) => record?.canary === 'E2E_SECRET_PACED_CANARY'),
      ).toEqual(PACED_CANARY_RECORD);
      // The durable record that carries a masked KEY alongside a key already
      // named `***`. Both fields have to survive re-reading the file: masking
      // must never turn two distinct keys into one.
      const keyRecord = records.find(
        (record) => record?.keycanary === 'E2E_SECRET_KEY_CANARY',
      );
      expect(keyRecord).toBeDefined();
      expect(JSON.stringify(keyRecord)).not.toContain(KEY_SECRET);
      expect(Object.values(keyRecord ?? {})).toEqual(
        expect.arrayContaining(['already-a-mask', 'masked-key-value']),
      );
      // The over-cap record whose masked key precedes a literal `***` key. The
      // original has three distinct keys, so the persisted record must still
      // have three, with both values intact and the secret masked.
      const keyOrderRecord = records.find(
        (record) => record?.rowcanary === 'E2E_SECRET_KEYORDER_CANARY',
      );
      expect(keyOrderRecord).toBeDefined();
      expect(JSON.stringify(keyOrderRecord)).not.toContain(KEY_SECRET);
      expect(Object.keys(keyOrderRecord ?? {})).toHaveLength(4);
      expect(Object.values(keyOrderRecord ?? {})).toEqual(
        expect.arrayContaining(['sensitive-key-value', 'ordinary-key-value']),
      );
      // The over-cap record. It has no secret in it, so it must survive whole:
      // every row keeps every field, and the record still parses.
      const rowRecord = records.find(
        (record) => record?.rowcanary === 'E2E_SECRET_ROWS_CANARY',
      );
      expect(rowRecord).toBeDefined();
      expect(Array.isArray(rowRecord?.results)).toBe(true);
      expect(rowRecord?.results).toHaveLength(6000);
      const damagedRows = (rowRecord?.results ?? []).filter(
        (row) =>
          typeof row?.id !== 'number' ||
          typeof row?.name !== 'string' ||
          typeof row?.note !== 'string',
      );
      expect(damagedRows).toHaveLength(0);
      // The record past the 8 MiB retention threshold, delivered as ~2,300
      // backpressured writes. Holding it whole deadlocked the step; this is
      // the same flow through the real app, so the assertion is that the run
      // completed at all AND that the record came back intact.
      const hugeRecord = records.find(
        (record) => record?.hugecanary === 'E2E_SECRET_HUGE_CANARY',
      );
      expect(hugeRecord).toBeDefined();
      expect(hugeRecord?.filler).toHaveLength(9 * 1024 * 1024);
      expect(JSON.stringify(hugeRecord)).not.toContain(KEY_SECRET);
      // Five keys: the canary, the masked key, the filler, the astral field
      // and the key that was already literally `***`. Masking must not
      // collapse the last two.
      expect(Object.keys(hugeRecord ?? {})).toHaveLength(5);
      expect(Object.values(hugeRecord ?? {})).toEqual(
        expect.arrayContaining([
          'E2E_SECRET_HUGE_CANARY',
          'huge-masked-key-value',
          'huge-ordinary-value',
        ]),
      );
      // The action never wrote a line break after this record. A line reader
      // still owes the caller what it is holding at EOF; dropping it lost a
      // whole step's output while the run reported success.
      expect(persisted.endsWith('\n')).toBe(false);
      // The astral character sits next to the configured value and crossed a
      // write boundary on its way to disk. Asserting the SAVED BYTES is the
      // point: two separately encoded surrogate halves reconstruct perfectly
      // when the live fragments are concatenated and are still corrupt on
      // disk.
      expect(hugeRecord?.astral).toBe(
        `\u{1F600}E2E_SECRET_ASTRAL_EDGE\u{1F600}`,
      );
      const persistedBytes = readPersistedStepLogBytes(
        userDataDir,
        executionId,
        'E2E_SECRET_HUGE_CANARY',
      );
      expect(persistedBytes.includes(Buffer.from('\u{1F600}', 'utf8'))).toBe(
        true,
      );
      expect(persistedBytes.includes(Buffer.from('\uFFFD', 'utf8'))).toBe(
        false,
      );
      // A configured value spanning a newline into a JSON-shaped continuation
      // is deliberately NOT exercised here: masking it necessarily emits a
      // non-JSON line, which would mean weakening this spec's every-line-parses
      // invariant. It is covered instead by the real-subprocess case in
      // `packages/desktop-shared/src/node/pipelines/executor/__tests__/spawned-process.test.ts`,
      // which spawns an actual child, reads the actual durable file, and
      // asserts the live stream equals it byte for byte.
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('persists a spilled record with a whitespace head byte for byte', async () => {
    test.setTimeout(300_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-whitespace-record-',
    );
    const { electronApp, userDataDir, window } = fixture;

    try {
      const app = new CanopyAppDriver(window);
      await configureGlobalPipelineSecret(
        window,
        COLLIDING_ESCAPE_KEY,
        COLLIDING_ESCAPE_SECRET,
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await waitForActivityPanel(window);

      const { executionId, runCard } = await dispatchPipeline(
        window,
        WHITESPACE_RECORD_PIPELINE_NAME,
      );
      await expect(runCard).toContainText('success', { timeout: 240_000 });

      // The record contains no configured value, only the `\nABCDE` escape a
      // raw matcher configured with `nABCDE` splices through. The saved file
      // must hold exactly the bytes the child wrote.
      const persisted = readPersistedStepLogBytes(
        userDataDir,
        executionId,
        'E2E_WHITESPACE_HEAD_CANARY',
      );
      const expected = Buffer.from(WHITESPACE_RECORD_LINE, 'utf8');
      expect(persisted.length).toBe(expected.length);
      expect(persisted.equals(expected)).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('masks a configured value the action prints JSON-escaped, once and nested', async () => {
    test.setTimeout(300_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-escaped-record-',
    );
    const { electronApp, userDataDir, window } = fixture;
    try {
      const app = new CanopyAppDriver(window);
      await configureGlobalPipelineSecret(
        window,
        ESCAPED_SECRET_KEY,
        ESCAPED_SECRET,
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await waitForActivityPanel(window);

      const { executionId, runCard } = await dispatchPipeline(
        window,
        ESCAPED_PIPELINE_NAME,
      );
      await expect(runCard).toContainText('success', { timeout: 240_000 });

      const saved = readPersistedStepLog(
        userDataDir,
        executionId,
        ESCAPED_CANARY,
      );
      const line = saved
        .split('\n')
        .find((row) => row.includes(ESCAPED_CANARY));
      // Still the record the action wrote, with both escaped forms masked.
      expect(JSON.parse(line ?? '')).toEqual({
        ecanary: ESCAPED_CANARY,
        note: 'once=["***"] twice="[\\"***\\"]"',
      });
      expect(saved).not.toContain('CANARY-EE-4412');

      // And what the step's output view renders.
      const detail = await reopenCompletedStep(
        window,
        runCard,
        'record',
        'emit',
      );
      const output = detail.getByTestId('pipeline-step-log-output-emit');
      await expect(output).toContainText(ESCAPED_CANARY);
      await expect(output).not.toContainText('CANARY-EE-4412');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('masks a whole configured URL in a stored record when its password is configured too', async () => {
    test.setTimeout(300_000);
    const fixture = await launchFixtureApp(
      'canopy-electron-pipeline-contained-record-',
    );
    const { electronApp, userDataDir, window } = fixture;
    try {
      const app = new CanopyAppDriver(window);
      await configureGlobalPipelineSecret(window, 'E2E_DB_URL', CONTAINED_URL);
      await configureGlobalPipelineSecret(
        window,
        'E2E_DB_PASSWORD',
        CONTAINED_PASSWORD,
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await waitForActivityPanel(window);

      const { executionId, runCard } = await dispatchPipeline(
        window,
        CONTAINED_PIPELINE_NAME,
      );
      await expect(runCard).toContainText('success', { timeout: 240_000 });

      // Exactly the record the child wrote, with the URL masked whole in both
      // the value and the property name.
      const saved = readPersistedStepLog(
        userDataDir,
        executionId,
        CONTAINED_CANARY,
      );
      const expected = `${JSON.stringify({
        ccanary: CONTAINED_CANARY,
        note: 'DB is *** ok',
        '***': 17,
        filler: 'c'.repeat(CONTAINED_FILLER),
      })}\n`;
      expect(saved.includes('db.internal')).toBe(false);
      expect(saved.length).toBe(expected.length);
      expect(saved === expected).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  for (const mode of ['cancel', 'control']) {
    test(`keeps a configured value masked when a stored replay is ${mode === 'cancel' ? 'stopped by cancelling the run' : 'allowed to finish (control)'}`, async () => {
      test.setTimeout(300_000);
      const gateDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-e2e-replay-gate-'),
      );
      const fixture = await launchFixtureApp(
        `canopy-electron-replay-${mode}-`,
        { CANOPY_E2E_REPLAY_GATE_DIR: gateDir },
      );
      const { electronApp, userDataDir, window, worktreePath } = fixture;
      const control = path.join(worktreePath, '.canopy', 'e2e-replay');
      mkdirSync(control, { recursive: true });
      try {
        const app = new CanopyAppDriver(window);
        await configureGlobalPipelineSecret(
          window,
          REPLAY_SECRET_KEY,
          REPLAY_SECRET,
        );
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_BRANCH);
        await waitForActivityPanel(window);
        const { executionId, runCard } = await dispatchPipeline(
          window,
          REPLAY_PIPELINE_NAME,
        );
        await openRunningJob(window, runCard, 'replay', 'Replay');

        // The replay is paused just after its first chunk, whose last eight
        // characters are the configured value's start.
        await waitForPath(path.join(gateDir, 'replay-paused'));
        const liveOutput = window
          .getByTestId('pipeline-step-log-output-record')
          .last();
        await expect(liveOutput).toContainText(REPLAY_CANARY, {
          timeout: 30_000,
        });
        await expect(liveOutput).not.toContainText('SECRET-T');

        // The child writes more output while the replay is held.
        writeFileSync(path.join(control, 'go'), 'go');
        await waitForPath(path.join(control, 'late-written'));

        if (mode === 'cancel') {
          const cancelButton = window.getByTestId(
            `pipeline-detail-cancel-${executionId}`,
          );
          await expect(cancelButton).toBeEnabled();
          await cancelButton.click();
          await expect(runCard).toContainText('cancelled', {
            timeout: 60_000,
          });
          // Let the held replay finish so its cleanup completes.
          writeFileSync(path.join(gateDir, 'replay-release'), 'go');
        } else {
          writeFileSync(path.join(gateDir, 'replay-release'), 'go');
          writeFileSync(path.join(control, 'finish'), 'go');
          await expect(runCard).toContainText('success', { timeout: 120_000 });
        }

        const expected = `${replayHead()}***${'b'.repeat(REPLAY_TAIL)}\n${replayLateLines()}`;
        const saved = readPersistedStepLog(
          userDataDir,
          executionId,
          REPLAY_CANARY,
        );
        for (const fragment of ['SECRET-T', 'OKEN-123456', REPLAY_SECRET])
          expect(saved).not.toContain(fragment);
        if (mode === 'cancel') {
          // A stopped step ends at the record: never a fragment of the value,
          // never output out of order.
          expect(expected.startsWith(saved)).toBe(true);
        } else {
          // Positive control: the gated path masks the whole value and keeps
          // every byte of the output, in order.
          expect(saved.length).toBe(expected.length);
          expect(saved === expected).toBe(true);
        }
        await expect(liveOutput).not.toContainText('SECRET-T');
        await expect(liveOutput).not.toContainText('OKEN-123456');
      } finally {
        writeFileSync(path.join(gateDir, 'replay-release'), 'go');
        writeFileSync(path.join(control, 'finish'), 'go');
        await closeCanopy(electronApp, userDataDir);
        rmSync(gateDir, { recursive: true, force: true });
      }
    });
  }
});
