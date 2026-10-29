// eslint-disable-next-line no-restricted-imports -- This architecture test inspects source without adding runtime Node usage.
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- This architecture test inspects source without adding runtime Node usage.
import { join } from 'node:path';

describe('projectsStore module dependencies', () => {
  it('does not import activityStore', () => {
    const source = readFileSync(
      join(__dirname, '..', 'projectsStore.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/from ['"]\.\/activityStore['"]/);
  });
});
