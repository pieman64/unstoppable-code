import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { getBundledCodeGraphDir } from '../../../pipelines/config-paths';
import { CodeGraphEngine } from '../engine';
import { openCodeGraphDatabase, requireRow } from '../store/database';
import { CodeGraphParserRuntime } from '../parser/runtime';
import {
  CODE_GRAPH_NON_CODE_EXTRACTORS,
  nonCodeExtractorForPath,
} from '../extract/extractor-registry';
import {
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH,
  CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES,
  CODE_GRAPH_CUSTOM_LANGUAGES_MAX,
  CODE_GRAPH_CUSTOM_LANGUAGE_ID_PATTERN,
  CODE_GRAPH_CUSTOM_WASM_MAX_BYTES,
  CODE_GRAPH_PROTECTED_NON_CODE_EXTENSIONS,
  customLanguagesConfigPath,
  fingerprintCustomLanguageInputs,
  parseCustomLanguagesConfig,
  parseCustomLanguagesReport,
  resolveCustomLanguages,
  validateCustomLanguageEntries,
} from '../languages/custom-config';

const RESOURCES_DIR = getBundledCodeGraphDir();
const REAL_WASM = path.join(
  RESOURCES_DIR,
  'grammars',
  'tree-sitter-typescript.wasm',
);
const REAL_TAGS = path.join(RESOURCES_DIR, 'queries', 'javascript.tags.scm');

/** Raw entries helper: wraps plain values in the {index, value} shape the
 * static validator consumes, mirroring what parseCustomLanguagesConfig
 * produces. */
function rawEntries(
  values: readonly unknown[],
): Array<{ index: number; value: unknown }> {
  return values.map((value, index) => ({ index, value }));
}

function validEntryValue(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'zzlang',
    extensions: ['.zz'],
    wasmFile: 'grammar.wasm',
    tagsFiles: ['tags.scm'],
    ...overrides,
  };
}

describe('custom language config parsing', () => {
  it('parses a well-formed version-1 config', () => {
    const result = parseCustomLanguagesConfig(
      JSON.stringify({ version: 1, languages: [validEntryValue()] }),
    );
    if (!result.ok) {
      throw new Error(`expected ok, got: ${result.error}`);
    }
    expect(result.rawEntries).toHaveLength(1);
    expect(result.rawEntries[0].index).toBe(0);
  });

  it('rejects malformed JSON as a config-level error', () => {
    const result = parseCustomLanguagesConfig('{ not json');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object root, a wrong version, and a non-array languages field', () => {
    expect(parseCustomLanguagesConfig('[]').ok).toBe(false);
    expect(
      parseCustomLanguagesConfig(JSON.stringify({ version: 2, languages: [] }))
        .ok,
    ).toBe(false);
    expect(
      parseCustomLanguagesConfig(
        JSON.stringify({ version: 1, languages: 'nope' }),
      ).ok,
    ).toBe(false);
  });
});

describe('custom language static validation', () => {
  it('accepts a valid entry', () => {
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries([validEntryValue()]),
    );
    expect(diagnostics).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('zzlang');
    expect(entries[0].extensions).toEqual(['.zz']);
  });

  it('skips a non-object entry with a diagnostic', () => {
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries(['nope']),
    );
    expect(entries).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].index).toBe(0);
    expect(diagnostics[0].entryId).toBeNull();
  });

  it('skips entries beyond the language cap', () => {
    const values = Array.from(
      { length: CODE_GRAPH_CUSTOM_LANGUAGES_MAX + 2 },
      (_, i) => validEntryValue({ id: `lang-${i}`, extensions: [`.zz${i}x`] }),
    );
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries(values),
    );
    expect(entries).toHaveLength(CODE_GRAPH_CUSTOM_LANGUAGES_MAX);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].message).toContain(
      String(CODE_GRAPH_CUSTOM_LANGUAGES_MAX),
    );
  });

  it('rejects bad ids (regex, built-in collision, duplicate custom)', () => {
    expect(CODE_GRAPH_CUSTOM_LANGUAGE_ID_PATTERN.test('Bad_Id')).toBe(false);
    const badShapes = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ id: 'Bad_Id' }),
        validEntryValue({ id: '9starts-with-digit' }),
        validEntryValue({ id: 'x'.repeat(33) }),
        validEntryValue({ id: 42 }),
      ]),
    );
    expect(badShapes.entries).toEqual([]);
    expect(badShapes.diagnostics).toHaveLength(4);

    const builtinCollision = validateCustomLanguageEntries(
      rawEntries([validEntryValue({ id: 'typescript' })]),
    );
    expect(builtinCollision.entries).toEqual([]);
    expect(builtinCollision.diagnostics[0].message).toContain('typescript');

    const duplicate = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ id: 'zig', extensions: ['.zig'] }),
        validEntryValue({ id: 'zig', extensions: ['.zag'] }),
      ]),
    );
    expect(duplicate.entries).toHaveLength(1);
    expect(duplicate.diagnostics).toHaveLength(1);
    expect(duplicate.diagnostics[0].index).toBe(1);
  });

  it('rejects extension shadowing of built-in grammar extensions', () => {
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries([validEntryValue({ id: 'faux-ts', extensions: ['.ts'] })]),
    );
    expect(entries).toEqual([]);
    expect(diagnostics[0].message).toContain('.ts');
  });

  it('rejects extension shadowing of protected non-code corpus extensions, including suffix shadowing', () => {
    // `.md` is a literal protected extension.
    const literal = validateCustomLanguageEntries(
      rawEntries([validEntryValue({ id: 'notmd', extensions: ['.md'] })]),
    );
    expect(literal.entries).toEqual([]);
    // Extension matching is endsWith, so a custom extension that ENDS WITH a
    // protected one (`x.config.json` also ends with `.json`) would steal
    // those files from the non-code extractors.
    const suffix = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ id: 'sneaky', extensions: ['.config.json'] }),
      ]),
    );
    expect(suffix.entries).toEqual([]);
    expect(suffix.diagnostics[0].message).toContain('.json');
    // Same rule against the markdown corpus.
    const superset = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ id: 'mdplus', extensions: ['.notes.md'] }),
      ]),
    );
    expect(superset.entries).toEqual([]);
  });

  it('keeps the protected non-code extension list in lockstep with the extractor registry (drift guard)', () => {
    // The extensions each registry extractor's matcher depends on. If the
    // extractor id set below drifts from CODE_GRAPH_NON_CODE_EXTRACTORS,
    // this test fails — whoever adds/renames a non-code extractor must
    // extend BOTH this map and CODE_GRAPH_PROTECTED_NON_CODE_EXTENSIONS
    // when the new extractor matches by extension, or shadow protection
    // silently weakens (a custom entry could claim the new corpus files).
    const coverageByExtractorId: Record<
      string,
      { extensions: string[]; representativePaths: string[] }
    > = {
      prisma: {
        extensions: ['.prisma'],
        representativePaths: ['apps/web/schema.prisma'],
      },
      markdown: {
        extensions: ['.md', '.mdx'],
        representativePaths: ['docs/readme.md', 'docs/page.mdx'],
      },
      'package-json': {
        extensions: ['.json'],
        representativePaths: ['package.json'],
      },
      tsconfig: {
        extensions: ['.json'],
        representativePaths: ['tsconfig.json', 'tsconfig.base.json'],
      },
      'mcp-config': {
        extensions: ['.json'],
        representativePaths: ['.mcp.json', 'sub/mcp.json'],
      },
      'github-workflow': {
        extensions: ['.yml', '.yaml'],
        representativePaths: [
          '.github/workflows/ci.yml',
          '.github/workflows/ci.yaml',
        ],
      },
      'github-action-manifest': {
        extensions: ['.yml', '.yaml'],
        representativePaths: ['actions/setup/action.yml', 'action.yaml'],
      },
    };

    // Direction 1 (drift tripwire): every registry extractor is accounted
    // for in the coverage map — a newly added extractor fails here.
    expect(
      CODE_GRAPH_NON_CODE_EXTRACTORS.map((extractor) => extractor.id).sort(),
    ).toEqual(Object.keys(coverageByExtractorId).sort());

    const coveredExtensions = new Set<string>();
    for (const [id, coverage] of Object.entries(coverageByExtractorId)) {
      for (const extension of coverage.extensions) {
        coveredExtensions.add(extension);
        // Direction 2: every extension an extractor matches by is in the
        // protected list, so a custom entry can never claim it.
        expect(CODE_GRAPH_PROTECTED_NON_CODE_EXTENSIONS).toContain(extension);
      }
      // Sanity: the representative paths really do route to this extractor,
      // so the map reflects the registry's actual matching behavior rather
      // than this test's assumptions.
      for (const representativePath of coverage.representativePaths) {
        expect(nonCodeExtractorForPath(representativePath)?.id).toBe(id);
      }
    }
    // Direction 3 (no stale protection): every protected extension is
    // justified by some extractor above — the list cannot silently
    // accumulate entries that block custom languages for no corpus reason.
    for (const extension of CODE_GRAPH_PROTECTED_NON_CODE_EXTENSIONS) {
      expect(Array.from(coveredExtensions)).toContain(extension);
    }
  });

  it('rejects extension shadowing between two custom entries', () => {
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ id: 'first', extensions: ['.zz'] }),
        validEntryValue({ id: 'second', extensions: ['.a.zz'] }),
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('first');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].entryId).toBe('second');
  });

  it('rejects malformed extensions', () => {
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ extensions: [] }),
        validEntryValue({ id: 'nodot', extensions: ['zz'] }),
        validEntryValue({ id: 'notstr', extensions: [42] }),
      ]),
    );
    expect(entries).toEqual([]);
    expect(diagnostics).toHaveLength(3);
  });

  it('rejects traversal attempts in wasmFile and tagsFiles', () => {
    const { entries, diagnostics } = validateCustomLanguageEntries(
      rawEntries([
        validEntryValue({ id: 'a1', wasmFile: '../escape.wasm' }),
        validEntryValue({ id: 'a2', wasmFile: '/abs/path.wasm' }),
        validEntryValue({ id: 'a3', wasmFile: 'C:/win/path.wasm' }),
        validEntryValue({ id: 'a4', wasmFile: 'sub\\dir.wasm' }),
        validEntryValue({ id: 'a5', tagsFiles: ['../tags.scm'] }),
        validEntryValue({ id: 'a6', tagsFiles: [] }),
      ]),
    );
    expect(entries).toEqual([]);
    expect(diagnostics).toHaveLength(6);
  });
});

describe('custom language input fingerprint', () => {
  let fixtureDir: string;
  let configDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'code-graph-fingerprint-'));
    configDir = path.join(fixtureDir, '.canopy', 'code-graph');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('is stable when absent and changes with config, WASM, and tags bytes', async () => {
    const absentA = await fingerprintCustomLanguageInputs(fixtureDir);
    const absentB = await fingerprintCustomLanguageInputs(fixtureDir);
    expect(absentA).toEqual(absentB);
    expect(absentA.configPresent).toBe(false);

    writeFileSync(path.join(configDir, 'grammar.wasm'), 'wasm-a');
    writeFileSync(path.join(configDir, 'tags.scm'), 'tags-a');
    writeFileSync(
      path.join(configDir, 'languages.json'),
      JSON.stringify({ version: 1, languages: [validEntryValue()] }),
    );
    const initial = await fingerprintCustomLanguageInputs(fixtureDir);
    expect(initial.configPresent).toBe(true);
    expect(initial.value).not.toBe(absentA.value);

    writeFileSync(
      path.join(configDir, 'languages.json'),
      JSON.stringify({
        version: 1,
        languages: [validEntryValue({ extensions: ['.changed'] })],
      }),
    );
    const configChanged = await fingerprintCustomLanguageInputs(fixtureDir);
    expect(configChanged.value).not.toBe(initial.value);

    writeFileSync(path.join(configDir, 'grammar.wasm'), 'wasm-b');
    const wasmChanged = await fingerprintCustomLanguageInputs(fixtureDir);
    expect(wasmChanged.value).not.toBe(configChanged.value);

    writeFileSync(path.join(configDir, 'tags.scm'), 'tags-b');
    const tagsChanged = await fingerprintCustomLanguageInputs(fixtureDir);
    expect(tagsChanged.value).not.toBe(wasmChanged.value);
  });

  it('uses explicit markers for oversized configs and symlinked assets', async () => {
    const configPath = path.join(configDir, 'languages.json');
    writeFileSync(configPath, 'x');
    truncateSync(configPath, CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_MAX_BYTES + 1);

    const oversized = await fingerprintCustomLanguageInputs(fixtureDir);
    expect(oversized.configPresent).toBe(true);

    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, languages: [validEntryValue()] }),
    );
    writeFileSync(path.join(configDir, 'real-grammar.wasm'), 'wasm-a');
    symlinkSync('real-grammar.wasm', path.join(configDir, 'grammar.wasm'));
    writeFileSync(path.join(configDir, 'tags.scm'), 'tags-a');
    const symlinked = await fingerprintCustomLanguageInputs(fixtureDir);

    rmSync(path.join(configDir, 'grammar.wasm'));
    writeFileSync(path.join(configDir, 'grammar.wasm'), 'wasm-a');
    const regular = await fingerprintCustomLanguageInputs(fixtureDir);

    expect(symlinked.value).not.toBe(regular.value);
    expect(oversized.value).not.toBe(regular.value);
  });

  it('reads each repeated asset only once per reference kind', async () => {
    const tagsPath = path.join(configDir, 'tags.scm');
    writeFileSync(path.join(configDir, 'grammar.wasm'), 'wasm-a');
    writeFileSync(tagsPath, 'tags-a');
    writeFileSync(
      path.join(configDir, 'languages.json'),
      JSON.stringify({
        version: 1,
        languages: [
          validEntryValue({ tagsFiles: Array(100).fill('tags.scm') }),
        ],
      }),
    );
    const openSpy = jest.spyOn(fsPromises, 'open');
    try {
      await fingerprintCustomLanguageInputs(fixtureDir);
      expect(
        openSpy.mock.calls.filter(
          ([filePath]) => path.basename(String(filePath)) === 'tags.scm',
        ),
      ).toHaveLength(1);
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('custom language resolution (fs + wasm + query compile)', () => {
  let fixtureDir: string;
  let configDir: string;
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
  });
  afterAll(() => {
    runtime.dispose();
  });
  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'code-graph-custom-'));
    configDir = path.join(fixtureDir, '.canopy', 'code-graph');
    mkdirSync(configDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  function writeConfig(languages: unknown[]): string {
    const configPath = path.join(configDir, 'languages.json');
    writeFileSync(configPath, JSON.stringify({ version: 1, languages }));
    return configPath;
  }

  it('returns absent when no config file exists', async () => {
    const outcome = await resolveCustomLanguages({
      configPath: path.join(configDir, 'languages.json'),
      runtime,
    });
    expect(outcome.kind).toBe('absent');
  });

  it('returns config-error for a malformed config file', async () => {
    const configPath = path.join(configDir, 'languages.json');
    writeFileSync(configPath, '{ nope');
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    expect(outcome.kind).toBe('config-error');
  });

  it('loads a real copied grammar wasm and reports its ABI (happy path)', async () => {
    copyFileSync(REAL_WASM, path.join(configDir, 'grammar.wasm'));
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.report.diagnostics).toEqual([]);
    expect(outcome.report.loaded).toHaveLength(1);
    expect(outcome.report.loaded[0].id).toBe('zzlang');
    expect(outcome.report.loaded[0].abiVersion).toBeGreaterThanOrEqual(13);
    expect(outcome.grammars).toHaveLength(1);
    expect(path.isAbsolute(outcome.grammars[0].wasmFile)).toBe(true);
    expect(outcome.grammars[0].inlineQuerySuffix).toBe('');
  });

  it('returns the fingerprint for the exact grammar bytes loaded by the runtime', async () => {
    const wasmPath = path.join(configDir, 'grammar.wasm');
    const tagsPath = path.join(configDir, 'tags.scm');
    copyFileSync(REAL_WASM, wasmPath);
    copyFileSync(REAL_TAGS, tagsPath);
    const configPath = writeConfig([validEntryValue()]);
    const capturedFingerprint =
      await fingerprintCustomLanguageInputs(fixtureDir);
    const getCustomGrammar = runtime.getCustomGrammar.bind(runtime);
    jest
      .spyOn(runtime, 'getCustomGrammar')
      .mockImplementationOnce(async (definition, captured) => {
        writeFileSync(wasmPath, 'changed after capture');
        writeFileSync(tagsPath, '(changed_after_capture) @definition.function');
        return getCustomGrammar(definition, captured);
      });

    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }

    expect(outcome.report.loaded).toHaveLength(1);
    expect(outcome.fingerprint).toEqual(capturedFingerprint);
    const grammarAfterMutation = await runtime.getResolvedCustomGrammar(
      outcome.grammars[0],
    );
    expect(typeof grammarAfterMutation.abiVersion).toBe('number');
    expect(await fingerprintCustomLanguageInputs(fixtureDir)).not.toEqual(
      capturedFingerprint,
    );
  });

  it('skips an entry whose wasm file is missing', async () => {
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toEqual([]);
    expect(outcome.report.diagnostics).toHaveLength(1);
    expect(outcome.report.diagnostics[0].entryId).toBe('zzlang');
  });

  it('skips an oversized wasm file without reading it', async () => {
    const wasmPath = path.join(configDir, 'grammar.wasm');
    writeFileSync(wasmPath, 'x');
    truncateSync(wasmPath, CODE_GRAPH_CUSTOM_WASM_MAX_BYTES + 1);
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toEqual([]);
    expect(outcome.report.diagnostics[0].message).toContain('32');
  });

  it('rejects symlinked grammar assets consistently with fingerprinting', async () => {
    copyFileSync(REAL_WASM, path.join(configDir, 'real-grammar.wasm'));
    symlinkSync('real-grammar.wasm', path.join(configDir, 'grammar.wasm'));
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([validEntryValue()]);

    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toEqual([]);
    expect(outcome.report.diagnostics[0].message).toContain('symlink');
  });

  it('skips an entry whose wasm is not a valid grammar (bad wasm / ABI)', async () => {
    writeFileSync(path.join(configDir, 'grammar.wasm'), 'not really wasm');
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toEqual([]);
    expect(outcome.report.diagnostics).toHaveLength(1);
  });

  it('skips an entry whose tags file is missing', async () => {
    copyFileSync(REAL_WASM, path.join(configDir, 'grammar.wasm'));
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toEqual([]);
    expect(outcome.report.diagnostics).toHaveLength(1);
  });

  it('skips an entry whose tags query does not compile, naming the tags file', async () => {
    copyFileSync(REAL_WASM, path.join(configDir, 'grammar.wasm'));
    writeFileSync(
      path.join(configDir, 'tags.scm'),
      '(this_node_kind_does_not_exist) @definition.function\n',
    );
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toEqual([]);
    expect(outcome.report.diagnostics).toHaveLength(1);
    expect(outcome.report.diagnostics[0].message).toContain('tags.scm');
  });

  it('keeps valid entries when a sibling entry fails', async () => {
    copyFileSync(REAL_WASM, path.join(configDir, 'grammar.wasm'));
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([
      validEntryValue(),
      validEntryValue({
        id: 'broken',
        extensions: ['.brk'],
        wasmFile: 'missing.wasm',
      }),
    ]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    expect(outcome.grammars).toHaveLength(1);
    expect(outcome.report.loaded[0].id).toBe('zzlang');
    expect(outcome.report.diagnostics).toHaveLength(1);
    expect(outcome.report.diagnostics[0].entryId).toBe('broken');
  });

  it('round-trips a report through parseCustomLanguagesReport', async () => {
    copyFileSync(REAL_WASM, path.join(configDir, 'grammar.wasm'));
    copyFileSync(REAL_TAGS, path.join(configDir, 'tags.scm'));
    const configPath = writeConfig([validEntryValue()]);
    const outcome = await resolveCustomLanguages({ configPath, runtime });
    if (outcome.kind !== 'resolved') {
      throw new Error(`expected resolved, got ${outcome.kind}`);
    }
    const parsed = parseCustomLanguagesReport(JSON.stringify(outcome.report));
    expect(parsed).toEqual(outcome.report);
    expect(parseCustomLanguagesReport('{ nope')).toBeNull();
    expect(parseCustomLanguagesReport('42')).toBeNull();
  });
});

describe('parser runtime custom grammar keying', () => {
  it('keys custom grammars by absolute wasm path so equal ids with different wasm do not collide', async () => {
    const runtime = await CodeGraphParserRuntime.create();
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-keying-'));
    try {
      const wasmA = path.join(dir, 'a.wasm');
      const wasmB = path.join(dir, 'b.wasm');
      copyFileSync(REAL_WASM, wasmA);
      copyFileSync(REAL_WASM, wasmB);
      const tags = path.join(dir, 'tags.scm');
      copyFileSync(REAL_TAGS, tags);
      const a = await runtime.getCustomGrammar({
        id: 'samelang',
        extensions: ['.aa'],
        wasmFile: wasmA,
        tagsFiles: [tags],
        inlineQuerySuffix: '',
      });
      const b = await runtime.getCustomGrammar({
        id: 'samelang',
        extensions: ['.bb'],
        wasmFile: wasmB,
        tagsFiles: [tags],
        inlineQuerySuffix: '',
      });
      expect(a).not.toBe(b);
      const aAgain = await runtime.getCustomGrammar({
        id: 'samelang',
        extensions: ['.aa'],
        wasmFile: wasmA,
        tagsFiles: [tags],
        inlineQuerySuffix: '',
      });
      expect(aAgain).toBe(a); // cached by absolute path

      writeFileSync(tags, `${readFileSync(tags, 'utf8')}\n; changed bytes\n`);
      const aAfterTagsChange = await runtime.getCustomGrammar({
        id: 'samelang',
        extensions: ['.aa'],
        wasmFile: wasmA,
        tagsFiles: [tags],
        inlineQuerySuffix: '',
      });
      expect(aAfterTagsChange).not.toBe(a);

      // A custom grammar must never poison the built-in id-based lookup.
      const builtin = await runtime.getGrammar('typescript');
      expect(builtin).not.toBe(a);
      expect(builtin.definition.wasmFile).toBe(
        'grammars/tree-sitter-typescript.wasm',
      );
    } finally {
      runtime.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('engine end-to-end with a custom language', () => {
  let root: string;
  let engine: CodeGraphEngine | null = null;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-custom-engine-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
  });
  afterEach(() => {
    if (engine !== null) {
      engine.close();
      engine = null;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function writeCustomConfig(languages: unknown[]): void {
    const configPath = customLanguagesConfigPath(root);
    expect(configPath).toBe(
      path.join(
        root,
        ...CODE_GRAPH_CUSTOM_LANGUAGES_CONFIG_RELATIVE_PATH.split('/'),
      ),
    );
    mkdirSync(path.dirname(configPath), { recursive: true });
    copyFileSync(
      REAL_WASM,
      path.join(path.dirname(configPath), 'grammar.wasm'),
    );
    copyFileSync(REAL_TAGS, path.join(path.dirname(configPath), 'tags.scm'));
    writeFileSync(configPath, JSON.stringify({ version: 1, languages }));
  }

  it('reports null custom languages when no config exists', async () => {
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function one(): number { return 1; }\n',
    );
    engine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.graph', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
      worktreeRootPath: root,
    });
    const result = await engine.buildOrUpdate();
    expect(result.customLanguages).toBeNull();
    expect(engine.getStatus().customLanguages).toBeNull();
  });

  it('scans, parses, and extracts definitions/references for a custom extension', async () => {
    writeCustomConfig([validEntryValue()]);
    writeFileSync(
      path.join(root, 'src', 'widget.zz'),
      'export function widgetMain(): void { helperFn(); }\nfunction helperFn(): void {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function one(): number { return 1; }\n',
    );
    engine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.graph', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
      worktreeRootPath: root,
    });
    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);
    // The .zz file was enumerated + parsed alongside the .ts file.
    expect(result.filesParsed).toBeGreaterThanOrEqual(2);
    expect(result.customLanguages).not.toBeNull();
    expect(result.customLanguages?.loaded.map((l) => l.id)).toEqual(['zzlang']);
    expect(result.customLanguages?.diagnostics).toEqual([]);

    const queries = engine.queries();
    const summary = queries.getFileSummary('src/widget.zz', 'fixture');
    if (summary === null) {
      throw new Error('custom-extension file missing from graph');
    }
    const names = summary.symbols.map((s) => s.qualifiedName);
    expect(names).toContain('src/widget.zz::widgetMain');
    expect(names).toContain('src/widget.zz::helperFn');
    // Generic tags path: reference edges bind the call within the file.
    const callers = queries.getCallers('src/widget.zz::helperFn', 'fixture');
    expect(callers.map((c) => c.qualifiedName)).toContain(
      'src/widget.zz::widgetMain',
    );

    // Diagnostics also surface through status after the build.
    const status = engine.getStatus();
    expect(status.customLanguages?.loaded.map((l) => l.id)).toEqual(['zzlang']);
  });

  it('selectively refreshes custom-grammar symbols and equals a cold full FTS index', async () => {
    writeCustomConfig([validEntryValue()]);
    writeFileSync(
      path.join(root, 'src', 'widget.zz'),
      'export function customLookup(value: string): string { return value; }\n',
    );
    engine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.graph', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
      worktreeRootPath: root,
    });
    await engine.buildOrUpdate();
    const beforeDb = openCodeGraphDatabase(
      path.join(root, '.graph', 'graph.db'),
    );
    let priorId: string;
    try {
      const row = beforeDb
        .prepare(`SELECT id FROM symbols WHERE qualified_name = ?`)
        .get('src/widget.zz::customLookup');
      if (row === undefined)
        throw new Error('custom symbol missing before edit');
      priorId = String(requireRow(row).id);
    } finally {
      beforeDb.close();
    }

    writeFileSync(
      path.join(root, 'src', 'widget.zz'),
      'export function customLookup(value: number): number { return value + 1; }\n',
    );
    await engine.buildOrUpdate();
    const coldEngine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.cold', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
      worktreeRootPath: root,
    });
    try {
      await coldEngine.buildOrUpdate();
      const afterDb = openCodeGraphDatabase(
        path.join(root, '.graph', 'graph.db'),
      );
      try {
        const row = afterDb
          .prepare(`SELECT id, signature FROM symbols WHERE qualified_name = ?`)
          .get('src/widget.zz::customLookup');
        if (row === undefined)
          throw new Error('custom symbol missing after edit');
        expect(String(requireRow(row).id)).toBe(priorId);
        expect(String(requireRow(row).signature)).toContain('number');
      } finally {
        afterDb.close();
      }
      for (const query of ['customLookup', 'customLook', 'lookup']) {
        for (const limit of [1, 5, 20]) {
          expect(engine.queries().search(query, limit, 'fixture')).toEqual(
            coldEngine.queries().search(query, limit, 'fixture'),
          );
        }
      }
    } finally {
      coldEngine.close();
    }
  });

  it('surfaces per-entry diagnostics in build result and status while keeping valid entries', async () => {
    writeCustomConfig([
      validEntryValue(),
      validEntryValue({ id: 'Bad_Id!', extensions: ['.bad'] }),
    ]);
    writeFileSync(
      path.join(root, 'src', 'widget.zz'),
      'export function widgetMain(): void {}\n',
    );
    engine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.graph', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
      worktreeRootPath: root,
    });
    const result = await engine.buildOrUpdate();
    expect(result.customLanguages?.loaded).toHaveLength(1);
    expect(result.customLanguages?.diagnostics).toHaveLength(1);
    const status = engine.getStatus();
    expect(status.customLanguages?.diagnostics).toHaveLength(1);
  });

  it('treats a malformed config as a config-level diagnostic without failing the build', async () => {
    const configPath = customLanguagesConfigPath(root);
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ nope');
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function one(): number { return 1; }\n',
    );
    engine = await CodeGraphEngine.open({
      dbPath: path.join(root, '.graph', 'graph.db'),
      repositories: [{ repoId: 'fixture', rootPath: root }],
      worktreeRootPath: root,
    });
    const result = await engine.buildOrUpdate();
    expect(result.filesParsed).toBe(1);
    expect(result.customLanguages).not.toBeNull();
    expect(result.customLanguages?.loaded).toEqual([]);
    expect(result.customLanguages?.diagnostics).toHaveLength(1);
    expect(result.customLanguages?.diagnostics[0].index).toBe(-1);
  });
});
