// The placement of content beside a chat is shared with the web portal; this
// path stays for the desktop modules and tests that already import it.
export {
  CHAT_SIBLING_CONTENT_KINDS,
  createChatSiblingGroupToRight,
  pickContentTargetGroupId,
  pickReusableChatSiblingGroupId,
  resolveChatPanelAnchor,
  rollbackCreatedChatSiblingGroup,
  type ChatPanelAnchor,
  type CreatedChatSiblingGroup,
  type FilePanelPlacementPolicy,
} from '@canopy/ui-app/panel-layout-store';
