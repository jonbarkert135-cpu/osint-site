# Raven — 04 DESIGN SYSTEM

## Dark Premium Intelligence Interface

**Scope**
This document defines the complete visual and interaction-surface language of Raven: token
architecture, color, elevation, typography, space, motion, every UI component with every state,
and the canvas-specific visual language. It is the normative source for `packages/ui` and is the
reference for quality-gate check 3 in `00_MASTER.md` §8 ("Visual"). It does not define layout of
screens (see `03_UX.md`) or rendering algorithms (see `05_CANVAS_ENGINE.md`).
Everything here is implementable without further design input: no value is left to taste.

---

## 1. Design philosophy

Raven looks like professional instrumentation, not like a consumer app and not like a "cyber"
dashboard. The reference feeling is a high-end audio console or a Bloomberg-class terminal
redesigned in 2026: dark, dense, quiet, with light used as information rather than decoration.
`00_MASTER.md` §3.5 states the product principle ("Calm interface. Dark, quiet, high-contrast
where it matters; no neon, no glow, no noise."). The six principles below operationalize it.

### P1 — Luminance is the primary structural tool

Depth, grouping and hierarchy come from small, exact steps in background luminance plus 1px
hairline borders. Shadows are a secondary cue used only for true overlays.

- **Do:** raise a panel from `--surface-1` to `--surface-2` (ΔL\* ≈ 2.6) and add
  `1px solid var(--border-subtle)`.
- **Don't:** separate two adjacent panels with `box-shadow: 0 8px 24px rgba(0,0,0,.6)`; large
  shadows on dark surfaces read as smudge, not depth.

### P2 — Color carries meaning, never mood

There is exactly one accent family. Every other saturated color is semantic (status) or taxonomic
(entity type). If a color cannot be explained in one sentence ("this is the danger color", "this is
the identity entity color"), it does not exist.

- **Do:** paint a "Run failed" pill with `--status-danger-fg` on `--status-danger-bg`.
- **Don't:** tint a settings header violet because it looks nice.

### P3 — Density is a feature, calm is the constraint

Analysts keep 40+ rows, 12 panels and 5,000 nodes on screen. We use compact metrics (32px default
control height, 4px base grid) but never compact contrast: text is ≥ 4.5:1 and touch/keyboard
targets stay ≥ 28px in the vertical rhythm with 8px hit-slop.

- **Do:** 28px table rows with 12px horizontal padding and `--text-body-sm`.
- **Don't:** shrink to 20px rows by dropping font size to 11px and gray text to `--fg-muted`.

### P4 — Motion explains causality, nothing else

Animation exists to show where something came from and where it went. Nothing loops, nothing
pulses, nothing draws attention to itself.

- **Do:** slide a drawer 240ms with `--ease-out-quint` from the edge it is anchored to.
- **Don't:** fade-and-scale every list item on mount, or pulse a "live" dot forever.

### P5 — Every state is designed, including the ugly ones

Empty, loading, partial, stale, offline, error, permission-denied, undo-available. A component
without these states is unfinished and fails the quality gate.

- **Do:** ship `<NodeInspector>` with `empty | loading | ready | stale | error` variants and a
  visual snapshot for each.
- **Don't:** render `null` while loading and let layout jump when data lands.

### P6 — The chrome must never outshine the data

The canvas is the subject. UI chrome sits within a narrow luminance band (`--surface-0` …
`--surface-3`) so that node cards, thumbnails and user images are the brightest things on screen.

- **Do:** keep toolbars at `--surface-2` with `--fg-secondary` icons; let a node's favicon be the
  only saturated pixel in that region.
- **Don't:** give the toolbar an accent-tinted gradient background.

### P7 — One brand material, applied to the chrome only

The chrome (topbar, rail, inspector, statusbar, board toolbar) is a single translucent material:
`--glass-bg` / `--glass-bg-strong` tint + `blur(var(--glass-blur))` + a 1px hairline highlight.
It stays neutral in hue — the accent appears in the chrome only in the brand mark, the wordmark
gradient and the one primary button per region — so P6 still holds: the canvas is the brightest
thing on screen.

Brand tokens (Tier 2, `--brand-gradient`, `--brand-text-gradient`, `--glass-*`, `--glow-accent`,
`--ambient-glow`) exist so no component hand-writes a gradient.

**Brand assets.** The raven mark ships as transparent PNGs in `apps/web/public/brand/`
(`favicon-32`, `raven-mark-{64,180,192,512}`) and is used for the favicon, the apple-touch icon,
the topbar lockup and the README header. The mark is always decorative (`alt=""`): the board
title remains the only heading in the chrome.

---

## 2. Token architecture

### 2.1 Three tiers

```text
Tier 1  PRIMITIVE   raw values, theme-independent      --nx-neutral-600, --nx-accent-500, --nx-space-4
Tier 2  SEMANTIC    role in the interface, theme-bound  --surface-2, --fg-primary, --border-strong
Tier 3  COMPONENT   per-component contract              --btn-primary-bg-hover, --tree-item-indent
```

Rules, enforced by an ESLint rule `@nexus/tokens-only` (`packages/config/eslint/tokens-only.ts`):

1. **Components may only read Tier 3 and Tier 2.** Reading a Tier 1 primitive inside
   `packages/ui/src/components/**` or `apps/web/**` is an error.
2. **Tier 3 tokens may only be defined in terms of Tier 2.** A component token that references a
   primitive is an error (it would break theming).
3. **Tier 2 tokens may only be defined in terms of Tier 1** plus `color-mix()`.
4. **No literal color, length, radius, shadow or duration in component code.** The lint rule
   matches `/#[0-9a-f]{3,8}\b|rgba?\(|\b\d+px\b|\b\d+ms\b/` in `style`/`className` string literals,
   with an allowlist for `0`, `1px` inside token files, and `100%`.

### 2.2 Naming convention

```text
--nx-<category>-<scale>            primitive   --nx-neutral-300, --nx-accent-500, --nx-radius-2
--<role>[-<variant>][-<state>]     semantic    --fg-primary, --surface-2, --border-focus
--<component>-<part>-<prop>[-<state>]  component  --btn-primary-bg-hover, --input-border-error
```

- Categories (Tier 1): `neutral`, `accent`, `info`, `success`, `warn`, `danger`, `entity`,
  `space`, `radius`, `size`, `font`, `weight`, `leading`, `tracking`, `dur`, `ease`, `shadow`,
  `blur`, `z`.
- Roles (Tier 2): `surface-{0..4}`, `fg-{primary,secondary,muted,disabled,inverse,accent,on-accent}`,
  `border-{subtle,default,strong,focus,accent,danger}`, `status-{info,success,warn,danger}-{fg,bg,border}`,
  `entity-{type}-{fg,bg,border}`, `overlay-{scrim,backdrop}`, `selection-{ring,fill}`.
- States are always suffixes and always from this closed set:
  `hover | active | focus | selected | disabled | loading | error | success`.
- No abbreviations except `fg`, `bg`, `dur`, `nx`. `--btn-bg-hvr` is invalid.

### 2.3 Theming strategy (Light theme without touching components)

Tier 1 is theme-independent and lives in `primitives.css`. Tier 2 is defined twice: once under
`:root, [data-theme="dark"]` in `semantic.dark.css`, once under `[data-theme="light"]` in
`semantic.light.css`. Tier 3 (`components.css`) is written **only** against Tier 2 and therefore
loaded once for both themes. Adding Light later is: author `semantic.light.css` (one file, ~120
declarations), add `light` to the `Theme` union in `tokens.ts`, done — zero component diffs.

Theme is applied by `data-theme` on `<html>`, resolved at boot before first paint by an inline
script (`apps/web/index.html`) reading `localStorage.nx-theme` (`'dark' | 'light' | 'system'`) to
avoid a flash. `color-scheme` is set alongside so native scrollbars and form controls follow.
Dark is the default and the only theme shipped in P1; light lands in P16 and its only acceptance
criterion is "no file under `src/components/**` changed".

Canvas rendering does **not** read CSS variables per frame. `packages/canvas-engine` receives a
resolved `CanvasPalette` object (plain numbers/strings) built once per theme change by
`packages/ui/src/tokens/canvasPalette.ts` using `getComputedStyle(document.documentElement)`;
see `05_CANVAS_ENGINE.md` §7 for how it is invalidated.

### 2.4 Tailwind bridge

`packages/config/tailwind/preset.ts` is **generated** from `tokens.ts` by
`pnpm --filter @nexus/ui gen:tailwind` (script `packages/ui/scripts/gen-tailwind.ts`). The
generator emits only `var(--…)` references, never literal values, so Tailwind classes and raw CSS
always agree. Generated file is committed and CI fails if regeneration produces a diff.

---

## 3. Token files (actual content)

Directory: `packages/ui/tokens/`.

```text
packages/ui/tokens/
├─ primitives.css        Tier 1
├─ semantic.dark.css     Tier 2 (dark)
├─ semantic.light.css    Tier 2 (light, added in P16 — file exists with the dark values inverted)
├─ components.css        Tier 3
├─ index.css             @import order: primitives → semantic.dark → semantic.light → components
└─ tokens.ts             typed TS export + CanvasPalette builder
```

### 3.1 `packages/ui/tokens/primitives.css`

```css
/* Tier 1 — primitives. Theme-independent. Never referenced from components. */
:root {
  /* ── Neutral ramp (14 stops, dark-tuned; see §4.1) ───────────────────────── */
  --nx-neutral-000: oklch(13.9% 0.005 262.8); /* #08090B */
  --nx-neutral-050: oklch(15.8% 0.007 258.4); /* #0B0D10 */
  --nx-neutral-100: oklch(18.2% 0.009 264.3); /* #101216 */
  --nx-neutral-150: oklch(20.8% 0.011 260.7); /* #15181D */
  --nx-neutral-200: oklch(23.8% 0.013 258.4); /* #1B1F25 */
  --nx-neutral-300: oklch(27.9% 0.016 259.8); /* #242931 */
  --nx-neutral-400: oklch(32.7% 0.02 260.6); /* #2F353F */
  --nx-neutral-500: oklch(38.5% 0.021 259.4); /* #3D444F */
  --nx-neutral-600: oklch(49.4% 0.023 260.1); /* #5A626F */
  --nx-neutral-700: oklch(61.4% 0.024 259.2); /* #7C8593 */
  --nx-neutral-800: oklch(73.5% 0.02 258.4); /* #A2AAB6 */
  --nx-neutral-900: oklch(84.6% 0.014 258.3); /* #C7CDD6 */
  --nx-neutral-950: oklch(93.3% 0.007 260.7); /* #E6E9EE */
  --nx-neutral-1000: oklch(97.9% 0.003 264.5); /* #F7F8FA */

  /* ── Accent: "Raven Azure", single family, sampled from the raven mark ────── */
  --nx-accent-200: #cfe7fb;
  --nx-accent-300: #8fcbf5; /* fg-accent — AA (≥ 8:1) on S0…S4 */
  --nx-accent-400: #4faee9; /* border-focus — ≥ 3:1 non-text on every surface */
  --nx-accent-500: #2f95d6;
  --nx-accent-600: #2176ae; /* accent-solid — white text on it is AA (4.6:1) */
  --nx-accent-700: #1a5a85;
  --nx-accent-800: #143f5c;
  --nx-accent-900: #102e42;

  /* ── Semantic hues ───────────────────────────────────────────────────────── */
  --nx-info-400: oklch(71% 0.093 244.6); /* #6EA8D8 */
  --nx-info-900: oklch(25.5% 0.038 244.6);
  --nx-success-400: oklch(67.5% 0.098 157.5); /* #5FA97F */
  --nx-success-900: oklch(24.5% 0.04 157.5);
  --nx-warn-400: oklch(73% 0.115 85.8); /* #C8A24A */
  --nx-warn-900: oklch(26% 0.045 85.8);
  --nx-danger-400: oklch(66.6% 0.121 27.1); /* #D4756B */
  --nx-danger-300: oklch(72.1% 0.107 27.2); /* #E08A80 */
  --nx-danger-900: oklch(25.5% 0.05 27.1);

  /* ── Entity taxonomy (10 node types, equal L*, see §4.4) ─────────────────── */
  --nx-entity-url: oklch(71.6% 0.086 255.4); /* #7FA6D9 */
  --nx-entity-page: oklch(71.1% 0.068 183.6); /* #6FB0A6 */
  --nx-entity-image: oklch(73.5% 0.097 304.5); /* #B79ADB */
  --nx-entity-file: oklch(72.2% 0.05 251.4); /* #8FA8C4 */
  --nx-entity-note: oklch(77% 0.078 88.1); /* #C9B27A */
  --nx-entity-person: oklch(75.7% 0.091 52); /* #DFA07A */
  --nx-entity-identity: oklch(72.5% 0.101 356); /* #D98BA8 */
  --nx-entity-repo: oklch(73.2% 0.096 147.1); /* #7FB985 */
  --nx-entity-toolrun: oklch(74.9% 0.016 260.7); /* #A8AEB8 */
  --nx-entity-group: oklch(74.9% 0.043 252.9); /* #9BB0C9 */

  /* ── Space (4px base, 10 steps) ──────────────────────────────────────────── */
  --nx-space-0: 0px;
  --nx-space-1: 2px;
  --nx-space-2: 4px;
  --nx-space-3: 8px;
  --nx-space-4: 12px;
  --nx-space-5: 16px;
  --nx-space-6: 20px;
  --nx-space-7: 24px;
  --nx-space-8: 32px;
  --nx-space-9: 40px;
  --nx-space-10: 56px;

  /* ── Radius ──────────────────────────────────────────────────────────────── */
  --nx-radius-0: 0px;
  --nx-radius-1: 3px;
  --nx-radius-2: 5px;
  --nx-radius-3: 8px;
  --nx-radius-4: 12px;
  --nx-radius-5: 16px;
  --nx-radius-full: 999px;

  /* ── Border widths ───────────────────────────────────────────────────────── */
  --nx-border-hairline: 1px;
  --nx-border-thick: 1.5px;
  --nx-border-heavy: 2px;

  /* ── Sizes (control heights, icon grid) ──────────────────────────────────── */
  --nx-size-xs: 22px;
  --nx-size-sm: 26px;
  --nx-size-md: 32px;
  --nx-size-lg: 38px;
  --nx-size-xl: 44px;
  --nx-icon-1: 16px;
  --nx-icon-2: 20px;
  --nx-icon-3: 24px;

  /* ── Typography ──────────────────────────────────────────────────────────── */
  --nx-font-display: 'Manrope Variable', 'Manrope', ui-sans-serif, system-ui, -apple-system,
    'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --nx-font-sans: 'Inter Tight Variable', 'InterVariable', 'Inter', ui-sans-serif, system-ui,
    -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --nx-font-mono: 'JetBrains Mono Variable', 'JetBrainsMonoVariable', 'JetBrains Mono',
    ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace;
  --nx-weight-regular: 400;
  --nx-weight-medium: 500;
  --nx-weight-semibold: 600;
  --nx-weight-bold: 680;

  /* ── Motion ──────────────────────────────────────────────────────────────── */
  --nx-dur-1: 75ms;
  --nx-dur-2: 120ms;
  --nx-dur-3: 180ms;
  --nx-dur-4: 240ms;
  --nx-dur-5: 320ms;
  --nx-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --nx-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --nx-ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --nx-ease-inout: cubic-bezier(0.65, 0, 0.35, 1);
  --nx-ease-linear: linear;

  /* ── Shadows (dark-tuned: tight, low alpha, plus a hairline top highlight) ─ */
  --nx-shadow-0: none;
  --nx-shadow-1: 0 1px 2px rgb(0 0 0 / 0.28);
  --nx-shadow-2: 0 2px 6px rgb(0 0 0 / 0.32), 0 1px 1px rgb(0 0 0 / 0.24);
  --nx-shadow-3: 0 8px 20px -6px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 / 0.3);
  --nx-shadow-4: 0 20px 44px -12px rgb(0 0 0 / 0.6), 0 4px 12px rgb(0 0 0 / 0.36);

  /* ── Z-index ─────────────────────────────────────────────────────────────── */
  --nx-z-canvas: 0;
  --nx-z-canvas-overlay: 10;
  --nx-z-panel: 100;
  --nx-z-sticky: 200;
  --nx-z-dropdown: 300;
  --nx-z-dialog: 400;
  --nx-z-toast: 500;
  --nx-z-tooltip: 600;
  --nx-z-devtools: 900;
}
```

Colors are authored in OKLCH. The hex in the comment is the sRGB fallback and is also emitted by
the build (`packages/ui/scripts/gen-fallbacks.ts`) as a `@supports not (color: oklch(0 0 0))`
block appended to `primitives.css`. Every browser in our support matrix (`19_DEPLOYMENT.md` §2)
supports OKLCH; the fallback exists only for embedded webviews.

### 3.2 `packages/ui/tokens/semantic.dark.css`

```css
/* Tier 2 — semantic. Components read these. */
:root,
[data-theme='dark'] {
  color-scheme: dark;

  /* Surfaces — see §5 */
  --surface-0: var(--nx-neutral-000); /* app backdrop, canvas void            */
  --surface-1: var(--nx-neutral-100); /* primary panels, canvas node cards    */
  --surface-2: var(--nx-neutral-150); /* toolbars, headers, raised rows       */
  --surface-3: var(--nx-neutral-200); /* popovers, menus, dialogs             */
  --surface-4: var(--nx-neutral-300); /* dragged/floating, tooltips           */
  --surface-inset: var(--nx-neutral-050); /* inputs, code blocks, wells        */
  --surface-hover: color-mix(in oklab, var(--nx-neutral-1000) 4%, transparent);
  --surface-active: color-mix(in oklab, var(--nx-neutral-1000) 7%, transparent);
  --surface-selected: color-mix(in oklab, var(--nx-accent-400) 14%, transparent);

  /* Foreground */
  --fg-primary: var(--nx-neutral-950);
  --fg-secondary: var(--nx-neutral-800);
  --fg-muted: var(--nx-neutral-700);
  --fg-disabled: var(--nx-neutral-600);
  --fg-inverse: var(--nx-neutral-000);
  --fg-accent: var(--nx-accent-300);
  --fg-on-accent: var(--nx-neutral-1000);

  /* Borders */
  --border-subtle: color-mix(in oklab, var(--nx-neutral-1000) 8%, transparent);
  --border-default: color-mix(in oklab, var(--nx-neutral-1000) 13%, transparent);
  --border-strong: color-mix(in oklab, var(--nx-neutral-1000) 22%, transparent);
  --border-accent: var(--nx-accent-500);
  --border-focus: var(--nx-accent-400);
  --border-danger: var(--nx-danger-400);

  /* Accent surfaces */
  --accent-solid: var(--nx-accent-600);
  --accent-solid-hover: var(--nx-accent-500);
  --accent-solid-active: var(--nx-accent-700);
  --accent-soft: color-mix(in oklab, var(--nx-accent-400) 16%, transparent);
  --accent-soft-hover: color-mix(in oklab, var(--nx-accent-400) 24%, transparent);

  /* Status */
  --status-info-fg: var(--nx-info-400);
  --status-info-bg: color-mix(in oklab, var(--nx-info-400) 14%, transparent);
  --status-info-border: color-mix(in oklab, var(--nx-info-400) 34%, transparent);
  --status-success-fg: var(--nx-success-400);
  --status-success-bg: color-mix(in oklab, var(--nx-success-400) 14%, transparent);
  --status-success-border: color-mix(in oklab, var(--nx-success-400) 34%, transparent);
  --status-warn-fg: var(--nx-warn-400);
  --status-warn-bg: color-mix(in oklab, var(--nx-warn-400) 14%, transparent);
  --status-warn-border: color-mix(in oklab, var(--nx-warn-400) 34%, transparent);
  --status-danger-fg: var(--nx-danger-300);
  --status-danger-bg: color-mix(in oklab, var(--nx-danger-400) 14%, transparent);
  --status-danger-border: color-mix(in oklab, var(--nx-danger-400) 36%, transparent);

  /* Entity roles (repeat for the 10 types; url shown, rest identical in shape) */
  --entity-url-fg: var(--nx-entity-url);
  --entity-url-bg: color-mix(in oklab, var(--nx-entity-url) 10%, transparent);
  --entity-url-border: color-mix(in oklab, var(--nx-entity-url) 32%, transparent);
  /* … page, image, file, note, person, identity, repo, toolrun, group … */

  /* Overlays, selection, canvas */
  --overlay-scrim: rgb(0 0 0 / 0.56);
  --overlay-backdrop-blur: 6px;
  --selection-ring: var(--nx-accent-400);
  --selection-fill: color-mix(in oklab, var(--nx-accent-400) 12%, transparent);
  --canvas-void: var(--nx-neutral-000);
  --canvas-grid-dot: color-mix(in oklab, var(--nx-neutral-1000) 6%, transparent);
  --canvas-grid-line: color-mix(in oklab, var(--nx-neutral-1000) 4%, transparent);
  --canvas-edge: var(--nx-neutral-600);
  --canvas-edge-strong: var(--nx-neutral-700);
  --canvas-guide: var(--nx-accent-300);
  --canvas-marquee-fill: color-mix(in oklab, var(--nx-accent-400) 10%, transparent);

  /* Focus ring composition (used verbatim by every focusable component) */
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;
  --focus-ring-color: var(--border-focus);
  --focus-ring-shadow: 0 0 0 var(--focus-ring-offset) var(--surface-0),
    0 0 0 calc(var(--focus-ring-offset) + var(--focus-ring-width)) var(--focus-ring-color);
}
```

### 3.3 `packages/ui/tokens/semantic.light.css` (shipped in P16)

Same 120 declarations, different bindings. The contract that makes it work without component
changes: **role names and their meaning are identical; only values differ.** Excerpt:

```css
[data-theme='light'] {
  color-scheme: light;
  --surface-0: var(--nx-neutral-1000);
  --surface-1: #ffffff;
  --surface-2: var(--nx-neutral-950);
  --surface-3: #ffffff;
  --surface-4: #ffffff;
  --surface-inset: var(--nx-neutral-950);
  --fg-primary: var(--nx-neutral-050);
  --fg-secondary: var(--nx-neutral-400);
  --fg-muted: var(--nx-neutral-500);
  --border-subtle: color-mix(in oklab, var(--nx-neutral-000) 10%, transparent);
  --border-default: color-mix(in oklab, var(--nx-neutral-000) 16%, transparent);
  --fg-accent: var(--nx-accent-700);
  --accent-solid: var(--nx-accent-600);
  --overlay-scrim: rgb(16 18 22 / 0.32);
  /* shadows get higher alpha in light mode: elevation there is shadow-driven */
  --nx-shadow-2: 0 2px 6px rgb(16 18 22 / 0.1), 0 1px 1px rgb(16 18 22 / 0.06);
}
```

Note the inversion of principle P1: in light mode elevation is shadow-driven, which is why
elevation must never be hardcoded per-component and always comes from `--elevation-*` recipes
(§5.2).

### 3.4 `packages/ui/tokens/components.css` (excerpt — full file ~380 declarations)

```css
/* Tier 3 — component tokens. Defined ONLY in terms of Tier 2. Loaded once for all themes. */
:root {
  /* Button */
  --btn-height-sm: var(--nx-size-sm);
  --btn-height-md: var(--nx-size-md);
  --btn-height-lg: var(--nx-size-lg);
  --btn-padding-x: var(--nx-space-4);
  --btn-gap: var(--nx-space-3);
  --btn-radius: var(--nx-radius-2);
  --btn-font-size: 13px;
  --btn-font-weight: var(--nx-weight-medium);

  --btn-primary-bg: var(--accent-solid);
  --btn-primary-bg-hover: var(--accent-solid-hover);
  --btn-primary-bg-active: var(--accent-solid-active);
  --btn-primary-fg: var(--fg-on-accent);
  --btn-primary-border: color-mix(in oklab, var(--nx-neutral-1000) 12%, transparent);

  --btn-secondary-bg: var(--surface-2);
  --btn-secondary-bg-hover: var(--surface-3);
  --btn-secondary-bg-active: var(--surface-4);
  --btn-secondary-fg: var(--fg-primary);
  --btn-secondary-border: var(--border-default);

  --btn-ghost-bg: transparent;
  --btn-ghost-bg-hover: var(--surface-hover);
  --btn-ghost-bg-active: var(--surface-active);
  --btn-ghost-fg: var(--fg-secondary);

  --btn-danger-bg: color-mix(in oklab, var(--nx-danger-400) 82%, black);
  --btn-danger-bg-hover: var(--nx-danger-400);
  --btn-danger-fg: var(--nx-neutral-1000);

  --btn-disabled-bg: var(--surface-2);
  --btn-disabled-fg: var(--fg-disabled);

  /* Input family */
  --input-height: var(--nx-size-md);
  --input-bg: var(--surface-inset);
  --input-bg-hover: color-mix(in oklab, var(--surface-inset) 92%, var(--nx-neutral-1000));
  --input-bg-disabled: var(--surface-1);
  --input-border: var(--border-default);
  --input-border-hover: var(--border-strong);
  --input-border-focus: var(--border-focus);
  --input-border-error: var(--border-danger);
  --input-fg: var(--fg-primary);
  --input-placeholder: var(--fg-muted);
  --input-radius: var(--nx-radius-2);
  --input-padding-x: var(--nx-space-4);

  /* Surfaces of floating layers */
  --menu-bg: var(--surface-3);
  --menu-border: var(--border-default);
  --menu-radius: var(--nx-radius-3);
  --menu-shadow: var(--nx-shadow-3);
  --menu-item-height: 28px;
  --menu-item-bg-hover: var(--surface-hover);
  --menu-item-fg: var(--fg-primary);

  --tooltip-bg: var(--surface-4);
  --tooltip-fg: var(--fg-primary);
  --tooltip-radius: var(--nx-radius-2);
  --tooltip-shadow: var(--nx-shadow-2);

  /* Canvas node card */
  --node-bg: var(--surface-1);
  --node-bg-hover: var(--surface-2);
  --node-border: var(--border-default);
  --node-border-hover: var(--border-strong);
  --node-radius: var(--nx-radius-3);
  --node-shadow: var(--nx-shadow-1);
  --node-shadow-drag: var(--nx-shadow-4);
  --node-width-default: 240px;
  --node-header-height: 26px;
  --node-accent-bar-width: 3px;

  /* Table */
  --table-row-height: 28px;
  --table-row-height-comfortable: 36px;
  --table-header-bg: var(--surface-2);
  --table-border: var(--border-subtle);
  --table-row-bg-hover: var(--surface-hover);
  --table-row-bg-selected: var(--surface-selected);

  /* Scrollbar */
  --scrollbar-size: 10px;
  --scrollbar-thumb: color-mix(in oklab, var(--nx-neutral-1000) 14%, transparent);
  --scrollbar-thumb-hover: color-mix(in oklab, var(--nx-neutral-1000) 24%, transparent);
  --scrollbar-track: transparent;
}
```

### 3.5 `packages/ui/tokens/tokens.ts` (typed export)

```ts
// packages/ui/tokens/tokens.ts
export type Theme = 'dark' | 'light';

/** Tier-1 primitive scales, as literal maps. Used by the Tailwind generator,
 *  the docs site and the canvas palette builder. Never imported by components. */
export const primitives = {
  neutral: {
    '000': '#08090B',
    '050': '#0B0D10',
    '100': '#101216',
    '150': '#15181D',
    '200': '#1B1F25',
    '300': '#242931',
    '400': '#2F353F',
    '500': '#3D444F',
    '600': '#5A626F',
    '700': '#7C8593',
    '800': '#A2AAB6',
    '900': '#C7CDD6',
    '950': '#E6E9EE',
    '1000': '#F7F8FA',
  },
  accent: {
    200: '#BFD0F0',
    300: '#93AEE6',
    400: '#6E8FD6',
    500: '#5B7CC4',
    600: '#4A66A8',
    700: '#38507F',
    800: '#27374F',
    900: '#1A2437',
  },
  entity: {
    url: '#7FA6D9',
    page: '#6FB0A6',
    image: '#B79ADB',
    file: '#8FA8C4',
    note: '#C9B27A',
    person: '#DFA07A',
    identity: '#D98BA8',
    repo: '#7FB985',
    toolrun: '#A8AEB8',
    group: '#9BB0C9',
  },
  space: [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 56],
  radius: { 0: 0, 1: 3, 2: 5, 3: 8, 4: 12, 5: 16, full: 999 },
  duration: { 1: 75, 2: 120, 3: 180, 4: 240, 5: 320 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    in: 'cubic-bezier(0.7, 0, 0.84, 0)',
    inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
  },
} as const;

export type SemanticToken =
  | `--surface-${0 | 1 | 2 | 3 | 4}`
  | '--surface-inset'
  | '--surface-hover'
  | '--surface-active'
  | '--surface-selected'
  | `--fg-${'primary' | 'secondary' | 'muted' | 'disabled' | 'inverse' | 'accent' | 'on-accent'}`
  | `--border-${'subtle' | 'default' | 'strong' | 'focus' | 'accent' | 'danger'}`
  | `--status-${'info' | 'success' | 'warn' | 'danger'}-${'fg' | 'bg' | 'border'}`
  | `--entity-${EntityKind}-${'fg' | 'bg' | 'border'}`;

export type EntityKind =
  | 'url'
  | 'page'
  | 'image'
  | 'file'
  | 'note'
  | 'person'
  | 'identity'
  | 'repo'
  | 'toolrun'
  | 'group';

/** Resolved, numeric palette handed to the canvas engine once per theme change.
 *  The engine must never call getComputedStyle itself (see 05_CANVAS_ENGINE.md §7). */
export interface CanvasPalette {
  void: string;
  gridDot: string;
  gridLine: string;
  edge: string;
  edgeStrong: string;
  edgeSelected: string;
  edgeLabelBg: string;
  nodeBg: string;
  nodeBorder: string;
  nodeFg: string;
  nodeFgMuted: string;
  selectionRing: string;
  selectionFill: string;
  guide: string;
  marqueeFill: string;
  marqueeStroke: string;
  entity: Record<EntityKind, string>;
}

const CANVAS_VARS: Record<keyof Omit<CanvasPalette, 'entity'>, string> = {
  void: '--canvas-void',
  gridDot: '--canvas-grid-dot',
  gridLine: '--canvas-grid-line',
  edge: '--canvas-edge',
  edgeStrong: '--canvas-edge-strong',
  edgeSelected: '--selection-ring',
  edgeLabelBg: '--surface-2',
  nodeBg: '--node-bg',
  nodeBorder: '--node-border',
  nodeFg: '--fg-primary',
  nodeFgMuted: '--fg-muted',
  selectionRing: '--selection-ring',
  selectionFill: '--selection-fill',
  guide: '--canvas-guide',
  marqueeFill: '--canvas-marquee-fill',
  marqueeStroke: '--selection-ring',
};

export function readCanvasPalette(root: HTMLElement = document.documentElement): CanvasPalette {
  const cs = getComputedStyle(root);
  const get = (v: string) => cs.getPropertyValue(v).trim();
  const entity = Object.fromEntries(
    (Object.keys(primitives.entity) as EntityKind[]).map((k) => [k, get(`--entity-${k}-fg`)]),
  ) as Record<EntityKind, string>;
  const base = Object.fromEntries(Object.entries(CANVAS_VARS).map(([k, v]) => [k, get(v)])) as Omit<
    CanvasPalette,
    'entity'
  >;
  return { ...base, entity };
}

export function applyTheme(theme: Theme | 'system'): Theme {
  const resolved: Theme =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem('nx-theme', theme);
  return resolved;
}
```

---

## 4. Color

### 4.1 Neutral ramp

Dark-tuned: the low end is compressed (steps 000→300 are ~2–4 L\* apart) because that band carries
all surface elevation and needs fine control; the high end is stretched because it only carries
text. Hue is fixed at ~260° (cool blue-grey) with chroma ≤ 0.024 so neutrals never read as "blue
theme" but never look dead-grey on OLED either.

| Step         | OKLCH                      | Hex       | L\*  | Role                                       |
| ------------ | -------------------------- | --------- | ---- | ------------------------------------------ |
| neutral-000  | `oklch(13.9% 0.005 262.8)` | `#08090B` | 13.9 | app backdrop / canvas void                 |
| neutral-050  | `oklch(15.8% 0.007 258.4)` | `#0B0D10` | 15.8 | inset wells, inputs                        |
| neutral-100  | `oklch(18.2% 0.009 264.3)` | `#101216` | 18.2 | surface-1: panels, node cards              |
| neutral-150  | `oklch(20.8% 0.011 260.7)` | `#15181D` | 20.8 | surface-2: toolbars, headers               |
| neutral-200  | `oklch(23.8% 0.013 258.4)` | `#1B1F25` | 23.8 | surface-3: menus, dialogs                  |
| neutral-300  | `oklch(27.9% 0.016 259.8)` | `#242931` | 27.9 | surface-4: tooltips, dragging              |
| neutral-400  | `oklch(32.7% 0.020 260.6)` | `#2F353F` | 32.7 | strong dividers, disabled fill             |
| neutral-500  | `oklch(38.5% 0.021 259.4)` | `#3D444F` | 38.5 | inactive track, skeleton base              |
| neutral-600  | `oklch(49.4% 0.023 260.1)` | `#5A626F` | 49.4 | disabled text, canvas edges                |
| neutral-700  | `oklch(61.4% 0.024 259.2)` | `#7C8593` | 61.4 | muted text (4.4:1 on surface-2, use ≥13px) |
| neutral-800  | `oklch(73.5% 0.020 258.4)` | `#A2AAB6` | 73.5 | secondary text                             |
| neutral-900  | `oklch(84.6% 0.014 258.3)` | `#C7CDD6` | 84.6 | strong secondary / icons                   |
| neutral-950  | `oklch(93.3% 0.007 260.7)` | `#E6E9EE` | 93.3 | primary text                               |
| neutral-1000 | `oklch(97.9% 0.003 264.5)` | `#F7F8FA` | 97.9 | on-accent text, pure highlight             |

Fourteen stops are listed although §2 calls the ramp "12 steps of usable UI grey": `000` and
`1000` are endpoints reserved for backdrop and on-accent, the twelve stops `050…950` are the
working ramp.

**Never** use `#000000` or `#FFFFFF` in dark mode. Pure black kills the elevation ladder (nothing
can go below it) and pure white on dark causes halation at small sizes.

### 4.2 Accent — "Signal Blue"

One family, hue 264°, chroma capped at 0.117. It is deliberately less saturated than a default
`blue-500` so that entity colors and status colors can out-rank it when they need attention.

| Token             | Hex       | Use                                                        |
| ----------------- | --------- | ---------------------------------------------------------- |
| `--nx-accent-200` | `#BFD0F0` | text on accent-800 fills, keyboard hints                   |
| `--nx-accent-300` | `#93AEE6` | `--fg-accent`: links, active tab label, selected tree item |
| `--nx-accent-400` | `#6E8FD6` | `--border-focus`, selection ring, guides                   |
| `--nx-accent-500` | `#5B7CC4` | primary button hover, active border                        |
| `--nx-accent-600` | `#4A66A8` | primary button rest fill                                   |
| `--nx-accent-700` | `#38507F` | primary button pressed                                     |
| `--nx-accent-800` | `#27374F` | accent-tinted surfaces (selected row on dark)              |
| `--nx-accent-900` | `#1A2437` | subtlest accent wash                                       |

Accent budget rule: **at most 3 accent-solid elements visible at once** in any viewport. If a
screen needs a fourth, one of them is not primary. Enforced by review, checked in the visual
checklist (§13.3).

### 4.3 Semantic colors

| Role    | fg (text/icon)                    | bg (14% mix)       | border (34% mix)   | Meaning                                                  |
| ------- | --------------------------------- | ------------------ | ------------------ | -------------------------------------------------------- |
| info    | `#6EA8D8`                         | `color-mix(… 14%)` | `color-mix(… 34%)` | neutral system information, AI proposal pending          |
| success | `#5FA97F`                         | idem               | idem               | run completed, saved, verified                           |
| warn    | `#C8A24A`                         | idem               | idem               | partial result, stale data, rate limited, low confidence |
| danger  | `#E08A80` (fg) / `#D4756B` (fill) | idem               | idem               | failure, destructive action, SSRF block                  |

`--status-danger-fg` uses the lighter `#E08A80` so danger text keeps ≥ 7:1 on all surfaces while
the darker `#D4756B` is reserved for solid fills where white text sits on top.

Status is never communicated by color alone (N6, WCAG 1.4.1): every status pill carries an icon
(`info` = circle-i, `success` = check, `warn` = triangle-!, `danger` = octagon-x) and a text label
or an `aria-label`.

### 4.4 Entity-type color coding (10 node types)

All ten hues are placed at L\* 71–77 with chroma 0.016–0.101, spread around the hue wheel with
≥ 25° separation except where a deliberate pairing exists (`url` 255° / `file` 251° differ by
chroma: `file` is desaturated because files are containers, URLs are addresses). Equal lightness
is what makes them harmonious: at 100% they are equally loud, at 5–12% they all become the same
quiet tint of their hue.

| Node type           | Token                  | Hex       | OKLCH            | Hue        | Mnemonic         |
| ------------------- | ---------------------- | --------- | ---------------- | ---------- | ---------------- |
| URL / link          | `--nx-entity-url`      | `#7FA6D9` | 71.6% 0.086 255° | blue       | the web          |
| Page / snapshot     | `--nx-entity-page`     | `#6FB0A6` | 71.1% 0.068 184° | teal       | captured content |
| Image / media       | `--nx-entity-image`    | `#B79ADB` | 73.5% 0.097 305° | violet     | visual           |
| File / document     | `--nx-entity-file`     | `#8FA8C4` | 72.2% 0.050 251° | slate-blue | inert container  |
| Note / text         | `--nx-entity-note`     | `#C9B27A` | 77.0% 0.078 88°  | sand       | human writing    |
| Person              | `--nx-entity-person`   | `#DFA07A` | 75.7% 0.091 52°  | amber      | warm = human     |
| Identity / account  | `--nx-entity-identity` | `#D98BA8` | 72.5% 0.101 356° | rose       | handle/persona   |
| Repository / code   | `--nx-entity-repo`     | `#7FB985` | 73.2% 0.096 147° | green      | build            |
| Tool run / evidence | `--nx-entity-toolrun`  | `#A8AEB8` | 74.9% 0.016 261° | neutral    | machine-produced |
| Group / cluster     | `--nx-entity-group`    | `#9BB0C9` | 74.9% 0.043 253° | pale blue  | container        |

Usage recipe per entity color `E`:

| Context                                 | Value                                     | Opacity                                                |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Node accent bar (left edge, 3px)        | `E`                                       | 100%                                                   |
| Far-LOD glyph fill on canvas            | `E`                                       | 100%                                                   |
| Icon in node header, badge text         | `E`                                       | 100%                                                   |
| Edge stroke when typed by source entity | `E`                                       | 70% (`color-mix(in oklab, E 70%, var(--canvas-void))`) |
| Chip / tag background                   | `color-mix(in oklab, E 10%, transparent)` | 10%                                                    |
| Chip / tag border                       | `color-mix(in oklab, E 32%, transparent)` | 32%                                                    |
| Group frame fill                        | `color-mix(in oklab, E 5%, transparent)`  | 5%                                                     |
| Selected-row wash in table/list         | `color-mix(in oklab, E 8%, transparent)`  | 8%                                                     |

Because all ten share L\*, a canvas holding all ten node types shows a color-coded taxonomy with
no single type screaming. Colorblind safety: hue alone is never the only differentiator — every
node type also has a distinct icon (§12) and the far-LOD glyph has a distinct silhouette (§11.1).

### 4.5 Contrast table (WCAG AA proof)

Ratios computed with the WCAG 2.x relative-luminance formula against the actual sRGB fallbacks.
Backgrounds: S0 `#08090B`, S1 `#101216`, S2 `#15181D`, S3 `#1B1F25`, S4 `#242931`, inset `#0B0D10`.
AA requires 4.5:1 for body text, 3:1 for ≥ 18.66px/bold-14px text and for UI component boundaries.

| Foreground                     | Hex       | on S0 | on S1 | on S2 | on S3 | on S4 | Verdict                                                   |
| ------------------------------ | --------- | ----- | ----- | ----- | ----- | ----- | --------------------------------------------------------- |
| `--fg-primary` (neutral-950)   | `#E6E9EE` | 16.37 | 15.40 | 14.62 | 13.59 | 12.01 | AAA everywhere                                            |
| `--fg-secondary` (neutral-800) | `#A2AAB6` | 8.50  | 8.00  | 7.59  | 7.06  | 6.24  | AAA everywhere                                            |
| `--fg-muted` (neutral-700)     | `#7C8593` | 5.34  | 5.03  | 4.77  | 4.44  | 3.92  | AA on S0–S3; **on S4 only for ≥18.66px or non-text**      |
| `--fg-disabled` (neutral-600)  | `#5A626F` | 3.24  | 3.05  | 2.89  | 2.69  | 2.37  | disabled text is exempt (WCAG 1.4.3), still ≥3:1 on S0–S1 |
| `--fg-accent` (accent-300)     | `#93AEE6` | 8.95  | 8.43  | 8.00  | 7.44  | 6.57  | AAA everywhere                                            |
| accent-400 (focus ring, UI)    | `#6E8FD6` | 6.23  | 5.86  | 5.56  | 5.17  | 4.57  | AA text + AA non-text                                     |
| `--status-info-fg`             | `#6EA8D8` | 7.83  | 7.37  | 6.99  | 6.50  | 5.75  | AAA on S0–S3, AA on S4                                    |
| `--status-success-fg`          | `#5FA97F` | 7.08  | 6.67  | 6.33  | 5.88  | 5.20  | AA everywhere                                             |
| `--status-warn-fg`             | `#C8A24A` | 8.27  | 7.79  | 7.39  | 6.87  | 6.07  | AAA on S0–S3                                              |
| `--status-danger-fg`           | `#E08A80` | 7.70  | 7.25  | 6.88  | 6.39  | 5.65  | AAA on S0–S3                                              |
| entity `url`                   | `#7FA6D9` | 7.99  | 7.46  | 7.09  | 6.59  | 5.83  | AA everywhere                                             |
| entity `page`                  | `#6FB0A6` | 8.07  | 7.53  | 7.15  | 6.65  | 5.88  | AA everywhere                                             |
| entity `image`                 | `#B79ADB` | 8.28  | 7.73  | 7.34  | 6.82  | 6.04  | AA everywhere                                             |
| entity `file`                  | `#8FA8C4` | 8.20  | 7.65  | 7.27  | 6.75  | 5.98  | AA everywhere                                             |
| entity `note`                  | `#C9B27A` | 9.71  | 9.05  | 8.60  | 7.98  | 7.07  | AAA everywhere                                            |
| entity `person`                | `#DFA07A` | 9.04  | 8.43  | 8.01  | 7.44  | 6.58  | AAA on S0–S3                                              |
| entity `identity`              | `#D98BA8` | 7.85  | 7.33  | 6.96  | 6.47  | 5.72  | AA everywhere                                             |
| entity `repo`                  | `#7FB985` | 8.79  | 8.20  | 7.79  | 7.23  | 6.40  | AAA on S0–S3                                              |
| entity `toolrun`               | `#A8AEB8` | 9.00  | 8.40  | 7.98  | 7.41  | 6.56  | AAA on S0–S3                                              |
| entity `group`                 | `#9BB0C9` | 9.04  | 8.43  | 8.01  | 7.44  | 6.58  | AAA on S0–S3                                              |

Inverse pairs (text on solid fills):

| Pair                                        | Ratio | Verdict                                                                                                                                              |
| ------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#F7F8FA` on accent-600 `#4A66A8`           | 5.27  | AA (body), AAA at 18.66px                                                                                                                            |
| `#F7F8FA` on accent-500 `#5B7CC4` (hover)   | 3.86  | **AA for ≥18.66px / bold-14px only** → primary buttons use `--btn-font-weight: 500` at 13px, so hover state is additionally darkened: see rule below |
| `#F7F8FA` on accent-700 `#38507F` (active)  | 7.44  | AAA                                                                                                                                                  |
| `#F7F8FA` on danger fill `#B05F57`          | 5.10  | AA                                                                                                                                                   |
| `#08090B` on `--fg-primary` (inverse chips) | 15.4  | AAA                                                                                                                                                  |

**Rule derived from the table:** primary-button hover must not reduce contrast below 4.5:1. So
`--btn-primary-bg-hover` is defined as `color-mix(in oklab, var(--nx-accent-500) 88%, black)`
(→ ≈ `#516EAE`, 4.62:1) rather than raw accent-500. Hover brightening on dark surfaces is capped
by contrast, not by aesthetics. This exact override is present in `components.css`.

Enforcement: `packages/ui/tokens/contrast.test.ts` recomputes every pair in this table from the
token files at test time and fails if any pair drops below its stated threshold. Adding a token
without adding a row fails the test (the test enumerates all `--fg-*`, `--status-*-fg`,
`--entity-*-fg` tokens found in the CSS).

---

## 5. Elevation and surfaces

### 5.1 Five levels

Elevation in dark mode = luminance step + hairline border + (only above level 3) a tight shadow.
Never blur-heavy, never colored, never `inset 0 1px 0 white` glossy.

| Level | Token         | Background | Border                            | Shadow          | Used for                                                                 |
| ----- | ------------- | ---------- | --------------------------------- | --------------- | ------------------------------------------------------------------------ |
| 0     | `--surface-0` | `#08090B`  | none                              | none            | app backdrop, canvas void, behind everything                             |
| 1     | `--surface-1` | `#101216`  | `1px solid var(--border-subtle)`  | `--nx-shadow-0` | panels, node cards, cards in lists                                       |
| 2     | `--surface-2` | `#15181D`  | `1px solid var(--border-subtle)`  | `--nx-shadow-1` | toolbars, panel headers, sticky rows, segmented control track            |
| 3     | `--surface-3` | `#1B1F25`  | `1px solid var(--border-default)` | `--nx-shadow-3` | popovers, dropdown menus, dialogs, command palette                       |
| 4     | `--surface-4` | `#242931`  | `1px solid var(--border-strong)`  | `--nx-shadow-4` | tooltips, dragged node ghost, drag preview, floating toolbar over canvas |

Shadow values (from §3.1): note that the largest shadow is only 44px blur at 60% alpha with a
negative spread, which reads as separation, not as a drop shadow.

### 5.2 Elevation recipes as tokens

```css
/* Elevation is a triple (bg + border + shadow), so it is shipped as utility classes,
   not as single custom properties. Tailwind preset exposes them as `elev-1..4`. */
.nx-elev-1 {
  background: var(--surface-1);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--nx-shadow-0);
}
.nx-elev-2 {
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--nx-shadow-1);
}
.nx-elev-3 {
  background: var(--surface-3);
  border: 1px solid var(--border-default);
  box-shadow: var(--nx-shadow-3);
}
.nx-elev-4 {
  background: var(--surface-4);
  border: 1px solid var(--border-strong);
  box-shadow: var(--nx-shadow-4);
}
```

Components use `.nx-elev-N` (or the equivalent Tailwind `elev-N` utility from the generated
preset) and never spell out a background/border/shadow triple. This is what makes the light theme
possible: `.nx-elev-3` in light mode resolves to white + a real shadow with no component change.

### 5.3 Rules

1. Adjacent surfaces never differ by more than one level. A level-1 panel cannot contain a
   level-4 child except as a true overlay (`position: fixed`, portal).
2. A floating layer never uses a background blur except the dialog backdrop
   (`backdrop-filter: blur(var(--overlay-backdrop-blur))` = 6px). Blur on menus costs GPU during
   canvas interaction and is banned.
3. Hairline borders use `--border-subtle` (8% white) inside dense UI and `--border-default` (13%)
   for floating layers. `--border-strong` (22%) is only for level 4 and for hovered inputs.
4. On surfaces ≥ level 3, dividers are `1px solid var(--border-subtle)` — never a second
   background band.
5. Nothing uses `outline` for decoration; `outline` is reserved for focus (§9.1).

---

## 6. Typography

### 6.1 Fonts

| Role    | Family                            | Package                               | Fallback stack                                                                                     |
| ------- | --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Display | **Manrope Variable** (OFL)        | `@fontsource-variable/manrope`        | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| UI sans | **Inter Tight Variable** (OFL)    | `@fontsource-variable/inter-tight`    | same as above                                                                                      |
| Mono    | **JetBrains Mono Variable** (OFL) | `@fontsource-variable/jetbrains-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`                      |

Two text faces, on purpose: a display grotesque names things (brand, headings, section eyebrows)
and a tighter text face carries everything read in volume. The pairing is what makes the chrome
read as instrumentation rather than as a default web app, and it costs nothing at runtime — the
display face appears only in chrome, so it is a few hundred glyphs on screen at most.

Self-hosted, never a font CDN (privacy requirement for an OSINT tool; `15_SECURITY.md`) and never
a network dependency (N2 local-first). Delivery is Fontsource: `apps/web/src/styles/fonts.css`
imports the weight axis of each family (`wght.css`, no italic file), which declares one
`@font-face` per unicode-range subset. All three families cover Latin, Latin-ext and Cyrillic — the
UI must render Cyrillic without fallback substitution — and a Latin-only session downloads only the
Latin subsets, roughly 60 KB in total.

```css
/* apps/web/src/styles/fonts.css */
@import '@fontsource-variable/inter-tight/wght.css';
@import '@fontsource-variable/manrope/wght.css';
@import '@fontsource-variable/jetbrains-mono/wght.css';

:root {
  font-synthesis: none; /* never fake bold/italic */
  -webkit-font-smoothing: antialiased; /* required: light-on-dark otherwise blooms */
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  font-variant-ligatures: none; /* UI text: no ligatures, they hurt scanning */
}
.nx-tabular {
  font-variant-numeric: tabular-nums;
} /* mandatory in tables, counters, timers */
```

Every face declares `font-display: swap`, so a first paint before the font file lands is a metric
shift, never invisible text or a missing glyph.

### 6.2 Type scale (11 steps)

Sizes are px (not rem) because this is a fixed-density desktop application and the canvas mixes
DOM text with canvas-drawn text that must match exactly. User zoom still works (browser zoom
scales px). A `--nx-font-scale` multiplier (0.9 / 1.0 / 1.15) is exposed in Settings → Appearance
and applied via `font-size` on `:root` with all steps declared in `em` internally; the table below
is the 1.0 baseline.

| #   | Token             | Role    | Size | Line-height  | Letter-spacing | Weight | Use                                                                      |
| --- | ----------------- | ------- | ---- | ------------ | -------------- | ------ | ------------------------------------------------------------------------ |
| 0   | `--text-hero`     | Hero    | 40px | 44px (1.10)  | -0.03em        | 600    | first-run and empty-workspace hero (display face)                        |
| 1   | `--text-display`  | Display | 28px | 34px (1.21)  | -0.025em       | 600    | onboarding, empty-project hero (display face)                            |
| 2   | `--text-title-lg` | Title L | 20px | 26px (1.30)  | -0.015em       | 600    | dialog titles, board title in header                                     |
| 3   | `--text-title`    | Title   | 16px | 22px (1.375) | -0.01em        | 600    | panel titles, section headers                                            |
| 4   | `--text-body-lg`  | Body L  | 15px | 22px (1.47)  | -0.005em       | 400    | long-form note editor body                                               |
| 5   | `--text-body`     | Body    | 13px | 18px (1.38)  | 0              | 400    | default UI text, menu items, inputs                                      |
| 6   | `--text-body-sm`  | Body S  | 12px | 16px (1.33)  | +0.005em       | 400    | table cells, node metadata, dense lists                                  |
| 7   | `--text-label`    | Label   | 11px | 14px (1.27)  | +0.02em        | 500    | field labels, column headers, tab labels                                 |
| 8   | `--text-caption`  | Caption | 10px | 13px (1.30)  | +0.03em        | 500    | badges, timestamps, LOD-2 node subtitle                                  |
| 9   | `--text-eyebrow`  | Eyebrow | 10px | 14px (1.40)  | +0.18em        | 600    | upper-case region markers: panel and menu section headers (display face) |
| 10  | `--text-mono`     | Mono    | 12px | 18px (1.5)   | 0              | 400    | hashes, IDs, code, JSON payloads, CLI output                             |

Uppercase is allowed **only** through `--text-eyebrow` (and its `.nx-eyebrow` utility), which is
the single sanctioned upper-case treatment: 10px, 600, +0.18em. The spacing carries the hierarchy,
which is why the eyebrow can stay at `--fg-muted`. Never uppercase body text.

```css
:root {
  --text-hero: 600 40px/44px var(--nx-font-display);
  --text-display: 600 28px/34px var(--nx-font-display);
  --text-title-lg: 600 20px/26px var(--nx-font-display);
  --text-title: 600 16px/22px var(--nx-font-display);
  --text-body-lg: 400 15px/22px var(--nx-font-sans);
  --text-body: 400 13px/18px var(--nx-font-sans);
  --text-body-sm: 400 12px/16px var(--nx-font-sans);
  --text-label: 500 11px/14px var(--nx-font-sans);
  --text-caption: 500 10px/13px var(--nx-font-sans);
  --text-mono: 400 12px/18px var(--nx-font-mono);
  /* tracking must be applied separately; the `font` shorthand cannot carry it */
  --tracking-display: -0.02em;
  --tracking-title-lg: -0.015em;
  --tracking-title: -0.01em;
  --tracking-body-lg: -0.005em;
  --tracking-body: 0;
  --tracking-body-sm: 0.005em;
  --tracking-label: 0.02em;
  --tracking-caption: 0.03em;
  --tracking-mono: 0;
}
```

### 6.3 Rules for dense UI

1. **Three sizes maximum per panel.** A typical inspector uses `--text-label` for field names,
   `--text-body` for values, `--text-body-sm` for helper text. A fourth size means the hierarchy
   is wrong.
2. **Weight before size before color.** To emphasize, go 400→500 first; only then increase size;
   color change is last and only within the fg ramp.
3. **Never below 10px.** Anything that wants to be 9px must instead be truncated, moved to a
   tooltip, or dropped.
4. **Optical alignment:** icon+text rows align on the text baseline, not the box. Icons at 16px
   sit with `margin-block-start: -1px` against 13px text (cap-height compensation).
5. **Truncation:** single line uses `text-overflow: ellipsis`, always paired with a `title`
   attribute or tooltip carrying the full string. Multi-line uses `-webkit-line-clamp` with an
   explicit `max-height` so layout cannot shift when the font loads.
6. **Numbers in any column that is compared vertically use `.nx-tabular`.** No exceptions:
   confidence scores, byte sizes, node counts, durations, timestamps.
7. **Measure:** long-form text (note editor, report preview) is capped at 72ch. UI text is never
   wider than 90ch.
8. **Cyrillic check:** every screenshot test has a `ru-RU` variant fixture with the longest
   Russian string for that surface; layout must not break (Russian labels run ~25% longer).

---

## 7. Space, radius, borders, icons

### 7.1 Spacing scale (4px base, 10 usable steps)

| Token           | Value | Primary use                                                |
| --------------- | ----- | ---------------------------------------------------------- |
| `--nx-space-0`  | 0     | reset                                                      |
| `--nx-space-1`  | 2px   | icon-to-badge nudge, hairline gaps                         |
| `--nx-space-2`  | 4px   | inside a chip, between icon and its 11px label             |
| `--nx-space-3`  | 8px   | default gap inside a control row, menu item padding-x      |
| `--nx-space-4`  | 12px  | control padding-x, table cell padding-x, node card padding |
| `--nx-space-5`  | 16px  | panel padding, gap between form fields                     |
| `--nx-space-6`  | 20px  | gap between form groups                                    |
| `--nx-space-7`  | 24px  | dialog padding, section gap                                |
| `--nx-space-8`  | 32px  | between major sections in a settings page                  |
| `--nx-space-9`  | 40px  | empty-state vertical padding                               |
| `--nx-space-10` | 56px  | page-level top padding (onboarding, reports only)          |

Only these values may appear as spacing. `10px`, `14px`, `18px` are forbidden and are caught by
the tokens-only lint rule.

### 7.2 Radius scale

| Token              | Value | Applies to                                                  |
| ------------------ | ----- | ----------------------------------------------------------- |
| `--nx-radius-0`    | 0     | table cells, panel edges flush to the viewport, canvas grid |
| `--nx-radius-1`    | 3px   | checkbox, small badges, keyboard-key hint                   |
| `--nx-radius-2`    | 5px   | buttons, inputs, select, chips, segmented items             |
| `--nx-radius-3`    | 8px   | node cards, popovers, menus, toasts, panels                 |
| `--nx-radius-4`    | 12px  | dialogs, command palette, sheets                            |
| `--nx-radius-5`    | 16px  | onboarding cards, presentation-mode slides                  |
| `--nx-radius-full` | 999px | avatars, switch, status dots, pills                         |

Nesting rule: an inner radius = outer radius − padding, floored at `--nx-radius-1`. A 8px-radius
card with 12px padding hosts a 5px-radius input; it never hosts another 8px radius.

### 7.3 Border widths

| Token                  | Value | Use                                                         |
| ---------------------- | ----- | ----------------------------------------------------------- |
| `--nx-border-hairline` | 1px   | everything structural: panels, inputs, cards, dividers      |
| `--nx-border-thick`    | 1.5px | selected node card border, active tab underline             |
| `--nx-border-heavy`    | 2px   | focus ring width, drag-over drop target, error input border |

At `devicePixelRatio: 1`, 1.5px borders are rendered by the browser as 1px+antialias on DOM and by
the canvas engine as `ctx.lineWidth = 1.5` aligned to `+0.5` pixel offsets (see
`05_CANVAS_ENGINE.md` §5 for the crisp-line rule).

### 7.4 Icon grid and stroke rules

Three sizes only: **16 / 20 / 24 px**.

| Size | Grid                                | Stroke | Use                                                             |
| ---- | ----------------------------------- | ------ | --------------------------------------------------------------- |
| 16   | 16×16, 1px padding → 14px live area | 1.5px  | inline with 12–13px text, menu items, table cells, node headers |
| 20   | 20×20, 2px padding → 16px live area | 1.5px  | toolbar buttons, tab icons, inspector section headers           |
| 24   | 24×24, 2px padding → 20px live area | 2px    | empty states, dialog headers, canvas floating toolbar           |

Rules:

1. Stroke-based icons only (no filled duotone) except: status dots, avatars, brand logos, and the
   entity glyph inside the node header when the node is selected (filled = selected affordance).
2. Stroke width is optically constant: 1.5px at 16/20, 2px at 24. Never scale an icon between
   sizes; use the size-specific artwork.
3. Terminals are `stroke-linecap: round`, joins `stroke-linejoin: round`, corner radius 2 on the
   16px grid.
4. `stroke: currentColor`, `fill: none`. Icons inherit text color; there is no icon color token.
5. Optical alignment: circular glyphs (globe, clock) are drawn 1px larger than square glyphs
   (file, folder) to match perceived size.
6. Icons never carry meaning alone in destructive contexts — a trash icon button always has a
   tooltip + `aria-label`.

---

## 8. Motion

### 8.1 Duration scale

| Token        | Value | Use                                                              |
| ------------ | ----- | ---------------------------------------------------------------- |
| `--nx-dur-1` | 75ms  | state color/opacity change on hover/press (button, row, icon)    |
| `--nx-dur-2` | 120ms | tooltip show, checkbox check, small toggles, segmented thumb     |
| `--nx-dur-3` | 180ms | dropdown/popover/context-menu enter, tab content crossfade       |
| `--nx-dur-4` | 240ms | dialog enter, drawer/sheet slide, panel resize snap, toast enter |
| `--nx-dur-5` | 320ms | command palette enter, view-mode transition (canvas → timeline)  |

Exits are always **0.75×** the enter duration, rounded to the nearest scale step or its
`calc(var(--nx-dur-N) * 0.75)`. Nothing in the product animates longer than 320ms except the
camera fly-to (§8.5) which is capped at 420ms.

### 8.2 Easing

| Token                | Curve                            | Use                                                               |
| -------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `--nx-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)`     | default for anything that both moves and fades                    |
| `--nx-ease-out`      | `cubic-bezier(0.16, 1, 0.3, 1)`  | entrances: menus, dialogs, drawers, toasts                        |
| `--nx-ease-in`       | `cubic-bezier(0.7, 0, 0.84, 0)`  | exits                                                             |
| `--nx-ease-inout`    | `cubic-bezier(0.65, 0, 0.35, 1)` | reversible movement: segmented thumb, tab underline               |
| `--nx-ease-linear`   | `linear`                         | continuous/indeterminate only: spinner rotation, progress shimmer |

No spring physics in UI chrome. Springs are reserved for canvas camera inertia
(`05_CANVAS_ENGINE.md` §4.3) where the physical metaphor is real.

### 8.3 What may animate

Allowed properties, always: `opacity`, `transform` (translate/scale/rotate), `background-color`,
`border-color`, `color`, `box-shadow`, `stroke-dashoffset` (edge "flow" for a running tool only),
`clip-path` on skeleton shimmer.

**Never animated:**

- `width` / `height` / `top` / `left` / `margin` / `padding` — layout thrash; use transform.
- Anything inside the canvas viewport during pan/zoom (`00_MASTER.md` architecture row: "never
  animate layout inside the canvas").
- Node position changes caused by another user's edit (they jump — see §8.5 exception for
  auto-layout, which is explicitly user-initiated).
- Text content (no counting-up numbers, no typewriter effects).
- Anything on an infinite loop except: spinner (only while a request is in flight), the 1.4s
  skeleton shimmer, and the 2s "recording/live scan" status dot which is the single exception
  and uses opacity 0.55→1.0 (never scale).

### 8.4 Reduced motion mapping

`@media (prefers-reduced-motion: reduce)` — implemented once in `packages/ui/tokens/index.css`:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --nx-dur-1: 1ms;
    --nx-dur-2: 1ms;
    --nx-dur-3: 1ms;
    --nx-dur-4: 1ms;
    --nx-dur-5: 1ms;
  }
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

Behavioral mapping (not just "faster"):

| Normal                          | Reduced                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| Drawer slides in from the right | appears in place, opacity 0→1 in 1ms (i.e. instant)                       |
| Toast slides up + fades         | appears in place                                                          |
| Skeleton shimmer                | static `--surface-2` block, no shimmer                                    |
| Spinner rotation                | replaced by a static 3-dot glyph with `aria-busy="true"`; text "Loading…" |
| Camera fly-to on "focus node"   | instant camera set                                                        |
| Auto-layout transition          | instant reposition, with an "Undo layout" toast (240ms → instant)         |
| Live scan pulse dot             | static filled dot + text label                                            |

The reduced-motion state is also exposed to the canvas engine as
`CanvasOptions.reducedMotion: boolean`, read from a `matchMedia` listener in
`apps/web/src/canvas/useCanvasOptions.ts`.

### 8.5 Canvas-specific motion rules

1. **Pan/zoom is never animated** — it tracks the pointer/wheel 1:1 through a rAF-batched camera
   update. Inertia after a fling is a physics decay (`v *= 0.92` per frame, stop below 0.05px/frame),
   not a CSS transition.
2. **Fly-to** (focus a node, jump from search, follow a presence cursor) animates camera
   `{x, y, zoom}` with `--nx-ease-standard` over `clamp(180ms, distance / 4, 420ms)`. Zoom is
   interpolated in log space so the motion feels linear.
3. **Auto-layout** animates node positions over 320ms with `--nx-ease-inout`, but only nodes whose
   position actually changed, and only if `nodeCount ≤ 600`; above that it applies instantly with
   a toast ("Layout applied to 1,240 nodes · Undo").
4. **New node appearance** (paste, tool import accept): scale 0.96→1 + opacity 0→1 over 120ms,
   staggered by `min(index * 12ms, 240ms)` capped at 20 nodes; nodes 21+ appear instantly.
5. **Edge draw** while dragging a connection is drawn every frame, no easing.
6. **Selection ring** appears with no animation (0ms) — selection must feel instantaneous.
7. **Hover halo** fades in over 75ms, out over 55ms.
8. During any camera movement, all DOM-node transitions are suspended by adding
   `data-camera-moving` on the canvas root, which sets `transition: none` on descendants. This is
   required to hold the 16.6ms frame budget (N1).

---

## 9. Component specification

All components live in `packages/ui/src/components/<Name>/`. Every one is built on a Radix
primitive where one exists (`00_MASTER.md`: "Radix primitives, all skinned; zero default browser
controls"). Each folder contains `<Name>.tsx`, `<Name>.css` (component tokens consumed, no
literals), `<Name>.stories.tsx` (one story per state in the table), and `<Name>.test.tsx`.

### 9.1 Universal state contract

Every interactive component implements exactly these states with these rules:

| State            | Trigger                           | Universal rule                                                                                                                                                                                   |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| rest             | —                                 | tokens as specified per component                                                                                                                                                                |
| hover            | `:hover` on a pointer-fine device | background moves one step (`--surface-hover` overlay) OR fill lightens ≤ 8% L\*; never changes size or border width; 75ms                                                                        |
| active (pressed) | `:active`                         | background one step darker than rest, `transform: translateY(0.5px)` only on buttons; 0ms in, 75ms out                                                                                           |
| focus-visible    | keyboard focus (`:focus-visible`) | `box-shadow: var(--focus-ring-shadow)` — 2px ring, 2px offset in `--surface-0`; `outline: none`. Never rendered for mouse interaction                                                            |
| selected         | app state                         | `--surface-selected` background + `--fg-primary` text + 2px `--border-accent` left marker where a marker fits                                                                                    |
| disabled         | `disabled` / `aria-disabled`      | `--fg-disabled` text, `--surface-2` fill, `cursor: not-allowed`, `opacity: 1` (never fade — fading disabled elements below 3:1 is a known a11y failure), no hover response, tooltip explains why |
| loading          | pending async                     | control keeps its exact size; content is replaced by a 16px spinner or the label is kept and a 2px indeterminate bar appears at the bottom edge; `aria-busy="true"`; pointer events off          |
| error            | validation / operation failure    | `--input-border-error` (2px) + message below in `--status-danger-fg` at `--text-body-sm` + `aria-invalid`, `aria-describedby`                                                                    |

Focus ring is never omitted, never replaced by a color change alone, and always drawn **outside**
the component box so it survives on adjacent surfaces.

### 9.2 Button (5 variants)

Sizes: `sm` 26px / `md` 32px (default) / `lg` 38px. Padding-x `--nx-space-4` (12px), `--nx-space-3`
(8px) for `sm`. Icon+label gap 6px (`--nx-space-3` minus optical 2px → token `--btn-gap: 6px`).
Font `--text-body` at weight 500. Radius `--nx-radius-2`. Min-width 64px for text buttons.

| Variant       | rest                                                                                                                              | hover                                                     | active                                                      | focus-visible                        | disabled                                                  | loading                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| **primary**   | bg `--btn-primary-bg` (#4A66A8), fg `--fg-on-accent`, border `--btn-primary-border`                                               | bg `--btn-primary-bg-hover` (contrast-capped mix, 4.62:1) | bg `--btn-primary-bg-active` (#38507F), `translateY(0.5px)` | + `--focus-ring-shadow`              | bg `--btn-disabled-bg`, fg `--btn-disabled-fg`, no border | spinner replaces icon, label stays, width frozen via `min-width` snapshot |
| **secondary** | bg `--surface-2`, fg `--fg-primary`, border `--border-default`                                                                    | bg `--surface-3`, border `--border-strong`                | bg `--surface-4`                                            | + ring                               | bg `--surface-1`, fg disabled, border subtle              | as primary                                                                |
| **ghost**     | transparent, fg `--fg-secondary`                                                                                                  | bg `--surface-hover`, fg `--fg-primary`                   | bg `--surface-active`                                       | + ring                               | fg disabled                                               | as primary                                                                |
| **danger**    | bg `--btn-danger-bg` (#B05F57), fg `#F7F8FA`                                                                                      | bg `--nx-danger-400`                                      | bg mix(danger 70% black)                                    | + ring, ring color `--border-danger` | as secondary disabled                                     | as primary                                                                |
| **link**      | transparent, fg `--fg-accent`, underline `1px` offset `2px` with `text-decoration-color: color-mix(--fg-accent 40%, transparent)` | underline full opacity                                    | fg `--nx-accent-200`                                        | ring hugs the text box (offset 1px)  | fg disabled, no underline                                 | inline 12px spinner after label                                           |

Notes: a `danger` button in a dialog is never the default focused control; focus starts on Cancel
(`03_UX.md` §7). Buttons never contain more than 2 words + optional icon. No uppercase.

### 9.3 Icon button

Square: `sm` 26×26 (icon 16), `md` 32×32 (icon 20), `lg` 38×38 (icon 20). Radius `--nx-radius-2`.
Variants mirror Button (`ghost` is default in toolbars, `secondary` when standalone).
States: rest fg `--fg-secondary`; hover bg `--surface-hover` + fg `--fg-primary`; active bg
`--surface-active`; focus ring as universal; `toggled` state = bg `--accent-soft`, fg `--fg-accent`,
`aria-pressed="true"`; disabled fg `--fg-disabled`. Every icon button **must** have a tooltip
(delay 400ms) and `aria-label`. Hit-slop: `::before` inset -4px so the effective target is 40×40
even at `sm`.

### 9.4 Input (text/number/search/password)

Height `--input-height` 32px, padding-x 12px (8px when a leading icon is present, icon at 8px from
edge, 16px icon, text starts at 32px), bg `--surface-inset`, border 1px `--border-default`,
radius 5px, font `--text-body`, caret `--fg-accent`.

| State         | Spec                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| rest          | as above, placeholder `--input-placeholder`                                                                        |
| hover         | border `--input-border-hover` (22% white); bg `--input-bg-hover`                                                   |
| focus-visible | border `--input-border-focus` **and** `--focus-ring-shadow` (ring drawn outside)                                   |
| filled        | identical to rest — no "filled" styling; content is the signal                                                     |
| selected text | `::selection` bg `--accent-soft-hover`, fg `--fg-primary`                                                          |
| disabled      | bg `--surface-1`, fg `--fg-disabled`, border `--border-subtle`, `cursor: not-allowed`                              |
| readonly      | bg `--surface-1`, fg `--fg-secondary`, border `--border-subtle`, text selectable                                   |
| error         | border 2px `--border-danger`, message row 4px below, `--text-body-sm`, `--status-danger-fg` with a 14px alert icon |
| success       | border `--status-success-border`, 16px check icon at trailing edge, auto-clears after 2s                           |
| loading       | trailing 16px spinner replaces the clear/action affordance                                                         |
| with clear    | trailing 16px `x-circle` icon button appears only when value is non-empty and the field is hovered or focused      |

Number inputs use `.nx-tabular` and never show native spinners; they get a 20px stepper column
(up/down chevrons, each 16px tall) on hover/focus only.
Search inputs: leading 16px magnifier, `Esc` clears (and stops propagation only if non-empty),
debounce 180ms, `role="searchbox"`.

### 9.5 Textarea

Same visual contract as Input. Min-height 72px, padding 8px 12px, line-height 18px, resize handle
custom (native `resize: vertical` restyled with a 12×12 corner grip in `--fg-muted`). Auto-grow
variant caps at 12 lines then scrolls. Character counter (when `maxLength` set) sits bottom-right
in `--text-caption` `--fg-muted`, turning `--status-warn-fg` at 90% and `--status-danger-fg` at
100%. `Enter` inserts newline; submit is `Cmd/Ctrl+Enter` and this is shown as a keyboard hint
(§9.32) in the footer of the field.

### 9.6 Select (Radix Select)

Trigger identical to Input plus trailing 16px `chevron-down` in `--fg-muted` (rotates 180° in
120ms when open). Content: `.nx-elev-3`, radius 8px, padding 4px, max-height
`min(320px, var(--radix-select-content-available-height))`, item height 28px, item padding-x 8px,
selected item shows a 16px check at the leading edge (reserved 20px gutter so labels never shift).
States: item hover `--menu-item-bg-hover`; item selected fg `--fg-accent` + check; disabled item
fg `--fg-disabled`. Typeahead is enabled. Placeholder uses `--input-placeholder`. Open/close:
scale 0.98→1 + opacity, 180ms `--nx-ease-out`, transform-origin at the trigger side.

### 9.7 Combobox (filterable, async)

Composition: Input + Popover list. Extra states beyond Select:
`empty` ("No matches for “{query}”" + optional "Create “{query}”" action row),
`loading` (3 skeleton rows at 28px, shimmer),
`error` (row with danger icon + "Couldn't load options · Retry"),
`more` (footer "Showing 50 of 312 — refine your search", `--text-caption`).
Selected values render as chips (§9.22) inside the input when `multiple`; chip overflow shows
`+N` and the full set on hover. Keyboard: `↑/↓` move, `Enter` select, `Backspace` on empty input
removes the last chip, `Esc` closes without committing.

### 9.8 Checkbox

16×16, radius `--nx-radius-1` (3px), border 1px `--border-strong`, bg `--surface-inset`.
Checked: bg `--accent-solid`, border same, 12px check stroke `--fg-on-accent` drawn with
`stroke-dasharray` 0→1 over 120ms `--nx-ease-out`. Indeterminate: 8×1.5px bar, same fill.
Hover: border `--border-focus` at 60% mix. Disabled+checked: bg `--nx-neutral-500`, check
`--fg-disabled`. Focus: universal ring. Label sits 8px right, `--text-body`, clickable, 20px line
box so the row height is 20px. Error: border `--border-danger`.

### 9.9 Radio

16×16 circle, same border/bg/hover as Checkbox. Selected: 1.5px `--border-accent` ring + 6px
`--accent-solid` centre dot, dot scales 0.6→1 in 120ms. Group has `role="radiogroup"` and arrow-key
roving focus. Never used for more than 5 options — beyond that use Select.

### 9.10 Switch

Track 28×16, radius full, bg `--nx-neutral-500` off / `--accent-solid` on. Thumb 12×12 circle
`--nx-neutral-1000`, offset 2px, translates 12px in 120ms `--nx-ease-inout`. Hover: track lightens
one step. Disabled: track `--surface-2`, thumb `--fg-disabled`. Focus: ring around the track.
Loading (optimistic toggle awaiting server): thumb becomes a 12px spinner, track holds the
_pending_ color at 60% opacity; reverts with a toast on failure. Switches apply immediately and
are never paired with a Save button; if a Save button exists, use a Checkbox.

### 9.11 Slider

Track 4px, radius full, bg `--nx-neutral-500`; filled range `--accent-solid`. Thumb 14×14 circle
`--nx-neutral-1000`, border 1px `rgb(0 0 0 / .35)`, shadow `--nx-shadow-1`. Hover: thumb scales to
16px (transform, 75ms). Active/drag: thumb 16px + `--nx-shadow-2`, a value bubble
(`.nx-elev-4`, `--text-caption`, tabular) appears 8px above. Focus: ring on the thumb. Disabled:
track `--surface-2`, thumb `--nx-neutral-600`. Steps render as 2px dots in `--border-strong` when
`step` count ≤ 20. Keyboard: arrows = 1 step, `Shift+arrow` = 10 steps, `Home/End` = min/max.

### 9.12 Segmented control

Track: height 28px, bg `--surface-inset`, border 1px `--border-subtle`, radius 5px, padding 2px.
Items: height 24px, padding-x 10px, `--text-body` weight 500, fg `--fg-secondary`.
Thumb: absolutely positioned `--surface-3` block, radius 3px, `--nx-shadow-1`, moves with
`transform: translateX()` over 180ms `--nx-ease-inout` (width interpolated via `scaleX` on a
1px-wide element to avoid layout animation). Selected item fg `--fg-primary`.
Hover on unselected: fg `--fg-primary`. Disabled item: fg `--fg-disabled`.
Max 5 items; above that, use Tabs. Roving tabindex; `←/→` move selection.

### 9.13 Tabs

Underline style only (no boxed tabs). Tab: height 34px, padding-x 12px, `--text-body` weight 500,
fg `--fg-muted`; hover fg `--fg-secondary`; selected fg `--fg-primary` with a 1.5px
`--border-accent` underline anchored to the bottom edge, animated horizontally 180ms
`--nx-ease-inout`. Tab list has a 1px `--border-subtle` bottom rule that the underline overlaps.
Badge/count inside a tab uses `--text-caption` in a 16px pill (`--surface-3`).
Disabled tab: fg `--fg-disabled`, no underline, tooltip required.
Overflow: horizontal scroll with 24px edge fade masks (`mask-image: linear-gradient`) and
chevron buttons appearing only when scrollable.
Content: crossfade 180ms; height is not animated (containers are already sized by layout).

### 9.14 Tooltip

`.nx-elev-4`, radius 5px, padding 4px 8px, `--text-body-sm`, fg `--fg-primary`, max-width 280px.
No arrow (arrows cost a repaint per position flip and look toy-like at this scale) — instead an
8px offset from the trigger. Delay: 400ms open, 100ms close, 0ms when moving between tooltips in
the same group (Radix `<Tooltip.Provider skipDelayDuration={300}>`). Motion: opacity + 2px
translate along the side axis, 120ms `--nx-ease-out`. Keyboard-key hints inside a tooltip are
right-aligned with 8px gap. Tooltips never contain interactive content — that is a Popover.
Tooltips are suppressed entirely while `data-camera-moving` is set.

### 9.15 Popover

`.nx-elev-3`, radius 8px, padding 12px, min-width 200px, max-width 420px, `--nx-shadow-3`.
Enter: opacity 0→1 + scale 0.98→1 + 4px translate from the trigger side, 180ms `--nx-ease-out`.
Exit: 135ms `--nx-ease-in`. Collision-aware (Radix), `collisionPadding: 8`.
Contains a title (`--text-label`, uppercase, `--fg-muted`) when it has more than one control.
Dismiss: `Esc`, outside click, or an explicit close icon button (top-right, 24px, only when the
popover holds a form). Focus is trapped only if it contains ≥ 2 focusables.

### 9.16 Dropdown menu

`.nx-elev-3`, radius 8px, padding 4px, min-width 180px, max-width 320px.
Item: height 28px, padding 0 8px, radius 3px, `--text-body`, fg `--fg-primary`;
leading 16px icon gutter (20px reserved, always, even if the item has no icon);
trailing shortcut hint `--text-caption` `--fg-muted` right-aligned.
Hover/highlight: bg `--menu-item-bg-hover` (4% white) — highlight follows keyboard and pointer
identically. Danger item: fg `--status-danger-fg`, hover bg `--status-danger-bg`.
Disabled: fg `--fg-disabled`, no highlight, tooltip on hover explaining why.
Checkable item: check in the leading gutter. Submenu: trailing chevron, opens after 180ms hover
intent with a "safe triangle" pointer path. Separator: 1px `--border-subtle` with 4px margin-block.
Group label: `--text-label` uppercase `--fg-muted`, 24px row, padding-x 8px.
Max height 60vh with internal scroll + 16px scroll shadows.

### 9.17 Context menu

Identical visual spec to Dropdown menu. Differences: opens at the pointer with a 2px offset,
never animates position, enter animation is 120ms opacity only (a scale animation at the cursor
reads as lag). On canvas, the context menu is content-aware and its first group always reflects
the current selection count ("3 nodes selected"), rendered as a non-interactive header row in
`--text-caption` `--fg-muted`.

### 9.18 Command palette (`Ctrl/Cmd+K`)

Container: width `min(680px, 92vw)`, max-height 60vh, radius `--nx-radius-4` (12px), `.nx-elev-3`
with `--nx-shadow-4`, positioned at 12vh from the top, backdrop `--overlay-scrim` + 6px blur.
Enter: opacity 0→1 + scale 0.97→1 + translateY(-6px→0), 320ms `--nx-ease-out`; exit 180ms.
Input row: 48px, no border, `--text-body-lg`, leading 20px icon showing the current mode
(search / command / node-jump), trailing `Esc` key hint.
Result row: 40px, leading 16px icon, primary label `--text-body`, secondary path/breadcrumb
`--text-body-sm` `--fg-muted` on the same line after a 8px separator dot, trailing shortcut hint.
Highlighted row: bg `--surface-selected`, 2px `--border-accent` left marker.
Match highlighting: matched substrings in `--fg-accent` weight 600 (never a background highlight).
Sections: `--text-label` uppercase `--fg-muted`, sticky, 24px.
States: `empty` (typed query with no results → "No results for “x”" + 3 suggested actions),
`loading` (3 skeleton rows), `error`, `recent` (initial state shows 5 recent + 5 suggested).
Never more than 50 rows rendered (virtualized above 30).

### 9.19 Dialog (modal)

Backdrop: `--overlay-scrim` (56% black) + `backdrop-filter: blur(6px)`, fades 240ms.
Panel: `.nx-elev-3`, radius 12px, `--nx-shadow-4`, width by size token
(`sm` 400px / `md` 520px / `lg` 720px / `xl` 960px), max-height `calc(100vh - 96px)`.
Enter: opacity + scale 0.97→1 + translateY(8px→0), 240ms `--nx-ease-out`; exit 180ms `--nx-ease-in`.
Structure: header (padding 20px 24px 12px; title `--text-title-lg`; optional description
`--text-body` `--fg-secondary`; close icon button top-right 24px), body (padding 0 24px, scrolls,
with 1px `--border-subtle` top/bottom rules appearing only when scrolled), footer (padding
16px 24px 20px, buttons right-aligned, 8px gap, order: [secondary/Cancel] [primary]).
Focus: first focusable that is not destructive; `Esc` closes unless the dialog has unsaved edits,
in which case it triggers the discard confirm. Focus trap + `aria-modal` + focus restore.
Nested dialogs are forbidden; use a Sheet or an inline step.

### 9.20 Sheet / drawer

Side: right (default) or bottom. Width 380px (`sm`) / 520px (`md`) / 720px (`lg`); bottom sheet
height `min(72vh, content)`. `.nx-elev-3`, radius 12px on the two inner corners only, full-height
1px `--border-default` on the inner edge. Enter: `translateX(100% → 0)` 240ms `--nx-ease-out`;
exit 180ms. Backdrop only when modal; the node inspector drawer is **non-modal** (canvas stays
interactive) and therefore has no backdrop and no focus trap, but has a visible focus boundary
and `Esc` closes it. Resizable drawers use the Resizable panel handle (§9.26) and persist width
in `localStorage` per drawer id.

### 9.21 Toast

Bottom-right stack, 16px from edges, gap 8px, max 3 visible (older ones collapse into "+2 more").
Width 360px, min-height 44px, `.nx-elev-4`, radius 8px, padding 12px, leading 16px status icon,
title `--text-body` weight 500, description `--text-body-sm` `--fg-secondary`, trailing action
(link button) and a 20px close icon button. Left edge carries a 2px status-colored bar.
Timings: info/success 5s, warn 8s, danger persists until dismissed. Timer pauses on hover/focus
and while the tab is hidden. Enter: translateY(8px)+opacity 240ms `--nx-ease-out`; exit 180ms with
a 0.98 scale. A toast that offers **Undo** shows a 2px progress bar at the bottom edge draining
over the timeout (linear) — the only progress-as-countdown in the product.
Toasts never carry critical errors that need a decision; those are Dialogs.

### 9.22 Banner (inline, page/panel level)

Full-width block, radius 8px (0 when flush to a panel edge), padding 12px 16px, bg
`--status-{kind}-bg`, border 1px `--status-{kind}-border`, leading 16px icon in
`--status-{kind}-fg`, title `--text-body` weight 500 `--fg-primary`, body `--text-body-sm`
`--fg-secondary`, actions right-aligned as `ghost`/`link` buttons, optional dismiss.
Variants: `info`, `success`, `warn`, `danger`, plus `offline` (uses `warn` tokens, is sticky to
the top of the app shell, and is the only banner that cannot be dismissed while the condition
holds — required by N2's "Offline always visible").

### 9.23 Badge / chip

Badge (non-interactive status): height 18px, radius 3px, padding 0 6px, `--text-caption` weight
500, `.nx-tabular` for numeric. Variants: `neutral` (bg `--surface-3`, fg `--fg-secondary`),
`accent`, `info`, `success`, `warn`, `danger` (bg `--status-*-bg`, fg `--status-*-fg`, border
`--status-*-border`), `entity-<kind>` (bg 10%, border 32%, fg 100% of the entity hue).
Count badge: min-width 18px, radius full, centered.
Chip (interactive, removable): height 22px, radius 5px, padding 0 4px 0 8px, `--text-body-sm`,
trailing 14px `x` icon button (hover bg `--surface-active`), hover border `--border-strong`,
selected bg `--accent-soft`, focus ring universal, disabled fg `--fg-disabled`.

### 9.24 Tag (user-authored labels)

Chip geometry with a user-chosen color from the entity palette only (§4.4 — no free color picker;
10 harmonized options keep boards from becoming a rainbow). Rest: bg 10%, border 32%, fg 100%,
leading 6px dot in the pure hue. Hover: bg 16%. Selected (filtering by tag): bg 22% + 1px
`--border-accent`. Editing: inline input with the same box metrics so no reflow occurs.

### 9.25 Avatar

Sizes 20 / 24 / 32 / 40px, radius full. Image, else initials (1–2 chars, `--text-caption` at 20/24,
`--text-body-sm` at 32/40, weight 600, `--fg-primary`) on a deterministic background chosen by
`hash(userId) % 10` from the entity palette at 22% mix. Border: 1px `--border-subtle` (separates
avatar from same-luminance surfaces). Presence ring: 2px in the user's presence color with a 2px
`--surface-1` gap. Stack: overlap 8px, `outline: 2px solid var(--surface-1)`, `+N` overflow chip
after 4. Loading: skeleton circle.

### 9.26 Breadcrumb

Row height 24px, `--text-body-sm`. Items: fg `--fg-muted`, hover fg `--fg-primary` + underline,
last item fg `--fg-primary` weight 500 and non-interactive. Separator: 12px `chevron-right` in
`--fg-disabled` with 4px margins. Overflow: collapse the middle into a `…` dropdown button when
the row exceeds its container, always keeping first and last. Each item is a link with a
`title` for the full name when truncated at 24ch.

### 9.27 Tree item (project/board/layer trees)

Row height 26px, padding-right 8px, `padding-left: calc(var(--nx-space-3) + var(--depth) * 14px)`
(`--tree-item-indent: 14px`). Parts: 16px twisty (chevron, rotates 90° in 120ms), 16px type icon
in the entity color, label `--text-body` truncated with ellipsis, trailing 16px action slot
revealed on hover/focus, trailing count `--text-caption` `--fg-muted`.
States: hover bg `--surface-hover`; selected bg `--surface-selected` + 2px `--border-accent` left
marker + fg `--fg-primary`; focus ring inset (`--focus-ring-offset: -2px`) so it doesn't overlap
neighbours; drag-over-into bg `--accent-soft` + 1px dashed `--border-accent`; drag-over-between:
2px `--border-accent` line at the insertion point with a 6px circular cap at the indent origin;
disabled fg `--fg-disabled`; loading (lazy children) a 12px spinner in the twisty slot.
Indent guides: 1px `--border-subtle` vertical lines at each ancestor indent, drawn only when the
tree has depth ≥ 3.

### 9.28 Table

Header: height 32px, bg `--table-header-bg`, `--text-label` uppercase `--fg-muted`, sticky,
1px `--border-subtle` bottom. Sortable header: hover fg `--fg-secondary`, 12px sort chevron in
a fixed 16px trailing slot (reserved always, so sorting never shifts text).
Row: 28px compact (default) / 36px comfortable, 1px `--border-subtle` bottom, padding-x 12px.
Zebra striping is **not** used (it fights the surface ladder); separation is the hairline rule.
States: hover bg `--table-row-bg-hover`; selected bg `--table-row-bg-selected` + 2px
`--border-accent` left marker; focus-visible row ring inset; disabled fg `--fg-disabled`.
Cell alignment: text left, numbers right with `.nx-tabular`, actions right, checkbox column 32px
fixed. Column resize handle: 8px hit area, 1px `--border-strong` line on hover, live resize with
a 1px `--canvas-guide` drop line. Sticky first column gets a 8px inner shadow when scrolled.
States of the whole table: `loading` (8 skeleton rows), `empty` (§9.31 inside the table body),
`error` (banner in the body area + Retry), `partial` (footer "Showing 200 of 5,120 · Load more"),
`filtered-empty` ("No rows match these filters · Clear filters").
Virtualized above 100 rows (`@tanstack/react-virtual`), row height must stay constant.

### 9.29 Resizable panel

Handle: 4px visual, 10px hit area, transparent at rest; hover shows a 1px `--border-strong` line
after 120ms; active shows a 1.5px `--border-accent` line. Cursor `col-resize` / `row-resize`.
Double-click resets to the default size. Drag is transform-free (real layout resize) but throttled
to rAF and the canvas is told to skip re-render until `pointerup` +1 frame.
Min/max sizes are declared per panel; dragging past min collapses to a 0-width state with a
persistent 24px re-open rail (icon button, tooltip "Show inspector ⌥I").
Sizes persist per user per board in `localStorage` under `nx.panels.<boardId>`.

### 9.30 Scrollbar

Custom, both engines:

```css
.nx-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}
.nx-scroll::-webkit-scrollbar {
  width: var(--scrollbar-size);
  height: var(--scrollbar-size);
}
.nx-scroll::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}
.nx-scroll::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: var(--nx-radius-full);
  border: 3px solid transparent;
  background-clip: padding-box;
}
.nx-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
  background-clip: padding-box;
}
.nx-scroll::-webkit-scrollbar-corner {
  background: transparent;
}
```

Thumb is 4px visible (10px track minus 3px transparent borders). Scroll shadows: a 16px
`linear-gradient` mask at each scrollable edge, applied by a `useScrollShadow` hook that toggles
`data-scroll-start/end` attributes; never a hardcoded shadow div.

### 9.31 Skeleton, spinner, progress, empty state

**Skeleton**: bg `--surface-2`, radius matches the real content's radius, height matches the real
line-height exactly. Shimmer: a 1.4s linear translate of a
`linear-gradient(90deg, transparent, rgb(255 255 255 / .04), transparent)` band, `will-change:
transform`, disabled under reduced motion. Skeletons only appear after 180ms of pending state
(avoids flash) and always match the final layout's box count, never a generic 3-bar placeholder.

**Spinner**: 12 / 16 / 20 / 24px. SVG circle, `stroke-width` 1.5 (2 at 24px), 25% arc,
`stroke-linecap: round`, `animation: spin 720ms linear infinite`, color `currentColor` at 70%
opacity. Never centered alone on a full page — always with a label after 800ms
("Loading board…").

**Progress**: linear bar height 4px (2px inside controls), radius full, track `--surface-2`,
fill `--accent-solid`, determinate width transitions 180ms `--nx-ease-standard`.
Indeterminate: a 30%-wide fill translating -40%→140% over 1.2s linear. Value label
`--text-caption` `.nx-tabular` right-aligned above. Multi-stage runs (tool execution) use a
segmented bar: one segment per stage, completed segments `--status-success-fg` at 60%, current
segment indeterminate, pending `--surface-2`; hovering a segment shows its name and duration.

**Empty state**: centered column, max-width 360px, gap 12px: 24px icon in `--fg-muted` inside a
40px circle of `--surface-2`; title `--text-title` `--fg-primary`; body `--text-body`
`--fg-secondary`; primary action button; optional secondary link. Every empty state must teach —
copy states what this surface is for and the single next action (`00_MASTER.md` §3.1: "empty
states teach"). Variants: `first-run`, `no-results` (offers "Clear filters"), `error` (danger icon,
Retry), `permission` (lock icon, "Ask the project owner for access").

### 9.32 Keyboard-key hint (`<Kbd>`)

Height 18px, min-width 18px, padding 0 5px, radius 3px, bg `--surface-3`, border 1px
`--border-default`, border-bottom-width 2px (the only faux-3D affordance we allow — it is the
universal convention for keys), fg `--fg-secondary`, `--text-caption` weight 500, mono font for
single letters. Sequences render as separate keys with a 3px gap and no `+` glyph; a chord shows
`⌘ K`, a sequence shows `G` `then` `B` where "then" is `--fg-disabled` `--text-caption` lowercase.
Platform mapping is automatic (`⌘/⌥/⇧/⌃` on macOS, `Ctrl/Alt/Shift` elsewhere) via
`packages/ui/src/hooks/usePlatformKeys.ts`.

### 9.33 Split button

Two adjacent segments sharing one border: primary action (padding-x 12px) + 24px chevron segment,
separated by a 1px `--btn-primary-border` divider. Radius applies to the outer corners only.
Hover highlights only the hovered segment. Focus: the two segments are separate tab stops, each
with its own ring; when the chevron is focused, `↓` opens the menu. Disabled disables both.
Loading disables both and shows the spinner in the primary segment.

### 9.34 Toolbar

Height 40px (app header), 36px (panel header), 32px (floating canvas toolbar). Bg `--surface-2`,
1px `--border-subtle` on the edge facing content, no shadow when docked; floating toolbars use
`.nx-elev-4` with radius 8px. Contents: icon buttons at `sm`, separated into groups by a 1px
`--border-subtle` vertical divider with 6px margins. Item gap 2px within a group, 8px between
groups. Overflow: a trailing `…` icon button opening a dropdown that reproduces the hidden items
in the same order. Toggled items use the icon-button `toggled` state. The floating canvas toolbar
hides during pan/zoom (opacity 0, pointer-events none, 75ms) and returns 120ms after motion stops.

### 9.35 Minimap

Fixed 200×140px, bottom-right of the canvas, 16px inset, `.nx-elev-3`, radius 8px, 70% opacity at
rest and 100% on hover (120ms). Contents drawn on canvas by the engine (see
`05_CANVAS_ENGINE.md` §9): nodes as 2×2..6×4 rects in their entity color at 70% opacity, edges
omitted below 1,000 nodes-scale zoom, viewport rectangle 1px `--selection-ring` with a
`--selection-fill` interior. Interactions: click to jump (fly-to, §8.5), drag the viewport rect to
pan (1:1), scroll over the minimap zooms the main camera. Collapsed state: a 32px icon button.
The minimap re-renders at most 20 fps and never during an active drag of nodes.

### 9.36 Status pill (sync/run status)

Height 22px, radius full, padding 0 8px 0 6px, gap 6px, `--text-caption` weight 500,
bg `--surface-2`, border 1px `--border-subtle`. Leading 8px dot in the status color.
States used by N2's save indicator: `saved` (success dot, "Saved"), `saving` (accent dot +
12px spinner, "Saving…"), `offline` (warn dot, "Offline — changes stored locally"),
`error` (danger dot, "Not saved — Retry" with the label acting as a button),
`readonly` (neutral dot + lock icon, "Read-only"). Transitions between states are opacity-only
crossfades of the label (120ms) with the pill width animated via `transform` on an inner span so
no layout shift occurs in the header.

---

## 10. Canvas visual language

This section defines _appearance_. Geometry, culling and the interaction FSM are in
`05_CANVAS_ENGINE.md` §2–§6; node data shapes are in `06_NODE_SYSTEM.md`; edge semantics in
`07_EDGE_SYSTEM.md`.

### 10.1 Node card anatomy, 4 LOD levels

LOD is selected by camera zoom `z`. The thresholds below are the design contract; the engine owns
the hysteresis (±0.03 to prevent flicker at the boundary).

| LOD          | Zoom range        | Representation                                            | Renderer    |
| ------------ | ----------------- | --------------------------------------------------------- | ----------- |
| L3 (full)    | `z ≥ 0.85`        | full DOM card                                             | DOM overlay |
| L2 (compact) | `0.55 ≤ z < 0.85` | DOM card, media and body hidden                           | DOM overlay |
| L1 (glyph)   | `0.25 ≤ z < 0.55` | canvas-painted rounded rect + entity glyph + 1-line title | Canvas2D    |
| L0 (dot)     | `z < 0.25`        | canvas-painted 6×6 rounded square in the entity color     | Canvas2D    |

**L3 — full card.** Default width 240px (`--node-width-default`), height auto (min 72px, max
360px then internal fade-out mask). Structure top→bottom:

```text
┌─ 3px entity accent bar (left edge, full height, radius 8px 0 0 8px) ───────────┐
│ header  26px : 16px entity icon · title (--text-body, 600, 1 line, ellipsis)  │
│                · trailing 16px status/confidence dot                          │
│ media   opt  : 16:9 thumbnail, radius 5px, object-fit cover, 1px inner border │
│ body    opt  : --text-body-sm --fg-secondary, max 3 lines, line-clamp         │
│ meta    18px : source favicon 12px · domain --text-caption --fg-muted         │
│                · time-ago · provenance icon (tool) when tool-created          │
│ footer  opt  : tag chips (max 3 + “+N”), 18px badges                          │
└───────────────────────────────────────────────────────────────────────────────┘
padding 10px 12px; gap 6px; bg --node-bg; border 1px --node-border; radius 8px;
shadow --nx-shadow-1
```

**L2 — compact card.** Same box, media/body/footer removed, height fixed 44px: accent bar, 16px
icon, title (1 line), and one meta line at `--text-caption`. Border and radius unchanged so the
transition L3↔L2 is a content change, not a shape change.

**L1 — glyph.** Canvas-painted: rounded rect (radius 4px in screen space, i.e. `4/z` in world
units), fill `--node-bg`, 1px border `--node-border`, a 10px entity glyph at the left, and the
title truncated to the available width in 11px sans (canvas text, `--fg-secondary`). Titles are
skipped entirely when the painted width would be < 48px screen px.

**L0 — dot.** 6×6 screen-px rounded square (radius 2) in the entity hue at 85% opacity. Selected
dots get a 1px `--selection-ring` outline. No text. Clusters of ≥ 12 dots within 24 screen px are
replaced by a single 12px circle with a tabular count label (`--text-caption`) — the cluster is a
_rendering_ aggregate only; it is not a data grouping and clicking it zooms to fit.

Silhouette rule (colorblind safety): entity glyph shapes at L1/L0 differ per type — `url` link
chevron, `page` document corner, `image` rounded square with a notch, `file` folded corner, `note`
lined square, `person` circle, `identity` circle with a slash, `repo` cube, `toolrun` diamond,
`group` bracket.

### 10.2 Node states

| State                                  | Visual                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rest                                   | as §10.1                                                                                                                                                                |
| hover                                  | border `--node-border-hover`, bg `--node-bg-hover`, plus the hover halo (§10.3); 75ms                                                                                   |
| selected                               | 1.5px border in `--selection-ring` + the selection ring (§10.3); header title fg `--fg-primary`; entity glyph switches to filled                                        |
| multi-selected                         | same as selected; the group gets one shared bounding box (1px dashed `--selection-ring` at 50%) with 8 resize handles only when ≥ 2 nodes and resizing is allowed       |
| focused (keyboard)                     | selection ring + an additional 1px `--nx-accent-200` inner ring so keyboard focus is distinguishable from mouse selection                                               |
| dragging                               | `--node-shadow-drag` (`--nx-shadow-4`), `scale(1.02)`, opacity 0.92; the original position shows a 1px dashed `--border-strong` outline placeholder                     |
| drop-target (link)                     | 2px `--border-accent` + `--accent-soft` fill wash at 10%                                                                                                                |
| loading (unfurl pending)               | title/meta replaced by skeleton lines; accent bar animates a 1.2s indeterminate sweep at 40% opacity                                                                    |
| error (unfurl/tool failed)             | 1px `--status-danger-border`, a 14px danger icon in the header trailing slot, and a one-line reason at `--text-caption` `--status-danger-fg`; the card is never removed |
| stale (data older than the node's TTL) | 1px `--status-warn-border` at 60%, a 12px clock icon in meta, tooltip with `observed_at`                                                                                |
| low-confidence (`confidence < 0.5`)    | the entity accent bar is rendered as a 3px dashed pattern (4px on / 3px off) instead of solid                                                                           |
| collapsed (group child hidden)         | see group frame §10.7                                                                                                                                                   |
| locked                                 | 12px lock icon in meta; border `--border-subtle`; no resize handles                                                                                                     |
| commented                              | 16px comment badge overlapping the top-right corner by 6px, count in `--text-caption`                                                                                   |

Provenance is always visible at L3: tool-created nodes show a 12px tool glyph in the meta row
tinted `--nx-entity-toolrun`; hovering it opens a popover with `tool`, `run_id`, `observed_at`,
`confidence` (`00_MASTER.md` §1, provenance-first).

### 10.3 Selection ring and hover halo

**Selection ring**: 2px stroke in `--selection-ring`, drawn 3px outside the node box, radius
`node-radius + 3`, no fade, no animation (§8.5.6). Rendered in DOM for L2/L3 (a pseudo-element with
`box-shadow: 0 0 0 2px var(--selection-ring)` at a 3px offset spacer) and on canvas for L0/L1.
It is drawn in the canvas overlay layer _above_ edges so it is never occluded.

**Hover halo**: 1px stroke in `color-mix(in oklab, var(--selection-ring) 45%, transparent)` at a
2px offset, fade in 75ms / out 55ms. No blur, no glow, no drop-shadow. On dark surfaces a blurred
"glow" halo is the single most common cheap-looking artifact — it is banned (§14, AP-3).

### 10.4 Connection handles

Four handles per node (N/E/S/W), each 8×8px screen-space, radius full, fill `--surface-4`, border
1.5px `--border-strong`. Visibility: `opacity: 0` at rest; 1 when the node is hovered or selected,
or when a connection drag is in progress anywhere (all valid targets show handles). Hover on a
handle: 10×10, fill `--accent-solid`, border `--nx-accent-200`, cursor `crosshair`.
Handles are hidden entirely below `z < 0.55` (L1/L0) — connections at that zoom are made through
the context menu instead. Invalid target during a drag: handle fill `--status-danger-bg`, border
`--status-danger-border`, cursor `not-allowed`, and a tooltip with the reason.
Hit area is 16×16 (double the visual) via an invisible padded rect.

### 10.5 Edge styles per relationship type

Base: 1.25px stroke at `z = 1` (screen-constant: `lineWidth = 1.25` regardless of zoom, so edges
never become hairlines or ropes), color `--canvas-edge` (`#5A626F`), `lineCap: round`.
Selected edge: 2px, `--selection-ring`. Hovered edge: 1.75px, `--canvas-edge-strong`, plus a 10px
invisible hit stroke. Edge under a running tool: `stroke-dasharray 4 6` with `dashoffset`
animating 0→-10 over 900ms linear (the only looping canvas animation, stopped under reduced
motion and while `data-camera-moving`).

| Relationship                          | Stroke                                                                     | Arrow                                   | Label                                         |
| ------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `references` (default)                | solid 1.25px `--canvas-edge`                                               | single 6px open arrowhead at target     | none                                          |
| `derived_from` (tool output → source) | solid 1.25px, color = source entity hue at 70%                             | 6px filled arrowhead                    | tool name at `--text-caption` when `z ≥ 0.85` |
| `same_as` (identity equivalence)      | solid 1.25px `--nx-entity-identity`                                        | none, but a 6px circle cap at both ends | confidence %                                  |
| `mentions`                            | dashed `2 4` 1.25px `--canvas-edge`                                        | single open arrowhead                   | none                                          |
| `contains` (group/parent)             | solid 1px `--border-strong`                                                | none, T-junction cap at parent          | none                                          |
| `contradicts`                         | solid 1.25px `--nx-danger-400`, with a 8px double-slash marker at midpoint | double arrowhead                        | reason on hover                               |
| `temporal_next`                       | solid 1.25px `--nx-entity-page`, 40% opacity                               | chevron marker at 60% along the path    | timestamp delta                               |
| `custom` (user-defined)               | solid 1.25px, user-chosen entity hue                                       | open arrowhead                          | user label                                    |

Labels: `--text-caption`, fg `--fg-secondary`, on a `--surface-2` rounded rect (radius 3px,
padding 1px 4px) with a 1px `--border-subtle`, drawn only when `z ≥ 0.7` and only if the label box
fits within 60% of the edge length; otherwise labels collapse to a 4px dot that reveals the label
on hover. Bidirectional pairs are drawn as a single edge with arrowheads on both ends, never as
two overlapping curves.

### 10.6 Grid

Dot grid, base spacing 16 world px. Rendered as 1px dots in `--canvas-grid-dot` (6% white).
Adaptive: the engine draws the grid level whose screen spacing lands in [12px, 48px], stepping by
×4 (16 → 64 → 256 → 1024 world px). Two levels are drawn simultaneously during transitions: the
finer level fades out linearly across its last octave (opacity `map(screenSpacing, 12, 20, 0, 1)`).
An optional 1px line grid (`--canvas-grid-line`, 4% white) is available in Settings and draws only
the coarse level. The grid never renders below `z < 0.2`. Origin (0,0) has no special marker —
an infinite canvas has no center and pretending otherwise is noise.

### 10.7 Group frame

Rect with radius 12px (world-space, so it scales), fill `color-mix(in oklab, <groupColor> 5%,
transparent)`, border 1.5px `color-mix(in oklab, <groupColor> 45%, transparent)`.
Title bar: a pill above the top-left corner, offset 6px up, `--surface-2` bg, 1px
`--border-subtle`, `--text-body-sm` weight 500 in the group color, with a 12px collapse chevron.
Selected group: border `--selection-ring` 2px + the standard selection ring around the frame.
Hover: fill goes to 8%. Collapsed: the frame shrinks to a 240×44 card showing the group icon,
title, and a member count badge; contained edges re-route to the collapsed card (see
`07_EDGE_SYSTEM.md` §6). Nested groups darken by an additional 3% fill per level, capped at 2
levels of visual nesting.

### 10.8 Snap guides and alignment

While dragging, alignment guides appear when a dragged node's edge or center is within 4 screen px
of another node's or group's edge/center: 1px line in `--canvas-guide` (`#93AEE6`) extending 24px
beyond the two aligned objects, with 4px perpendicular end caps. Distance labels appear between
equally spaced siblings: `--text-caption` on a `--surface-3` chip with a 1px border, showing the
gap in world px (tabular). Max 4 guides drawn at once (2 horizontal, 2 vertical) — the nearest by
distance. Snapping magnet strength: 4px, released after 8px of continued motion. Grid snap (when
enabled) is 8 world px and shows no guides.

### 10.9 Marquee (rubber-band selection)

Fill `--canvas-marquee-fill` (accent at 10%), border 1px `--selection-ring` at 70%, no radius,
no dash. Drawn in screen space so the border stays exactly 1px. Nodes intersecting the marquee get
a preview state: 1px `--selection-ring` at 50% (not the full selection ring), so the user can see
what will be selected before releasing. Additive marquee (`Shift`) shows a small `+` glyph at the
cursor; subtractive (`Alt`) a `−` glyph.

### 10.10 Cursor set

Custom cursors are 24×24 PNG @1x and 48×48 @2x, authored in `packages/ui/assets/cursors/`, white
fill with a 1px `#08090B` outline and a 12% black drop shadow (this is the one place a shadow is
mandatory — cursors must survive on both node cards and the void).

```css
:root {
  --cursor-default: default;
  --cursor-pan: url('../assets/cursors/pan.png') 12 12, grab;
  --cursor-panning: url('../assets/cursors/panning.png') 12 12, grabbing;
  --cursor-select: default;
  --cursor-marquee: crosshair;
  --cursor-connect: url('../assets/cursors/connect.png') 6 6, crosshair;
  --cursor-connect-invalid: not-allowed;
  --cursor-text: text;
  --cursor-move: move;
  --cursor-resize-ns: ns-resize;
  --cursor-resize-ew: ew-resize;
  --cursor-resize-nesw: nesw-resize;
  --cursor-resize-nwse: nwse-resize;
  --cursor-zoom-in: zoom-in;
  --cursor-zoom-out: zoom-out;
  --cursor-comment: url('../assets/cursors/comment.png') 4 20, cell;
  --cursor-eyedrop: url('../assets/cursors/pick.png') 4 20, copy;
  --cursor-busy: progress;
}
.nx-canvas[data-tool='select'] {
  cursor: var(--cursor-default);
}
.nx-canvas[data-tool='pan'] {
  cursor: var(--cursor-pan);
}
.nx-canvas[data-panning='true'] {
  cursor: var(--cursor-panning);
}
.nx-canvas[data-tool='connect'] {
  cursor: var(--cursor-connect);
}
.nx-canvas[data-tool='comment'] {
  cursor: var(--cursor-comment);
}
```

Native cursors are used wherever a native cursor exists and reads correctly; only `pan`, `panning`,
`connect`, `comment` and `pick` are custom (native `grab`/`crosshair` are ambiguous at our density).
Every custom cursor declares a native fallback after the comma — required, since custom cursors
fail silently in some remote-desktop contexts.

### 10.11 Presence cursors (collaboration)

Pointer: a 14×18px arrow glyph filled with the peer's presence color, 1px `#08090B` outline.
Label: name chip 6px right and 4px below the tip, height 18px, radius 3px 8px 8px 8px, padding
0 6px, bg = presence color, fg = `#08090B` or `#F7F8FA` chosen by computing the contrast ratio at
runtime and picking the higher one. `--text-caption` weight 600.
Presence colors: the ten entity hues (§4.4) assigned by `hash(userId) % 10`, which guarantees both
harmony and equal luminance across peers; collisions are resolved by the sync server assigning the
next free index per room.
Motion: peer cursors interpolate toward their last received position with a 60ms linear tween
(hides jitter without adding perceived lag). Idle > 8s: fade to 40% opacity. Idle > 60s or on
disconnect: fade out over 240ms. Selection by a peer is shown as a 1.5px ring in the peer color at
70% around the node, drawn _inside_ our own selection ring so they never overlap ambiguously.
Peer viewport (when "follow" is off) is not drawn — viewport rectangles from other users are
visual noise; instead the avatar stack in the header shows a "jump to" action.

---

## 11. Iconography

1. **Set:** [Lucide](https://lucide.dev) (ISC license) as the base, consumed via
   `lucide-react` with tree-shaken named imports. Rationale: 1.5px stroke on a 24px grid matches
   our stroke rules natively, permissive license, complete coverage of file/network/graph glyphs.
2. **Custom icons** are authored only when: (a) it is a Raven domain concept with no Lucide
   equivalent (entity glyphs, provenance mark, proposal mark, LOD glyph silhouettes), or (b) it is
   a third-party brand mark (GitHub, Sherlock, SpiderFoot). Custom icons live in
   `packages/ui/src/icons/custom/*.svg`, are drawn on the same 24px grid with 1.5px strokes, and
   are compiled to React components by `pnpm --filter @nexus/ui gen:icons` (SVGR, `currentColor`
   enforced by an SVGO plugin that strips all `fill`/`stroke` literals except `none`).
3. **Sizing** is fixed to 16/20/24 (§7.4). An icon is never rendered at a size outside the grid;
   if a 14px icon is "needed", the layout is wrong.
4. **Optical alignment:** icons are centered in their box, then nudged by the per-icon
   `opticalOffset` recorded in `packages/ui/src/icons/offsets.ts` (default `{x:0,y:0}`; e.g.
   `play: {x: 0.5, y: 0}`, `chevron-right: {x: 0.5, y: 0}`). Text+icon rows align the icon's
   optical center to the text's cap-height center, not the line box center.
5. **Brand marks** keep their own geometry and are the only icons allowed to use fills; they are
   rendered monochrome in `--fg-secondary` except inside a run-detail header where the official
   color is allowed at ≤ 20px.
6. **Animation:** icons never animate except: chevrons rotate on expand/collapse (120ms), the
   spinner, and the checkbox check draw-on. No icon morphing.

---

## 12. Density, alignment and the visual quality checklist

### 12.1 Density rules

1. **The 4px grid is absolute.** Every box dimension, padding, margin and gap is a multiple of 4,
   except the deliberate 2px and 6px values already tokenized (`--nx-space-1`, `--btn-gap`) and
   1px hairlines.
2. **Three densities exist** and are a user setting stored per user:
   `compact` (row 24px, control 28px), `default` (row 28px, control 32px),
   `comfortable` (row 36px, control 38px). They are implemented by overriding four component
   tokens (`--table-row-height`, `--menu-item-height`, `--input-height`, `--btn-height-md`) on
   `[data-density]`; **no component reads the density directly**.
3. **Vertical rhythm:** stacked form fields sit on a 4px rhythm with a 16px gap between fields and
   20px between groups; label→control gap is 4px; control→helper gap is 4px.
4. **Panel padding is 16px**, dialog padding 24px, popover padding 12px, menu padding 4px. There
   are no other panel paddings.
5. **Maximum information density before a break is required:** a panel may show at most 12 fields
   before it must be split into collapsible sections; a table at most 9 columns before column
   management (show/hide) becomes mandatory.
6. **Number formatting:** counts use thin-space grouping (`1 240`), durations use `1.2s` / `340ms`,
   bytes use IEC (`4.2 MiB`), timestamps are relative under 7 days (`3h ago`) with the absolute
   ISO-8601 value in the tooltip. Confidence is a percentage with no decimals.
7. **Truncation before wrapping** everywhere except note bodies and error messages.

### 12.2 Alignment grid

- App shell is a 3-column layout: left rail 48px (fixed), left panel 240–420px (resizable,
  default 280px), canvas (flex), right inspector 280–520px (resizable, default 320px).
- All panel content aligns to a 16px inner margin; icons align to a 20px gutter; labels in a form
  align left (no right-aligned label columns — they break under Cyrillic length variance).
- Header height 40px, status bar height 24px, both flush with the panels.
- Everything that repeats vertically (rows, list items, tree items) shares the same left inset so
  a vertical line can be traced through all icons.

### 12.3 Visual quality checklist (quality gate item 3)

A phase PR must include this checklist, ticked, in the body. Each item is objectively checkable.

1. Zero literal colors/spacings/durations in the diff (`pnpm lint:tokens` green).
2. Every new interactive element has rest/hover/active/focus-visible/disabled states implemented
   and a Storybook story per state.
3. Focus ring is visible on every focusable element on `--surface-0` through `--surface-4`.
4. `axe-core` reports zero violations on every new route/dialog (CI).
5. Contrast test (`contrast.test.ts`) green, including any newly added token.
6. Every async surface has loading, empty, and error variants with real copy (no "Something went
   wrong").
7. No layout shift when data loads: skeletons match final box geometry (verified by a Playwright
   CLS assertion < 0.02 on the surface).
8. `prefers-reduced-motion` snapshot for the surface shows no animation.
9. Cyrillic fixture (`ru-RU`) renders without overflow or clipping.
10. Elevation is achieved with `.nx-elev-*` only; no ad-hoc `box-shadow`.
11. Icons are from the 16/20/24 grid and inherit `currentColor`.
12. Text at 12px or below is never `--fg-muted` on `--surface-4`.
13. Nothing loops or pulses except the three approved cases (§8.3).
14. At most 3 accent-solid elements per viewport (§4.2).
15. Visual snapshots reviewed and committed at 1× and 2× DPR, dark theme.

---

## 13. Anti-patterns gallery

Twelve concrete failure modes that make machine-generated interfaces look cheap, with the
replacing rule. These are review-blocking.

| #     | Anti-pattern                                                                                                  | Why it looks cheap                                                                       | The rule that replaces it                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| AP-1  | Purple→blue gradient headers, gradient buttons, gradient text                                                 | Signals template; gradients band badly on dark OLED                                      | Flat fills only. The one gradient allowed in the product is the 16px scroll-shadow mask and the skeleton shimmer band          |
| AP-2  | Saturated neon accents (`#00E5FF`, `#7C3AED` at full chroma)                                                  | Vibrates against dark backgrounds, destroys the entity palette's hierarchy               | Chroma ceiling 0.12 in OKLCH for any fill larger than 24×24px; one accent family only (§4.2)                                   |
| AP-3  | Glow: `box-shadow: 0 0 20px <accent>` on hover/focus/selection                                                | Reads as a game UI; blurs the 1px structure the whole system depends on                  | Selection = 2px hard ring; hover = 1px 45% ring; focus = 2px ring at 2px offset. Zero blur radius on any accent shadow (§10.3) |
| AP-4  | Frosted glass everywhere (`backdrop-filter: blur(20px)` on panels, cards, headers)                            | Destroys text contrast, costs 3–6ms/frame during canvas interaction                      | Blur is allowed on exactly one surface: the modal dialog backdrop, 6px (§5.3.2)                                                |
| AP-5  | Giant soft drop shadows on flat cards (`0 10px 40px rgba(0,0,0,.5)`)                                          | On dark backgrounds this is invisible smudge, not depth                                  | Elevation = luminance step + hairline border; shadows only at level 3–4 and ≤ 44px blur (§5)                                   |
| AP-6  | Emoji as icons (🚀, ⚡, 🔥) in product UI                                                                     | Platform-dependent rendering, no color control, unprofessional in an evidence tool       | Lucide stroke icons at 16/20/24 with `currentColor` (§11)                                                                      |
| AP-7  | Everything rounded to 16–24px "pill" corners                                                                  | Consumer-app look, wastes pixels at dense sizes, breaks nesting math                     | Radius by role: 5px controls, 8px cards/menus, 12px dialogs, full only for pills/avatars (§7.2)                                |
| AP-8  | Uniform 24px padding everywhere and 20px gaps between everything                                              | Kills density; the UI shows 40% of what an analyst needs                                 | Padding by container role (§12.1.4); 4px grid; three densities                                                                 |
| AP-9  | Animating everything on mount (staggered fade-in lists, spring cards)                                         | Every navigation costs 400ms of perceived lag; feels like a demo                         | Motion only for causality (§8.3); lists appear instantly; only ≤20 new canvas nodes get a 120ms entrance                       |
| AP-10 | Low-contrast grey-on-grey text (`#666` on `#1a1a1a`) to look "sleek"                                          | 2.4:1, unreadable, fails N6                                                              | Every text token proved ≥ 4.5:1 in §4.5 and re-proved by `contrast.test.ts` on every commit                                    |
| AP-11 | Fake states: no empty state, spinner centered on a blank page, `alert()` for errors, no disabled reasoning    | The moment real data is missing, the product falls apart                                 | §9.1 universal state contract + §9.31 empty states + `03_UX.md` §12 error copy (what happened / why / what to do)              |
| AP-12 | Inconsistent icon weights and sizes mixed in one row (filled + stroke, 14px + 18px), text baselines unaligned | The single strongest "AI-built" tell; the eye reads misalignment before it reads content | 16/20/24 grid, 1.5px stroke, `offsets.ts` optical nudges, cap-height baseline alignment (§7.4, §11.4)                          |

Additional standing bans, no table needed: no drop-caps, no letterspaced uppercase body text, no
"card in a card in a card", no centered body text in panels, no full-width primary buttons in
desktop dialogs, no more than two font weights in one component, no `!important` outside the
reduced-motion block.

---

## 14. Implementation checklist for P1

`00_MASTER.md` §7 puts tokens in Phase 1. P1 is complete for this document when:

1. `packages/ui/tokens/{primitives,semantic.dark,components,index}.css` exist with the exact
   content of §3 (semantic.light.css exists with the P16 stub values and is not imported yet).
2. `packages/ui/tokens/tokens.ts` exports `primitives`, `Theme`, `EntityKind`, `CanvasPalette`,
   `readCanvasPalette`, `applyTheme`.
3. `packages/config/tailwind/preset.ts` is generated and CI verifies regeneration produces no diff.
4. `contrast.test.ts` passes with every pair in §4.5.
5. The ESLint rule `@nexus/tokens-only` is active on `packages/ui` and `apps/web`.
6. Fonts are self-hosted, subset (latin + latin-ext + cyrillic), preloaded.
7. `.nx-elev-1..4`, `.nx-scroll`, `.nx-tabular` utilities exist.
8. Storybook runs with a dark canvas and a state-matrix addon; Button, Input, Menu, Dialog, Toast,
   Tooltip, Table and Empty State are implemented with all states from §9.
9. Playwright visual baselines exist for the §9 components at 1× and 2× DPR.

---

## Open risks

1. **OKLCH → sRGB clipping on wide-gamut displays.** Our accent and entity hues at chroma ≤ 0.12
   are inside sRGB, but the browser may render them in Display-P3 on capable screens, making them
   slightly more saturated than the hex fallbacks used in the contrast proof. Mitigation: the
   contrast test runs against the sRGB hex values (the worst case for a _dark_ UI is actually the
   less-saturated one, so the proof stays conservative); if a P3 mismatch is reported, wrap the
   ramp in `@media (color-gamut: p3)` with chroma reduced by 8%. Owner: P16 a11y audit.
2. **`color-mix()` in `getComputedStyle` output.** Browsers resolve `color-mix()` to `oklab(...)`
   or `color(srgb ...)` strings; `readCanvasPalette` hands these directly to Canvas2D
   `fillStyle`. Chromium/WebKit/Firefox all accept those color syntaxes today, but this is the one
   place where a browser regression would silently blank the canvas. Mitigation: `readCanvasPalette`
   validates each value by assigning it to an offscreen `ctx.fillStyle` and comparing the readback;
   on mismatch it falls back to the literal hex from `primitives` and reports to telemetry.
3. **Density × Cyrillic.** `compact` density (24px rows, 11px labels) plus Russian strings ~25%
   longer than English may force truncation on labels that must stay readable. Unresolved until
   real copy exists; mitigation is the `ru-RU` fixture in the visual checklist (§12.3.9) and, if
   it fails, raising `compact` label size to 12px rather than truncating.
4. **Custom cursors under remote desktop / Wayland fractional scaling.** PNG cursors can render at
   the wrong size. Fallbacks are declared, but the `connect` cursor's fallback (`crosshair`) is
   ambiguous with marquee. Accepted risk; if reported, switch `connect` to an in-canvas painted
   cursor glyph (the engine already draws in screen space).
5. **Entity palette exhaustion.** Ten hues at equal lightness is the maximum that stays
   distinguishable. Plugins (`17_PLUGIN_SDK.md`) that introduce new node types must map onto an
   existing hue plus a distinct icon; they cannot request a new color. If the type count grows past
   ~14 in practice, the visual taxonomy must switch from hue-per-type to icon-per-type with hue
   reserved for _category_ (5 categories). Decision deferred to whoever writes the plugin type
   registry, but the constraint is stated here so it is not discovered late.
6. **`font-size` in px vs. user browser font settings.** We chose px for canvas/DOM text parity;
   users who enlarge the default browser font will not see UI text scale (browser _zoom_ still
   works). Mitigated by the in-app font-scale setting (§6.2). This is a deliberate accessibility
   trade-off and must be re-reviewed in the P16 a11y audit.
