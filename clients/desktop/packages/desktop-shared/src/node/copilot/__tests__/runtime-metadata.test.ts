import type * as Metadata from '../runtime-metadata';

const artifact = {
  url: 'https://registry.npmjs.org/fixture.tgz',
  integrity: 'sha512-fixture',
  archiveBytes: 100,
  executableSha256: 'fixture',
};

function fromManifest(
  value: unknown,
): Metadata.CopilotRuntimeArtifact | undefined {
  const injected = Object.getOwnPropertyDescriptor(
    globalThis,
    '__CANOPY_COPILOT_CLI__',
  );
  Object.defineProperty(globalThis, '__CANOPY_COPILOT_CLI__', {
    value: undefined,
    configurable: true,
  });
  jest.doMock('node:fs', () => ({
    readFileSync: (): string => JSON.stringify(value),
  }));
  try {
    let result: Metadata.CopilotRuntimeArtifact | undefined;
    jest.isolateModules(() => {
      const metadata = jest.requireActual<typeof Metadata>(
        '../runtime-metadata',
      );
      result = metadata.getCopilotRuntimeArtifact('darwin', 'arm64');
    });
    return result;
  } finally {
    jest.dontMock('node:fs');
    if (injected)
      Object.defineProperty(globalThis, '__CANOPY_COPILOT_CLI__', injected);
    else Reflect.deleteProperty(globalThis, '__CANOPY_COPILOT_CLI__');
  }
}

test('loads validated source-mode runtime metadata', () => {
  expect(
    fromManifest({
      'copilot-cli': {
        version: '1.2.3',
        artifacts: { 'darwin-arm64': artifact },
      },
    }),
  ).toEqual({ version: '1.2.3', ...artifact });
});

test.each([
  null,
  {},
  { ...artifact, url: 42 },
  { ...artifact, integrity: null },
  { ...artifact, archiveBytes: '100' },
  { ...artifact, executableSha256: [] },
])('rejects malformed artifact metadata before exposing it: %p', (value) => {
  expect(() =>
    fromManifest({
      'copilot-cli': { version: '1.2.3', artifacts: { 'darwin-arm64': value } },
    }),
  ).toThrow('metadata');
});
