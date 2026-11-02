// Forked host for `daemon-start-attach-run.mjs`, bundled at run time: the
// production CLI daemon host composition with spawns counted at the
// supervisor. Inputs arrive in CANOPY_DAEMON_POPULATION_HOST; commands over IPC.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { createCanopyClientLease } from '@canopy/core-client';
import { attachOrStartCanopyDaemon } from '@canopy/core-client/node';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import { createCliDaemonHost } from '../../../desktop-cli/src/runtime';

const definitions = {
  queries: CORE_TRANSPORT_QUERY_DEFINITIONS,
  instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  streams: {},
};
const inputs = JSON.parse(process.env.CANOPY_DAEMON_POPULATION_HOST ?? '{}');
const platform = hostPlatformServices(
  createPlatformEndpointServices(hostPlatformOperatingSystem()),
);
let held;

async function publishedDescriptor(dataRoot) {
  try {
    return JSON.parse(
      await readFile(join(dataRoot, 'runtime', 'core.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const commands = {
  brand: async () => BRAND.id,
  /** The root's existence and publication and, by pid or publication, its owner's state. */
  async inspect({ dataRoot, pid }) {
    const rootPresent = await lstat(dataRoot).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    const published = await publishedDescriptor(dataRoot);
    const owner = pid ?? published?.pid;
    const state =
      owner === undefined
        ? null
        : await platform.supervision.inspectProcess({ pid: owner });
    return {
      rootPresent,
      descriptorPresent: published !== null,
      pid: owner ?? null,
      ownerState: state?.state ?? null,
      ownerStartIdentity: state?.startIdentity ?? null,
    };
  },
  /** Composes the host without launching, so its endpoint rules run early. */
  async endpoint({ dataRoot }) {
    createCliDaemonHost({ ...inputs, dataRoot });
    return true;
  },
  /** Cold time runs from the supervisor spawn to authenticated `ready` health. */
  async attach({ dataRoot, hold }) {
    const host = createCliDaemonHost({ ...inputs, dataRoot });
    const supervisor = host.launch.ports.supervisor;
    let spawns = 0;
    let spawnAt;
    const ports = {
      ...host.launch.ports,
      supervisor: {
        ...supervisor,
        spawnDaemon: (command) => {
          spawns += 1;
          spawnAt ??= performance.now();
          return supervisor.spawnDaemon(command);
        },
      },
    };
    const begin = performance.now();
    const result = await attachOrStartCanopyDaemon({
      ...host.launch,
      ports,
      attach: (endpoint, setup) =>
        host.connect({
          endpoint,
          ...setup,
          clientName: 'cli',
          clientVersion: 'daemon-populations',
          definitions,
        }),
      dispose: (client) => client.close(),
    });
    const health = await result.value.query('core.runtime.health.get', {});
    const end = performance.now();
    const trial = {
      started: result.started,
      spawns,
      attacherPid: process.pid,
      readyMs: end - (spawnAt ?? begin),
      attachMs: end - begin,
      healthState: health.runtime.state,
      identity: {
        pid: result.descriptor.pid,
        startIdentity: result.descriptor.startIdentity,
        daemonEpoch: health.runtime.daemonEpoch,
      },
    };
    if (!hold) {
      await result.value.close();
      return trial;
    }
    // The holder keeps the daemon retained; it never reconnects.
    const lease = createCanopyClientLease({
      client: result.value,
      attach: async () => {
        throw new Error('The population holder lost its daemon.');
      },
      identity: {
        clientInstanceId: 'daemon-populations-holder',
        interfaceKind: 'cli',
        label: 'population holder',
      },
      renewalIntervalMs: 15_000,
      presence: () => ({ interactive: true, foreground: true }),
    });
    await lease.acquire();
    held = { lease, client: result.value };
    return trial;
  },
  async release() {
    await held?.lease.release('normal_shutdown');
    await held?.client.close();
    held = undefined;
  },
};

process.on('message', async ({ id, command, args }) => {
  try {
    process.send({ id, value: await commands[command](args) });
  } catch (error) {
    process.send({ id, error: String(error?.stack ?? error) });
  }
});
