import {
  defineCanopyInstructionRegistry,
  defineCanopyQueryRegistry,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  CORE_CHAT_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_QUERY_DEFINITIONS,
  CORE_CHAT_STREAM_DEFINITIONS,
} from './chat/registry';
import { CORE_WORKSPACE_QUERIES } from './workspace/registry';
import { CORE_WORKTREE_QUERIES } from './worktree/registry';
import { CORE_CHAT_MESSAGE_INSTRUCTION_DEFINITIONS } from './chat/commands-messaging';
import {
  COST_INSTRUCTION_DEFINITIONS,
  COST_QUERY_DEFINITIONS,
} from './cost/operations';
import {
  LEDGER_INSTRUCTION_DEFINITIONS,
  LEDGER_QUERY_DEFINITIONS,
} from './ledger/operations';
import { CORE_CLIENT_INSTRUCTIONS } from './client/registry';
import {
  CORE_EVENTS_INSTRUCTIONS,
  CORE_EVENTS_STREAMS,
} from './events/registry';
import { CORE_RUNTIME_QUERIES, CORE_RUNTIME_STREAMS } from './runtime/registry';

export const CORE_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  ...CORE_CHAT_QUERY_DEFINITIONS,
  ...CORE_WORKSPACE_QUERIES,
  ...CORE_WORKTREE_QUERIES,
  ...LEDGER_QUERY_DEFINITIONS,
  ...COST_QUERY_DEFINITIONS,
});
export const CORE_INSTRUCTION_DEFINITIONS = defineCanopyInstructionRegistry(
  'core',
  {
    ...CORE_CHAT_INSTRUCTION_DEFINITIONS,
    ...CORE_CHAT_MESSAGE_INSTRUCTION_DEFINITIONS,
    ...LEDGER_INSTRUCTION_DEFINITIONS,
    ...COST_INSTRUCTION_DEFINITIONS,
  },
);
export const CORE_STREAM_DEFINITIONS = defineCanopyStreamRegistry('core', {
  ...CORE_CHAT_STREAM_DEFINITIONS,
});

// Transport-level definitions (handshake, leases, events, health). The
// dispatcher requires a handler for every definition it is given, so these stay
// out of the maps above until the daemon lanes (CAN-3727/CAN-3728) wire handlers.
export const CORE_TRANSPORT_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  { ...CORE_RUNTIME_QUERIES },
);
export const CORE_TRANSPORT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    ...CORE_CLIENT_INSTRUCTIONS,
    ...CORE_EVENTS_INSTRUCTIONS,
  });
export const CORE_TRANSPORT_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  { ...CORE_RUNTIME_STREAMS, ...CORE_EVENTS_STREAMS },
);
