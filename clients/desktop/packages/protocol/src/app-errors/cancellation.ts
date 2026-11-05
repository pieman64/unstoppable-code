import { z } from 'zod';

export const AppCancellationSchema = z
  .object({ type: z.literal('app_cancellation') })
  .strict();

export class AppCancellation extends Error {
  readonly type = 'app_cancellation';
  constructor() {
    super('Operation cancelled');
    this.name = 'AppCancellation';
  }
  toJSON(): z.infer<typeof AppCancellationSchema> {
    return { type: this.type };
  }
}

export function isAppCancellation(value: unknown): boolean {
  try {
    return (
      value instanceof AppCancellation ||
      AppCancellationSchema.safeParse(value).success
    );
  } catch {
    return false;
  }
}
