import {
  CanopyRuntimeDescriptorSchema,
  type CanopyRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import { parseCanopyRuntimeDescriptor } from '../descriptor';
import type { CanopyRuntimeDescriptor as LauncherDescriptor } from '../daemon-ports';
import type { CanopyStartupClaimPort as LauncherClaimPort } from '../launcher-ports';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

it('the C5 schema matches the lane K descriptor contract', () => {
  const descriptor: CanopyRuntimeDescriptor =
    CanopyRuntimeDescriptorSchema.parse({
      version: 1,
      pid: 42,
      startIdentity: 'start-42',
      endpoint: { kind: 'pipe', path: '\\\\.\\pipe\\core-test' },
      protocolRange: { min: 1, max: 2 },
      buildVersion: 'test',
      tokenRef: 'core.token',
    });
  const launcher: LauncherDescriptor = descriptor;
  expect(parseCanopyRuntimeDescriptor(launcher)).toEqual(descriptor);
  for (const version of [undefined, 2]) {
    const unknown = { ...descriptor, version };
    expect(CanopyRuntimeDescriptorSchema.safeParse(unknown).success).toBe(
      false,
    );
    expect(parseCanopyRuntimeDescriptor(unknown)).toBeNull();
  }
});

it('the C5 claim helper satisfies the lane K launcher port', () => {
  const helper = createCanopyStartupClaimPort({
    dataRoot: resolve(tmpdir(), 'canopy-test'),
    owner: { pid: 42, startIdentity: 'start-42' },
    inspectProcess: () => Promise.resolve({ kind: 'unknown' }),
  });
  const port: LauncherClaimPort = helper;
  expect(typeof port.tryAcquire).toBe('function');
  expect(typeof port.release).toBe('function');
  expect(typeof helper.adopt).toBe('function');
  expect(typeof helper.identity).toBe('function');
});
