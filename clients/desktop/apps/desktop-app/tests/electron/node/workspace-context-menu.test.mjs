import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerLabelNamesContext } from '../workspaceContextMenu.mjs';

test('names the selected context with no attention suffix', () => {
  assert.equal(
    triggerLabelNamesContext('Workspace context: Personal', 'Personal'),
    true,
  );
});

test('tolerates updates, pending shares, and both', () => {
  for (const label of [
    'Workspace context: Personal, updates in Acme',
    'Workspace context: Personal, 1 pending share in Zen',
    'Workspace context: Personal, 2 pending shares in Zen, 1 pending share in Acme',
    'Workspace context: Personal, updates in Acme, 2 pending shares in Zen',
    'Workspace context: Personal, 1 pending invitation',
    'Workspace context: Personal, 2 pending invitations',
    'Workspace context: Personal, 2 pending shares in Zen, 1 pending invitation',
  ]) {
    assert.equal(triggerLabelNamesContext(label, 'Personal'), true, label);
  }
});

test('matches a context name that contains commas', () => {
  assert.equal(
    triggerLabelNamesContext('Workspace context: Acme, Inc', 'Acme, Inc'),
    true,
  );
  assert.equal(
    triggerLabelNamesContext(
      'Workspace context: Acme, Inc, 1 pending share in Personal',
      'Acme, Inc',
    ),
    true,
  );
});

test('rejects another context and a name that only starts the same', () => {
  assert.equal(
    triggerLabelNamesContext('Workspace context: Personal', 'Acme'),
    false,
  );
  assert.equal(
    triggerLabelNamesContext('Workspace context: Acme, Inc', 'Acme'),
    false,
  );
  assert.equal(
    triggerLabelNamesContext('Workspace context: Acme Labs', 'Acme'),
    false,
  );
  assert.equal(triggerLabelNamesContext(null, 'Acme'), false);
});
