import type {
  SettingsEvent,
  SettingsReadMap,
  SettingsReadName,
  SettingsSubscriptionScope,
  SettingsWriteMap,
  SettingsWriteName,
} from '@canopy/protocol/settings';

/**
 * Hosted account and organization settings data access, exposed as optional
 * `CanopyClient.settings`. Every call names a fixed `SETTINGS_OPERATIONS`
 * entry; there is deliberately no generic URL, method, or header proxy.
 * Implementations validate input before sending and validate results before
 * resolving, and reject with `SettingsOperationError`.
 */
export interface AccountOrganizationSettingsClient {
  read<K extends SettingsReadName>(
    operation: K,
    input: SettingsReadMap[K]['input'],
  ): Promise<SettingsReadMap[K]['result']>;
  write<K extends SettingsWriteName>(
    operation: K,
    input: SettingsWriteMap[K]['input'],
  ): Promise<SettingsWriteMap[K]['result']>;
  /** Returns an unsubscribe function; safe to call more than once. */
  subscribe(
    scope: SettingsSubscriptionScope,
    listener: (event: SettingsEvent) => void,
  ): () => void;
}
