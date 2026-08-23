/**
 * Image capability probing (13_SHERLOCK.md §3.6, generalised).
 *
 * A pinned image is a promise about a CLI, not proof of one: the digest can point at an older or
 * newer build whose flags differ. So before the first run per digest the runner asks the image what
 * it is (`--version`) and what it accepts (`--help`), and this module turns those two strings into
 * a verdict. Everything here is pure — the spawning lives in the runner's container executor — and
 * tool-agnostic: what counts as "required" comes from the manifest (R1).
 */

export interface ImageCapabilities {
  imageDigest: string;
  probedAt: string;
  /** The raw first non-empty line of `--version`, kept for provenance. */
  versionString: string | null;
  /** Parsed `x.y.z` if the version line contains one. */
  semver: string | null;
  /** Every `-f` / `--flag` token that starts a `--help` line. */
  flags: readonly string[];
}

export interface CapabilityProbeSpec {
  versionArgs: readonly string[];
  helpArgs: readonly string[];
  requiredFlags: readonly string[];
  minVersion?: string | undefined;
}

export interface CapabilityVerdict {
  ok: boolean;
  /** Flags the manifest requires that `--help` does not advertise. */
  missingFlags: readonly string[];
  /** Set when the image is older than the version the parser was verified against. */
  warning: string | null;
}

const SEMVER = /(\d+)\.(\d+)\.(\d+)/;
/** A help line describing options starts with indentation and a `-f` / `--flag` token. */
const HELP_LINE = /^\s+-{1,2}[\w-]/;
const FLAG_TOKEN = /-{1,2}[\w-]+/g;

function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/**
 * Collects the flags `--help` advertises. Only the option column is read — the two-space gap that
 * every argparse-style help uses before the description — so a flag merely *named* in prose is not
 * mistaken for a supported one.
 */
function helpFlags(help: string): readonly string[] {
  const found = new Set<string>();
  for (const line of help.split('\n')) {
    if (!HELP_LINE.test(line)) continue;
    const column = line.trim().split(/\s{2,}/)[0] ?? '';
    for (const token of column.match(FLAG_TOKEN) ?? []) found.add(token);
  }
  return [...found].sort();
}

export function parseImageCapabilities(input: {
  imageDigest: string;
  versionOutput: string;
  helpOutput: string;
  probedAt: string;
}): ImageCapabilities {
  const versionString = firstLine(input.versionOutput);
  const semver = versionString === null ? null : (SEMVER.exec(versionString)?.[0] ?? null);
  return {
    imageDigest: input.imageDigest,
    probedAt: input.probedAt,
    versionString,
    semver,
    flags: helpFlags(input.helpOutput),
  };
}

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * §3.6: a missing required flag is fatal (we never fall back to scraping human-readable stdout),
 * an unparseable version is not — the parsers here are shape-driven, so an unknown version only
 * earns a warning that makes a future shape change diagnosable.
 */
export function checkCapabilities(
  caps: ImageCapabilities,
  spec: CapabilityProbeSpec,
): CapabilityVerdict {
  const missingFlags = spec.requiredFlags.filter((flag) => !caps.flags.includes(flag));
  const older =
    spec.minVersion !== undefined &&
    caps.semver !== null &&
    compareSemver(caps.semver, spec.minVersion) < 0;
  return {
    ok: missingFlags.length === 0,
    missingFlags,
    warning: older
      ? `This image (${caps.semver ?? '?'}) predates the version Raven was verified against (v${spec.minVersion ?? '?'}). Results may parse differently.`
      : null,
  };
}
