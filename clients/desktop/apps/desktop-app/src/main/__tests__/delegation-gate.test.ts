import { app } from 'electron';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { managedDelegationEnabled } from '../agents/delegation/gate';
import { createAppAdvisorRuntimeFixture } from './fixtures/app-advisor-runtime';
import { createPipelineEditorToolRuntime } from '../pipeline-editor/runtime';

jest.mock('electron', () => ({ app: { isPackaged: false } }));
const options = {
  cwd: '/worktree',
  projectId: 'workspace',
  worktreeId: 'entry',
  chatId: 'chat',
};
const key = brandEnvName('DEVELOPMENT_DELEGATION');
const previous = process.env[key];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
beforeEach(() => {
  process.env[key] = '1';
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'darwin',
  });
});
afterEach(() => {
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});
afterAll(() => {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
});
it('requires an explicit host-owned worktree chat surface, even when other surfaces have all IDs', () => {
  expect(app.isPackaged).toBe(false);
  expect(managedDelegationEnabled(options)).toBe(false);
});

it.each([false, true])(
  'ignores the retired environment default (packaged=%s)',
  (packaged) => {
    Object.defineProperty(app, 'isPackaged', {
      value: packaged,
      configurable: true,
    });
    try {
      const worktree = {
        ...options,
        managedDelegationSurface: 'worktree-chat' as const,
      };
      for (const value of ['0', '1']) {
        process.env[key] = value;
        expect(managedDelegationEnabled(worktree)).toBe(false);
        expect(
          managedDelegationEnabled({
            ...worktree,
            managedDelegationMode: 'explicit-only',
          }),
        ).toBe(true);
      }
    } finally {
      Object.defineProperty(app, 'isPackaged', {
        value: false,
        configurable: true,
      });
    }
  },
);

it.each(['explicit-only', 'proactive'] as const)(
  'allows a user opt-in %s in a packaged supported worktree chat',
  (mode) => {
    delete process.env[key];
    Object.defineProperty(app, 'isPackaged', {
      value: true,
      configurable: true,
    });
    try {
      const enabled = {
        ...options,
        managedDelegationSurface: 'worktree-chat' as const,
        managedDelegationMode: mode,
      };
      expect(managedDelegationEnabled(enabled)).toBe(true);
      expect(
        managedDelegationEnabled({
          ...enabled,
          appAdvisorRuntime: createAppAdvisorRuntimeFixture(),
        }),
      ).toBe(false);
      expect(
        managedDelegationEnabled({
          ...enabled,
          pipelineEditorRuntime: createPipelineEditorToolRuntime(
            { getMainWindow: () => null },
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
              providerType: 'claude',
            },
          ),
        }),
      ).toBe(false);
      expect(managedDelegationEnabled({ ...enabled, chatId: '' })).toBe(false);
    } finally {
      Object.defineProperty(app, 'isPackaged', {
        value: false,
        configurable: true,
      });
    }
  },
);

it('preserves explicit Off even when the retired variable is set', () => {
  process.env[key] = '1';
  expect(
    managedDelegationEnabled({
      ...options,
      managedDelegationSurface: 'worktree-chat',
      managedDelegationMode: 'off',
    }),
  ).toBe(false);
});

it('enables managed delegation on macOS and Windows only', () => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  expect(
    managedDelegationEnabled({
      ...options,
      managedDelegationSurface: 'worktree-chat',
      managedDelegationMode: 'explicit-only',
    }),
  ).toBe(true);

  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'linux',
  });
  expect(
    managedDelegationEnabled({
      ...options,
      managedDelegationSurface: 'worktree-chat',
      managedDelegationMode: 'explicit-only',
    }),
  ).toBe(false);
});
