import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const WEB_THEME_IDS = ['default', 'unstoppable'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Dynamic named themes must be resolved here before their CSS can be removed. */
export function checkWebThemeSource(source, file = 'source.tsx') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors = [];
  const literalText = (node) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  function propertyName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node))
      return literalText(node.argumentExpression);
    return undefined;
  }
  function check(value) {
    if (value && ts.isJsxExpression(value)) value = value.expression;
    if (
      !value ||
      !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ) {
      errors.push(
        `${file}: dynamic data-theme needs an explicit supported-value contract`,
      );
    } else if (!WEB_THEME_IDS.includes(value.text)) {
      errors.push(
        `${file}: unsupported web data-theme ${JSON.stringify(value.text)}`,
      );
    }
  }
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'data-theme') {
      check(node.initializer);
    }
    if (
      ts.isPropertyAssignment(node) &&
      (literalText(node.name) ??
        (ts.isComputedPropertyName(node.name)
          ? literalText(node.name.expression)
          : undefined)) === 'data-theme'
    ) {
      check(node.initializer);
    }
    if (ts.isCallExpression(node)) {
      const method = node.expression;
      const name = propertyName(method);
      const attributeIndex = name === 'setAttributeNS' ? 1 : 0;
      if (
        (name === 'setAttribute' || name === 'setAttributeNS') &&
        literalText(node.arguments[attributeIndex]) === 'data-theme'
      )
        check(node.arguments[attributeIndex + 1]);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = node.left;
      if (
        (ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
        propertyName(target) === 'theme' &&
        propertyName(target.expression) === 'dataset'
      )
        check(node.right);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return errors;
}

export function checkWebThemeUsage(checkout = root) {
  const errors = [];
  function scan(directory) {
    for (const entry of readdirSync(resolve(checkout, directory), {
      withFileTypes: true,
    })) {
      if (['__tests__', 'node_modules'].includes(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) scan(file);
      else if (
        /\.[jt]sx?$/.test(entry.name) &&
        !/\.(test|spec)\./.test(entry.name)
      ) {
        errors.push(
          ...checkWebThemeSource(
            readFileSync(resolve(checkout, file), 'utf8'),
            file,
          ),
        );
      }
    }
  }
  // Conservative: every browser-safe shared component may mount on the web.
  for (const directory of [
    'packages/ui-app/src',
    'packages/ui-shared/src',
    'packages/ui-rich/src',
  ]) {
    // The public desktop source export omits the hosted web app. Shared UI
    // remains mandatory and is checked even when the host is absent.
    if (
      directory === 'apps/web/src' &&
      !existsSync(resolve(checkout, 'apps/web'))
    )
      continue;
    scan(directory);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkWebThemeUsage();
  process.stdout.write(
    'Web named-theme usage matches the generated stylesheet.\n',
  );
}
