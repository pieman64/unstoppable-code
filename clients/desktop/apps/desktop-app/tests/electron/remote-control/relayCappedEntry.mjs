// Test-only relay entry: the production relay server, configuration and
// logger (apps/device-relay), with a per-account device cap the spec chooses
// through CANOPY_E2E_RELAY_MAX_DEVICES_PER_ACCOUNT. Production fixes the cap
// at 32 (`DEFAULT_MAX_DEVICES_PER_ACCOUNT`), which a spec cannot reach
// cheaply. Run by `startDeviceRelay({ maxDevicesPerAccount })` under tsx.
import { parseDeviceRelayEnvironment } from '../../../../device-relay/src/config.ts';
import { createLogger } from '../../../../device-relay/src/logger.ts';
import { createDeviceRelayServer } from '../../../../device-relay/src/server.ts';

const maxDevicesPerAccount = Number(
  process.env.CANOPY_E2E_RELAY_MAX_DEVICES_PER_ACCOUNT,
);
if (!Number.isInteger(maxDevicesPerAccount) || maxDevicesPerAccount < 1) {
  throw new Error('CANOPY_E2E_RELAY_MAX_DEVICES_PER_ACCOUNT must be set.');
}
const config = parseDeviceRelayEnvironment(process.env);
const logger = createLogger();
const server = await createDeviceRelayServer({
  port: config.port,
  tokenSecret: config.tokenSecret,
  memoryBudgetBytes: config.memoryBudgetBytes,
  maxDevicesPerAccount,
  logger,
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
