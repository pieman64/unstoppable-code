export async function drainChatStateBeforeRuntimeShutdown(
  drain: () => Promise<unknown>,
  shutdown: () => Promise<unknown> | undefined,
): Promise<void> {
  await drain().catch(() => undefined);
  await shutdown();
}
