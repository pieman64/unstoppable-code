import { join } from 'node:path';
import ts from 'typescript';

// The checker, not ts-jest's transpile-only pass, proves these surfaces.
const header = `
import type { InProcessCanopyClient as Local } from '@canopy/core-runtime';
import type {
  CanopyInstructionDefinitionMap as I,
  CanopyQueryDefinitionMap as Q,
  CanopyStreamDefinitionMap as S,
} from '@canopy/protocol/canopy-core';
import type { connectCanopyClient } from '../index';
type Ops = 'query' | 'instruction' | 'openStream';
type None = Record<never, never>;
type Remote<Qs extends Q, Is extends I = None, Ss extends S = None> =
  Pick<Awaited<ReturnType<typeof connectCanopyClient<Qs, Is, Ss>>>, Ops>;
`;
const SOURCES = {
  'parity.virtual.ts': `${header}
import type { CANONICAL_DEFINITIONS } from '../../__tests__/fixtures/canonical-core';
type D = typeof CANONICAL_DEFINITIONS;
type Both<A, B> = [(a: A) => B, (b: B) => A];
export type Explicit = Both<Remote<D['queries'], D['instructions'], D['streams']>,
  Pick<Local<D['queries'], D['instructions'], D['streams']>, Ops>>;
export type Wide = Both<Remote<Q, I, S>, Pick<Local, Ops>>;
export type Defaulted = Both<Remote<D['queries']>,
  Pick<Local<D['queries'], None, None>, Ops>>;
// An any-typed connector would satisfy every check above.
type IsAny<T> = 0 extends 1 & T ? true : false;
export const typed: IsAny<Remote<Q, I, S>['openStream']> = false;
export const checks: [Explicit, Wide, Defaulted] = [
  [(a) => a, (b) => b], [(a) => a, (b) => b], [(a) => a, (b) => b],
];
`,
  // Negative control: a surface without openStream must not satisfy parity.
  'missing.virtual.ts': `${header}
export const missing = (a: Omit<Remote<Q, I, S>, 'openStream'>): Pick<Local, Ops> => a;
`,
};

// TypeScript hands the host forward-slash paths, even on Windows.
const virtualPath = (name: string): string =>
  join(__dirname, name).replace(/\\/g, '/');

function diagnose(): Record<string, string[]> {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(__dirname, '../../../tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!parsed) throw new Error('core-client tsconfig did not parse.');
  const options: ts.CompilerOptions = {
    ...parsed.options,
    // Build layout options are dropped: the program also loads core-runtime.
    rootDir: undefined,
    outDir: undefined,
    composite: false,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
  };
  const files = new Map(
    Object.entries(SOURCES).map(([name, text]) => [virtualPath(name), text]),
  );
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (file): boolean => files.has(file) || base.fileExists(file),
    readFile: (file): string | undefined =>
      files.get(file) ?? base.readFile(file),
    getSourceFile: (file, version, ...rest): ts.SourceFile | undefined => {
      const text = files.get(file);
      if (text === undefined) return base.getSourceFile(file, version, ...rest);
      return ts.createSourceFile(file, text, version);
    },
  };
  const program = ts.createProgram(Array.from(files.keys()), options, host);
  return Object.fromEntries(
    Object.keys(SOURCES).map((name) => [
      name,
      ts
        .getPreEmitDiagnostics(
          program,
          program.getSourceFile(virtualPath(name)),
        )
        .map(
          ({ code, messageText }) =>
            `TS${code}: ${ts.flattenDiagnosticMessageText(messageText, ' ')}`,
        ),
    ]),
  );
}

describe('connectCanopyClient operation parity with InProcessCanopyClient', () => {
  it('matches explicit, wide, and defaulted surfaces both ways; a missing openStream fails', () => {
    expect(diagnose()).toEqual({
      'parity.virtual.ts': [],
      'missing.virtual.ts': [
        expect.stringMatching(/^TS2741: Property 'openStream' is missing/),
      ],
    });
  }, 30_000);
});
