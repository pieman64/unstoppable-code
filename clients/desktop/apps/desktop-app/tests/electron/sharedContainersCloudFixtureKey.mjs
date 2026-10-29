export const SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX =
  'csk_shared_containers_e2e';

export function isSharedContainersCloudApiKey(value) {
  return (
    typeof value === 'string' &&
    (value === SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX ||
      value.startsWith(`${SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX}_worker-`))
  );
}

export function sharedContainersCloudApiKeyForWorker(env = process.env) {
  const workerIndex = env.TEST_PARALLEL_INDEX ?? env.TEST_WORKER_INDEX;
  return workerIndex === undefined || workerIndex === ''
    ? SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX
    : `${SHARED_CONTAINERS_CLOUD_API_KEY_PREFIX}_worker-${workerIndex}`;
}
