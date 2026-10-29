import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REQUIRED_ARGUMENTS = new Map<string, number>([
  ['isModelBlockedByStoredPolicy', 2],
  ['isModelBlockedByCurrentPolicy', 2],
  ['isOrgModelPolicyActiveForStoredAccount', 1],
  ['getModelGatewayRequirementForOwner', 1],
  ['getCurrentModelGatewayRequirementForOwner', 1],
  ['checkModelGatewayRoute', 2],
  ['resolveHelperModelForEnforcedGateway', 2],
]);

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__'
        ? []
        : productionTypeScriptFiles(target);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  });
}

it('requires an explicit owner argument at every model-enforcement call site', () => {
  const mainRoot = path.resolve(__dirname, '..');
  const violations: string[] = [];
  for (const file of productionTypeScriptFiles(mainRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const required = REQUIRED_ARGUMENTS.get(node.expression.text);
        if (required !== undefined && node.arguments.length < required) {
          const position = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          violations.push(
            `${path.relative(mainRoot, file)}:${String(position.line + 1)} ${node.expression.text}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
