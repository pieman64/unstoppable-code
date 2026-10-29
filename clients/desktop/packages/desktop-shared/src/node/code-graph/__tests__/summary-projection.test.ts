// PRIVATE UNRUN DRAFT: apply only after the implementation/baseline gate.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import { readCodeGraphSummaryProjection } from '../base-graph';
import { publishCodeGraphSummaryProjection } from '../summary-projection';
import {
  getMetadataValue,
  setMetadataValue,
  withImmediateTransaction,
} from '../store/database';

// A generated graph, not an incident database. No custom grammar is loaded:
// publication exercises the existing persisted-report parser over metadata.
describe('summary projection portable custom-language boundary', () => {
  let root: string;
  let dbPath: string;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'summary-projection-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'src', 'main.ts'),
      'export const answer = 42;\n',
    );
    dbPath = path.join(root, '.graph', 'graph.db');
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function publishReport(raw: string): void {
    const db = new DatabaseSync(dbPath);
    try {
      withImmediateTransaction(db, () => {
        setMetadataValue(db, 'custom_languages', raw);
        expect(
          publishCodeGraphSummaryProjection(db, { worktreeRootPath: root }),
        ).not.toBeNull();
      });
    } finally {
      db.close();
    }
  }

  function sourceReport(message: string): string {
    return JSON.stringify({
      configPath: path.join(root, '.canopy', 'code-graph', 'languages.json'),
      loaded: [
        {
          index: 0,
          id: 'custom-lang',
          extensions: ['.custom'],
          abiVersion: 15,
        },
      ],
      diagnostics: [{ entryId: 'custom-lang', index: 0, message }],
    });
  }

  it('sanitizes writer diagnostics and preserves identity strings verbatim', () => {
    publishReport(
      sourceReport(`Cannot open "${path.join(root, 'language.wasm')}".`),
    );
    const result = readCodeGraphSummaryProjection(dbPath);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready')
      throw new Error('Expected generated projection.');
    expect(result.projection.customLanguages).toMatchObject({
      configRelativePath: '.canopy/code-graph/languages.json',
      loaded: [{ id: 'custom-lang', extensions: ['.custom'] }],
      diagnostics: [{ entryId: 'custom-lang', index: 0 }],
    });
    expect(JSON.stringify(result.projection.customLanguages)).not.toContain(
      root,
    );
  });

  it.each([
    'Failed to open /Users/private-user/project/language.wasm',
    'Failed to open C:\\Users\\private-user\\language.wasm',
    'Failed to open \\\\server\\share\\language.wasm',
  ])(
    'rejects a stored unsafe diagnostic with otherwise unchanged identity: %s',
    (message) => {
      publishReport(sourceReport('Grammar could not be loaded.'));
      const before = readCodeGraphSummaryProjection(dbPath);
      if (
        before.state !== 'ready' ||
        before.projection.customLanguages === null
      ) {
        throw new Error('Expected generated custom-language projection.');
      }
      const altered = {
        ...before.projection,
        customLanguages: {
          ...before.projection.customLanguages,
          diagnostics: [{ entryId: 'custom-lang', index: 0, message }],
        },
      };
      const db = new DatabaseSync(dbPath);
      try {
        const identity = getMetadataValue(db, 'summary_projection_identity_v1');
        setMetadataValue(db, 'summary_projection_v1', JSON.stringify(altered));
        expect(getMetadataValue(db, 'summary_projection_identity_v1')).toBe(
          identity,
        );
      } finally {
        db.close();
      }
      // The diagnostic itself is not covered by the identity hash. Strict
      // canonical portable-text validation must prevent its disclosure anyway.
      expect(readCodeGraphSummaryProjection(dbPath)).toMatchObject({
        state: 'pending',
        reason: 'projection-invalid',
      });
    },
  );

  it('retains malformed report null rather than inventing loaded entries', () => {
    publishReport('{malformed');
    const result = readCodeGraphSummaryProjection(dbPath);
    if (result.state !== 'ready')
      throw new Error('Expected measured projection.');
    expect(result.projection.customLanguages).toBeNull();
  });

  it.each([
    { id: '/Users/private-user', extensions: ['.custom'] },
    { id: 'custom-lang', extensions: ['C:\\Users\\private-user'] },
  ])('does not silently rewrite nonportable identity %j', (identity) => {
    const report = JSON.stringify({
      configPath: path.join(root, '.canopy', 'code-graph', 'languages.json'),
      loaded: [{ index: 0, ...identity, abiVersion: 15 }],
      diagnostics: [],
    });
    publishReport(report);
    const result = readCodeGraphSummaryProjection(dbPath);
    if (result.state !== 'ready')
      throw new Error('Expected measured projection.');
    expect(result.projection.customLanguages).toBeNull();
  });
});
