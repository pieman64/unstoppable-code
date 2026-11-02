import {
  CORE_EXECUTION_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { ResourceMonitorSnapshot } from '@canopy/desktop-shared/types';
import { getResourceMonitorService } from '../resource-monitor';
import { captureExecutionStatusProjection } from './core-execution-adapter';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * `resource-monitor:get-snapshot` as a projection of `core.execution.status.get`
 * (CAN-5080). The call holds only `core.execution.read`; the resource monitor
 * adds the desktop guard counts and keeps the host metadata, so the payload
 * is unchanged.
 */

export type ExecutionStatusDispatcher = Pick<DesktopCanopyDispatcher, 'query'>;

export async function readResourceMonitorSnapshotThroughCore(
  dispatcher: ExecutionStatusDispatcher,
  caller: CanopyCallerDescriptor,
): Promise<ResourceMonitorSnapshot> {
  const { projection } = await captureExecutionStatusProjection(() =>
    preserveRuntimeCauseError(
      dispatcher.query(
        'core.execution.status.get',
        {},
        { caller: { ...caller, grants: [CORE_EXECUTION_GRANTS.read] } },
      ),
    ),
  );
  if (!projection.snapshot)
    throw new Error('Execution status projection was not captured.');
  return getResourceMonitorService().snapshotFor(projection.snapshot);
}
