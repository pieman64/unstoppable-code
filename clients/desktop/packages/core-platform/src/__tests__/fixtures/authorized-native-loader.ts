/** Mapper qualification seam: authorization itself is exercised by its migration golden. */
import { isAbsolute } from 'node:path';
import * as authorization from '../../secret-protection/authorization';
import { createHostTrustGeneration } from '../../prepared-trust';
import {
  createSecretProtectionServices as compose,
  type SecretProtectionOptions,
} from '../../secret-protection';

const tokens = new Map<string, authorization.PreparedNativeArtifact>();
const bindings = new WeakMap<authorization.PreparedNativeArtifact, unknown>();
const paths = new WeakMap<authorization.PreparedNativeArtifact, string>();
const attempted = new WeakSet<authorization.PreparedNativeArtifact>();
const generation = createHostTrustGeneration('native-preparation');
const original = authorization.loadPreparedNativeArtifact;
jest
  .spyOn(authorization, 'loadPreparedNativeArtifact')
  .mockImplementation((capability) => {
    if (!generation.accepts(capability) || !paths.has(capability))
      return original(capability);
    if (attempted.has(capability)) return bindings.get(capability);
    attempted.add(capability);
    const module = { exports: {} };
    try {
      process.dlopen(module, paths.get(capability) ?? '');
      bindings.set(capability, module.exports);
      return module.exports;
    } catch {
      return undefined;
    }
  });
export function createSecretProtectionServices(
  options: SecretProtectionOptions,
): ReturnType<typeof compose> {
  const path = options.nativePath;
  let preparedNative = options.preparedNative;
  if (!preparedNative && path && isAbsolute(path)) {
    const key = `${options.os}:${path}`;
    preparedNative = options.os === 'win32' ? undefined : tokens.get(key);
    if (!preparedNative) {
      preparedNative = generation.issue();
      tokens.set(key, preparedNative);
      paths.set(preparedNative, path);
    }
  }
  return compose({ ...options, preparedNative });
}
