import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

interface ModuleImport {
  specifier: string;
  names: string[];
  typeOnly: boolean;
}

function importsOf(file: string): ModuleImport[] {
  const path = join(__dirname, '..', file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: ModuleImport[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          names.push((element.propertyName ?? element.name).text);
      found.push({
        specifier: node.moduleSpecifier.text,
        names,
        typeOnly: clause?.isTypeOnly === true,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names: string[] = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          names.push((element.propertyName ?? element.name).text);
      found.push({
        specifier: node.moduleSpecifier.text,
        names,
        typeOnly: node.isTypeOnly,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument))
        found.push({ specifier: argument.text, names: [], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const specifiers = (file: string): string[] =>
  importsOf(file).map(({ specifier }) => specifier);

describe('MCP proxy boundaries (CAN-4125)', () => {
  it('the agent connection service imports no tool, window or transport module', () => {
    const imported = specifiers('agent-mcp-connections.ts');
    expect(imported.length).toBeGreaterThan(0);
    for (const forbidden of [
      'electron',
      '../lib/window-send',
      './http-proxy-service',
      './canopy-tool-router',
      './canopy-route-tools',
    ])
      expect(imported).not.toContain(forbidden);
    for (const prefix of [
      '../canopy-tools/',
      '../app-advisor/',
      '../pipeline-editor/',
    ])
      expect(imported.filter((s) => s.startsWith(prefix))).toEqual([]);
  });

  it('the tool router and listing reach presentation only through the interface port', () => {
    for (const file of ['canopy-tool-router.ts', 'canopy-route-tools.ts']) {
      const imports = importsOf(file);
      const imported = imports.map(({ specifier }) => specifier);
      expect(imported.length).toBeGreaterThan(0);
      for (const forbidden of [
        'electron',
        '../lib/window-send',
        '../canopy-tools/show-files-runtime',
        './agent-mcp-connections',
      ])
        expect(imported).not.toContain(forbidden);
      const names = imports.flatMap((entry) => entry.names);
      for (const forbidden of [
        'requestAnswersFromRenderer',
        'requestShowFiles',
        'mainWindowOnlyToolSurfaces',
        'sendToWindow',
      ])
        expect(names).not.toContain(forbidden);
    }
  });

  it('the interface port imports no connection or plugin module', () => {
    const imports = importsOf('interface-tool-requests.ts');
    const imported = imports.map(({ specifier }) => specifier);
    expect(imported).not.toContain('./agent-mcp-connections');
    expect(imported.filter((s) => s.startsWith('../plugins/'))).toEqual([]);
    // ShowVisual stages through core.chat.visual.stage, not the port (CAN-5996).
    expect(imported).not.toContain('../canopy-tools/show-visual-host');
    expect(imports.flatMap((entry) => entry.names)).not.toContain(
      'createShowVisualHost',
    );
    for (const entry of imports)
      if (entry.specifier === './canopy-tool-router')
        expect(entry.typeOnly).toBe(true);
  });
});
