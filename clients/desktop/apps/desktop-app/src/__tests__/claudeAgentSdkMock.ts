async function* emptyMessages(): AsyncGenerator<unknown, void> {}

export function query(): AsyncGenerator<unknown, void> {
  return emptyMessages();
}
