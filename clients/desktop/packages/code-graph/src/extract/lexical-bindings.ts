import type { Node } from 'web-tree-sitter';
import type { CodeGraphSymbolRecord } from '../types/code-graph';

interface Scope {
  parent: Scope | null;
  functionScope: boolean;
  bindings: Map<string, Array<string | null>>;
}

const FUNCTIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);
const SCOPES = new Set([
  'program',
  'statement_block',
  'class_body',
  'catch_clause',
  'for_statement',
  'for_in_statement',
  'switch_body',
  ...Array.from(FUNCTIONS),
]);

/** Binding patterns only: never treat identifiers in annotations/default RHS as declarations. */
function patternNames(node: Node | null): Node[] {
  if (node === null) return [];
  if (
    node.type === 'identifier' ||
    node.type === 'shorthand_property_identifier_pattern'
  )
    return [node];
  if (
    node.type === 'assignment_pattern' ||
    node.type === 'object_assignment_pattern'
  )
    return patternNames(node.childForFieldName('left'));
  if (node.type === 'pair_pattern')
    return patternNames(node.childForFieldName('value'));
  if (
    node.type === 'required_parameter' ||
    node.type === 'optional_parameter'
  ) {
    return patternNames(
      node.childForFieldName('pattern') ??
        node.childForFieldName('name') ??
        node.namedChildren[0] ??
        null,
    );
  }
  if (
    [
      'formal_parameters',
      'object_pattern',
      'array_pattern',
      'rest_pattern',
    ].includes(node.type)
  ) {
    return node.namedChildren.flatMap(patternNames);
  }
  return [];
}

/** One lexical index per parsed tree, consumed before the tree is disposed. */
export function indexLexicalBindings(
  root: Node,
  symbols: readonly CodeGraphSymbolRecord[],
): (reference: Node, name: string, capture: string) => Record<string, unknown> {
  const scopes = new Map<number, Scope>();
  const byName = new Map<string, CodeGraphSymbolRecord[]>();
  for (const symbol of symbols) {
    const candidates = byName.get(symbol.name) ?? [];
    candidates.push(symbol);
    byName.set(symbol.name, candidates);
  }
  const symbolFor = (name: Node): string | null => {
    const candidates = (byName.get(name.text) ?? []).filter(
      (symbol) =>
        symbol.byteStart !== null &&
        symbol.byteEnd !== null &&
        symbol.byteStart <= name.startIndex &&
        name.endIndex <= symbol.byteEnd,
    );
    candidates.sort((a, b) => (b.byteStart ?? 0) - (a.byteStart ?? 0));
    return candidates[0]?.qualifiedName ?? null;
  };
  const bind = (scope: Scope, name: Node, known: boolean): void => {
    const entries = scope.bindings.get(name.text) ?? [];
    entries.push(known ? symbolFor(name) : null);
    scope.bindings.set(name.text, entries);
  };
  const global: Scope = {
    parent: null,
    functionScope: true,
    bindings: new Map(),
  };
  const pending: Array<{ node: Node; scope: Scope }> = [
    { node: root, scope: global },
  ];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    const { node } = item;
    let scope = item.scope;
    // A declaration belongs to the containing scope, not its own function body.
    if (
      [
        'function_declaration',
        'generator_function_declaration',
        'class_declaration',
        'abstract_class_declaration',
        'interface_declaration',
        'type_alias_declaration',
        'enum_declaration',
      ].includes(node.type)
    ) {
      const name = node.childForFieldName('name');
      if (name !== null) bind(scope, name, true);
    }
    if (SCOPES.has(node.type)) {
      scope = {
        parent: node.type === 'program' ? null : scope,
        functionScope: node.type === 'program' || FUNCTIONS.has(node.type),
        bindings: new Map(),
      };
      scopes.set(node.id, scope);
    }
    if (node.type === 'class_body' && node.parent?.type === 'class') {
      const name = node.parent.childForFieldName('name');
      if (name !== null) bind(scope, name, true);
    }
    if (FUNCTIONS.has(node.type)) {
      for (const name of patternNames(
        node.childForFieldName('parameters') ??
          node.childForFieldName('parameter'),
      ))
        bind(scope, name, false);
      if (['function_expression', 'generator_function'].includes(node.type)) {
        const name = node.childForFieldName('name');
        if (name !== null) bind(scope, name, true);
      }
    }
    if (node.type === 'variable_declarator') {
      let owner = scope;
      if (node.parent?.type === 'variable_declaration') {
        while (!owner.functionScope && owner.parent !== null)
          owner = owner.parent;
      }
      for (const name of patternNames(node.childForFieldName('name')))
        bind(owner, name, true);
    }
    if (node.type === 'catch_clause') {
      for (const name of patternNames(node.childForFieldName('parameter')))
        bind(scope, name, false);
    }
    if (
      node.type === 'for_in_statement' &&
      node.children.some((child) =>
        ['const', 'let', 'var'].includes(child.type),
      )
    ) {
      let owner = scope;
      if (node.children.some((child) => child.type === 'var')) {
        while (!owner.functionScope && owner.parent !== null)
          owner = owner.parent;
      }
      for (const name of patternNames(node.childForFieldName('left')))
        bind(owner, name, false);
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) {
      const child = node.namedChildren[i];
      if (child !== undefined) pending.push({ node: child, scope });
    }
  }
  return (reference, name, capture) => {
    let call: Node | null = capture === 'reference.call' ? reference : null;
    while (call !== null && call.type !== 'call_expression') call = call.parent;
    const callee = call?.childForFieldName('function') ?? null;
    const receiver =
      callee?.type === 'member_expression'
        ? (callee.childForFieldName('object')?.text ?? '')
        : null;
    const evidence =
      receiver === null
        ? { lexicalScope: true }
        : {
            lexicalScope: true,
            receiver,
            memberCall: true,
          };
    let current: Node | null = reference;
    let scope: Scope | undefined;
    while (current !== null && scope === undefined) {
      scope = scopes.get(current.id);
      current = current.parent;
    }
    while (scope !== undefined) {
      const bindings = scope.bindings.get(receiver ?? name);
      if (bindings !== undefined) {
        const unique = Array.from(new Set(bindings));
        if (receiver === null && unique.length === 1 && unique[0] !== null)
          return { ...evidence, lexicalTarget: unique[0] };
        return {
          ...evidence,
          shadowed: true,
          lexicalCandidates: bindings.length,
        };
      }
      scope = scope.parent ?? undefined;
    }
    return evidence;
  };
}
