export function assessCodexSubagentThreadRouting(descriptors, threadsByChat) {
  const expectedParentChatIds = descriptors
    .filter(
      (descriptor) =>
        descriptor.providerType === 'codex' && descriptor.usesSubagent,
    )
    .map((descriptor) => descriptor.id);
  const expectedParents = new Set(expectedParentChatIds);
  const violations = [];

  for (const chatId of expectedParentChatIds) {
    const observed = threadsByChat[chatId] ?? 0;
    if (observed !== 1) {
      violations.push({ chatId, expected: 1, observed });
    }
  }
  for (const [chatId, observed] of Object.entries(threadsByChat)) {
    if (!expectedParents.has(chatId) && observed > 0) {
      violations.push({ chatId, expected: 0, observed });
    }
  }

  return {
    passed: violations.length === 0,
    expectedParentChatIds,
    violations,
  };
}
