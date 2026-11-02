import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  seedSharedContainerRecipientCoworkRevision,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
} from '../seeders/seedSharedContainerRecipientReplicas.mjs';

test('revision two note body agrees with the published title and scheduling detail', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'can-4908-fixture-'));
  try {
    seedSharedContainerRecipientCoworkRevision(root, {
      revisionId: SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
      includeRevisionTwoContent: true,
    });
    const revision = path.join(
      root,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
      'revisions',
      SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
    );
    const layout = JSON.parse(
      await readFile(
        path.join(revision, 'artifacts', 'container.json'),
        'utf8',
      ),
    );
    const body = await readFile(
      path.join(revision, 'content', 'notes', 'cowork-note.md'),
      'utf8',
    );
    assert.equal(
      body,
      '# Revision two follow-up\n\nCall the customer on Friday. Ada added a scheduling detail.\n',
    );
    assert.equal(layout.notes[0].title, body.split('\n')[0].slice(2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
