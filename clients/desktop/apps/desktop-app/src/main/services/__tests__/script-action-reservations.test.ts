import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { SCRIPT_ACTION_RESERVED_SHORTCUTS } from '@canopy/protocol/script-actions/reserved-shortcuts';

it('reserves every existing desktop command and panel chord without importing UI code', () => {
  const file = resolve(
    __dirname,
    '../../../renderer/src/lib/keyboardShortcuts.ts',
  );
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find(
      (item) =>
        ts.isIdentifier(item.name) && item.name.text === 'COMMAND_DEFINITIONS',
    );
  const array = declaration?.initializer;
  if (!array || !ts.isArrayLiteralExpression(array))
    throw new Error('Missing desktop command definitions');
  const glyphs: Record<string, string> = {
    '⌘': 'Command+',
    '⌃': 'Control+',
    '⌥': 'Alt+',
    '⇧': 'Shift+',
    '←': 'Left',
    '→': 'Right',
    '↑': 'Up',
    '↓': 'Down',
  };
  const canonical = (value: string): string =>
    value
      .replace(/[⌘⌃⌥⇧←→↑↓]/g, (glyph) => glyphs[glyph] ?? glyph)
      .replace(/Ctrl /g, 'Control+')
      .replace(/Shift /g, 'Shift+')
      .replace(/Alt /g, 'Alt+');
  let count = 0;
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const fields = element.properties.filter(ts.isPropertyAssignment);
    const id = fields.find(
      (field) => ts.isIdentifier(field.name) && field.name.text === 'id',
    )?.initializer;
    const shortcut = fields.find(
      (field) => ts.isIdentifier(field.name) && field.name.text === 'shortcut',
    )?.initializer;
    if (
      !id ||
      !ts.isStringLiteral(id) ||
      !shortcut ||
      !ts.isCallExpression(shortcut)
    )
      continue;
    const mac = shortcut.arguments[0];
    const other = shortcut.arguments[1];
    if (
      !mac ||
      !other ||
      !ts.isStringLiteral(mac) ||
      !ts.isStringLiteral(other)
    )
      continue;
    const binding = SCRIPT_ACTION_RESERVED_SHORTCUTS.find(
      (entry) => entry.id === id.text,
    );
    expect(binding).toMatchObject({
      darwin: canonical(mac.text),
      other: canonical(other.text),
    });
    count++;
  }
  expect(count).toBeGreaterThan(30);
});
