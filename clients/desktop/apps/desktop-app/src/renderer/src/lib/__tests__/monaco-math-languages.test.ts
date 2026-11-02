// eslint-disable-next-line no-restricted-imports -- The Node Jest test launches Monaco's ESM lexer in a child process.
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line no-restricted-imports -- The test reads the three checked-in language fixtures.
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- Jest resolves Monaco's native ESM modules without transforming them.
import { createRequire } from 'node:module';
// eslint-disable-next-line no-restricted-imports -- The test resolves Monaco's ESM compiler from its installed package.
import path from 'node:path';
// eslint-disable-next-line no-restricted-imports -- The child process imports Monaco's ESM modules by file URL.
import { pathToFileURL } from 'node:url';
import type * as monaco from 'monaco-editor';
import {
  BIBTEX_LANGUAGE_ID,
  LEAN_LANGUAGE_ID,
  LATEX_LANGUAGE_ID,
  bibtexLanguage,
  leanLanguage,
  latexLanguage,
  registerMathLanguages,
} from '../monaco-math-languages';

interface Token {
  offset: number;
  type: string;
}

interface TokenizedLine {
  line: string;
  tokens: Token[];
}

interface RegistrationCalls {
  registrations: monaco.languages.ILanguageExtensionPoint[];
  tokenProviders: Array<{
    id: string;
    grammar: monaco.languages.IMonarchLanguage;
  }>;
  configurations: Array<{
    id: string;
    configuration: monaco.languages.LanguageConfiguration;
  }>;
}

interface FakeMathMonacoApi {
  api: Parameters<typeof registerMathLanguages>[0];
  calls: RegistrationCalls;
}

const nodeRequire = createRequire(path.join(process.cwd(), 'jest.config.js'));
const monacoPackageRoot = path.dirname(
  nodeRequire.resolve('monaco-editor/package.json'),
);
const monarchDirectory = path.join(
  monacoPackageRoot,
  'esm/vs/editor/standalone/common/monarch',
);
const monarchCompileUrl = pathToFileURL(
  path.join(monarchDirectory, 'monarchCompile.js'),
).href;
const monarchLexerUrl = pathToFileURL(
  path.join(monarchDirectory, 'monarchLexer.js'),
).href;

const monarchRunner = `
import { readFileSync } from 'node:fs';
import { compile } from ${JSON.stringify(monarchCompileUrl)};
import { MonarchTokenizer } from ${JSON.stringify(monarchLexerUrl)};

const input = JSON.parse(readFileSync(0, 'utf8'), (_key, value) => {
  if (value && typeof value === 'object' && '__regexp' in value) {
    return new RegExp(value.__regexp, value.flags);
  }
  return value;
});
const lexer = compile('math-language-test', input.grammar);
const configurationService = {
  getValue: () => undefined,
  onDidChangeConfiguration: () => ({ dispose() {} }),
};
const tokenMetadata = new Map();
let nextTokenMetadata = 1;
const themeService = {
  getColorTheme: () => ({
    tokenTheme: {
      match: (_languageId, tokenType) => {
        let metadata = tokenMetadata.get(tokenType);
        if (metadata === undefined) {
          metadata = nextTokenMetadata;
          nextTokenMetadata += 1;
          tokenMetadata.set(tokenType, metadata);
        }
        return metadata;
      },
    },
  }),
};
const languageService = {
  requestRichLanguageFeatures() {},
  isRegisteredLanguageId() { return false; },
};
const tokenizer = new MonarchTokenizer(languageService, themeService, 'math-language-test', lexer, configurationService);
let state = tokenizer.getInitialState();
const result = [];
for (const line of input.source.split('\\n')) {
  try {
    const lineResult = tokenizer.tokenize(line, false, state);
    state = lineResult.endState;
    result.push({ line, tokens: lineResult.tokens.map(({ offset, type }) => ({ offset, type })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error('Tokenization failed on ' + JSON.stringify(line) + ' from state ' + JSON.stringify(state) + ': ' + message);
  }
}
process.stdout.write(JSON.stringify(result));
`;

function serializeForMonarch(
  grammar: monaco.languages.IMonarchLanguage,
  source: string,
): string {
  const serialized: string | undefined = JSON.stringify(
    { grammar, source },
    (_key: string, value: unknown): unknown => {
      if (value instanceof RegExp) {
        return { __regexp: value.source, flags: value.flags };
      }

      return value;
    },
  );

  if (serialized === undefined) {
    throw new Error('Failed to serialize Monarch input');
  }

  return serialized;
}

function parseTokenizedLines(output: string): TokenizedLine[] {
  const parsed: unknown = JSON.parse(output);

  if (!Array.isArray(parsed)) {
    throw new Error('Monarch runner returned an invalid line list');
  }

  const lines: unknown[] = parsed;

  return lines.map((value: unknown): TokenizedLine => {
    if (
      !isRecord(value) ||
      typeof value.line !== 'string' ||
      !Array.isArray(value.tokens)
    ) {
      throw new Error('Monarch runner returned an invalid tokenized line');
    }

    const tokens: unknown[] = value.tokens;

    return {
      line: value.line,
      tokens: tokens.map((token: unknown): Token => {
        if (
          !isRecord(token) ||
          typeof token.offset !== 'number' ||
          typeof token.type !== 'string'
        ) {
          throw new Error('Monarch runner returned an invalid token');
        }

        return { offset: token.offset, type: token.type };
      }),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokenize(
  grammar: monaco.languages.IMonarchLanguage,
  source: string,
): TokenizedLine[] {
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', monarchRunner],
    {
      encoding: 'utf8',
      input: serializeForMonarch(grammar, source),
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return parseTokenizedLines(output);
}

function tokenAt(line: TokenizedLine, substring: string): string {
  const characterIndex = line.line.indexOf(substring);

  if (characterIndex < 0) {
    throw new Error(
      `Expected ${JSON.stringify(substring)} in ${JSON.stringify(line.line)}`,
    );
  }

  const matchingTokens = line.tokens.filter(
    (token) => token.offset <= characterIndex,
  );
  const token = matchingTokens[matchingTokens.length - 1];

  if (!token) {
    throw new Error(
      `No token covers ${JSON.stringify(substring)} in ${JSON.stringify(line.line)}`,
    );
  }

  return token.type;
}

function expectToken(
  line: TokenizedLine,
  substring: string,
  expected: string,
): void {
  const actual = tokenAt(line, substring);

  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(substring)} to use ${expected}, received ${actual} in ${JSON.stringify(line.tokens)}`,
    );
  }
}

function createFakeMathMonacoApi(
  initialLanguages: monaco.languages.ILanguageExtensionPoint[] = [],
): FakeMathMonacoApi {
  const registeredLanguages = [...initialLanguages];
  const calls: RegistrationCalls = {
    registrations: [],
    tokenProviders: [],
    configurations: [],
  };

  return {
    calls,
    api: {
      languages: {
        getLanguages: (): monaco.languages.ILanguageExtensionPoint[] =>
          registeredLanguages,
        register: (
          language: monaco.languages.ILanguageExtensionPoint,
        ): void => {
          registeredLanguages.push(language);
          calls.registrations.push(language);
        },
        setMonarchTokensProvider: (
          id: string,
          grammar: Parameters<
            typeof monaco.languages.setMonarchTokensProvider
          >[1],
        ): monaco.IDisposable => {
          if (!('tokenizer' in grammar))
            throw new Error('Expected a Monarch grammar');
          calls.tokenProviders.push({ id, grammar });
          return { dispose: (): void => undefined };
        },
        setLanguageConfiguration: (
          id: string,
          configuration: monaco.languages.LanguageConfiguration,
        ): monaco.IDisposable => {
          calls.configurations.push({ id, configuration });
          return { dispose: (): void => undefined };
        },
      },
    },
  };
}

describe('math Monarch grammars', () => {
  it('tokenizes LaTeX commands, environments, math regions, and verbatim bodies', () => {
    const source = [
      '% This is a comment',
      '\\% and \\section{Hello} \\\\',
      '\\begin{theorem}Prose $x^2$ and $$y+3$$',
      'a \\(b + \\cmd\\) and',
      '\\[',
      '\\alpha_1 + 2',
      '\\]',
      '\\begin{equation}x + 1\\end{equation}',
      '\\begin{verbatim}',
      '100% $ \\cmd { text',
      '\\end{verbatim}',
      '\\begin{lstlisting}[language=Python]',
      'x = "$" # \\cmd %',
      '\\end{lstlisting}',
      '\\end{theorem}',
      '  \\begin{verbatim*}',
      '  raw',
      '  \\end{verbatim*} \\after',
    ].join('\n');
    const lines = tokenize(latexLanguage, source);

    expectToken(lines[0], '% This', 'comment.latex');
    expectToken(lines[1], '\\%', 'delimiter.latex');
    expectToken(lines[1], '\\section', 'keyword.command.latex');
    expectToken(lines[1], '\\\\', 'delimiter.latex');
    expectToken(lines[2], '\\begin', 'keyword.latex');
    expectToken(lines[2], 'theorem', 'tag.latex');
    expectToken(lines[2], '{', 'delimiter.latex');
    expectToken(lines[2], 'x', 'string.math.latex');
    expectToken(lines[2], '2', 'number.latex');
    expectToken(lines[2], 'y', 'string.math.latex');
    expectToken(lines[2], '$$', 'delimiter.math.latex');
    expectToken(lines[3], '\\(', 'delimiter.math.latex');
    expectToken(lines[3], '\\cmd', 'keyword.command.latex');
    expectToken(lines[3], '\\)', 'delimiter.math.latex');
    expectToken(lines[4], '\\[', 'delimiter.math.latex');
    expectToken(lines[5], '\\alpha', 'keyword.command.latex');
    expectToken(lines[6], '\\]', 'delimiter.math.latex');
    expectToken(lines[7], 'x', 'string.math.latex');
    expectToken(lines[7], '\\end{equation}', 'keyword.latex');
    expectToken(lines[9], '$', 'string.latex');
    expectToken(lines[9], '\\cmd', 'string.latex');
    expectToken(lines[10], '\\end{verbatim}', 'delimiter.latex');
    expectToken(lines[12], '\\cmd', 'string.latex');
    expectToken(lines[14], '\\end', 'keyword.latex');
    expectToken(lines[2], 'Prose', '');
    // An indented `\end{verbatim*}` still closes the body.
    expectToken(lines[16], 'raw', 'string.latex');
    expectToken(lines[17], '\\end{verbatim*}', 'delimiter.latex');
    expectToken(lines[17], '\\after', 'keyword.command.latex');
  });

  it('tokenizes BibTeX headers, fields, values, macros, and comments', () => {
    const source = [
      'bibliography text outside entries',
      '@article{doe2024,',
      '  title = {Nested {braces} in a title},',
      '  journal = "Math \\"Review",',
      '  year = 2024,',
      '  month = jan # feb',
      '}',
      '@comment{comment {with nested} and symbols}',
      '@string{jmath = "Journal of Math"}',
      '@preamble{"\\\\newcommand"}',
    ].join('\n');
    const lines = tokenize(bibtexLanguage, source);

    expectToken(lines[0], 'bibliography', 'comment.bibtex');
    expectToken(lines[1], 'article', 'keyword.bibtex');
    expectToken(lines[1], 'doe2024', 'type.bibtex');
    expectToken(lines[2], 'title', 'attribute.name.bibtex');
    expectToken(lines[2], 'Nested', 'string.bibtex');
    expectToken(lines[2], 'braces', 'string.bibtex');
    expectToken(lines[3], 'Math', 'string.bibtex');
    expectToken(lines[3], '\\"', 'string.escape.bibtex');
    expectToken(lines[4], '2024', 'number.bibtex');
    expectToken(lines[5], 'jan', 'variable.bibtex');
    expectToken(lines[5], '#', 'delimiter.operator.bibtex');
    expectToken(
      lines[7],
      'comment {with nested} and symbols',
      'comment.bibtex',
    );
    expectToken(lines[8], 'string', 'keyword.bibtex');
    expectToken(lines[9], 'preamble', 'keyword.bibtex');
  });

  it('recovers after BibTeX preambles and parses parenthesized entries', () => {
    const source = [
      '@PREAMBLE{"\\\\newcommand"}',
      '@book{after_preamble, title = {Kept}}',
      '@ comment{spaced comment}',
      '@article(paren2024, title={Hello})',
      '@misc{after_paren, year = 2025}',
    ].join('\n');
    const lines = tokenize(bibtexLanguage, source);

    expectToken(lines[0], 'newcommand', 'string.bibtex');
    expectToken(lines[1], 'book', 'keyword.bibtex');
    expectToken(lines[1], 'after_preamble', 'type.bibtex');
    expectToken(lines[2], 'spaced comment', 'comment.bibtex');
    expectToken(lines[3], 'article', 'keyword.bibtex');
    expectToken(lines[3], 'paren2024', 'type.bibtex');
    expectToken(lines[3], 'Hello', 'string.bibtex');
    expectToken(lines[4], 'misc', 'keyword.bibtex');
    expectToken(lines[4], '2025', 'number.bibtex');
  });

  it('recovers from incomplete BibTeX entries without leaving a stuck state', () => {
    const source = [
      '@comment(note)',
      '@{',
      '@article{incomplete,',
      '  title',
      '  year = 2024,',
      '}',
      '@book{next_entry, title = {Fine}}',
    ].join('\n');
    const lines = tokenize(bibtexLanguage, source);

    expectToken(lines[0], 'note', 'comment.bibtex');
    expectToken(lines[3], 'title', 'attribute.name.bibtex');
    expectToken(lines[6], 'book', 'keyword.bibtex');
    expectToken(lines[6], 'next_entry', 'type.bibtex');
    expectToken(lines[6], 'Fine', 'string.bibtex');
  });

  it('returns to the root after field-less BibTeX entries', () => {
    const lines = tokenize(
      bibtexLanguage,
      ['@misc{lonely}', 'between entries', '@article{after, year = 1}'].join(
        '\n',
      ),
    );

    expectToken(lines[1], 'between', 'comment.bibtex');
    expectToken(lines[2], 'article', 'keyword.bibtex');
    expectToken(lines[2], 'after', 'type.bibtex');
  });

  it('keeps ordinary Lean and Mathlib notation neutral, not invalid', () => {
    const lines = tokenize(
      leanLanguage,
      'example : n % 2 = 0 ∧ a ∣ b ∧ ‖x‖ = (↑n : ℝ) ∧ s ∪ t = ∅ := @Nat.rec',
    );

    for (const symbol of ['%', '∣', '‖', '↑', '∪', '∅', '@Nat']) {
      const token = tokenAt(lines[0], symbol);
      if (token.startsWith('invalid')) {
        throw new Error(`Expected ${symbol} not to be invalid, got ${token}`);
      }
    }
  });

  it('closes Lean raw strings without treating backslashes as escapes', () => {
    const source = [
      'def path := r"C:\\dir\\"',
      'theorem afterRaw : True := trivial',
      'def hashed := r#"has "quotes" inside\\"#',
      'lemma afterHash : True := trivial',
    ].join('\n');
    const lines = tokenize(leanLanguage, source);

    expectToken(lines[0], 'dir', 'string.lean');
    expectToken(lines[1], 'theorem', 'keyword.lean');
    expectToken(lines[1], 'afterRaw', 'identifier.lean');
    expectToken(lines[2], 'quotes', 'string.lean');
    expectToken(lines[3], 'lemma', 'keyword.lean');
  });

  it('tokenizes Lean declarations, tactics, comments, directives, literals, and Unicode', () => {
    const source = [
      'theorem demo (n : ℕ) : n → ℕ := by simp',
      'sorry admit #check Nat @[simp, norm_cast]',
      '/- outer /- nested -/ still comment -/ theorem after',
      '/-- documentation -/ theorem docs',
      '/-! module documentation -/ def moduleDocs := 1',
      '-- line comment',
      'def greeting := "say \\"hi\\""',
      'def invalidEscape := "\\q"',
      "def letter := 'a'; def newline := '\\n'; def prime := h'",
      'def number := 0x10 + 12.5',
    ].join('\n');
    const lines = tokenize(leanLanguage, source);

    expectToken(lines[0], 'theorem', 'keyword.lean');
    expectToken(lines[0], 'simp', 'type.tactic.lean');
    expectToken(lines[0], 'ℕ', 'type.lean');
    expectToken(lines[0], '→', 'keyword.flow.lean');
    expectToken(lines[1], 'sorry', 'invalid.sorry.lean');
    expectToken(lines[1], 'admit', 'invalid.sorry.lean');
    expectToken(lines[1], '#check', 'annotation.directive.lean');
    expectToken(lines[1], '@[', 'annotation.lean');
    expectToken(lines[2], 'still comment', 'comment.lean');
    expectToken(lines[2], 'after', 'identifier.lean');
    expectToken(lines[3], 'documentation', 'comment.doc.lean');
    expectToken(lines[4], 'module documentation', 'comment.doc.lean');
    expectToken(lines[5], '-- line comment', 'comment.lean');
    expectToken(lines[6], '\\"', 'string.escape.lean');
    expectToken(lines[7], '\\q', 'invalid.escape.lean');
    expectToken(lines[8], "'a'", 'string.char.lean');
    expectToken(lines[8], "'\\n'", 'string.char.lean');
    expectToken(lines[8], "h'", 'identifier.lean');
    expectToken(lines[9], '0x10', 'number.lean');
  });

  it('tokenizes each representative language fixture with multiple token classes', () => {
    const fixtures: Array<{
      file: string;
      grammar: monaco.languages.IMonarchLanguage;
    }> = [
      {
        file: 'apps/desktop-app/tests/electron/fixtures/math-languages/ramsey.tex',
        grammar: latexLanguage,
      },
      {
        file: 'apps/desktop-app/tests/electron/fixtures/math-languages/references.bib',
        grammar: bibtexLanguage,
      },
      {
        file: 'apps/desktop-app/tests/electron/fixtures/math-languages/Gauss.lean',
        grammar: leanLanguage,
      },
    ];

    for (const fixture of fixtures) {
      const source = readFileSync(
        path.join(process.cwd(), fixture.file),
        'utf8',
      );
      const lines = tokenize(fixture.grammar, source);
      const tokenTypes = new Set(
        lines.flatMap((line) => line.tokens.map((token) => token.type)),
      );

      expect(tokenTypes.size).toBeGreaterThan(1);
    }
  });
});

describe('registerMathLanguages', () => {
  it('registers each language and its tokenizer/configuration once', () => {
    const fake = createFakeMathMonacoApi();

    registerMathLanguages(fake.api);
    registerMathLanguages(fake.api);

    expect(fake.calls.registrations.map((language) => language.id)).toEqual([
      LATEX_LANGUAGE_ID,
      BIBTEX_LANGUAGE_ID,
      LEAN_LANGUAGE_ID,
    ]);
    expect(fake.calls.registrations).toEqual([
      {
        id: LATEX_LANGUAGE_ID,
        extensions: ['.tex', '.sty', '.cls', '.ltx', '.bbl'],
        aliases: ['LaTeX', 'TeX'],
      },
      { id: BIBTEX_LANGUAGE_ID, extensions: ['.bib'], aliases: ['BibTeX'] },
      {
        id: LEAN_LANGUAGE_ID,
        extensions: ['.lean'],
        aliases: ['Lean 4', 'Lean'],
      },
    ]);
    expect(fake.calls.tokenProviders.map((provider) => provider.id)).toEqual([
      LATEX_LANGUAGE_ID,
      BIBTEX_LANGUAGE_ID,
      LEAN_LANGUAGE_ID,
    ]);
    expect(
      fake.calls.configurations.map((configuration) => configuration.id),
    ).toEqual([LATEX_LANGUAGE_ID, BIBTEX_LANGUAGE_ID, LEAN_LANGUAGE_ID]);
  });

  it('skips languages whose ids are already registered', () => {
    const fake = createFakeMathMonacoApi([
      { id: LATEX_LANGUAGE_ID },
      { id: BIBTEX_LANGUAGE_ID },
      { id: LEAN_LANGUAGE_ID },
    ]);

    registerMathLanguages(fake.api);

    expect(fake.calls.registrations).toHaveLength(0);
    expect(fake.calls.tokenProviders).toHaveLength(0);
    expect(fake.calls.configurations).toHaveLength(0);
  });
});
