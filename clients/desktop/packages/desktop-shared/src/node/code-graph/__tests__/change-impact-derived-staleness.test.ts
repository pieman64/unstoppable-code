/**
 * Phase 20 (G6): change impact's risk formula reads flow criticality and
 * community membership from derived analysis. While that analysis lags the
 * published graph, the formula's own output says its flow and community
 * inputs are stale; once the analysis catches up, the note disappears. The
 * score itself is computed exactly as before.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { openCodeGraphDatabase } from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { CodeGraphQueryService } from '../query/queries';
import { scoreChangeRisk } from '../impact/change-impact';
import type { CodeGraphRiskAssessment } from '../../../types/code-graph-tools';

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;

const STALE_NOTE = 'derived analyses stale';

describe('change impact risk formula with stale derived analysis', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-risk-stale-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(root, 'src', 'main.ts'), MAIN);
    dbPath = path.join(root, '.graph', 'graph.db');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function riskForDoWork(): CodeGraphRiskAssessment {
    const db = openCodeGraphDatabase(dbPath);
    try {
      const store = new CodeGraphStore(db);
      const queries = new CodeGraphQueryService(db);
      const symbol = store.getSymbolByQualifiedName(
        'src/lib.ts::doWork',
        'fixture',
      );
      if (symbol === null) throw new Error('doWork missing from the graph');
      return scoreChangeRisk({
        store,
        repoId: 'fixture',
        delta: { added: [], removed: [], signatureChanged: [] },
        changed: [
          {
            qualifiedName: symbol.qualifiedName,
            kind: symbol.kind,
            filePath: 'src/lib.ts',
            lineStart: symbol.lineStart,
            lineEnd: symbol.lineEnd,
            changeKind: 'modified',
          },
        ],
        queries,
      });
    } finally {
      db.close();
    }
  }

  it('notes stale flow and community inputs while derived analysis lags the build, and drops the note once it catches up', async () => {
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    try {
      await engine.buildOrUpdate();
      const current = riskForDoWork();
      expect(current.formula).not.toContain(STALE_NOTE);
      expect(current).not.toHaveProperty('staleInputs');
      expect(current.reasons.join(' ')).toContain('flow');

      writeFileSync(
        path.join(root, 'src', 'extra.ts'),
        `import { run } from './main';\nexport function extra(): number { return run(); }\n`,
      );
      await engine.buildOrUpdate({ deferDerived: true });
      const stale = riskForDoWork();
      expect(stale.formula).toContain(STALE_NOTE);
      expect(stale.staleInputs).toEqual([
        'flowParticipation',
        'communityCrossing',
      ]);
      // Scoring itself is unchanged: the stale analysis is still the input.
      expect(stale.score).toBe(current.score);
      expect(stale.reasons).toEqual(current.reasons);

      await engine.completeDeferredDerived();
      const caughtUp = riskForDoWork();
      expect(caughtUp.formula).not.toContain(STALE_NOTE);
      expect(caughtUp).not.toHaveProperty('staleInputs');
    } finally {
      engine.close();
    }
  });
});
