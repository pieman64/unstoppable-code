import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Only canopy-paths needs a mixed-module transform; source consumers stay lazy.
// Retain node_modules inclusion for bundled CommonJS dependencies.
export const workspaceCommonjsOptions = {
  include: [
    /node_modules/,
    /[/\\]packages[/\\](?:desktop-shared|execution-engine)[/\\]src[/\\]canopy-paths\.[jt]s$/,
  ],
  extensions: ['.js', '.cjs', '.ts'],
  transformMixedEsModules: true,
};

function literalString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = literalString(node.left);
    const right = literalString(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

function nodesIn(ast) {
  const nodes = [];
  const pending = [ast];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string') nodes.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) pending.push(child);
      } else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return nodes;
}

function memberName(node) {
  return node.computed ? literalString(node.property) : node.property?.name;
}

export function assertNoWorkspaceImports(code, fileName, parse) {
  const nodes = nodesIn(parse(code));
  const factories = new Set(['createRequire']);
  const loaders = new Set(['require']);
  for (const node of nodes) {
    if (
      node.type === 'ImportDeclaration' &&
      ['module', 'node:module'].includes(literalString(node.source))
    ) {
      for (const specifier of node.specifiers) {
        if (specifier.imported?.name === 'createRequire')
          factories.add(specifier.local.name);
      }
    }
  }
  function isFactory(node) {
    if (node?.type === 'SequenceExpression')
      return isFactory(node.expressions.at(-1));
    return (
      (node?.type === 'Identifier' && factories.has(node.name)) ||
      (node?.type === 'MemberExpression' &&
        memberName(node) === 'createRequire')
    );
  }
  function isLoader(node) {
    if (node?.type === 'SequenceExpression')
      return isLoader(node.expressions.at(-1));
    return (
      (node?.type === 'Identifier' &&
        (loaders.has(node.name) || /^__require\d*$/.test(node.name))) ||
      (node?.type === 'MemberExpression' && memberName(node) === 'require') ||
      (node?.type === 'CallExpression' && isFactory(node.callee))
    );
  }
  // Track statically named loaders, including minified createRequire aliases.
  // This is not general data-flow analysis of arbitrary computed specifiers.
  let previousSize;
  do {
    previousSize = loaders.size;
    for (const node of nodes) {
      const binding =
        node.type === 'VariableDeclarator'
          ? node.id
          : node.type === 'AssignmentExpression'
            ? node.left
            : null;
      const value = node.type === 'VariableDeclarator' ? node.init : node.right;
      if (binding?.type === 'Identifier' && isLoader(value))
        loaders.add(binding.name);
    }
  } while (loaders.size !== previousSize);

  for (const node of nodes) {
    const isRequire =
      node.type === 'CallExpression' &&
      (isLoader(node.callee) ||
        (node.callee.type === 'MemberExpression' &&
          memberName(node.callee) === 'resolve' &&
          isLoader(node.callee.object)));
    const source = isRequire
      ? node.arguments[0]
      : node.type === 'ImportExpression' ||
          node.type === 'ImportDeclaration' ||
          node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportAllDeclaration'
        ? node.source
        : null;
    const specifier = literalString(source);
    if (specifier?.startsWith('@canopy/')) {
      throw new Error(
        `${fileName}: unbundled workspace import ${JSON.stringify(specifier)}. ` +
          'Desktop Node bundles must inline workspace packages; check aliases, dependency externalization and CommonJS transforms.',
      );
    }
  }
}

export function workspaceBundleGuardPlugin() {
  let outputDir = '';
  let bundleWritten = false;
  return {
    name: 'canopy:workspace-bundle-guard',
    apply: 'build',
    configResolved(config) {
      outputDir = config.build.outDir;
    },
    buildStart() {
      bundleWritten = false;
    },
    writeBundle() {
      bundleWritten = true;
    },
    // Bytecode fallbacks, utility workers and the safe-storage helper are
    // written by other plugins. Inspect their final JavaScript too.
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (!bundleWritten) return;
        for (const file of readdirSync(outputDir, { recursive: true })) {
          if (!/\.(?:cjs|mjs|js)$/.test(file)) continue;
          const fileName = resolve(outputDir, file);
          assertNoWorkspaceImports(
            readFileSync(fileName, 'utf8'),
            fileName,
            (code) => this.parse(code),
          );
        }
      },
    },
  };
}
