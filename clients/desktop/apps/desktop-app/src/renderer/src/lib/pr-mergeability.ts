// `isPrReadyToMerge` now lives in the shared package so the main-process merge
// handler can re-verify mergeability with identical semantics. Re-exported here
// to keep the renderer's existing import path stable.
export { isPrReadyToMerge } from '@canopy/desktop-shared/types/github';
