import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { SCRIPT_ACTION_RESERVED_SHORTCUTS } from '@canopy/protocol/script-actions/reserved-shortcuts';
// The shared shortcut registry is display data with no UI imports; desktop
// command definitions read their keys from it with formatShortcut(id).
import {
  formatShortcut,
  SHORTCUTS,
  type ShortcutId,
} from '@canopy/ui-shared/lib/shortcuts';

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

function isRegistryId(id: string): id is ShortcutId {
  return Object.hasOwn(SHORTCUTS, id);
}

/** The reservation a registry binding must match, in accelerator spelling. */
function registryAccelerators(id: ShortcutId): {
  darwin: string;
  other: string;
} {
  return {
    darwin: canonical(formatShortcut(id, 'mac')),
    other: canonical(formatShortcut(id, 'other')),
  };
}

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
    const binding = SCRIPT_ACTION_RESERVED_SHORTCUTS.find(
      (entry) => entry.id === id.text,
    );
    const [first, second] = shortcut.arguments;
    if (
      first &&
      second &&
      ts.isStringLiteral(first) &&
      ts.isStringLiteral(second)
    ) {
      // A chord spelled in place: formatShortcut('<mac>', '<other>').
      expect(binding).toMatchObject({
        darwin: canonical(first.text),
        other: canonical(second.text),
      });
    } else if (first && !second && ts.isStringLiteral(first)) {
      // A chord read from the shared registry: formatShortcut('<id>'). It
      // must name this command's own registry entry.
      expect(first.text).toBe(id.text);
      if (!isRegistryId(first.text)) {
        throw new Error(`${first.text} is not in the shortcut registry`);
      }
      expect(binding).toMatchObject(registryAccelerators(first.text));
    } else {
      continue;
    }
    count++;
  }
  expect(count).toBeGreaterThan(30);
});

it('keeps every reserved binding the shortcut registry names in step with it', () => {
  let count = 0;
  for (const binding of SCRIPT_ACTION_RESERVED_SHORTCUTS) {
    if (!isRegistryId(binding.id)) continue;
    expect({ darwin: binding.darwin, other: binding.other }).toEqual(
      registryAccelerators(binding.id),
    );
    count++;
  }
  expect(count).toBeGreaterThan(30);
});
