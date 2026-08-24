/**
 * Typed mirror of `src/tokens/*.css`. Values here MUST equal the CSS values —
 * `test/contrast.test.ts` and the Tailwind generator both read this file, and the
 * generator is the only thing allowed to duplicate a token (into
 * `tailwind/preset.generated.js`).
 *
 * This file is kept plain (no imports, no enums, no decorators) so that
 * `node --experimental-strip-types` can load it directly from a build script.
 */

export const tokens = {
  color: {
    neutral: {
      '000': '#08090b',
      '050': '#0b0d10',
      '100': '#101216',
      '150': '#15181d',
      '200': '#1b1f25',
      '300': '#242931',
      '400': '#2f353f',
      '500': '#3d444f',
      '600': '#5a626f',
      '700': '#7c8593',
      '800': '#a2aab6',
      '900': '#c7cdd6',
      '950': '#e6e9ee',
      '1000': '#f7f8fa',
    },
    accent: {
      '200': '#cfe7fb',
      '300': '#8fcbf5',
      '400': '#4faee9',
      '500': '#2f95d6',
      '600': '#2176ae',
      '700': '#1a5a85',
      '800': '#143f5c',
      '900': '#102e42',
    },
    info: { '400': '#6ea8d8' },
    success: { '400': '#5fa97f' },
    warn: { '400': '#c8a24a' },
    danger: { '300': '#e08a80', '400': '#d4756b' },
    entity: {
      url: '#7fa6d9',
      page: '#6fb0a6',
      image: '#b79adb',
      file: '#8fa8c4',
      note: '#c9b27a',
      text: '#a5b8d0',
      person: '#dfa07a',
      identity: '#d98ba8',
      repo: '#7fb985',
      toolrun: '#a8aeb8',
      group: '#9bb0c9',
    },
  },
  space: {
    '0': '0px',
    '1': '2px',
    '2': '4px',
    '3': '8px',
    '4': '12px',
    '5': '16px',
    '6': '20px',
    '7': '24px',
    '8': '32px',
    '9': '40px',
    '10': '56px',
  },
  size: { xs: '22px', sm: '26px', md: '32px', lg: '38px', xl: '44px' },
  icon: { '1': '16px', '2': '20px', '3': '24px' },
  radius: {
    '0': '0px',
    '1': '3px',
    '2': '5px',
    '3': '8px',
    '4': '12px',
    '5': '16px',
    full: '999px',
  },
  border: { hairline: '1px', thick: '1.5px', heavy: '2px' },
  font: {
    display:
      "'Manrope Variable', 'Manrope', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    sans: "'Inter Tight Variable', 'InterVariable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "'JetBrains Mono Variable', 'JetBrainsMonoVariable', 'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace",
  },
  weight: { regular: '400', medium: '500', semibold: '600', bold: '680' },
  shadow: {
    '0': 'none',
    '1': '0 1px 2px rgb(0 0 0 / 0.28)',
    '2': '0 2px 6px rgb(0 0 0 / 0.32), 0 1px 1px rgb(0 0 0 / 0.24)',
    '3': '0 8px 20px -6px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 / 0.3)',
    '4': '0 20px 44px -12px rgb(0 0 0 / 0.6), 0 4px 12px rgb(0 0 0 / 0.36)',
  },
  dur: { '1': '75ms', '2': '120ms', '3': '180ms', '4': '240ms', '5': '320ms' },
  ease: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    in: 'cubic-bezier(0.7, 0, 0.84, 0)',
    inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
    linear: 'linear',
  },
  z: {
    canvas: '0',
    'canvas-overlay': '10',
    panel: '100',
    sticky: '200',
    dropdown: '300',
    dialog: '400',
    toast: '500',
    tooltip: '600',
    devtools: '900',
  },
} as const;

/**
 * Tier-2 semantic roles, expressed as the primitive they bind to (dark theme).
 * Mirrors the `:root, [data-theme='dark']` block of `color.css`. Only the roles that
 * resolve to a flat primitive colour are listed — mixes stay in CSS, where they belong.
 */
export const semanticDark = {
  'surface-0': 'color.neutral.000',
  'surface-1': 'color.neutral.100',
  'surface-2': 'color.neutral.150',
  'surface-3': 'color.neutral.200',
  'surface-4': 'color.neutral.300',
  'surface-inset': 'color.neutral.050',
  'fg-primary': 'color.neutral.950',
  'fg-secondary': 'color.neutral.800',
  'fg-muted': 'color.neutral.700',
  'fg-disabled': 'color.neutral.600',
  'fg-inverse': 'color.neutral.000',
  'fg-accent': 'color.accent.300',
  'fg-on-accent': 'color.neutral.1000',
  'border-accent': 'color.accent.500',
  'border-focus': 'color.accent.400',
  'border-danger': 'color.danger.400',
  'accent-solid': 'color.accent.600',
  'accent-solid-active': 'color.accent.700',
  'status-info-fg': 'color.info.400',
  'status-success-fg': 'color.success.400',
  'status-warn-fg': 'color.warn.400',
  'status-danger-fg': 'color.danger.300',
} as const;

export type EntityKind = keyof typeof tokens.color.entity;
export type SemanticRole = keyof typeof semanticDark;

/** `color.neutral.100` → `--nx-neutral-100`, `space.4` → `--nx-space-4`. */
const CSS_PREFIX: Record<string, string> = {
  color: '--nx',
  space: '--nx-space',
  size: '--nx-size',
  icon: '--nx-icon',
  radius: '--nx-radius',
  border: '--nx-border',
  font: '--nx-font',
  weight: '--nx-weight',
  shadow: '--nx-shadow',
  dur: '--nx-dur',
  ease: '--nx-ease',
  z: '--nx-z',
};

function flatten(): Record<string, { name: string; value: string }> {
  const out: Record<string, { name: string; value: string }> = {};
  for (const [group, entries] of Object.entries(tokens)) {
    const prefix = CSS_PREFIX[group];
    if (prefix === undefined) continue;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === 'string') {
        out[`${group}.${key}`] = { name: `${prefix}-${key}`, value };
        continue;
      }
      // color has one nesting level more: color.<family>.<step>
      for (const [step, hex] of Object.entries(value as Record<string, string>)) {
        out[`${group}.${key}.${step}`] = {
          name: key === 'entity' ? `${prefix}-entity-${step}` : `${prefix}-${key}-${step}`,
          value: hex,
        };
      }
    }
  }
  return out;
}

/** Every token, keyed by dotted path. Built once; the generator and tests read it. */
export const flatTokens = flatten();

/** `cssVar('color.accent.600')` → `'var(--nx-accent-600)'`. Throws on an unknown path. */
export function cssVar(path: string): string {
  const token = flatTokens[path];
  if (!token) throw new Error(`Unknown design token: ${path}`);
  return `var(${token.name})`;
}

/** Raw value behind a token path, e.g. `'#4a66a8'`. */
export function tokenValue(path: string): string {
  const token = flatTokens[path];
  if (!token) throw new Error(`Unknown design token: ${path}`);
  return token.value;
}
