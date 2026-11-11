import { validateCapabilityBundle, type CapabilityBundleV1 } from '..';

function bundle(files: string[]): CapabilityBundleV1 {
  return {
    version: 1,
    instructions: [],
    skills: [
      {
        name: 'fixture',
        description: '',
        content: '# Fixture',
        files: files.map((file) => ({ path: file, content: file })),
      },
    ],
    mcpServers: [],
    provenance: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      resolved: [],
    },
    warnings: [],
  };
}

// The wire contract must remain portable even when local POSIX skill reads
// accept literal backslashes/colons and case-neighbor files.
it('accepts portable Unicode paths but rejects Windows-hostile bundle destinations', () => {
  expect(
    validateCapabilityBundle(
      bundle(["雪's file.ts", 'two words.ts', 'docs/api.md']),
    ),
  ).toEqual([]);
  for (const file of [
    'literal\\name.ts',
    'literal:name.ts',
    'C:/drive.txt',
    'CON.txt',
    'aux',
    'docs/LPT1.txt',
    'trailing.',
    'trailing ',
    '../escape.txt',
    '/absolute.txt',
    'docs/../../escape.txt',
    'nul\0.txt',
  ]) {
    expect(validateCapabilityBundle(bundle([file]))).toEqual(
      expect.arrayContaining([expect.stringContaining(`file path "${file}"`)]),
    );
  }
});

it('rejects case-folded collisions and generated entrypoint shadowing before materialization', () => {
  for (const files of [
    ['A.ts', 'a.ts'],
    ['docs/A.ts', 'DOCS/a.ts'],
    ['Docs', 'docs/api.md'],
    ['skill.md'],
    ['SKILL.md/nested.txt'],
  ]) {
    for (const order of [files, files.toReversed()]) {
      expect(validateCapabilityBundle(bundle(order))).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/collid|duplicate|prefix|nested/),
        ]),
      );
    }
  }
});
