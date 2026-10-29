import {
  openCodeGraphDatabase,
  withImmediateTransaction,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { ResolutionPriorFacts } from '../store/resolution-prior-facts';

// Additive focused test source; never executed in private drafting session.
describe('W3 build-owned preimages', () => {
  it('rejects use outside the existing writer transaction', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      expect(() => new ResolutionPriorFacts(db)).toThrow(
        'owned graph build transaction',
      );
    } finally {
      db.close();
    }
  });

  it('preserves deleted dependencies, absent new files and opaque repository identity', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      withImmediateTransaction(db, () => {
        db.prepare(
          `INSERT INTO resolution_dependencies VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'opaque-repo',
          'calls',
          'old-file',
          'old-edge',
          'export-name',
          '["barrel","foo"]',
          'null',
        );
        const prior = new ResolutionPriorFacts(db);
        try {
          prior.preserve('old-file');
          prior.preserve('new-file');
          prior.preserve('old-file');
          db.prepare(
            'DELETE FROM resolution_dependencies WHERE source_file_id = ?',
          ).run('old-file');
          expect(prior.listPreservedFileIds()).toEqual([
            'new-file',
            'old-file',
          ]);
          expect(prior.read('new-file').previousFile).toBeNull();
          expect(
            prior.reverseDependencies(
              'opaque-repo',
              'export-name',
              '["barrel","foo"]',
            ),
          ).toHaveLength(1);
          expect(
            prior.reverseDependencies(
              'public-name',
              'export-name',
              '["barrel","foo"]',
            ),
          ).toEqual([]);
        } finally {
          prior.close();
        }
      });
    } finally {
      db.close();
    }
  });

  it('never publishes a partial dependency replacement after failure', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      expect(() =>
        withImmediateTransaction(db, () => {
          const prior = new ResolutionPriorFacts(db);
          try {
            prior.preserve('new-file');
            db.prepare(
              `INSERT INTO resolution_dependencies VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              'opaque-repo',
              'calls',
              'new-file',
              '',
              'file',
              'new-file',
              'null',
            );
            throw new Error('dependency publication fault');
          } finally {
            prior.close();
          }
        }),
      ).toThrow('dependency publication fault');
      expect(db.prepare('SELECT * FROM resolution_dependencies').all()).toEqual(
        [],
      );
    } finally {
      db.close();
    }
  });
});
