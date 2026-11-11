import type {
  SDKMessage,
  SDKMessageOrigin,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  TerminalReason,
} from '@anthropic-ai/claude-agent-sdk';
import type { LifecycleRole } from '@canopy/execution-engine/node/harness-contract/lifecycle-role';

export const CLAUDE_LIFECYCLE = {
  messageTypes: {
    // The input envelope opens a turn and the result is the authoritative close signal.
    user: 'turn start',
    result: 'turn end',
    // These message kinds carry session lifecycle or authentication state.
    auth_status: 'session state',
    conversation_reset: 'session state',
    // Remaining top-level kinds carry content, progress, or events refined below by subtype.
    assistant: 'informational',
    system: 'informational',
    stream_event: 'informational',
    tool_progress: 'informational',
    tool_use_summary: 'informational',
    rate_limit_event: 'informational',
    prompt_suggestion: 'informational',
  } satisfies Record<SDKMessage['type'], LifecycleRole>,

  systemSubtypes: {
    // Init metadata opens each turn in a long-lived CLI process.
    init: 'turn start',
    // These report session phase, configuration, compaction, or worker lifecycle.
    session_state_changed: 'session state',
    status: 'session state',
    commands_changed: 'session state',
    compact_boundary: 'session state',
    worker_shutting_down: 'session state',
    // This is the authoritative change to the set of background tasks.
    background_tasks_changed: 'background set',
    // Task lifecycle events refer to an independently running child task.
    task_started: 'child',
    task_updated: 'child',
    task_progress: 'child',
    task_notification: 'child',
    // Other system subtypes report content, progress, diagnostics, or auxiliary events.
    api_retry: 'informational',
    control_request_progress: 'informational',
    model_refusal_fallback: 'informational',
    model_refusal_no_fallback: 'informational',
    local_command_output: 'informational',
    hook_started: 'informational',
    hook_progress: 'informational',
    hook_response: 'informational',
    plugin_install: 'informational',
    thinking_tokens: 'informational',
    notification: 'informational',
    files_persisted: 'informational',
    memory_recall: 'informational',
    elicitation_complete: 'informational',
    permission_denied: 'informational',
    mirror_error: 'informational',
    // Emitted after a disk-full exit; the process is already gone.
    session_writes_lost: 'informational',
    informational: 'informational',
  } satisfies Record<
    Extract<SDKMessage, { type: 'system' }>['subtype'],
    LifecycleRole
  >,

  resultSubtypes: {
    // Every result subtype ends this SDK turn, whether successful or early-stopped.
    success: 'turn end',
    error_during_execution: 'turn end',
    error_max_turns: 'turn end',
    error_max_budget_usd: 'turn end',
    error_max_structured_output_retries: 'turn end',
  } satisfies Record<SDKResultMessage['subtype'], LifecycleRole>,

  terminalReasons: {
    // Each terminal reason describes why the query loop ended.
    blocking_limit: 'turn end',
    rapid_refill_breaker: 'turn end',
    prompt_too_long: 'turn end',
    image_error: 'turn end',
    model_error: 'turn end',
    api_error: 'turn end',
    malformed_tool_use_exhausted: 'turn end',
    aborted_streaming: 'turn end',
    aborted_tools: 'turn end',
    stop_hook_prevented: 'turn end',
    hook_stopped: 'turn end',
    tool_deferred: 'turn end',
    max_turns: 'turn end',
    background_requested: 'turn end',
    completed: 'turn end',
    budget_exhausted: 'turn end',
    structured_output_retry_exhausted: 'turn end',
    tool_deferred_unavailable: 'turn end',
    turn_setup_failed: 'turn end',
  } satisfies Record<TerminalReason, LifecycleRole>,

  sessionStates: {
    // These are the SDK's explicit session lifecycle states.
    idle: 'session state',
    running: 'session state',
    requires_action: 'session state',
  } satisfies Record<SDKSessionStateChangedMessage['state'], LifecycleRole>,

  originKinds: {
    // Human, channel, and peer envelopes supply the next turn's input.
    human: 'turn start',
    channel: 'turn start',
    peer: 'turn start',
    // Task notifications and observer messages carry child-task provenance.
    'task-notification': 'child',
    observer: 'child',
    // Continuations open another turn; observer activity describes a child observer.
    'auto-continuation': 'turn start',
    'observer-activity': 'child',
    // Coordinator messages are auxiliary; unknown provenance is deliberately not a lifecycle signal.
    coordinator: 'informational',
    unclassified: 'ignored',
  } satisfies Record<SDKMessageOrigin['kind'], LifecycleRole>,

  taskNotificationSubkinds: {
    // Each subkind refines the source of a task-notification child event.
    'scheduled-trigger': 'child',
    'peer-send-message': 'child',
    'projects-relay': 'child',
    'session-inbox': 'child',
  } satisfies Record<
    NonNullable<
      Extract<SDKMessageOrigin, { kind: 'task-notification' }>['subkind']
    >,
    LifecycleRole
  >,
} as const;
