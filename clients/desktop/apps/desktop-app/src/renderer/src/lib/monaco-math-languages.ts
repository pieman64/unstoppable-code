import type * as monaco from 'monaco-editor';

/** Monarch grammars and editor settings for the math-focused source languages. */

export const LATEX_LANGUAGE_ID = 'latex';
export const BIBTEX_LANGUAGE_ID = 'bibtex';
export const LEAN_LANGUAGE_ID = 'lean';

const latexMathEnvironments: string[] = [
  'equation',
  'align',
  'gather',
  'multline',
  'displaymath',
  'math',
  'equation*',
  'align*',
  'gather*',
  'multline*',
  'displaymath*',
  'math*',
];

const latexVerbatimEnvironments: string[] = ['verbatim', 'verbatim*'];
const latexListingEnvironments: string[] = ['lstlisting', 'minted'];

// Prose stays in the default foreground so commands and math stand out.
export const latexLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: false,
  tokenPostfix: '.latex',
  mathEnvironments: latexMathEnvironments,
  verbatimEnvironments: latexVerbatimEnvironments,
  listingEnvironments: latexListingEnvironments,
  brackets: [
    { open: '{', close: '}', token: 'delimiter' },
    { open: '[', close: ']', token: 'delimiter' },
    { open: '(', close: ')', token: 'delimiter' },
  ],
  tokenizer: {
    root: [
      [
        /(\\begin)(\{)([a-zA-Z*@]+)(\})/,
        [
          'keyword',
          'delimiter',
          {
            cases: {
              '$3@mathEnvironments': { token: 'tag', next: '@mathEnv.$3' },
              '$3@verbatimEnvironments': { token: 'tag', next: '@verbatim.$3' },
              '$3@listingEnvironments': { token: 'tag', next: '@verbatim.$3' },
              '@default': 'tag',
            },
          },
          'delimiter',
        ],
      ],
      [
        /(\\end)(\{)([a-zA-Z*@]+)(\})/,
        ['keyword', 'delimiter', 'tag', 'delimiter'],
      ],
      [/\$\$/, { token: 'delimiter.math', next: '@mathDisplayDollar' }],
      [/\$/, { token: 'delimiter.math', next: '@mathDollar' }],
      [/\\\(/, { token: 'delimiter.math', next: '@mathParen' }],
      [/\\\[/, { token: 'delimiter.math', next: '@mathBracket' }],
      [/%.*$/, 'comment'],
      [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
      [/\\[{}%$&#_\\,;:!]/, 'delimiter'],
      [/[0-9]+(?:\.[0-9]+)?/, 'number'],
      [/[\[\]{}()]/, '@brackets'],
      [/[&_^]/, 'keyword.flow'],
      [/\s+/, 'white'],
      [/[a-zA-Z]+/, ''],
    ],
    mathDollar: [
      [/\$/, { token: 'delimiter.math', next: '@pop' }],
      [/%.*$/, 'comment'],
      [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
      [/\\[{}%$&#_\\,;:!]/, 'delimiter'],
      [/[0-9]+(?:\.[0-9]+)?/, 'number'],
      [/[{}\[\]()]/, '@brackets'],
      [/[+\-=*/.,:;<>|~!&_^]/, 'keyword.flow'],
      [/[^\s\\$%{}\[\]()0-9+*\/.,:;<>|~!&^_=-]+/, 'string.math'],
      [/\s+/, 'white'],
    ],
    mathDisplayDollar: [
      [/\$\$/, { token: 'delimiter.math', next: '@pop' }],
      [/\$/, 'delimiter.math'],
      [/\%.*$/, 'comment'],
      [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
      [/\\[{}%$&#_\\,;:!]/, 'delimiter'],
      [/[0-9]+(?:\.[0-9]+)?/, 'number'],
      [/[{}\[\]()]/, '@brackets'],
      [/[+\-=*/.,:;<>|~!&_^]/, 'keyword.flow'],
      [/[^\s\\$%{}\[\]()0-9+*\/.,:;<>|~!&^_=-]+/, 'string.math'],
      [/\s+/, 'white'],
    ],
    mathParen: [
      [/\\\)/, { token: 'delimiter.math', next: '@pop' }],
      [/%.*$/, 'comment'],
      [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
      [/\\[{}%$&#_\\,;:!]/, 'delimiter'],
      [/[0-9]+(?:\.[0-9]+)?/, 'number'],
      [/[{}\[\]()]/, '@brackets'],
      [/[+\-=*/.,:;<>|~!&_^]/, 'keyword.flow'],
      [/[^\s\\$%{}\[\]()0-9+*\/.,:;<>|~!&^_=-]+/, 'string.math'],
      [/\s+/, 'white'],
    ],
    mathBracket: [
      [/\\\]/, { token: 'delimiter.math', next: '@pop' }],
      [/%.*$/, 'comment'],
      [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
      [/\\[{}%$&#_\\,;:!]/, 'delimiter'],
      [/[0-9]+(?:\.[0-9]+)?/, 'number'],
      [/[{}\[\]()]/, '@brackets'],
      [/[+\-=*/.,:;<>|~!&_^]/, 'keyword.flow'],
      [/[^\s\\$%{}\[\]()0-9+*\/.,:;<>|~!&^_=-]+/, 'string.math'],
      [/\s+/, 'white'],
    ],
    mathEnv: [
      [/\$\$/, { token: 'delimiter.math', next: '@mathDisplayDollar' }],
      [/\$/, { token: 'delimiter.math', next: '@mathDollar' }],
      [/\\\(/, { token: 'delimiter.math', next: '@mathParen' }],
      [/\\\[/, { token: 'delimiter.math', next: '@mathBracket' }],
      [
        /(\\end)(\{)([a-zA-Z*@]+)(\})/,
        [
          'keyword',
          'delimiter',
          {
            cases: {
              '$3==$S2': { token: 'tag', next: '@pop' },
              '@default': 'tag',
            },
          },
          'delimiter',
        ],
      ],
      [
        /(\\begin)(\{)([a-zA-Z*@]+)(\})/,
        [
          'keyword',
          'delimiter',
          {
            cases: {
              '$3@mathEnvironments': { token: 'tag', next: '@mathEnv.$3' },
              '$3@verbatimEnvironments': { token: 'tag', next: '@verbatim.$3' },
              '$3@listingEnvironments': { token: 'tag', next: '@verbatim.$3' },
              '@default': 'tag',
            },
          },
          'delimiter',
        ],
      ],
      [/%.*$/, 'comment'],
      [/\\[a-zA-Z@]+\*?/, 'keyword.command'],
      [/\\[{}%$&#_\\,;:!]/, 'delimiter'],
      [/[0-9]+(?:\.[0-9]+)?/, 'number'],
      [/[{}\[\]()]/, '@brackets'],
      [/[+\-=*/.,:;<>|~!&_^]/, 'keyword.flow'],
      [/[^\s\\$%{}\[\]()]+/, 'string.math'],
      [/\s+/, 'white'],
    ],
    // Stop at every backslash so an indented `\end{…}` still closes the body.
    verbatim: [
      [/\\end\{$S2\}/, { token: 'delimiter', next: '@pop' }],
      [/[^\\]+/, 'string'],
      [/\\/, 'string'],
    ],
  },
};

export const latexLanguageConfiguration: monaco.languages.LanguageConfiguration =
  {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$', notIn: ['comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
  };

export const bibtexLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: 'comment',
  ignoreCase: false,
  tokenPostfix: '.bibtex',
  brackets: [
    { open: '{', close: '}', token: 'delimiter' },
    { open: '(', close: ')', token: 'delimiter' },
  ],
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [
        /@[cC][oO][mM][mM][eE][nN][tT]\b/,
        { token: 'comment', next: '@commentStart' },
      ],
      [/@/, { token: 'delimiter', next: '@entryType' }],
      [/[^@%]+/, 'comment'],
    ],
    entryType: [
      [/\s+/, 'white'],
      [
        /[a-zA-Z]+/,
        {
          cases: {
            '$0~[cC][oO][mM][mM][eE][nN][tT]': {
              token: 'comment',
              switchTo: '@commentStart',
            },
            '$0~[pP][rR][eE][aA][mM][bB][lL][eE]': {
              token: 'keyword',
              switchTo: '@preambleStart',
            },
            '@default': { token: 'keyword', switchTo: '@entryStart.$0' },
          },
        },
      ],
      [/./, { token: 'comment', next: '@pop' }],
    ],
    entryStart: [
      [/\s+/, 'white'],
      [
        /[{(]/,
        {
          cases: {
            '$S2~[pP][rR][eE][aA][mM][bB][lL][eE]': {
              token: 'delimiter',
              switchTo: '@fieldValue',
            },
            '@default': { token: 'delimiter', switchTo: '@entryKey' },
          },
        },
      ],
      [/./, { token: 'comment', next: '@popall' }],
    ],
    entryKey: [
      [/\s+/, 'white'],
      [/,/, { token: 'delimiter', switchTo: '@entryFields' }],
      [/=/, { token: 'delimiter.operator', switchTo: '@fieldValue' }],
      [/[^\s,={}()]+/, 'type'],
      [/[})]/, { token: 'delimiter', next: '@pop' }],
      [/./, 'delimiter'],
    ],
    entryFields: [
      [/\s+/, 'white'],
      [/[})]/, { token: 'delimiter', next: '@pop' }],
      [
        /[a-zA-Z][a-zA-Z0-9_-]*/,
        { token: 'attribute.name', next: '@fieldEquals' },
      ],
      [/,/, 'delimiter'],
      [/./, 'delimiter'],
    ],
    fieldEquals: [
      [/\s+/, 'white'],
      [/=/, { token: 'delimiter.operator', switchTo: '@fieldValue' }],
      [/./, { token: 'delimiter', next: '@pop' }],
    ],
    fieldValue: [
      [/\s+/, 'white'],
      [/\{/, { token: 'delimiter', next: '@braceValue' }],
      [/"/, { token: 'string.quote', next: '@quotedValue' }],
      [/#/, 'delimiter.operator'],
      [/\d+/, 'number'],
      [/[a-zA-Z][a-zA-Z0-9_-]*/, 'variable'],
      [/,/, { token: 'delimiter', next: '@pop' }],
      [/[})]/, { token: 'delimiter', next: '@popall' }],
      [/%.*$/, 'comment'],
      [/./, 'string'],
    ],
    braceValue: [
      [/\{/, { token: 'delimiter', next: '@push' }],
      [/\}/, { token: 'delimiter', next: '@pop' }],
      [/[^{}]+/, 'string'],
    ],
    quotedValue: [
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/[^"\\]+/, 'string'],
      [/\\/, 'string.escape'],
    ],
    commentStart: [
      [/\s+/, 'comment'],
      [/\{/, { token: 'comment', switchTo: '@commentBody' }],
      [/./, { token: 'comment', next: '@pop' }],
    ],
    commentBody: [
      [/\{/, { token: 'comment', next: '@push' }],
      [/\}/, { token: 'comment', next: '@pop' }],
      [/[^{}]+/, 'comment'],
    ],
    preambleStart: [
      [/\s+/, 'white'],
      [/[{(]/, { token: 'delimiter', switchTo: '@fieldValue' }],
      [/./, { token: 'comment', next: '@popall' }],
    ],
  },
};

export const bibtexLanguageConfiguration: monaco.languages.LanguageConfiguration =
  {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  };

const leanKeywords: string[] = [
  'theorem',
  'lemma',
  'def',
  'example',
  'abbrev',
  'structure',
  'class',
  'instance',
  'inductive',
  'coinductive',
  'where',
  'extends',
  'namespace',
  'section',
  'end',
  'open',
  'export',
  'variable',
  'universe',
  'import',
  'by',
  'fun',
  'λ',
  'let',
  'have',
  'show',
  'from',
  'suffices',
  'match',
  'with',
  'if',
  'then',
  'else',
  'do',
  'return',
  'for',
  'in',
  'at',
  'mutual',
  'deriving',
  'private',
  'protected',
  'noncomputable',
  'partial',
  'unsafe',
  'opaque',
  'axiom',
  'attribute',
  'macro',
  'macro_rules',
  'syntax',
  'notation',
  'infix',
  'infixl',
  'infixr',
  'prefix',
  'postfix',
  'elab',
  'set_option',
  'local',
  'scoped',
  'termination_by',
  'decreasing_by',
  'true',
  'false',
];

const leanTactics: string[] = [
  'simp',
  'simp_all',
  'simpa',
  'dsimp',
  'rw',
  'rwa',
  'erw',
  'exact',
  'exacts',
  'apply',
  'refine',
  'intro',
  'intros',
  'rintro',
  'induction',
  'cases',
  'rcases',
  'obtain',
  'rfl',
  'omega',
  'linarith',
  'nlinarith',
  'positivity',
  'norm_num',
  'aesop',
  'constructor',
  'use',
  'exists',
  'ring',
  'ring_nf',
  'field_simp',
  'decide',
  'trivial',
  'contradiction',
  'exfalso',
  'by_contra',
  'by_cases',
  'push_neg',
  'specialize',
  'unfold',
  'subst',
  'calc',
  'gcongr',
  'tauto',
  'assumption',
];

const leanTypes: string[] = [
  'Type',
  'Sort',
  'Prop',
  'Nat',
  'Int',
  'Bool',
  'String',
  'List',
  'Fin',
  'Set',
  'Option',
  'Array',
  'IO',
  'ℕ',
  'ℤ',
  'ℚ',
  'ℝ',
  'ℂ',
];

const leanSpecialWords: string[] = ['sorry', 'admit'];

export const leanLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: 'variable',
  ignoreCase: false,
  tokenPostfix: '.lean',
  keywords: leanKeywords,
  tactics: leanTactics,
  types: leanTypes,
  specialWords: leanSpecialWords,
  identifierStart: /[a-zA-Z_À-ɏͰ-῿⁰-↏Ⰰ-퟿豈-﷏ﷰ-￯]/,
  identifierPart: /[a-zA-Z0-9_'₀-₉À-ɏͰ-῿⁰-↏Ⰰ-퟿豈-﷏ﷰ-￯]/,
  identifier:
    /@identifierStart@identifierPart*(?:\.@identifierStart@identifierPart*)*/,
  number:
    /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)/,
  operators:
    /(?:<;>|<->|:=|=>|->|<-|<=|>=|!=|[+\-*/=<>|:&!^~?]+|[→←↔∀∃∧∨¬≠≤≥∈∉⊆∑∏×∘⟨⟩·▸])/,
  brackets: [
    { open: '(', close: ')', token: 'delimiter' },
    { open: '[', close: ']', token: 'delimiter' },
    { open: '{', close: '}', token: 'delimiter' },
    { open: '⟨', close: '⟩', token: 'delimiter' },
  ],
  tokenizer: {
    root: [
      [/\/--|\/-!/, { token: 'comment.doc', next: '@docComment' }],
      [/\/-/, { token: 'comment', next: '@blockComment' }],
      [/--.*$/, 'comment'],
      [/@\[/, { token: 'annotation', next: '@attribute' }],
      [
        /#(?:check|eval|print|reduce|exit|synth|help|lint)\b/,
        'annotation.directive',
      ],
      // Raw strings have no escapes: r"..." and r#"..."#.
      [/r"/, { token: 'string.quote', next: '@rawString' }],
      [/r(#+)"/, { token: 'string.quote', next: '@rawHashString.$1' }],
      [/"/, { token: 'string.quote', next: '@string' }],
      [
        /'(?:\\(?:[\\'"nrt0]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})|[^\\'\r\n])'/,
        'string.char',
      ],
      [/@number/, 'number'],
      [/@operators/, 'keyword.flow'],
      [
        /@identifier/,
        {
          cases: {
            '@specialWords': 'invalid.sorry',
            '@tactics': 'type.tactic',
            '@types': 'type',
            '@keywords': 'keyword',
            // Uncolored, so keywords and tactics stand out from names.
            '@default': 'identifier',
          },
        },
      ],
      [/[()\[\]{}⟨⟩]/, '@brackets'],
      [/[.,;:]/, 'delimiter'],
      [/\s+/, 'white'],
      // Unmatched Lean/Mathlib notation stays neutral; only sorry/admit are red.
      [/./, 'identifier'],
    ],
    blockComment: [
      [/\/-/, { token: 'comment', next: '@push' }],
      [/-\//, { token: 'comment', next: '@pop' }],
      [/[^/-]+/, 'comment'],
      [/./, 'comment'],
    ],
    docComment: [
      [/\/-/, { token: 'comment.doc', next: '@push' }],
      [/-\//, { token: 'comment.doc', next: '@pop' }],
      [/[^/-]+/, 'comment.doc'],
      [/./, 'comment.doc'],
    ],
    string: [
      [/\\(?:[\\'"nrt0]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/, 'string.escape'],
      [/\\./, 'invalid.escape'],
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/[^\\"]+/, 'string'],
      [/\\/, 'invalid.escape'],
    ],
    rawString: [
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/[^"]+/, 'string'],
    ],
    rawHashString: [
      [
        /"(#+)/,
        {
          cases: {
            '$1==$S2': { token: 'string.quote', next: '@pop' },
            '@default': 'string',
          },
        },
      ],
      [/[^"]+/, 'string'],
      [/"/, 'string'],
    ],
    attribute: [
      [/\]/, { token: 'annotation', next: '@pop' }],
      [/[a-zA-Z_][a-zA-Z0-9_']*/, 'annotation'],
      [/[,\s]+/, 'annotation'],
      [/./, 'annotation'],
    ],
  },
};

export const leanLanguageConfiguration: monaco.languages.LanguageConfiguration =
  {
    comments: { lineComment: '--', blockComment: ['/-', '-/'] },
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
      ['⟨', '⟩'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '⟨', close: '⟩' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: '/-', close: ' -/', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '⟨', close: '⟩' },
      { open: '"', close: '"' },
    ],
  };

type MathLanguageRegistration = {
  id: string;
  extensions: string[];
  aliases: string[];
  grammar: monaco.languages.IMonarchLanguage;
  configuration: monaco.languages.LanguageConfiguration;
};

const mathLanguages: MathLanguageRegistration[] = [
  {
    id: LATEX_LANGUAGE_ID,
    extensions: ['.tex', '.sty', '.cls', '.ltx', '.bbl'],
    aliases: ['LaTeX', 'TeX'],
    grammar: latexLanguage,
    configuration: latexLanguageConfiguration,
  },
  {
    id: BIBTEX_LANGUAGE_ID,
    extensions: ['.bib'],
    aliases: ['BibTeX'],
    grammar: bibtexLanguage,
    configuration: bibtexLanguageConfiguration,
  },
  {
    id: LEAN_LANGUAGE_ID,
    extensions: ['.lean'],
    aliases: ['Lean 4', 'Lean'],
    grammar: leanLanguage,
    configuration: leanLanguageConfiguration,
  },
];

/** Register the math languages only when Monaco has not registered them yet. */
export function registerMathLanguages(monacoApi: {
  languages: Pick<
    typeof monaco.languages,
    | 'register'
    | 'getLanguages'
    | 'setMonarchTokensProvider'
    | 'setLanguageConfiguration'
  >;
}): void {
  for (const language of mathLanguages) {
    const isRegistered = monacoApi.languages
      .getLanguages()
      .some((registeredLanguage) => registeredLanguage.id === language.id);

    if (isRegistered) {
      continue;
    }

    monacoApi.languages.register({
      id: language.id,
      extensions: language.extensions,
      aliases: language.aliases,
    });
    monacoApi.languages.setMonarchTokensProvider(language.id, language.grammar);
    monacoApi.languages.setLanguageConfiguration(
      language.id,
      language.configuration,
    );
  }
}
