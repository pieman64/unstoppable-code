// The receipts the project and bot writes answer, shared by every host that
// serves them (desktop and the web host for cloud projects).

/** A chat in a project, by canonical IDs. */
export type ProjectReceiptAddress = {
  projectId: string;
  taskId: string;
  chatId: string;
};

/** A chat of a bot, by canonical IDs. */
export type BotReceiptAddress = {
  botId: string;
  taskId: string;
  chatId: string;
};

export type WatcherReceipt = {
  watcherId: string;
  disposition: 'created' | 'deduplicated';
};

/**
 * Proof that the target accepted one input (plan 8.1). A queued receipt
 * carries the actual host queue row ID; a started one the canonical input ID.
 * Turn IDs are never synthesized.
 */
export type AcceptedInputReceipt = {
  address: ProjectReceiptAddress | BotReceiptAddress;
  acceptedAt: string;
  turnId?: string;
  watcherReceipts: WatcherReceipt[];
} & (
  | { disposition: 'started'; messageId: string; queuedMessageId?: string }
  | { disposition: 'queued'; queuedMessageId: string; messageId?: string }
);

/** Steering keeps the original input ID; it never sends another message. */
export type SteeredInputReceipt = {
  address: ProjectReceiptAddress;
  queuedMessageId: string;
  disposition: 'steered';
  steeredAt: string;
};

/**
 * A created (or, for chat creation in an existing task, reused empty) chat.
 * `chatCreated` is false only for documented empty-tab reuse. `input` is
 * present exactly when an initial message was accepted.
 */
export type CreatedTaskChatReceipt = {
  address: ProjectReceiptAddress | BotReceiptAddress;
  taskCreated: boolean;
  chatCreated: boolean;
  /**
   * Present exactly when the action supplied `model`: the id stored on the
   * new chat, a route for an Agent on the default model.
   */
  model?: string;
  /** The selected Agent's id, when the selected model is an Agent. */
  agentId?: string;
  input?: AcceptedInputReceipt;
};
