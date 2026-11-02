import type {
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
  CodeGraphEdgeRecord,
} from '../types/code-graph';
import { fileRowId, symbolRowId, edgeRowId } from '../ids';
import type { NonCodeExtractorInput } from './extractor-registry';

const SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

/** Local declarations only: no database, client generation, env reads or schema validation.
 * String/comment masking retains offsets and prevents attributes/defaults becoming facts. */
export function extractPrismaFacts(
  input: NonCodeExtractorInput,
): CodeGraphFileFacts {
  const masked = input.source.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"|\/\*/g,
    (text) => {
      if (text === '"' || text === '/*')
        throw new Error('Unterminated Prisma string or comment');
      return text.replace(/[^\r\n]/g, ' ');
    },
  );
  const lineStarts = [0];
  for (let i = 0; i < input.source.length; i += 1)
    if (input.source[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  };
  const fileId = fileRowId(input.repoId, input.relativePath);
  const file: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, input.relativePath),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: input.relativePath.split('/').pop() ?? input.relativePath,
    qualifiedName: input.relativePath,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: lineStarts.length,
    byteStart: 0,
    byteEnd: input.source.length,
    signature: null,
    exported: false,
    isTest: false,
    extra: {
      coverage:
        'local declarations and field types; no schema validation or client-call resolution',
    },
  };
  const symbols = [file];
  let truncatedFacts = 0;
  const maxSymbols = 5000;
  const edges: CodeGraphEdgeRecord[] = [];
  const declarations = new Map<string, CodeGraphSymbolRecord[]>();
  const refs: Array<{ field: CodeGraphSymbolRecord; type: string }> = [];
  const addEdge = (
    source: CodeGraphSymbolRecord,
    kind: 'CONTAINS' | 'REFERENCES',
    targetRef: string,
    target: CodeGraphSymbolRecord | null,
  ): void => {
    edges.push({
      id: edgeRowId({
        repoId: input.repoId,
        kind,
        sourceId: source.id,
        target: targetRef,
        line: source.lineStart,
      }),
      repositoryId: input.repoId,
      kind,
      sourceSymbolId: source.id,
      sourceFileId: fileId,
      targetSymbolId: target?.id ?? null,
      targetRef: kind === 'REFERENCES' ? targetRef : null,
      line: source.lineStart,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1,
      resolverId: null,
      evidence: {
        syntax: 'prisma',
        ...(kind === 'REFERENCES'
          ? {
              fieldType: targetRef,
              resolution:
                target === null
                  ? 'unknown-local-type'
                  : 'same-schema-declaration',
            }
          : {}),
      },
    });
  };
  const declarationPattern =
    /^[ \t]*(model|enum|type)[ \t]+([A-Za-z_][\w]*)[ \t]*\{/gm;
  for (const match of Array.from(masked.matchAll(declarationPattern))) {
    const start = match.index;
    const bodyStart = start + match[0].length;
    const end = masked.indexOf('}', bodyStart);
    if (end < 0 || masked.slice(bodyStart, end).includes('{'))
      throw new Error('Unclosed or nested Prisma declaration');
    if (symbols.length >= maxSymbols) {
      const omittedMembers = masked
        .slice(bodyStart, end)
        .split('\n')
        .filter((line) => {
          const member =
            /^[ \t]*([A-Za-z_]\w*)(?:[ \t]+([A-Za-z_]\w*)(\[\]|\?)?)?/.exec(
              line,
            );
          return (
            member !== null && (match[1] === 'enum' || member[2] !== undefined)
          );
        }).length;
      truncatedFacts += 1 + omittedMembers;
      continue;
    }
    const name = match[2];
    const qualifiedName = `${input.relativePath}::${name}`;
    if (declarations.has(name))
      throw new Error(`Duplicate Prisma declaration: ${name}`);
    const symbol: CodeGraphSymbolRecord = {
      ...file,
      id: symbolRowId(input.repoId, qualifiedName),
      name,
      qualifiedName,
      kind: match[1] === 'enum' ? 'enum' : 'type',
      parentSymbolId: file.id,
      lineStart: lineAt(start),
      lineEnd: lineAt(end),
      byteStart: start,
      byteEnd: end + 1,
      signature: `${match[1]} ${name}`,
      extra: { schemaKind: match[1] },
    };
    symbols.push(symbol);
    declarations.set(name, [symbol]);
    addEdge(file, 'CONTAINS', symbol.id, symbol);
    let offset = bodyStart;
    const fieldNames = new Set<string>();
    for (const line of masked.slice(bodyStart, end).split('\n')) {
      const member =
        /^[ \t]*([A-Za-z_]\w*)(?:[ \t]+([A-Za-z_]\w*)(\[\]|\?)?)?/.exec(line);
      if (member !== null && (match[1] === 'enum' || member[2] !== undefined)) {
        if (symbols.length >= maxSymbols) {
          truncatedFacts += 1;
          offset += line.length + 1;
          continue;
        }
        const memberName = member[1];
        if (fieldNames.has(memberName))
          throw new Error(`Duplicate Prisma field: ${name}.${memberName}`);
        fieldNames.add(memberName);
        const qn = `${qualifiedName}.${memberName}`;
        const type = match[1] === 'enum' ? null : member[2];
        const field: CodeGraphSymbolRecord = {
          ...symbol,
          id: symbolRowId(input.repoId, qn),
          kind: 'variable',
          name: memberName,
          qualifiedName: qn,
          parentSymbolId: symbol.id,
          lineStart: lineAt(offset),
          lineEnd: lineAt(offset),
          byteStart: offset,
          byteEnd: offset + line.length,
          signature:
            type === null
              ? memberName
              : `${memberName} ${type}${member[3] ?? ''}`,
          extra: {
            schemaKind: type === null ? 'enum-value' : 'field',
            ...(type === null
              ? {}
              : {
                  fieldType: type,
                  optional: member[3] === '?',
                  list: member[3] === '[]',
                }),
          },
        };
        symbols.push(field);
        addEdge(symbol, 'CONTAINS', field.id, field);
        if (type !== null && !SCALARS.has(type)) refs.push({ field, type });
      }
      offset += line.length + 1;
    }
  }
  for (const ref of refs)
    addEdge(
      ref.field,
      'REFERENCES',
      ref.type,
      declarations.get(ref.type)?.[0] ?? null,
    );
  if (truncatedFacts > 0) file.extra.truncatedFacts = truncatedFacts;
  return {
    file: {
      id: fileId,
      repositoryId: input.repoId,
      relativePath: input.relativePath,
      absolutePath: input.absolutePath,
      language: 'prisma',
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      mtimeNs: input.mtimeNs,
      lineCount: lineStarts.length,
      grammarId: 'prisma',
      grammarAbi: null,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols,
    edges,
  };
}
