import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';

/**
 * Cloud chat surfaces run on the web core, not this client: the thread
 * binding feeds the shared chat store and sends through the relay. Shared
 * components that ask for anything else get an explicit refusal, never a
 * call to the local core.
 */
const CLOUD_CHAT_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'none',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'in-memory',
  overviewNotifications: false,
  chatDrafts: false,
  chatVisuals: false,
  skillSuggestions: false,
  delegationStop: false,
  delegationMessaging: false,
  delegationWorktreeDetails: false,
};

function unsupported(name: string): Promise<never> {
  return Promise.reject(
    new Error(`${name} is not available in desktop cloud chats.`),
  );
}

class CloudChatCanopyClient implements CanopyClient {
  readonly capabilities: CanopyCapabilities = CLOUD_CHAT_CAPABILITIES;

  query<K extends QueryName>(name: K): Promise<QueryMap[K]['result']> {
    return unsupported(name);
  }

  command<K extends CommandName>(name: K): Promise<CommandMap[K]['result']> {
    return unsupported(name);
  }

  subscribe(): Unsubscribe {
    return () => undefined;
  }
}

/** One client, so every cloud chat shares one shared chat store instance. */
export const cloudChatCanopyClient: CanopyClient = new CloudChatCanopyClient();
