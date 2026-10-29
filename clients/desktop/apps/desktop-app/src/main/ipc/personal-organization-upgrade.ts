import { z } from 'zod';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  UpgradePersonalOrganizationRequestSchema,
  PersonalOrganizationPromotionOutcomeSchema,
  SendOrganizationInviteRequestSchema,
  OrganizationInviteResultSchema,
  OrganizationInviteStatusSchema,
  PersonalProjectListSchema,
  PersonalProjectConversionRequestSchema,
  PersonalProjectOperationSchema,
  PersonalProjectStatusRequestSchema,
  OrganizationOperationRefusalSchema,
  type OrganizationOperationRefusal,
} from '@canopy/protocol/organizations';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { registerIpcHandler } from './register';
import type { PersonalOrganizationUpgradeService } from '../services/personal-organization-upgrade';
const getService = async (): Promise<PersonalOrganizationUpgradeService> =>
  (
    await import('../services/personal-organization-upgrade-host')
  ).getPersonalOrganizationUpgradeService();

async function preserveRefusal<T>(
  run: () => Promise<T>,
): Promise<T | OrganizationOperationRefusal> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof CanopyCloudClientError)) throw error;
    const code = OrganizationOperationRefusalSchema.shape.code.safeParse(
      error.serverCode,
    );
    return OrganizationOperationRefusalSchema.parse({
      error: error.message,
      code: code.success
        ? code.data
        : error.code === 'network-error'
          ? 'offline'
          : 'failed',
      ...(error.status ? { status: error.status } : {}),
    });
  }
}

export function registerPersonalOrganizationUpgradeHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.personalOrganizationUpgradeInviteStatus,
    async (_event, value: unknown) =>
      preserveRefusal(async () => {
        const request = z
          .object({ organizationId: z.uuid(), email: z.email() })
          .strict()
          .parse(value);
        return OrganizationInviteStatusSchema.parse(
          await (
            await getService()
          ).inviteStatus(request.organizationId, request.email),
        );
      }),
  );
  registerIpcHandler(
    IPC_CHANNELS.personalOrganizationUpgradePromote,
    async (_event, value: unknown) =>
      preserveRefusal(async () =>
        PersonalOrganizationPromotionOutcomeSchema.parse(
          await (
            await getService()
          ).promote(UpgradePersonalOrganizationRequestSchema.parse(value)),
        ),
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.personalOrganizationUpgradeInvite,
    async (_event, value: unknown) =>
      preserveRefusal(async () => {
        const body = z
          .object({
            organizationId: z.uuid(),
            invite: SendOrganizationInviteRequestSchema,
          })
          .strict()
          .parse(value);
        return OrganizationInviteResultSchema.parse(
          await (await getService()).invite(body.organizationId, body.invite),
        );
      }),
  );
  registerIpcHandler(IPC_CHANNELS.personalOrganizationUpgradeList, async () =>
    PersonalProjectListSchema.parse(await (await getService()).list()),
  );
  registerIpcHandler(
    IPC_CHANNELS.personalOrganizationUpgradeConvert,
    async (_event, value: unknown) =>
      PersonalProjectOperationSchema.parse(
        await (
          await getService()
        ).convert(PersonalProjectConversionRequestSchema.parse(value)),
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.personalOrganizationUpgradeStatus,
    async (_event, value: unknown) =>
      PersonalProjectOperationSchema.nullable().parse(
        await (
          await getService()
        ).status(PersonalProjectStatusRequestSchema.parse(value).operationId),
      ),
  );
}
