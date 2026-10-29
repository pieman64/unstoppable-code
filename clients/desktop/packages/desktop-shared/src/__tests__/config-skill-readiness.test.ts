import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('bundled config skill repository-readiness coverage', () => {
  const skill = readFileSync(
    join(
      process.cwd(),
      'brand-templates',
      'skills',
      '{{BRAND_INTERNAL_NAME}}-config',
      'SKILL.md',
    ),
    'utf8',
  );

  it('documents lifecycle, platform shell, and dev-server authoring', () => {
    expect(skill).toContain('`setup`');
    expect(skill).toContain('`launch`');
    expect(skill).toContain('`teardown`');
    expect(skill).toContain('`devServerPattern`');
    expect(skill).toContain('`shell.windows`');
  });

  it('documents interactive scripts and command hook actions', () => {
    expect(skill).toContain('`interactive` is an optional boolean');
    expect(skill).toContain('"interactive": true');
    expect(skill).toContain('runs in a terminal panel within the workspace');
    expect(skill).toContain('Interactive lifecycle scripts');
    expect(skill).toContain('Interactive command hook actions');
    expect(skill).toContain('Local overrides preserve `interactive: true`');
    expect(skill).toContain('Interactive execution ignores `timeoutSeconds`');
    expect(skill).toContain('always use the background runner');
    expect(skill).toContain(
      'Interactive command hook actions ignore the hook timeout',
    );
    expect(skill).toContain('global script timeout preference');
    expect(skill).toContain(
      'separately to each non-interactive command action',
    );
  });

  it('documents the merge queue triggers, dispatch order, and variables', () => {
    for (const trigger of ['pr:queue:removed', 'pr:queue:entered']) {
      expect(skill).toContain(`- \`${trigger}\` fires when`);
      expect(skill).toContain(`  - \`${trigger}\``);
    }
    expect(skill.indexOf('  - `pr:queue:removed`')).toBeLessThan(
      skill.indexOf('  - `pr:queue:entered`'),
    );
    expect(skill).toContain('`{{BRAND_ENV_PREFIX}}_PR_QUEUE_ENTRY_ID`');
    expect(skill).toContain('`{{BRAND_ENV_PREFIX}}_PR_QUEUE_REMOVAL_REASON`');
  });

  it.each([
    'worktree:precommit:failure',
    'pr:create',
    'pr:reviews:new:has-comments',
    'pr:checks:finished:has-fail',
    'pr:merge-conflicts',
  ])('includes the conservative %s fallback', (trigger) => {
    expect(skill).toContain(`"${trigger}"`);
  });

  it('preserves safe fallback pipeline, review-plugin, and error fingerprints', () => {
    expect(skill).toContain('bundled-code-review-multi-provider');
    expect(skill).toContain('builtin-gh');
    expect(skill).toContain(
      '{{{{BRAND_ENV_PREFIX}}_WORKTREE_PRECOMMIT_FAILURE_ERROR}}',
    );
    expect(skill).toContain('untrusted data');
    expect(skill).toContain('<precommit-output>');
    expect(skill).toContain('unless the user explicitly approves it');
    const start = skill.lastIndexOf('"worktree:precommit:failure"');
    const end = skill.indexOf('"pr:create"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const precommitFallback = skill.slice(start, end);
    expect(precommitFallback).not.toHaveLength(0);
    expect(precommitFallback).not.toContain('"plugin_name"');
    expect(precommitFallback).not.toContain('"autoArchive"');
  });
});
