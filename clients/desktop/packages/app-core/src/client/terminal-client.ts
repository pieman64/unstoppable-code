import type {
  DomainEventMap,
  DomainEventName,
  SubscriptionFilter,
  Unsubscribe,
} from '../events/domain-events';
import type {
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
} from './canopy-client';

/** Queries owned by the shared terminal slice. */
export type TerminalQueryName = Extract<QueryName, `terminal.${string}`>;

/** Commands owned by the shared terminal slice. */
export type TerminalCommandName = Extract<CommandName, `terminal.${string}`>;

/** Domain events owned by the shared terminal slice. */
export type TerminalEventName = Extract<DomainEventName, `terminal.${string}`>;

/** Minimal terminal data seam accepted by shared stores and UI. */
export interface TerminalClient {
  query<K extends TerminalQueryName>(
    name: K,
    args: QueryMap[K]['args'],
  ): Promise<QueryMap[K]['result']>;

  command<K extends TerminalCommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;

  subscribe<K extends TerminalEventName>(
    name: K,
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ): Unsubscribe;
}
