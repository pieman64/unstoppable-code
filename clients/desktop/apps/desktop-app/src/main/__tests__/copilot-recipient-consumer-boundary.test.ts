// CAN-4960 (T21): Electron consumers hold results and opaque handles only.
// The SDK client, leases, tokens and token callbacks stay inside the
// recipient module, and only the grant authority reaches the credential store.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const main = 'apps/desktop-app/src/main';
const shared = 'packages/desktop-shared/src';
const connection = `${main}/copilot/connection.ts`;
const recipient = `${main}/copilot/recipient.ts`;
const authority = `${main}/copilot/grant-authority.ts`;
const broker = `${main}/copilot/credential-broker.ts`;
const handleModule = `${shared}/node/copilot/recipient-handle.ts`;
const turnDriver = `${shared}/node/copilot/turn-driver.ts`;
const sharedPipeline = `${shared}/node/pipelines/copilot-prompt-runner.ts`;

interface ImportRule {
  /** Importers allowed any import, including values. */
  value: readonly string[];
  /** Importers allowed `import type` only. */
  type: readonly string[] | 'any';
}
/** Module (repository path without extension) → who may import it. */
const IMPORT_RULES: Record<string, ImportRule> = {
  [`${main}/copilot/credential-store`]: { value: [authority], type: [broker] },
  [`${main}/copilot/grant-authority`]: {
    value: [connection],
    type: [recipient],
  },
  [`${main}/copilot/recipient`]: { value: [connection], type: [] },
  [`${shared}/node/copilot/runtime`]: {
    value: [connection],
    type: [recipient, turnDriver],
  },
  [`${shared}/node/copilot/runtime-auth`]: {
    value: [],
    type: [recipient, broker],
  },
  [`${shared}/node/copilot/turn-driver`]: { value: [connection], type: 'any' },
};

/** The recipient module may hold leases, tokens and the SDK client. */
const RECIPIENT_MODULE = new Set([
  connection,
  recipient,
  authority,
  broker,
  `${main}/copilot/credential-store.ts`,
  `${shared}/node/copilot/runtime-auth.ts`,
  `${shared}/node/copilot/runtime.ts`,
  `${shared}/node/copilot/session-policy.ts`,
  turnDriver,
]);
/** Credential-bearing types and members no consumer may name. */
const FORBIDDEN_NAMES = new Set([
  'ManagedCopilotRuntime',
  'OwnedCopilotRuntime',
  'CopilotRuntimeAuth',
  'CopilotOperationAuth',
  'CopilotRecipientLease',
  'CopilotRecipient',
  'tokenProviderForSession',
  'authForOperation',
  'gitHubToken',
  'gitHubTokenProvider',
  // Token minting and stored-grant reads, however they are reached.
  'createCopilotCredentialBroker',
  'CopilotCredentialBroker',
  'copilotGrantAuthority',
  'readCopilotCredential',
]);
/** Handle consumers read results; these members would reach past them. */
const FORBIDDEN_HANDLE_MEMBERS = new Set([
  'client',
  'auth',
  'admit',
  'token',
  'tokenProvider',
  'rpc',
]);
const HANDLE_MEMBERS = [
  'account',
  'close',
  'generation',
  'getQuota',
  'listModels',
  'runTurn',
];
const CONNECTION_EXPORTS = new Set([
  'COPILOT_SETUP_TIMEOUT_MS',
  'COPILOT_INSTALL_TIMEOUT_MS',
  'recoverCopilotAtStartup',
  'copilotConnectionStatus',
  'openManagedCopilotRuntime',
  'assertCopilotConnectionGeneration',
  'revokeCopilotRuntimes',
  'readCopilotAccount',
  'connectCopilot',
  'resetCopilotShutdownForTests',
  'shutdownCopilotRuntimes',
  'disconnectCopilot',
  'listCopilotModels',
  'assertCopilotModelAvailable',
  'getCopilotAccountGeneration',
  'readCopilotAccountUsage',
]);

function parse(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function resolveSpecifier(specifier: string, file: string): string | null {
  const withoutExtension = (value: string): string =>
    value.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  if (specifier.startsWith('.'))
    return withoutExtension(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      ),
    );
  if (specifier.startsWith('@canopy/desktop-shared/'))
    return withoutExtension(
      `${shared}/${specifier.slice('@canopy/desktop-shared/'.length)}`,
    );
  return null;
}

interface ModuleUse {
  module: string;
  typeOnly: boolean;
}

function moduleUses(root: ts.SourceFile, file: string): ModuleUse[] {
  const uses: ModuleUse[] = [];
  const add = (specifier: ts.Expression, typeOnly: boolean): void => {
    if (!ts.isStringLiteralLike(specifier)) return;
    const module = resolveSpecifier(specifier.text, file);
    if (module) uses.push({ module, typeOnly });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      add(
        node.moduleSpecifier,
        !!clause &&
          (clause.isTypeOnly ||
            (!clause.name &&
              !!named &&
              ts.isNamedImports(named) &&
              named.elements.length > 0 &&
              named.elements.every((element) => element.isTypeOnly))),
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      add(node.arguments[0], false);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return uses;
}

function importsHandleApi(root: ts.SourceFile, file: string): boolean {
  if (file === sharedPipeline) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportSpecifier(node) || ts.isTypeReferenceNode(node)) &&
      ['openManagedCopilotRuntime', 'CopilotRecipientHandle'].includes(
        (ts.isImportSpecifier(node)
          ? (node.propertyName ?? node.name)
          : node.typeName
        ).getText(root),
      )
    )
      found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
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
  return null;
}

function exportedNames(root: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of root.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement))
      names.push('<re-export>');
    if (!exported) continue;
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        names.push(declaration.name.getText(root));
    else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text);
  }
  return names;
}

function violations(source: string, file: string): string[] {
  const root = parse(source, file);
  const result: string[] = [];
  for (const use of moduleUses(root, file)) {
    const rule = IMPORT_RULES[use.module];
    if (!rule || rule.value.includes(file)) continue;
    if (use.typeOnly && (rule.type === 'any' || rule.type.includes(file)))
      continue;
    result.push(`${use.typeOnly ? 'type' : 'value'} import of ${use.module}`);
  }
  if (!RECIPIENT_MODULE.has(file)) {
    const handleConsumer = importsHandleApi(root, file);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && FORBIDDEN_NAMES.has(node.text))
        result.push(`credential name ${node.text}`);
      const member = memberName(node);
      if (member && FORBIDDEN_NAMES.has(member))
        result.push(`credential name ${member}`);
      if (handleConsumer && member && FORBIDDEN_HANDLE_MEMBERS.has(member))
        result.push(`handle member ${member}`);
      ts.forEachChild(node, visit);
    };
    visit(root);
  }
  if (file === connection) {
    for (const name of exportedNames(root))
      if (!CONNECTION_EXPORTS.has(name))
        result.push(`unexpected connection export ${name}`);
    const opener = root.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === 'openManagedCopilotRuntime',
    );
    if (opener?.type?.getText(root) !== 'Promise<CopilotRecipientHandle>')
      result.push('openManagedCopilotRuntime must return the recipient handle');
  }
  return result.filter((value, index) => result.indexOf(value) === index);
}

function handleShape(source: string): string[] | null {
  const root = parse(source, handleModule);
  const declaration = root.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'CopilotRecipientHandle',
  );
  if (!declaration || declaration.heritageClauses?.length) return null;
  return declaration.members
    .map((member) => member.name?.getText(root) ?? '<index>')
    .sort();
}

/** Only files that can touch the boundary are parsed; the rest are skipped by text. */
const RELEVANT = new RegExp(
  [
    'credential-store',
    'credential-broker',
    'grant-authority',
    'copilot/recipient',
    './recipient',
    'copilot/runtime',
    './runtime',
    'turn-driver',
    'openManagedCopilotRuntime',
    'CopilotRecipientHandle',
    'copilot-prompt-runner',
    ...Array.from(FORBIDDEN_NAMES),
  ]
    .map((fragment: string) => fragment.replace(/[./]/g, '\\$&'))
    .join('|'),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === 'node_modules' ||
      entry.name === '__tests__' ||
      entry.name === '__mocks__' ||
      entry.name === 'tests' ||
      entry.name === 'generated' ||
      entry.name === 'dist' ||
      entry.name === 'out' ||
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

test('production Copilot consumers stay outside the recipient boundary', () => {
  const errors = ['apps', 'packages']
    .flatMap((directory) => sourceFiles(path.join(repositoryRoot, directory)))
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      if (!RELEVANT.test(source)) return [];
      const relative = path
        .relative(repositoryRoot, file)
        .split(path.sep)
        .join('/');
      return violations(source, relative).map(
        (error) => `${relative}: ${error}`,
      );
    });
  expect(errors).toEqual([]);
});

test('the recipient handle exposes results and lifecycle only', () => {
  let source: string | undefined;
  try {
    source = readFileSync(path.join(repositoryRoot, handleModule), 'utf8');
  } catch {
    source = undefined;
  }
  expect(source && handleShape(source)).toEqual(HANDLE_MEMBERS);
});

test.each([
  [
    `${main}/agents/copilot-session.ts`,
    "import { openManagedCopilotRuntime } from '../copilot/connection'; const r = await openManagedCopilotRuntime(o); r.client.rpc.models.list({});",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "import { openManagedCopilotRuntime } from '../copilot/connection'; const { auth } = await openManagedCopilotRuntime(o);",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "import { openManagedCopilotRuntime } from '../copilot/connection'; const r = await openManagedCopilotRuntime(o); r['tokenProvider'];",
  ],
  [
    sharedPipeline,
    'async function run(host) { const r = await host.open(s); await r.admit(); }',
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "import { runCopilotTurn } from '@canopy/desktop-shared/node/copilot/turn-driver';",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "const { runCopilotTurn } = await import('@canopy/desktop-shared/node/copilot/turn-driver');",
  ],
  [
    `${main}/copilot/account-usage.ts`,
    "import { readCopilotCredential } from './credential-store';",
  ],
  [
    `${main}/copilot/connection.ts`,
    "import type { CopilotGrant } from './credential-store';",
  ],
  [
    `${main}/copilot/credential-broker.ts`,
    "import { readCopilotCredential } from './credential-store';",
  ],
  [
    `${main}/ipc/copilot-connection.ts`,
    "import { copilotGrantAuthority } from '../copilot/grant-authority';",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "import { CopilotRecipient } from '../copilot/recipient';",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "import { startCopilotRuntime } from '@canopy/desktop-shared/node/copilot/runtime';",
  ],
  [
    sharedPipeline,
    "import type { CopilotRuntimeAuth } from '../copilot/runtime-auth';",
  ],
  [
    `${main}/agents/delegation/copilot-runner.ts`,
    'runTurn({ gitHubTokenProvider: provider });',
  ],
  [
    `${main}/pipelines/copilot-prompt-runner.ts`,
    'type Runtime = ManagedCopilotRuntime;',
  ],
  [
    connection,
    'export function issueCopilotToken() {} export async function openManagedCopilotRuntime(): Promise<CopilotRecipientHandle> {}',
  ],
  [
    connection,
    'export async function openManagedCopilotRuntime(): Promise<OwnedCopilotRuntime> {}',
  ],
  [connection, "export { copilotGrantAuthority } from './grant-authority';"],
  [
    `${main}/copilot/account-usage.ts`,
    "import { createCopilotCredentialBroker } from './credential-broker';",
  ],
  [`${main}/copilot/index.ts`, "export * from './credential-store';"],
  [
    `${main}/agents/copilot-session.ts`,
    "import { startCopilotRuntime } from '@canopy/desktop-shared/node/copilot/runtime.js';",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    "const store = require('../copilot/credential-store');",
  ],
  [
    `${main}/agents/copilot-session.ts`,
    'const store = await import(`../copilot/credential-store`);',
  ],
])('detects a boundary bypass in %s: %s', (file, source) => {
  expect(violations(source, file).length).toBeGreaterThan(0);
});

test.each([
  'export interface CopilotRecipientHandle extends Handle { runTurn(): void; }',
  'export interface CopilotRecipientHandle { account: A; close(): void; generation: number; getQuota(): Q; listModels(): M; runTurn(): R; client: C; }',
  'export interface CopilotRecipientHandle { account: A; close(): void; generation: number; getQuota(): Q; listModels(): M; runTurn(): R; tokenProvider: P; }',
])('detects a widened recipient handle: %s', (source) => {
  expect(handleShape(source)).not.toEqual(HANDLE_MEMBERS);
});
