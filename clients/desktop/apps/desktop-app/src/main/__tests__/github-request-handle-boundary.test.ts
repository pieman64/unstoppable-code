// CAN-4109: core GitHub code holds results through the request handle only.
// Tokens, the Octokit client, the broker and token resolution stay behind the
// desktop handle implementation; the handle exposes no credential member. The
// rest of the app still resolves tokens directly (CAN-4415, CAN-4736), so
// this guards the core modules, not the whole app.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const main = 'apps/desktop-app/src/main';
const coreGitHub = 'packages/core-runtime/src/node/github';
const handleModule = `${coreGitHub}/request-handle.ts`;
const implementation = `${main}/github/request-handle.ts`;
const adapter = `${main}/canopy-runtime/core-integration-adapter.ts`;
const dispatch = `${main}/canopy-runtime/github-integration-dispatch.ts`;
const pullRequestAdapter = `${main}/canopy-runtime/core-pull-request-adapter.ts`;
const pullRequestDispatch = `${main}/canopy-runtime/github-pull-request-dispatch.ts`;
const pullRequestWriteDispatch = `${main}/canopy-runtime/github-pull-request-write-dispatch.ts`;
const projectionCapture = `${main}/github/projection-capture.ts`;
const GUARDED_DESKTOP = [
  adapter,
  dispatch,
  pullRequestAdapter,
  pullRequestDispatch,
  pullRequestWriteDispatch,
  projectionCapture,
];

/** Core GitHub modules: the portable handlers and the desktop projections. */
function isGuarded(file: string): boolean {
  return file.startsWith(`${coreGitHub}/`) || GUARDED_DESKTOP.includes(file);
}

/** Modules a guarded file never imports: credentials, clients, daemon access. */
const FORBIDDEN_MODULES = [
  `${main}/lib/github-client`,
  // GitHub writes reach core only through the handle's write members.
  `${main}/lib/github-pr-writes`,
  `${main}/lib/github-broker`,
  `${main}/lib/github-pat-env`,
  `${main}/lib/secure-storage-policy`,
  `${main}/canopy-runtime/electron-daemon-access`,
  `${main}/canopy-runtime/electron-daemon-connection`,
  `${main}/canopy-runtime/electron-daemon-files-access`,
  '@octokit',
  'octokit',
];
/** What a guarded file may import from the auth module: the CLI's status. */
const AUTH_MODULE = `${main}/lib/github-auth`;
const AUTH_BINDINGS = new Set(['observeGitHubCli', 'legacyGitHubCliStatus']);
/** Only the implementation reads the credential; only adapters hold it. */
const IMPORT_RULES: Record<string, { binding: string; importers: string[] }> = {
  [AUTH_MODULE]: {
    binding: 'describeGitHubCredential',
    importers: [implementation],
  },
  [`${main}/github/request-handle`]: {
    binding: 'desktopGitHubRequestHandle',
    importers: [adapter, pullRequestAdapter],
  },
};
/** Credential-bearing names no guarded file may mention. */
const FORBIDDEN_NAMES = new Set([
  'resolveGitHubToken',
  'resolveGitHubTokenWithSource',
  'loadStoredPat',
  'loadGhCliToken',
  'readStoredPatWithStatus',
  'loadGitHubPat',
  'describeGitHubCredential',
  'getGitHubBroker',
  'getGitHubClient',
  'Octokit',
  'authenticationToken',
]);
/** Handle consumers read results; these members would reach past them. */
const FORBIDDEN_HANDLE_MEMBERS = new Set([
  'token',
  'authenticationToken',
  'auth',
  'client',
  'octokit',
  'headers',
  'lease',
]);
const HANDLE_MEMBERS = [
  'createPullRequest',
  'describe',
  'findOpenPullRequest',
  'getBranchHead',
  'getPullRequest',
  'listPullRequests',
  'listRepositories',
  'updatePullRequest',
];
/** Each member resolves to its pinned results-only type. */
const MEMBER_RESULTS: Record<string, string> = {
  describe: 'Promise<GitHubCredentialDescription>',
  getPullRequest: 'Promise<GitHubPullRequestRecord>',
  listPullRequests: 'Promise<GitHubPullRequestPage>',
  listRepositories: 'Promise<GitHubRepositorySnapshot>',
  getBranchHead: 'Promise<GitHubBranchHead|null>',
  createPullRequest: 'Promise<GitHubPullRequestLocator>',
  findOpenPullRequest: 'Promise<GitHubPullRequestLocator|null>',
  updatePullRequest: 'Promise<GitHubPullRequestLocator>',
};
/** Result and input types' members: GitHub's values, never a credential. */
const RESULT_MEMBERS: Record<string, string[]> = {
  GitHubPullRequestPage: ['endCursor', 'pullRequests'],
  GitHubRepositorySnapshot: ['repositories', 'snapshotId'],
  GitHubRepositoryRecord: ['fullName', 'permissions', 'updatedAt', 'webUrl'],
  GitHubBranchHead: ['sha'],
  GitHubPullRequestLocator: ['number', 'url'],
  GitHubPullRequestCreateInput: [
    'baseBranch',
    'body',
    'draft',
    'headBranch',
    'title',
  ],
  GitHubPullRequestUpdateInput: ['baseBranch', 'body', 'title'],
};
/** The write members take no call options, so no abort signal reaches them. */
const WRITE_MEMBER_PARAMETERS: Record<string, string[]> = {
  createPullRequest: ['GitHubRepositoryRef', 'GitHubPullRequestCreateInput'],
  updatePullRequest: ['GitHubPullRequestRef', 'GitHubPullRequestUpdateInput'],
};
/** The pull request record is the canonical projection minus core's ids. */
const PULL_REQUEST_RECORD =
  "Readonly<Omit<CorePullRequest,'pullRequestId'|'integrationId'|'repositoryId'|'revision'>>";
/** `describe()` resolves to configured state only; a widened result fails. */
const DESCRIPTION_MEMBERS = ['storedCredential', 'tokenSource'];

function parse(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function resolveSpecifier(specifier: string, file: string): string {
  const withoutExtension = (value: string): string =>
    value.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '');
  if (specifier.startsWith('.'))
    return withoutExtension(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      ),
    );
  return withoutExtension(specifier);
}

interface ModuleUse {
  module: string;
  /** Imported names, or null for a namespace, re-export or dynamic load. */
  names: string[] | null;
}

function moduleUses(root: ts.SourceFile, file: string): ModuleUse[] {
  const uses: ModuleUse[] = [];
  const add = (specifier: ts.Expression, names: string[] | null): void => {
    if (ts.isStringLiteralLike(specifier))
      uses.push({ module: resolveSpecifier(specifier.text, file), names });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      add(
        node.moduleSpecifier,
        bindings && ts.isNamespaceImport(bindings)
          ? null
          : [
              ...(node.importClause?.name ? ['default'] : []),
              ...(bindings && ts.isNamedImports(bindings)
                ? bindings.elements.map(
                    (element) => (element.propertyName ?? element.name).text,
                  )
                : []),
            ],
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, null);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      add(node.arguments[0], null);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return uses;
}

function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  if (ts.isBindingElement(node)) {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) || ts.isStringLiteralLike(key)
      ? key.text
      : null;
  }
  // Declared members too: a result type or object carrying a credential.
  if (
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node)
  )
    return ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
      ? node.name.text
      : null;
  return null;
}

function violations(source: string, file: string): string[] {
  const root = parse(source, file);
  const result: string[] = [];
  for (const use of moduleUses(root, file)) {
    const rule = IMPORT_RULES[use.module];
    if (
      rule &&
      !rule.importers.includes(file) &&
      (use.names === null || use.names.includes(rule.binding))
    )
      result.push(`import of ${rule.binding} from ${use.module}`);
    if (!isGuarded(file)) continue;
    if (
      FORBIDDEN_MODULES.some(
        (module) =>
          use.module === module || use.module.startsWith(`${module}/`),
      )
    )
      result.push(`import of ${use.module}`);
    if (
      use.module === AUTH_MODULE &&
      (use.names === null || use.names.some((name) => !AUTH_BINDINGS.has(name)))
    )
      result.push(`credential import from ${use.module}`);
  }
  if (isGuarded(file)) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text))
        result.push(`credential name ${node.text}`);
      const member = memberName(node);
      if (member && FORBIDDEN_HANDLE_MEMBERS.has(member))
        result.push(`handle member ${member}`);
      ts.forEachChild(node, visit);
    };
    visit(root);
  }
  return result.filter((value, index) => result.indexOf(value) === index);
}

function interfaceShape(source: string, name: string): string[] | null {
  const root = parse(source, handleModule);
  const declaration = root.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration || declaration.heritageClauses?.length) return null;
  return declaration.members
    .map((member) => member.name?.getText(root) ?? '<index>')
    .sort();
}

function handleShape(source: string): string[] | null {
  return interfaceShape(source, 'GitHubRequestHandle');
}

/** A member must resolve to its pinned result, not a wider type. */
function memberResult(source: string, name = 'describe'): string | null {
  const root = parse(source, handleModule);
  const declaration = root.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'GitHubRequestHandle',
  );
  const member = declaration?.members.find(
    (candidate): candidate is ts.MethodSignature =>
      ts.isMethodSignature(candidate) && candidate.name.getText(root) === name,
  );
  return member?.type?.getText(root).replace(/\s+/g, '') ?? null;
}

function describeResult(source: string): string | null {
  return memberResult(source);
}

/** A member's parameter types, in order. */
function memberParameters(source: string, name: string): string[] | null {
  const root = parse(source, handleModule);
  const declaration = root.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'GitHubRequestHandle',
  );
  const member = declaration?.members.find(
    (candidate): candidate is ts.MethodSignature =>
      ts.isMethodSignature(candidate) && candidate.name.getText(root) === name,
  );
  return (
    member?.parameters.map(
      (parameter) => parameter.type?.getText(root) ?? '<untyped>',
    ) ?? null
  );
}

function typeAlias(source: string, name: string): string | null {
  const root = parse(source, handleModule);
  const declaration = root.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  return declaration?.type.getText(root).replace(/\s+/g, '') ?? null;
}

const RELEVANT =
  /github-auth|github-client|github-broker|github-pat-env|octokit|request-handle|electron-daemon|secure-storage-policy|GitHubRequestHandle|Octokit|authenticationToken|resolveGitHubToken|getGitHubBroker/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      [
        'node_modules',
        '__tests__',
        '__mocks__',
        'tests',
        'generated',
        'dist',
        'out',
      ].includes(entry.name) ||
      entry.name.startsWith('.')
    )
      return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

test('core GitHub code stays outside the credential boundary', () => {
  const files = ['apps/desktop-app/src', 'packages/core-runtime/src'].flatMap(
    (directory) => sourceFiles(path.join(repositoryRoot, directory)),
  );
  const relative = (file: string): string =>
    path.relative(repositoryRoot, file).split(path.sep).join('/');
  // The guarded modules exist where this test expects them.
  for (const file of [...GUARDED_DESKTOP, implementation, handleModule])
    expect(files.map(relative)).toContain(file);
  const errors = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const name = relative(file);
    if (!isGuarded(name) && !RELEVANT.test(source)) return [];
    return violations(source, name).map((error) => `${name}: ${error}`);
  });
  expect(errors).toEqual([]);
});

test('the request handle exposes results only', () => {
  const source = readFileSync(path.join(repositoryRoot, handleModule), 'utf8');
  expect(handleShape(source)).toEqual(HANDLE_MEMBERS);
  expect(describeResult(source)).toBe('Promise<GitHubCredentialDescription>');
  for (const [member, result] of Object.entries(MEMBER_RESULTS))
    expect([member, memberResult(source, member)]).toEqual([member, result]);
  expect(interfaceShape(source, 'GitHubCredentialDescription')).toEqual(
    DESCRIPTION_MEMBERS,
  );
  for (const [name, members] of Object.entries(RESULT_MEMBERS))
    expect([name, interfaceShape(source, name)]).toEqual([name, members]);
  for (const [member, parameters] of Object.entries(WRITE_MEMBER_PARAMETERS))
    expect([member, memberParameters(source, member)]).toEqual([
      member,
      parameters,
    ]);
  expect(typeAlias(source, 'GitHubPullRequestRecord')).toBe(
    PULL_REQUEST_RECORD,
  );
});

test('detects an abort signal reaching a write member', () => {
  expect(
    memberParameters(
      'export interface GitHubRequestHandle { createPullRequest(r: GitHubRepositoryRef, i: GitHubPullRequestCreateInput, o: GitHubCallOptions): Promise<GitHubPullRequestLocator>; }',
      'createPullRequest',
    ),
  ).not.toEqual(WRITE_MEMBER_PARAMETERS.createPullRequest);
});

test.each([
  [
    'listRepositories',
    'export interface GitHubRequestHandle { listRepositories(o: O): Promise<GitHubRepositorySnapshot & { token: string }>; }',
  ],
  [
    'getPullRequest',
    'export interface GitHubRequestHandle { getPullRequest(r: R, o: O): Promise<unknown>; }',
  ],
])('detects a widened %s result', (member, source) => {
  expect(memberResult(source, member)).not.toBe(MEMBER_RESULTS[member]);
});

test.each([
  'export interface GitHubCredentialDescription { readonly tokenSource: S; readonly storedCredential: C; readonly token: string; }',
  'export interface GitHubCredentialDescription extends Base { readonly tokenSource: S; readonly storedCredential: C; }',
])('detects a widened credential description: %s', (source) => {
  expect(interfaceShape(source, 'GitHubCredentialDescription')).not.toEqual(
    DESCRIPTION_MEMBERS,
  );
});

test.each([
  'export interface GitHubRequestHandle { describe(): Promise<GitHubCredentialDescription & { token: string }>; }',
  'export interface GitHubRequestHandle { describe(): Promise<{ token: string }>; }',
])('detects a describe result other than the description: %s', (source) => {
  expect(describeResult(source)).not.toBe(
    'Promise<GitHubCredentialDescription>',
  );
});

test.each([
  [adapter, "import { resolveGitHubToken } from '../lib/github-auth';"],
  [adapter, "import { describeGitHubCredential } from '../lib/github-auth';"],
  [adapter, "import * as auth from '../lib/github-auth';"],
  [dispatch, "import { getGitHubClient } from '../lib/github-client';"],
  [dispatch, "import { getGitHubBroker } from '../lib/github-broker';"],
  [dispatch, "const broker = await import('../lib/github-broker/index');"],
  [dispatch, "import { Octokit } from '@octokit/rest';"],
  [adapter, "import { getElectronDaemon } from './electron-daemon-access';"],
  [
    `${coreGitHub}/core-integration.ts`,
    'async function read(handle) { const { token } = await handle.describe(); }',
  ],
  [
    `${coreGitHub}/core-integration.ts`,
    "function headers(h) { return h['authenticationToken']; }",
  ],
  [
    handleModule,
    'export interface GitHubCredentialDescription { readonly token: string; }',
  ],
  [
    `${coreGitHub}/core-integration.ts`,
    'const connection = { integrationId: id, headers: h };',
  ],
  [
    `${main}/ipc/settings.ts`,
    "import { describeGitHubCredential } from '../lib/github-auth';",
  ],
  [
    `${main}/ipc/github.ts`,
    "import { desktopGitHubRequestHandle } from '../github/request-handle';",
  ],
  [`${main}/ipc/github.ts`, "export * from '../github/request-handle';"],
  [
    pullRequestDispatch,
    "import { desktopGitHubRequestHandle } from '../github/request-handle';",
  ],
  [
    pullRequestDispatch,
    "import { getGitHubClient } from '../lib/github-client';",
  ],
  [
    projectionCapture,
    "import { getGitHubBroker } from '../lib/github-broker';",
  ],
  [
    `${coreGitHub}/core-pull-request.ts`,
    'const record = { number: 1, headers: h };',
  ],
  [
    pullRequestWriteDispatch,
    "import { desktopGitHubRequestHandle } from '../github/request-handle';",
  ],
  [
    pullRequestWriteDispatch,
    "import { getGitHubClient } from '../lib/github-client';",
  ],
  [
    pullRequestWriteDispatch,
    "import { createGitHubPullRequest } from '../lib/github-pr-writes';",
  ],
  [
    handleModule,
    'export interface GitHubPullRequestLocator { readonly number: number; readonly token: string; }',
  ],
])('detects a boundary bypass in %s: %s', (file, source) => {
  expect(violations(source, file).length).toBeGreaterThan(0);
});

test.each([
  [
    adapter,
    "import { observeGitHubCli, legacyGitHubCliStatus } from '../lib/github-auth';",
  ],
  [
    adapter,
    "import { desktopGitHubRequestHandle } from '../github/request-handle';",
  ],
  [
    implementation,
    "import { describeGitHubCredential } from '../lib/github-auth';",
  ],
  [
    pullRequestAdapter,
    "import { desktopGitHubRequestHandle } from '../github/request-handle';",
  ],
  [
    implementation,
    "import { listOpenPullRequestsForRepo } from '../lib/github-pr-listing';",
  ],
  // Outside the guarded modules, today's direct token users are not this test's.
  [
    `${main}/lib/github-pr.ts`,
    "import { resolveGitHubToken } from './github-auth';",
  ],
])('allows %s: %s', (file, source) => {
  expect(violations(source, file)).toEqual([]);
});

test.each([
  'export interface GitHubRequestHandle extends Base { describe(): D; }',
  'export interface GitHubRequestHandle { describe(): D; token(): string; }',
  'export interface GitHubRequestHandle { describe(): D; client: C; }',
])('detects a widened request handle: %s', (source) => {
  expect(handleShape(source)).not.toEqual(HANDLE_MEMBERS);
});
