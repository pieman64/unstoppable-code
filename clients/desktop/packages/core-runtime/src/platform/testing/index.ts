export {
  createFakeSecretProtection,
  KEY_SLOT_MAX_BYTES,
  KEY_SLOT_NAME_PATTERN,
  type FakeKeySlotContents,
  type FakeSecretProtection,
  type FakeSecretProtectionFault,
  type FakeSecretProtectionOptions,
} from './fake-secret-protection';
export {
  runSecretProtectionConformance,
  SecretProtectionConformanceFailure,
  type MakeSecretProtectionSubject,
  type SecretProtectionConformanceSubject,
  type SecretProtectionConformanceTestApi,
} from './secret-protection-conformance';
export {
  createFakePlatformPowerServices,
  type FakePlatformPowerServices,
  type FakePowerAssertion,
  type FakePowerOutcome,
} from './fake-power';
