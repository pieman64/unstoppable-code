import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCodexSubagentThreadRouting } from './mixed-provider-validation.mjs';

const descriptors = [
  { id: 'claude-parent', providerType: 'claude', usesSubagent: true },
  { id: 'codex-parent-a', providerType: 'codex', usesSubagent: true },
  { id: 'codex-parent-b', providerType: 'codex', usesSubagent: true },
  { id: 'codex-root-only', providerType: 'codex', usesSubagent: false },
];

test('Codex subagent routing requires one native thread per expected parent', () => {
  const assessment = assessCodexSubagentThreadRouting(descriptors, {
    'codex-parent-a': 1,
    'codex-parent-b': 1,
  });

  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.violations, []);
});

test('Codex subagent routing rejects aggregate counts that mask misrouting', () => {
  const assessment = assessCodexSubagentThreadRouting(descriptors, {
    'codex-parent-a': 2,
    'codex-parent-b': 0,
  });

  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.violations, [
    { chatId: 'codex-parent-a', expected: 1, observed: 2 },
    { chatId: 'codex-parent-b', expected: 1, observed: 0 },
  ]);
});

test('Codex subagent routing rejects unexpected parent assignments', () => {
  const assessment = assessCodexSubagentThreadRouting(descriptors, {
    'codex-parent-a': 1,
    'codex-parent-b': 1,
    'codex-root-only': 1,
  });

  assert.equal(assessment.passed, false);
  assert.deepEqual(assessment.violations, [
    { chatId: 'codex-root-only', expected: 0, observed: 1 },
  ]);
});
