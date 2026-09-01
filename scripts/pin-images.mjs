// Image digest pinning (10_INTEGRATIONS.md §6.2). Resolves every entry in
// packages/integrations/src/pinnedImages.ts against the registry's HTTP API — no Docker daemon, so
// this runs identically on a laptop, in CI and in a sandbox.
//
// Usage:
//   node scripts/pin-images.mjs            # rewrite the pins that drifted
//   node scripts/pin-images.mjs --check    # exit 1 if any pin drifted (weekly workflow)
//   node scripts/pin-images.mjs --resolve alpine:3.20   # print one digest, change nothing
//
// Never auto-merged: the weekly workflow opens a PR and a human approves (ADR-011).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { repoRoot } from './lib.mjs';

const PINS_FILE = path.join(repoRoot, 'packages/integrations/src/pinnedImages.ts');
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/** Docker Hub short names ("sherlock/sherlock", "alpine") live under the library/ or user path. */
function repository(image) {
  if (image.includes('.') || image.includes(':')) {
    throw new Error(`only Docker Hub images are supported here, got "${image}"`);
  }
  return image.includes('/') ? image : `library/${image}`;
}

async function resolveDigest(image, tag) {
  const repo = repository(image);
  const auth = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
  );
  if (!auth.ok) throw new Error(`token request failed (${auth.status})`);
  const { token } = await auth.json();
  const response = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${token}`, accept: ACCEPT },
  });
  if (!response.ok) throw new Error(`manifest request failed (${response.status})`);
  const digest = response.headers.get('docker-content-digest');
  if (digest === null || !DIGEST.test(digest)) {
    throw new Error(`registry returned no usable digest for ${image}:${tag}`);
  }
  return digest;
}

/** The pins file is generated, so a regex read keeps this script dependency-free. */
function readPins(source) {
  const pins = [];
  const entry =
    /image:\s*'([^']+)',\s*\n\s*tag:\s*'([^']+)',\s*\n\s*digest:\s*'([^']+)',\s*\n\s*resolvedAt:\s*'([^']+)'/g;
  for (const match of source.matchAll(entry)) {
    pins.push({ image: match[1], tag: match[2], digest: match[3], resolvedAt: match[4] });
  }
  return pins;
}

function replacePin(source, pin, digest, today) {
  const block = new RegExp(
    `(image: '${pin.image.replaceAll('/', '\\/')}',\\s*\\n\\s*tag: '${pin.tag}',\\s*\\n\\s*digest: ')[^']+(',\\s*\\n\\s*resolvedAt: ')[^']+`,
  );
  return source.replace(block, `$1${digest}$2${today}`);
}

async function main() {
  const args = process.argv.slice(2);
  const resolveIndex = args.indexOf('--resolve');
  if (resolveIndex !== -1) {
    const target = args[resolveIndex + 1] ?? '';
    const [image, tag = 'latest'] = target.split(':');
    console.log(await resolveDigest(image, tag));
    return;
  }

  const check = args.includes('--check');
  const source = readFileSync(PINS_FILE, 'utf8');
  const pins = readPins(source);
  if (pins.length === 0) throw new Error('no pins found — did pinnedImages.ts change shape?');

  const today = new Date().toISOString().slice(0, 10);
  let updated = source;
  const drifted = [];
  for (const pin of pins) {
    const digest = await resolveDigest(pin.image, pin.tag);
    const label = `${pin.image}:${pin.tag}`;
    if (digest === pin.digest) {
      console.log(`ok      ${label} ${digest}`);
      continue;
    }
    drifted.push(`${label}: pinned ${pin.digest} → published ${digest}`);
    updated = replacePin(updated, pin, digest, today);
    console.log(`drifted ${label} ${pin.digest} → ${digest}`);
  }

  if (drifted.length === 0) {
    console.log('pin-images: every pin matches the published tag');
    return;
  }
  if (check) {
    console.error(`\npin-images: ${drifted.length} pin(s) drifted\n  ${drifted.join('\n  ')}`);
    process.exit(1);
  }
  writeFileSync(PINS_FILE, updated);
  console.log(`pin-images: updated ${String(drifted.length)} pin(s) in ${PINS_FILE}`);
}

await main();
