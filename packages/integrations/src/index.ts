/** Public surface of the integration framework. Pure re-export barrel (10_INTEGRATIONS.md §4.3). */

export * from './registry.ts';
export * from './errors.ts';
export * from './capabilities.ts';
export * from './manifest.ts';
export * from './license.ts';
export * from './contract.ts';
export * from './pinnedImages.ts';
export * from './safeDefaults.ts';
export * from './pipeline.ts';
export * from './apply.ts';
export * from './extract/confidence.ts';
export * from './extract/normalizers.ts';
export * from './extract/patterns.ts';
export * from './resolve/identity.ts';
export * from './resolve/merge.ts';
export * from './consent.ts';
export * from './declarativeParser.ts';
export * from './plugins.ts';
