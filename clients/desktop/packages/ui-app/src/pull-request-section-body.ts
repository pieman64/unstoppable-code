// Dedicated entry for the extracted PullRequestSection presentational core
// (CAN-1528). The desktop wrapper imports THIS subpath instead of the package
// barrel so renderer unit tests do not drag the chat transcript chain in —
// the same precedent as `./chat-panel`.
export {
  PullRequestSectionBody,
  PullRequestRepoDetail,
  type PullRequestSectionBodyProps,
  type PullRequestSectionRepo,
  type PullRequestSectionPrStatus,
  type PullRequestSectionPrState,
  type PullRequestSectionCheckStatus,
  type PullRequestSectionCheckDetail,
  type PullRequestSectionReviewStatus,
  type PullRequestSectionLabel,
  type PullRequestSectionCreationStep,
  type PullRequestSectionCreationProgress,
} from './code/activity/PullRequestSectionBody';
