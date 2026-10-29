import { defineCanopyQuery, defineCanopyStream } from '../shared';
import {
  CoreRuntimeErrorSchema,
  CoreRuntimeEventsEndSchema,
  CoreRuntimeEventsErrorSchema,
  CoreRuntimeEventsItemSchema,
  CoreRuntimeEventsOpenResultSchema,
  CoreRuntimeEventsParamsSchema,
  CoreRuntimeHealthErrorSchema,
  CoreRuntimeHealthGetParamsSchema,
  CoreRuntimeHealthGetResultSchema,
  CoreRuntimeInitializeParamsSchema,
  CoreRuntimeInitializeResultSchema,
  CoreRuntimeManifestErrorSchema,
  CoreRuntimeManifestGetParamsSchema,
  CoreRuntimeManifestGetResultSchema,
} from './runtime';

export const CORE_RUNTIME_QUERIES = {
  // No grants: the handshake runs before transport authentication completes.
  'core.runtime.initialize': defineCanopyQuery({
    plane: 'core',
    domain: 'runtime',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [],
    params: CoreRuntimeInitializeParamsSchema,
    result: CoreRuntimeInitializeResultSchema,
    error: CoreRuntimeErrorSchema,
  }),
  'core.runtime.health.get': defineCanopyQuery({
    plane: 'core',
    domain: 'runtime',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.runtime.read'],
    params: CoreRuntimeHealthGetParamsSchema,
    result: CoreRuntimeHealthGetResultSchema,
    error: CoreRuntimeHealthErrorSchema,
  }),
  'core.runtime.manifest.get': defineCanopyQuery({
    plane: 'core',
    domain: 'runtime',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.runtime.read'],
    params: CoreRuntimeManifestGetParamsSchema,
    result: CoreRuntimeManifestGetResultSchema,
    error: CoreRuntimeManifestErrorSchema,
  }),
};

export const CORE_RUNTIME_STREAMS = {
  'core.runtime.events': defineCanopyStream({
    plane: 'core',
    domain: 'runtime',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.runtime.read'],
    params: CoreRuntimeEventsParamsSchema,
    openResult: CoreRuntimeEventsOpenResultSchema,
    item: CoreRuntimeEventsItemSchema,
    end: CoreRuntimeEventsEndSchema,
    error: CoreRuntimeEventsErrorSchema,
  }),
};
