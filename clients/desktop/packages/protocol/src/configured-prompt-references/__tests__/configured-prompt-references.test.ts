import { validateConfiguredPromptReferences } from '../index';

describe('configured prompt reference DTO', () => {
  it('rejects host paths and unknown fields at every nesting level', () => {
    const base = {
      kind: 'file',
      textStart: 0,
      displayText: 'src/a.ts',
      root: { kind: 'workspace' },
      relativePath: 'src/a.ts',
    };
    expect(
      validateConfiguredPromptReferences('src/a.ts', [
        { ...base, absolutePath: '/host/src/a.ts' },
      ]),
    ).toContain('unsupported fields');
    expect(
      validateConfiguredPromptReferences('src/a.ts', [
        { ...base, root: { kind: 'workspace', absolutePath: '/host' } },
      ]),
    ).toContain('unsupported fields');
    expect(
      validateConfiguredPromptReferences('src/a.ts', [
        { ...base, relativePath: '../escape' },
      ]),
    ).toContain('root-relative');
    expect(
      validateConfiguredPromptReferences('plugin', [
        {
          kind: 'plugin',
          textStart: 0,
          displayText: 'plugin',
          plugin: {
            kind: 'portable',
            ref: {
              type: 'claude_plugin',
              marketplace: {
                type: 'builtin',
                id: 'app',
                absolutePath: '/host',
              },
              plugin_name: 'plugin',
            },
          },
        },
      ]),
    ).toContain('unsupported fields');
  });
});
