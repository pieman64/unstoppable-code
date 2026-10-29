import { runWithActionEnvironment } from '../_lib/action-env';

const originalGitExecutable = process.env.CANOPY_GIT_EXECUTABLE;

afterEach(() => {
  if (originalGitExecutable === undefined) {
    delete process.env.CANOPY_GIT_EXECUTABLE;
  } else {
    process.env.CANOPY_GIT_EXECUTABLE = originalGitExecutable;
  }
});

it('publishes the pipeline Git executable path while an action runs', async () => {
  process.env.CANOPY_GIT_EXECUTABLE = '/usr/bin/git';

  await runWithActionEnvironment(
    { CANOPY_GIT_EXECUTABLE: 'C:\\Program Files\\Git\\cmd\\git.exe' },
    () => {
      expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(
        'C:\\Program Files\\Git\\cmd\\git.exe',
      );
    },
  );

  expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/usr/bin/git');
});

it('clears the parent Git executable path when the action env omits it', async () => {
  process.env.CANOPY_GIT_EXECUTABLE = '/usr/bin/git';

  await runWithActionEnvironment({}, () => {
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
  });

  expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/usr/bin/git');
});
