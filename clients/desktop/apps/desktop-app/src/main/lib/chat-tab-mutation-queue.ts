const chatTabMutationQueues = new Map<string, Promise<void>>();

export function enqueueChatTabMutation<T>(
  projectId: string,
  worktreeId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const key = `${projectId}/${worktreeId}`;
  const previous = chatTabMutationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  chatTabMutationQueues.set(key, tail);
  void tail.finally(() => {
    if (chatTabMutationQueues.get(key) === tail) {
      chatTabMutationQueues.delete(key);
    }
  });
  return result;
}
