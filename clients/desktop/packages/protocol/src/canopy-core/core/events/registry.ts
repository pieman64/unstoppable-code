import { defineCanopyInstruction } from '../../definitions';
import { defineCanopyStream } from '../shared';
import {
  CoreEventsAckErrorSchema,
  CoreEventsAckParamsSchema,
  CoreEventsAckResultSchema,
  CoreEventsSubscribeEndSchema,
  CoreEventsSubscribeErrorSchema,
  CoreEventsSubscribeItemSchema,
  CoreEventsSubscribeOpenResultSchema,
  CoreEventsSubscribeParamsSchema,
} from './events';

export const CORE_EVENTS_INSTRUCTIONS = {
  'core.events.ack': defineCanopyInstruction({
    plane: 'core',
    domain: 'events',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.events.read'],
    params: CoreEventsAckParamsSchema,
    result: CoreEventsAckResultSchema,
    error: CoreEventsAckErrorSchema,
  }),
};

export const CORE_EVENTS_STREAMS = {
  'core.events.subscribe': defineCanopyStream({
    plane: 'core',
    domain: 'events',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.events.read'],
    params: CoreEventsSubscribeParamsSchema,
    openResult: CoreEventsSubscribeOpenResultSchema,
    item: CoreEventsSubscribeItemSchema,
    end: CoreEventsSubscribeEndSchema,
    error: CoreEventsSubscribeErrorSchema,
  }),
};
