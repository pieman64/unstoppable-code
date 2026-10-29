import {
  IPC_CHANNELS,
  type EnvironmentConfigData,
  type LoadEnvironmentConfigResponse,
  type SaveEnvironmentConfigResponse,
  type SaveEnvironmentConfigSuccessResponse,
  type UserEnvironmentData,
} from '@canopy/desktop-shared/types';
import {
  readEnvironmentConfig,
  readUserEnvironment,
  writeEnvironmentConfig,
  writeUserEnvironment,
} from '../lib/user-environment-store';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
} from '../lib/user-environment-runtime';
import { destroySessionsByProvider } from '../agents/session-manager';
import {
  hasDelegationLifecycle,
  revokeDelegationLifecycle,
} from '../agents/delegation/lifecycle';
import { getOllamaService } from '../ollama';
import { getSecureStorageFailure } from '../lib/secure-storage-policy';
import { registerIpcHandler } from './register';
import { logMainProcessWarn } from '../lib/main-process-logging';

async function revokeDelegationsAfterEnvironmentChange(): Promise<void> {
  if (!hasDelegationLifecycle()) return;
  try {
    await revokeDelegationLifecycle();
  } catch (error) {
    logMainProcessWarn(
      '[user-environment] Delegation revocation failed; continuing environment refresh',
      error,
    );
  }
}

export function registerUserEnvironmentHandlers(): void {
  initializeUserEnvironmentRuntime();

  registerIpcHandler(IPC_CHANNELS.userEnvironmentLoad, async () =>
    readUserEnvironment(),
  );

  registerIpcHandler(
    IPC_CHANNELS.environmentConfigLoad,
    async (): Promise<LoadEnvironmentConfigResponse> => {
      try {
        return await readEnvironmentConfig();
      } catch (error) {
        const secureStorageFailure = getSecureStorageFailure(error);
        return {
          ok: false,
          error: "Couldn't read saved environment values.",
          ...(secureStorageFailure ? { secureStorageFailure } : {}),
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.userEnvironmentSave,
    async (_event, data: UserEnvironmentData) => {
      const result = await writeUserEnvironment(data);
      invalidateUserEnvironmentInjectionCache();
      await revokeDelegationsAfterEnvironmentChange();
      await destroySessionsByProvider('ollama');
      await getOllamaService().handleUserEnvironmentChanged();
      return result;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.environmentConfigSave,
    async (
      _event,
      data: EnvironmentConfigData,
    ): Promise<SaveEnvironmentConfigResponse> => {
      try {
        const result: SaveEnvironmentConfigSuccessResponse =
          await writeEnvironmentConfig(data);
        // The write is already durable. Refresh failures must not report that
        // this credential operation was discarded or invite a duplicate save.
        try {
          invalidateUserEnvironmentInjectionCache();
          await revokeDelegationsAfterEnvironmentChange();
          await destroySessionsByProvider('ollama');
          await getOllamaService().handleUserEnvironmentChanged();
        } catch (error) {
          logMainProcessWarn(
            '[user-environment] Saved config; runtime refresh failed',
            error,
          );
        }
        return result;
      } catch (error) {
        const secureStorageFailure = getSecureStorageFailure(error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(secureStorageFailure ? { secureStorageFailure } : {}),
        };
      }
    },
  );
}
