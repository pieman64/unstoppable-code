// The browser-safe capability-name normalizer is hoisted to protocol so web
// and desktop consumers share one implementation. Keep this re-export shim so
// existing desktop-shared imports continue to work unchanged.
export { normalizeCapabilityName } from '@canopy/protocol/capability-name';
