import { z } from 'zod';

export const PULL_REQUEST_ACTION_TYPES = ['pull_request.create'] as const;

/** No fields: the host reads the branch, head and base it pins itself. */
export const pullRequestActionSchema = z.strictObject({
  type: z.literal('pull_request.create'),
});

export type PullRequestAction = z.output<typeof pullRequestActionSchema>;
