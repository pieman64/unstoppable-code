/**
 * Display vocabulary for the external-agent access editor: the preset picker,
 * one row per tool group with Off, Read or Write, optional destructive access,
 * and each group's tool list.
 *
 * Pure data. The host computes every value (from its own catalog and policy
 * rules) and passes it in; the editor never decides what a group offers or
 * which tools count.
 */

/** A group's chosen read/write level; destructive actions are a separate switch. */
export type AgentAccessLevel = 'off' | 'read' | 'write';

/** `custom` is selected whenever the rows no longer match a preset. */
export type AgentAccessPreset = 'read' | 'write' | 'custom';

/** A disclosure label shown beside a tool. */
export type AgentToolMarker =
  | 'spendsCredits'
  | 'sendsEmail'
  | 'publicEffect'
  | 'actsOnRemote';

export interface AgentAccessToolRow {
  /** Stable tool name; the key passed back in `onToolChange`. */
  readonly name: string;
  /** User-facing title, such as "Start a cloud task". */
  readonly title: string;
  /** The level its group needs before the tool can be on. */
  readonly access: 'read' | 'write';
  /** Off unless the person turns it on (listed with an "Off by default" label). */
  readonly defaultOff: boolean;
  readonly markers: readonly AgentToolMarker[];
  /** Whether the tool is on in the current choice. */
  readonly enabled: boolean;
  /**
   * False when the group's level does not reach `access` (or the group is
   * off): the switch shows off and cannot be changed.
   */
  readonly available: boolean;
}

export interface AgentAccessGroupRow {
  /** Stable group id; the key passed back in the callbacks. */
  readonly id: string;
  readonly label: string;
  /** One line naming what the group reaches. */
  readonly description: string;
  readonly level: AgentAccessLevel;
  /**
   * The levels this group offers, in order. A group with no Off (such as
   * Account) omits `off`; a read-only group omits `write`.
   */
  readonly levels: readonly AgentAccessLevel[];
  /**
   * When set, Write is shown but unavailable, with this reason as its
   * tooltip (for example "Agents can never change billing").
   */
  readonly writeUnavailableReason?: string;
  /**
   * When set, the whole row is shown disabled at Off with this short
   * explanation instead of a working picker (for example "Not available yet").
   */
  readonly unavailableReason?: string;
  /** Optional additional access for destructive actions in a writable group. */
  readonly destructive?: {
    readonly label: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly warning?: string;
  };
  readonly tools: readonly AgentAccessToolRow[];
}

export interface AgentAccessToolCount {
  /** Tools on in the current choice, counted exactly as the server does. */
  readonly enabled: number;
  /** Every tool the server offers, destructive ones included. */
  readonly total: number;
  /** The most tools one connection may expose. */
  readonly max: number;
}
