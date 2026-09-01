/**
 * Container images pinned by digest (10_INTEGRATIONS.md §6.2). Generated and verified by
 * `scripts/pin-images.mjs`, which resolves each `image:tag` through the registry HTTP API — no
 * Docker daemon anywhere, so any machine and CI can both refresh and check these.
 *
 * A plain object literal on purpose: this module is imported by browser-safe manifest code (N2),
 * so it must never read the filesystem. An env override still wins at runtime, letting a
 * deployment pin its own build without editing the repo.
 */

export interface PinnedImage {
  readonly image: string;
  readonly tag: string;
  readonly digest: string;
  /** When the digest was last resolved from the registry (UTC date). */
  readonly resolvedAt: string;
}

export const PINNED_IMAGES: readonly PinnedImage[] = [
  {
    image: 'sherlock/sherlock',
    tag: 'latest',
    digest: 'sha256:9d6602b98179fb15ceab88433626fb0ae603ae9880e13cab886970317fe1475f',
    resolvedAt: '2026-09-01',
  },
];

const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** The pinned digest for an image, or undefined when it is not pinned (never a floating tag). */
export function pinnedDigest(image: string): string | undefined {
  const entry = PINNED_IMAGES.find((pin) => pin.image === image);
  return entry !== undefined && DIGEST.test(entry.digest) ? entry.digest : undefined;
}
