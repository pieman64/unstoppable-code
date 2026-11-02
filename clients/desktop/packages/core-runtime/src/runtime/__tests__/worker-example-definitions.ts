import {
  CanopyErrorPayloadSchema,
  CanopyRequestMetadataSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  CoreEventsSubscribeOpenResultSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '@canopy/protocol/canopy-core';

/** Test-only worker operations; no catalog entry or profile row backs them. */
export const WORKER_EXAMPLE_INSTRUCTIONS = defineCanopyInstructionRegistry(
  'worker',
  {
    'worker.example.write': defineCanopyInstruction({
      plane: 'worker',
      domain: 'example',
      version: 1,
      placement: 'worker-only',
      idempotency: 'keyed',
      requiredGrants: ['worker.example.write'],
      params: CanopyStreamCursorSchema,
      result: CanopyStreamCursorSchema,
      error: CanopyErrorPayloadSchema,
    }),
  },
);

const effect = {
  plane: 'worker',
  domain: 'example',
  version: 1,
  placement: 'worker-only',
  requiredGrants: ['worker.example.write'],
  result: CanopyStreamCursorSchema,
  error: CanopyErrorPayloadSchema,
} as const;
/** Pins each retry class, and a keyed schema that declares its own `_meta`. */
export const WORKER_EXAMPLE_EFFECT_INSTRUCTIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.example.append': defineCanopyInstruction({
      ...effect,
      idempotency: 'none',
      params: CanopyStreamCursorSchema,
    }),
    'worker.example.keyed': defineCanopyInstruction({
      ...effect,
      idempotency: 'keyed',
      params: CanopyStreamCursorSchema.extend({
        _meta: CanopyRequestMetadataSchema.required({ idempotencyKey: true }),
      }),
    }),
  });

/** Transform-free, so each side's re-parse is idempotent over JSON. */
export const WORKER_EXAMPLE_STREAMS = defineCanopyStreamRegistry('worker', {
  'worker.example.events': defineCanopyStream({
    plane: 'worker',
    domain: 'example',
    version: 1,
    placement: 'worker-only',
    idempotency: 'inherent',
    requiredGrants: ['worker.example.read'],
    params: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).extend({
      cursor: CanopyStreamCursorSchema.nullable().optional(),
    }),
    item: CanopyStreamCursorSchema.pick({ daemonEpoch: true }),
    end: CanopyStreamEndSchema,
    openResult: CoreEventsSubscribeOpenResultSchema,
    error: CanopyErrorPayloadSchema,
  }),
});
