import {
  CANOPY_STREAM_DEFINITIONS,
  CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
  CORE_APPROVAL_QUERY_DEFINITIONS,
  CORE_APPROVAL_STREAM_DEFINITIONS,
  CORE_ARTIFACT_QUERY_DEFINITIONS,
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CHAT_LIVE_STREAM_DEFINITIONS,
  CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
  CORE_CHAT_TASK_QUERY_DEFINITIONS,
  CORE_CHAT_TASK_STREAM_DEFINITIONS,
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  composeCanopyStreamRegistries,
} from '@canopy/protocol/canopy-core';
import type { RelayDefinitions } from './definitions';
import type { InterfaceRelayOperationKind } from './interface-allowlist.generated';
import type { RendererRelaySurface } from './surface-allowlist';

/**
 * What the renderer may call on the web core (CAN-4185 D5): cloud cowork
 * chats only. Nothing Git, files, terminals, scripts or pull requests.
 */
export const WEB_CORE_RELAY_OPERATIONS: ReadonlySet<string> = new Set([
  'core.workspace.list',
  'core.workspace.get',
  'core.chat.task.list',
  'core.chat.task.events',
  'core.chat.list',
  'core.chat.snapshot.get',
  'core.chat.transcript.page',
  'core.chat.events',
  'core.chat.live.events',
  'core.chat.create',
  'core.chat.update',
  'core.chat.archive',
  'core.chat.message.send',
  'core.chat.send.receipt',
  'core.chat.turn.cancel',
  'core.chat.queue.entry.cancel',
  'core.chat.queue.entry.update',
  'core.chat.queue.entry.force',
  'core.chat.question.respond',
  'core.approval.request.list',
  'core.approval.request.events',
  'core.approval.request.respond',
  'core.catalog.snapshot.get',
  'core.catalog.selection.get',
  'core.catalog.selection.update',
  'core.artifact.list',
  'core.artifact.get',
]);

function allowed<D>(map: Readonly<Record<string, D>>): Record<string, D> {
  return Object.fromEntries(
    Object.entries(map).filter(([name]) => WEB_CORE_RELAY_OPERATIONS.has(name)),
  );
}

/**
 * The protocol definitions of `WEB_CORE_RELAY_OPERATIONS`. Task, live reply,
 * catalog, artifact, approval and question operations live in web-core-only
 * registries, kept out of the composed core ones the desktop dispatcher must
 * serve.
 */
export const WEB_CORE_RELAY_DEFINITIONS: RelayDefinitions = {
  queries: allowed(
    composeCanopyQueryRegistries(
      CORE_QUERY_DEFINITIONS,
      CORE_CHAT_TASK_QUERY_DEFINITIONS,
      CORE_CATALOG_QUERY_DEFINITIONS,
      CORE_ARTIFACT_QUERY_DEFINITIONS,
      CORE_APPROVAL_QUERY_DEFINITIONS,
    ),
  ),
  instructions: allowed(
    composeCanopyInstructionRegistries(
      CORE_INSTRUCTION_DEFINITIONS,
      CORE_CATALOG_INSTRUCTION_DEFINITIONS,
      CORE_APPROVAL_INSTRUCTION_DEFINITIONS,
      CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
    ),
  ),
  streams: allowed(
    composeCanopyStreamRegistries(
      CANOPY_STREAM_DEFINITIONS,
      CORE_CHAT_TASK_STREAM_DEFINITIONS,
      CORE_CHAT_LIVE_STREAM_DEFINITIONS,
      CORE_APPROVAL_STREAM_DEFINITIONS,
    ),
  ),
};

/**
 * What main itself calls on a web core connection: the client lease it holds
 * for the session and the acknowledgement of delivered stream items. Never in
 * `WEB_CORE_RELAY_OPERATIONS`, so the renderer can call none of them.
 */
export const WEB_CORE_HOST_DEFINITIONS: RelayDefinitions = {
  queries: {},
  instructions: {
    'core.client.lease.acquire':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.acquire'],
    'core.client.lease.renew':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.renew'],
    'core.client.lease.release':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.client.lease.release'],
    'core.events.ack':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
  },
  streams: {},
};

/**
 * Only the main window reaches the web core (CAN-4185 D4). Documented
 * exception to App Advisor parity: App Advisor reaches desktop capabilities
 * through agent actions, not this relay, and cloud chat agent actions are a
 * CAN-4186 follow-up (CAN-4185 D12). Pinned by web-core-relay.test.ts.
 */
export function webCoreRelayAllows(
  surface: RendererRelaySurface,
  _kind: InterfaceRelayOperationKind,
  method: string,
): boolean {
  return surface === 'main' && WEB_CORE_RELAY_OPERATIONS.has(method);
}
