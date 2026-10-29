import type {
  PortalChatFileReference,
  PortalChatSendPayload,
  PortalEditorFileMentionOption,
} from '@canopy/protocol/portal';

export type HostPortalChatFileReference = Omit<
  PortalChatFileReference,
  'referenceId'
> & {
  absolutePath: string;
};

export type HostPortalChatSendPayload = Omit<
  PortalChatSendPayload,
  'fileReferences'
> & {
  fileReferences?: HostPortalChatFileReference[];
};

export type HostPortalEditorFileMentionOption = Omit<
  PortalEditorFileMentionOption,
  'referenceId'
> & {
  absolutePath: string;
};
