// Monotonic renderer-session id generation for chat tabs and messages.

let tabCounter = 0;

export function nextTabId(): string {
  return `chat-${++tabCounter}-${Date.now()}`;
}

let messageCounter = 0;

export function nextMsgId(): string {
  return `msg-${++messageCounter}-${Date.now()}`;
}
