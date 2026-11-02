/** Parent-owned deletion fence shared by legacy logs and format-4 child writes. */
interface ParentDeleteState {
  generation: number;
  deleted: boolean;
  active: number;
  waiters: Array<() => void>;
}

export class ChatChildDeleteFence {
  private readonly parents = new Map<string, ParentDeleteState>();

  private state(chatId: string): ParentDeleteState {
    let state = this.parents.get(chatId);
    if (!state) {
      state = { generation: 0, deleted: false, active: 0, waiters: [] };
      this.parents.set(chatId, state);
    }
    return state;
  }

  public generation(chatId: string): number {
    return this.state(chatId).generation;
  }
  public isDeleted(
    chatId: string,
    generation = this.generation(chatId),
  ): boolean {
    const state = this.state(chatId);
    return state.deleted || state.generation !== generation;
  }
  public acquire(
    chatId: string,
  ): { generation: number; release: () => void } | undefined {
    const state = this.state(chatId);
    if (state.deleted) return undefined;
    state.active += 1;
    let released = false;
    return {
      generation: state.generation,
      release: (): void => {
        if (released) return;
        released = true;
        state.active -= 1;
        if (state.active === 0)
          for (const wake of state.waiters.splice(0)) wake();
      },
    };
  }
  public async retire(chatId: string): Promise<number> {
    const state = this.state(chatId);
    state.deleted = true;
    state.generation += 1;
    if (state.active !== 0)
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    return state.generation;
  }
  public restore(chatId: string): number {
    const state = this.state(chatId);
    state.generation += 1;
    state.deleted = false;
    return state.generation;
  }
}

const fences = new Map<string, ChatChildDeleteFence>();
export function chatChildDeleteFence(root: string): ChatChildDeleteFence {
  let fence = fences.get(root);
  if (!fence) {
    fence = new ChatChildDeleteFence();
    fences.set(root, fence);
  }
  return fence;
}
