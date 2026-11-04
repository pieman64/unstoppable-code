import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const nativeBoundary = 'apps/desktop-app/src/main/lib/safe-storage.ts';
const policyBoundary = 'apps/desktop-app/src/main/lib/secure-storage-policy.ts';
const recoveryBoundary =
  'apps/desktop-app/src/main/lib/linux-safe-storage-recovery.ts';
const helperBoundary =
  'apps/desktop-app/src/main/lib/linux-safe-storage-helper.ts';
const environmentStore =
  'apps/desktop-app/src/main/lib/user-environment-store.ts';
const remoteStore =
  'apps/desktop-app/src/main/remote-control/remote-access-store.ts';
const nativeNames = new Set([
  'safeStorage',
  'disableSafeStoragePlainTextEncryption',
  'getReadableSafeStorage',
  'getWritableSafeStorage',
  'ReadableSafeStorage',
  'WritableSafeStorage',
  'encryptString',
  'decryptString',
  'probeLinuxSafeStorageRecovery',
  'encryptWithLinuxSafeStorageRecovery',
  'decryptWithLinuxSafeStorageRecovery',
  'runLinuxSafeStorageHelper',
]);
const bypassNames = new Set([
  'setUsePlainTextEncryption',
  'encryptStringAsync',
  'decryptStringAsync',
]);

function memberName(node: ts.Node): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return null;
}

// Startup may only turn plaintext encryption OFF through the zero-argument
// native adapter. Policy owns Linux selection and harness overrides; consumers
// cannot call the adapter, access a native handle, alias the setter, or enable it.
function isStartupPlaintextOptOut(node: ts.Node, file: string): boolean {
  if (file === helperBoundary) {
    const member = ts.isIdentifier(node) ? node.parent : node;
    if (
      !ts.isPropertyAccessExpression(member) ||
      !ts.isIdentifier(member.expression) ||
      member.expression.text !== 'safeStorage'
    )
      return false;
    const call = member.parent;
    if (
      !ts.isCallExpression(call) ||
      call.expression !== member ||
      call.arguments.length !== 1 ||
      call.arguments[0].kind !== ts.SyntaxKind.FalseKeyword
    )
      return false;
    let owner: ts.Node | undefined = member;
    while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
    return owner?.name?.text === 'perform' && owner.parameters.length === 0;
  }
  if (file !== nativeBoundary) return false;
  const member = ts.isIdentifier(node) ? node.parent : node;
  if (
    !ts.isPropertyAccessExpression(member) ||
    !ts.isIdentifier(member.expression) ||
    member.expression.text !== 'storage'
  )
    return false;
  const use = member.parent;
  if (
    !ts.isTypeOfExpression(use) &&
    !(
      ts.isCallExpression(use) &&
      ts.isIdentifier(use.expression) &&
      use.expression.text === 'isCallable' &&
      use.arguments.length === 1 &&
      use.arguments[0] === member
    ) &&
    !(
      ts.isCallExpression(use) &&
      use.expression === member &&
      use.arguments.length === 1 &&
      use.arguments[0].kind === ts.SyntaxKind.FalseKeyword
    )
  )
    return false;
  let ancestor: ts.Node | undefined = member;
  while (ancestor && !ts.isFunctionDeclaration(ancestor))
    ancestor = ancestor.parent;
  return (
    ancestor?.name?.text === 'disableSafeStoragePlainTextEncryption' &&
    ancestor.parameters.length === 0
  );
}

function violations(source: string, file: string): string[] {
  const root = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const result: string[] = [];
  const allowedNative = [
    nativeBoundary,
    policyBoundary,
    recoveryBoundary,
    helperBoundary,
  ].includes(file);
  const visit = (node: ts.Node): void => {
    // Inspect imports, destructuring and computed members as well as ordinary calls.
    const name = memberName(node);
    if (
      name &&
      bypassNames.has(name) &&
      !(
        name === 'setUsePlainTextEncryption' &&
        isStartupPlaintextOptOut(node, file)
      )
    )
      result.push(`bypass:${name}`);
    const isNativeStorageMember =
      name !== 'safeStorage' ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isImportSpecifier(node.parent) ||
      ts.isBindingElement(node.parent);
    if (
      !allowedNative &&
      name &&
      nativeNames.has(name) &&
      isNativeStorageMember
    )
      result.push(`native:${name}`);
    if (name === 'runLinuxSafeStorageHelper' && file !== helperBoundary)
      result.push('helper entry outside isolated native adapter');
    if (file === policyBoundary && name === 'safeStorage')
      result.push('raw-native: safeStorage');
    if (
      name === 'getEnvironmentValueWritePolicy' &&
      file !== environmentStore &&
      file !== policyBoundary
    )
      result.push('environment fallback outside environment store');
    if (
      name === 'nativeEncryptionAvailable' &&
      file !== policyBoundary &&
      file !== remoteStore
    )
      result.push('native fallback outside remote identity');
    ts.forEachChild(node, visit);
  };
  visit(root);
  const boundaryExports =
    file === nativeBoundary
      ? new Set([
          'ReadableSafeStorage',
          'WritableSafeStorage',
          'SafeStorageBackendState',
          'SafeStorageStatus',
          'SafeStorageReadOptions',
          'SafeStorageWriteError',
          'getSafeStorageStatus',
          'disableSafeStoragePlainTextEncryption',
          'getReadableSafeStorage',
          'getWritableSafeStorage',
        ])
      : file === policyBoundary
        ? new Set([
            'SecretStoragePolicy',
            'EnvironmentValueWritePolicy',
            'SecureStorageOperationError',
            'getSecretStoragePolicy',
            'configureLinuxSecureStorage',
            'getSecureStorageFailure',
            'getEnvironmentValueWritePolicy',
          ])
        : file === helperBoundary
          ? new Set(['runLinuxSafeStorageHelper'])
          : file === recoveryBoundary
            ? new Set([
                'probeLinuxSafeStorageRecovery',
                'encryptWithLinuxSafeStorageRecovery',
                'decryptWithLinuxSafeStorageRecovery',
              ])
            : null;
  if (boundaryExports) {
    for (const statement of root.statements) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        if (!statement.name || !boundaryExports.has(statement.name.text))
          result.push('unexpected boundary export');
      }
      if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement))
        result.push('raw boundary re-export');
    }
  }
  if (
    [nativeBoundary, policyBoundary, helperBoundary, recoveryBoundary].includes(
      file,
    )
  ) {
    for (const statement of root.statements) {
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        result.push('exported raw storage variable');
    }
  }
  if (file === remoteStore) {
    const visitFallback = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        memberName(node.expression) === 'nativeEncryptionAvailable'
      ) {
        let ancestor: ts.Node | undefined = node.parent;
        let platformGuard = false;
        while (ancestor) {
          if (ts.isConditionalExpression(ancestor)) {
            const condition = ancestor.condition.getText(root);
            platformGuard ||=
              condition.includes("'darwin'") && condition.includes("'win32'");
          }
          if (ts.isIfStatement(ancestor)) {
            const condition = ancestor.expression.getText(root);
            platformGuard ||=
              condition.includes("'darwin'") && condition.includes("'win32'");
          }
          ancestor = ancestor.parent;
        }
        if (!platformGuard)
          result.push('remote plaintext fallback without macOS/Windows guard');
      }
      ts.forEachChild(node, visitFallback);
    };
    visitFallback(root);
  }
  return result.filter((value, index) => result.indexOf(value) === index);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === 'node_modules' ||
      entry.name === '__tests__' ||
      entry.name === 'tests' ||
      entry.name.startsWith('.')
    )
      return [];
    const full = path.join(directory, entry.name);
    // The E2E build stages this generated third-party PDF.js worker. Its
    // unrelated encryptString/decryptString members are not Electron storage.
    if (
      full ===
      path.join(
        repositoryRoot,
        'apps/desktop-app/src/renderer/public/pdf-worker',
      )
    )
      return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name)
      ? [full]
      : [];
  });
}

test('production secret consumers use only the shared policy boundary', () => {
  const errors = ['apps/desktop-app/src', 'packages']
    .flatMap((directory) => sourceFiles(path.join(repositoryRoot, directory)))
    .flatMap((file) => {
      const relative = path.relative(repositoryRoot, file);
      return violations(readFileSync(file, 'utf8'), relative).map(
        (error) => `${relative}: ${error}`,
      );
    });
  expect(errors).toEqual([]);
});

test.each([
  "import { safeStorage as vault } from 'electron'; vault.encryptString('fixture');",
  "import * as electron from 'electron'; electron.safeStorage.decryptString(buffer);",
  "const { safeStorage: vault } = require('electron');",
  "const vault = require('electron')['safeStorage']; vault['encryptString']('fixture');",
  "import { getWritableSafeStorage as getVault } from './safe-storage';",
  'vault.setUsePlainTextEncryption(true);',
  'vault.setUsePlainTextEncryption(false);',
  "import { disableSafeStoragePlainTextEncryption } from './safe-storage'; disableSafeStoragePlainTextEncryption();",
  "vault['decryptStringAsync'](buffer);",
  "import { getEnvironmentValueWritePolicy as fallback } from './secure-storage-policy';",
])('detects alternate bypass syntax: %s', (source) => {
  expect(violations(source, 'consumer.ts').length).toBeGreaterThan(0);
});

test('prevents new exports exposing native handles', () => {
  expect(
    violations(
      'export function rawVault() { return nativeVault; }',
      nativeBoundary,
    ),
  ).toContain('unexpected boundary export');
  expect(violations('export { nativeVault };', policyBoundary)).toContain(
    'raw boundary re-export',
  );
});

test('native startup adapter permits only a literal false call and an API check', () => {
  expect(
    violations(
      `export function disableSafeStoragePlainTextEncryption() {
    if (!isCallable(storage.setUsePlainTextEncryption)) throw new Error();
    storage.setUsePlainTextEncryption(false);
  }`,
      nativeBoundary,
    ),
  ).toEqual([]);
});

test.each([
  'storage.setUsePlainTextEncryption(true);',
  'storage.setUsePlainTextEncryption(enabled);',
  'const setter = storage.setUsePlainTextEncryption; setter(true);',
  'otherCheck(storage.setUsePlainTextEncryption);',
  "storage['setUsePlainTextEncryption'](true);",
])('native startup adapter still rejects bypass %s', (source) => {
  expect(
    violations(
      `export function disableSafeStoragePlainTextEncryption() { ${source} }`,
      nativeBoundary,
    ),
  ).toContain('bypass:setUsePlainTextEncryption');
});

test.each([nativeBoundary, policyBoundary])(
  'plaintext configuration remains forbidden elsewhere in %s',
  (file) => {
    expect(
      violations(
        'function unrelated() { storage.setUsePlainTextEncryption(false); }',
        file,
      ),
    ).toContain('bypass:setUsePlainTextEncryption');
  },
);

test.each([
  [
    nativeBoundary,
    'export function disableSafeStoragePlainTextEncryption(storage) { storage.setUsePlainTextEncryption(false); }',
  ],
  [
    nativeBoundary,
    'export function disableSafeStoragePlainTextEncryption() { other.setUsePlainTextEncryption(false); }',
  ],
  [
    policyBoundary,
    'export function disableSafeStoragePlainTextEncryption() { storage.setUsePlainTextEncryption(false); }',
  ],
])(
  'startup opt-out does not admit another signature, receiver, or boundary: %s',
  (file, source) => {
    expect(violations(source, file)).toContain(
      'bypass:setUsePlainTextEncryption',
    );
  },
);

// Recovery stays a native adapter, with no consumer-accessible native handle.
test('isolated recovery helper only disables plaintext in its bounded operation', () => {
  expect(
    violations(
      'async function perform() { safeStorage.setUsePlainTextEncryption(false); }',
      helperBoundary,
    ),
  ).toEqual([]);
  for (const statement of [
    'safeStorage.setUsePlainTextEncryption(true);',
    'safeStorage.setUsePlainTextEncryption(enabled);',
    'const setter = safeStorage.setUsePlainTextEncryption; setter(false);',
    "safeStorage['setUsePlainTextEncryption'](false);",
  ])
    expect(
      violations(`async function perform() { ${statement} }`, helperBoundary),
    ).toContain('bypass:setUsePlainTextEncryption');
  expect(
    violations(
      'function unrelated() { safeStorage.setUsePlainTextEncryption(false); }',
      helperBoundary,
    ),
  ).toContain('bypass:setUsePlainTextEncryption');
});

test.each([helperBoundary, recoveryBoundary])(
  'recovery boundary cannot export native handles: %s',
  (file) => {
    expect(
      violations('export function rawVault() { return safeStorage; }', file),
    ).toContain('unexpected boundary export');
    expect(violations('export const vault = safeStorage;', file)).toContain(
      'exported raw storage variable',
    );
    expect(violations('export { safeStorage };', file)).toContain(
      'raw boundary re-export',
    );
  },
);

test.each([
  'probeLinuxSafeStorageRecovery()',
  'encryptWithLinuxSafeStorageRecovery("fixture")',
  'decryptWithLinuxSafeStorageRecovery(buffer)',
  'runLinuxSafeStorageHelper()',
])('consumers cannot bypass policy through recovery: %s', (source) => {
  expect(violations(source, 'consumer.ts').length).toBeGreaterThan(0);
});
