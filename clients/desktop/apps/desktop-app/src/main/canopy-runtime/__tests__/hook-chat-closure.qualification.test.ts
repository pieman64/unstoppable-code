import { build } from 'esbuild';
import { resolve } from 'node:path';

it('keeps the initiated-work graph free of Electron and process-creation imports', async () => {
  const result = await build({
    entryPoints: [
      resolve(
        process.cwd(),
        'packages/core-runtime/src/node/initiated-work/index.ts',
      ),
    ],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'hook-chat-closure',
        setup(api): void {
          api.onResolve(
            {
              filter:
                /^(?:electron|(?:node:)?(?:child_process|cluster|worker_threads))$/,
            },
            (args) => ({
              errors: [
                {
                  text: `Initiated work imports a host process API: ${args.path}`,
                },
              ],
            }),
          );
        },
      },
    ],
  });
  expect(Object.keys(result.metafile?.inputs ?? {})).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/initiated-work\/hook-chat-claims\.ts$/),
      expect.stringMatching(/operations\/service\.ts$/),
    ]),
  );
  expect(
    Object.keys(result.metafile?.inputs ?? {}).some((path) =>
      path.includes('apps/desktop-app/'),
    ),
  ).toBe(false);
});
