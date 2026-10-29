import { z } from 'zod/v4';
import { SIDEBAR_ITEM_GROUP_COLORS } from '@canopy/protocol/sidebar';

export const sidebarGroupIdSchema = z
  .string()
  .regex(/^grp-[a-z0-9][a-z0-9-]*$/);
export const sidebarGroupAssignmentFields = {
  groupId: sidebarGroupIdSchema.nullable().optional(),
  newGroup: z
    .object({
      name: z.string().optional(),
      color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
      labelHidden: z.boolean().optional(),
    })
    .strict()
    .optional(),
};

export function hasOneSidebarGroupDestination(value: {
  groupId?: string | null;
  newGroup?: { name?: string; color?: string };
}): boolean {
  return (value.groupId !== undefined) !== (value.newGroup !== undefined);
}

export const scopedSidebarItemGroupSchemas = [
  z.object({ type: z.literal('sidebar.item_groups.list') }).strict(),
  z
    .object({
      type: z.literal('sidebar.item_groups.list_items'),
      groupId: sidebarGroupIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('sidebar.item_groups.set_item'),
      ...sidebarGroupAssignmentFields,
    })
    .strict()
    .refine(
      hasOneSidebarGroupDestination,
      'Supply exactly one of groupId or newGroup.',
    ),
  z
    .object({
      type: z.literal('sidebar.item_groups.update'),
      groupId: sidebarGroupIdSchema,
      name: z.string().optional(),
      color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
      collapsed: z.boolean().optional(),
      labelHidden: z.boolean().optional(),
      keepWhenEmpty: z.boolean().optional(),
    })
    .strict(),
] as const;
