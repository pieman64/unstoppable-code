import { getOpenCodeMcpBaseEnv } from './mcp-servers';
import type { getCodexRuntimeService } from '../codex/runtime-service';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { McpServer } from '@agentclientprotocol/sdk';
import { readOpenCodeMcpSnapshot } from '@canopy/desktop-shared/node/opencode/mcp-snapshot';
import type { OpenCodeCapabilitySnapshot } from '@canopy/desktop-shared/node/opencode/capability-snapshot';

/** Discovery uses the existing process broker so cancellation owns descendants too. */
export async function snapshotOpenCodeMcpTools(
  servers: readonly McpServer[],
  identities: Readonly<Record<string, unknown>>,
  cwd: string,
  signal: AbortSignal,
  alreadyBrokered = false,
): Promise<OpenCodeCapabilitySnapshot['mcp']> {
  const ownerId = `opencode-snapshot:${randomUUID()}`;
  let broker: ReturnType<typeof getCodexRuntimeService> | undefined;
  try {
    return await readOpenCodeMcpSnapshot(
      servers,
      identities,
      signal,
      async (server) => {
        const launcherEnv = ['TMPDIR', 'TMP', 'TEMP'].map((name) => ({
          name,
          value: tmpdir(),
        }));
        if (alreadyBrokered)
          return { ...server, env: [...server.env, ...launcherEnv] };
        const { getCodexRuntimeService } =
          await import('../codex/runtime-service');
        broker ??= getCodexRuntimeService();
        const route = await broker.registerStdioMcpRoute(
          {
            ownerId,
            routeKey: server.name,
            cwd,
            command: server.command,
            args: server.args,
            baseEnv: getOpenCodeMcpBaseEnv(),
            env: Object.fromEntries(
              server.env.map((entry) => [entry.name, entry.value]),
            ),
          },
          { signal, toolCallGate: () => Promise.resolve(false) },
        );
        return {
          name: server.name,
          command: route.command,
          args: route.args,
          // Only the launcher needs the host rendezvous directory. The selected
          // server's environment and credentials remain owned by the broker.
          env: launcherEnv,
        };
      },
    );
  } finally {
    await broker?.revokeStdioMcpRoutes(ownerId);
  }
}
