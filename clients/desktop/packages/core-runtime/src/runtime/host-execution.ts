import {
  CanopyHostExecutionSchema,
  type CanopyHostExecution,
} from '@canopy/protocol/canopy-core';

import { canopyInvalidArgumentError } from './errors';

/**
 * A received `_execution` member as a call option (CAN-5496). The receiving
 * dispatcher still refuses it on an operation that does not accept it. The
 * message never carries a value.
 */
export function hostExecutionOption(value: unknown): {
  execution?: CanopyHostExecution;
} {
  if (value === undefined) return {};
  const parsed = CanopyHostExecutionSchema.safeParse(value);
  if (!parsed.success)
    throw canopyInvalidArgumentError('Invalid host execution.');
  return { execution: parsed.data };
}
