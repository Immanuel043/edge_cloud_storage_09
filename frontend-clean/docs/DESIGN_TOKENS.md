# Design Tokens — "Signal"

**Last updated:** 2026-04-15
**Status:** ground-truth for the 2026 frontend UI redesign. Paste these values directly into `tailwind.config.js` and `src/index.css`.

---

## 1. Aesthetic direction

**Name:** Signal.
**One-liner:** High-trust precision for privacy-conscious storage — the serene confidence of a well-engineered security product, not another purple-gradient SaaS.

**Why this direction for this product:**
- The users are SME admins and privacy-conscious individuals. They need to *trust* the app on sight. Loud gradients, playful shapes, and marketing-page flourishes undermine that.
- It's a file-storage product — the screen is full of **numbers, paths, sizes, dates**. Those must feel crafted, not after-thoughts. That's why mono gets a real place in the type scale.
- We already shipped a gradient bento-grid AuthPage. Signal **keeps** that gradient as a signature — but treats it like a seal of authority (used on identity, upgrade, success). Everywhere else is cool neutrals with indigo-tinted hairlines. The gradient stays rare, which is why it stays powerful.
- Dark mode is where privacy software lives. It's designed first; light mode is a faithful inversion.

**Signature details that separate Signal from generic SaaS:**
1. **Indigo-tinted borders** — 1px hairlines at low opacity with a faint indigo cast. Makes cards feel structured, not just "rounded gray rectangles."
2. **Asymmetric radii on hero cards** — `rounded-t-2xl rounded-b-lg` on Pricing/Onboarding cards. Small choice, high character.
3. **Mono for all technical metadata** — file sizes, hashes, timestamps, paths. Never the body sans.
4. **Gradient is a seal, not a default** — only on identity moments, upgrade CTAs, and one-off success states. All other buttons are solid indigo or surface.

**Deferred to Phase 5+ polish (not foundation work):**
- Subtle noise/grain overlay on elevated surfaces (`url(noise.svg)` at ~3% opacity). Kept out of Phase 1 so the token-and-primitive scaffolding ships clean; revisit once the primitives are proven.

---

## 2. Color tokens

All colors are declared as CSS variables on `:root` and overridden on `.dark`. Tailwind reads them via `theme.extend.colors` using the `<alpha-value>` pattern so opacity utilities (`bg-primary/50`) still work.

### Light mode (`:root`)

```css
:root {
  /* Base surfaces */
  --bg:            249 250 252;   /* #f9fafb — page background */
  --surface:       255 255 255;   /* #ffffff — card surface */
  --surface-muted: 244 245 249;   /* #f4f5f9 — inset surfaces, table stripes */
  --surface-sunken: 239 241 246;  /* #eff1f6 — deeper sunken panels */

  /* Text */
  --fg:            15 23 42;      /* #0f172a — primary text */
  --fg-muted:      71 85 105;     /* #475569 — secondary text */
  --fg-subtle:     100 116 139;   /* #64748b — tertiary / captions */
  --fg-on-primary: 255 255 255;   /* text on solid primary */

  /* Borders (indigo-tinted, not neutral) */
  --border:        226 229 239;   /* #e2e5ef — 1px hairline default */
  --border-strong: 203 208 224;   /* #cbd0e0 — emphasized divider */
  --border-focus:  99 102 241;    /* indigo-500, used for focus rings */

  /* Brand / identity */
  --primary:       79 70 229;     /* #4f46e5 — indigo-600, the workhorse */
  --primary-hover: 67 56 202;     /* #4338ca — indigo-700 */
  --primary-soft:  238 238 255;   /* #eeeeff — primary-tinted wash */
  --primary-fg:    255 255 255;

  /* Accent — used ONLY inside the Signal gradient */
  --accent:        139 92 246;    /* #8b5cf6 — violet-500 */

  /* Semantic */
  --success:       5 150 105;     /* #059669 — emerald-600, not eye-searing */
  --success-soft:  220 252 231;   /* bg tint */
  --warning:       202 138 4;     /* #ca8a04 — amber-600 */
  --warning-soft:  254 249 195;
  --danger:        220 38 38;     /* #dc2626 — red-600 */
  --danger-soft:   254 226 226;
  --info:          2 132 199;     /* #0284c7 — sky-600 */
  --info-soft:     224 242 254;
}
```

### Dark mode (`.dark`)

```css
.dark {
  --bg:            11 14 23;      /* #0b0e17 — near-black with indigo hint */
  --surface:       18 22 33;      /* #121621 — card surface */
  --surface-muted: 24 29 43;      /* #181d2b */
  --surface-sunken: 14 17 26;     /* #0e111a */

  --fg:            241 245 249;   /* #f1f5f9 — primary text */
  --fg-muted:      148 163 184;   /* #94a3b8 */
  --fg-subtle:     100 116 139;
  --fg-on-primary: 255 255 255;

  --border:        38 44 62;      /* #262c3e */
  --border-strong: 55 64 85;      /* #374055 */
  --border-focus:  129 140 248;   /* indigo-400, brighter for dark */

  --primary:       129 140 248;   /* #818cf8 — indigo-400 reads cleanly in dark */
  --primary-hover: 165 180 252;   /* #a5b4fc */
  --primary-soft:  30 27 75;      /* #1e1b4b — indigo-950 wash */
  --primary-fg:    11 14 23;      /* near-black */

  --accent:        167 139 250;   /* violet-400 */

  --success:       52 211 153;    /* emerald-400 */
  --success-soft:  6 78 59;
  --warning:       250 204 21;    /* yellow-400 */
  --warning-soft:  66 32 6;
  --danger:        248 113 113;   /* red-400 */
  --danger-soft:   69 10 10;
  --info:          56 189 248;    /* sky-400 */
  --info-soft:     8 47 73;
}
```

### Signal gradient (the seal)

```css
/* Used ONLY on: auth hero, upgrade CTAs, success toasts, plan-tier "recommended" chip */
--signal-gradient:
  linear-gradient(135deg,
    rgb(79 70 229) 0%,      /* indigo-600 */
    rgb(99 102 241) 35%,    /* indigo-500 */
    rgb(139 92 246) 100%);  /* violet-500 */

/* Dark-mode variant (brighter anchors, reads better against #0b0e17) */
.dark {
  --signal-gradient:
    linear-gradient(135deg,
      rgb(99 102 241) 0%,
      rgb(129 140 248) 40%,
      rgb(167 139 250) 100%);
}
```

---

## 3. Typography

### Font families

```css
--font-sans: 'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif;
--font-display: 'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif;
--font-mono: 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

/* Enable Inter's stylistic sets for the distinctive character.
   cv11 = single-story 'a'; ss03 = straight-sided 'l'; cv05 = tighter '@'. */
html, body {
  font-family: var(--font-sans);
  font-feature-settings: 'cv11', 'ss03', 'cv05', 'ss01';
}
```

Install:
- `@fontsource-variable/inter` → imports Inter Variable
- `@fontsource-variable/jetbrains-mono` → imports JetBrains Mono Variable (for file sizes, hashes, paths, dates, counts)

### Type scale

Use these exact values in `tailwind.config.js > theme.extend.fontSize`.

| Token | Size | Line-height | Tracking | Weight | Use |
|---|---|---|---|---|---|
| `display-2xl` | `4.5rem (72px)` | `1` | `-0.04em` | 700 | Auth hero only |
| `display-xl` | `3.75rem (60px)` | `1.05` | `-0.035em` | 700 | Pricing page hero, marketing moments |
| `display-lg` | `3rem (48px)` | `1.1` | `-0.03em` | 700 | Empty-state hero, landing cards |
| `h1` | `2.25rem (36px)` | `1.15` | `-0.025em` | 600 | Page title (Dashboard > Files) |
| `h2` | `1.75rem (28px)` | `1.2` | `-0.02em` | 600 | Section heading |
| `h3` | `1.25rem (20px)` | `1.3` | `-0.015em` | 600 | Card title |
| `h4` | `1rem (16px)` | `1.4` | `-0.01em` | 600 | Subsection, list group title |
| `body-lg` | `1.0625rem (17px)` | `1.55` | `0` | 400 | Marketing body, modal body |
| `body` | `0.9375rem (15px)` | `1.55` | `0` | 400 | Default UI body |
| `body-sm` | `0.8125rem (13px)` | `1.5` | `0` | 400 | Table rows, dense UI |
| `caption` | `0.75rem (12px)` | `1.4` | `0.01em` | 500 | Labels, hints, metadata headers |
| `overline` | `0.6875rem (11px)` | `1.3` | `0.08em` (uppercase) | 600 | Section eyebrows, category tags |
| `mono-sm` | `0.8125rem (13px)` | `1.5` | `0` | 450 | File sizes, hashes, paths, counts |
| `mono-xs` | `0.6875rem (11px)` | `1.4` | `0` | 450 | Timestamps, inline IDs |

**Rule of thumb:** body copy defaults to `body` (15px), never 16px default. The 15/13 pair reads denser and more "engineered" than the standard 16/14 — which matches Signal's tone.

---

## 4. Radius scale

```js
// tailwind.config.js > theme.extend.borderRadius
{
  'none': '0',
  'xs':   '2px',
  'sm':   '4px',
  'md':   '6px',     // default for small UI (chips, inputs)
  'lg':   '10px',    // cards, buttons
  'xl':   '14px',    // modals, large cards
  '2xl':  '20px',    // hero cards, pricing tiers
  '3xl':  '28px',    // auth bento tiles
  'full': '9999px',
}
```

**Signature move:** hero cards use **asymmetric** radii — `rounded-t-2xl rounded-b-lg` — to feel crafted. Apply to PricingCard, EmptyState hero, AuthPage side panel.

---

## 5. Elevation scale (shadows)

Each elevation is a blend of a **sharp low shadow** (ambient occlusion) and a **soft high shadow** (diffuse light). This reads more physical than Material's single-blur defaults.

```js
// theme.extend.boxShadow
{
  'none': 'none',
  'xs':   '0 1px 2px rgb(15 23 42 / 0.04)',
  'sm':   '0 1px 2px rgb(15 23 42 / 0.04), 0 2px 4px rgb(15 23 42 / 0.03)',
  'md':   '0 2px 4px rgb(15 23 42 / 0.05), 0 4px 12px rgb(15 23 42 / 0.04)',
  'lg':   '0 4px 8px rgb(15 23 42 / 0.06), 0 12px 24px rgb(15 23 42 / 0.05)',
  'xl':   '0 8px 16px rgb(15 23 42 / 0.08), 0 24px 48px rgb(15 23 42 / 0.06)',
  '2xl':  '0 16px 32px rgb(15 23 42 / 0.10), 0 40px 80px rgb(15 23 42 / 0.08)',
  'focus': '0 0 0 3px rgb(99 102 241 / 0.35)',  // focus ring
  'glow':  '0 0 0 1px rgb(99 102 241 / 0.30), 0 8px 32px rgb(99 102 241 / 0.20)',  // hero CTA
}
```

Dark-mode override: drop the alpha by half on each shadow — dark surfaces don't need as much contrast to read as "elevated."

---

## 6. Motion tokens

```js
// theme.extend.transitionDuration / transitionTimingFunction
durations: {
  'micro':  '100ms',   // hover tint, active press
  'fast':   '160ms',   // button feedback, checkbox toggle
  'base':   '220ms',   // modal fade, dropdown open
  'slow':   '320ms',   // drawer slide, page transition
  'hero':   '480ms',   // landing-page reveals (AuthPage, PricingPage stagger)
}

easings: {
  'out-expo':   'cubic-bezier(0.16, 1, 0.3, 1)',       // enter (default)
  'in-quad':    'cubic-bezier(0.55, 0.08, 0.68, 0.53)',// exit
  'spring':     'cubic-bezier(0.34, 1.56, 0.64, 1)',   // playful feedback (added-to-favorites, etc.)
  'linear':     'linear',                              // progress bars only
}
```

All animations respect `prefers-reduced-motion: reduce` via the existing `@media` block in `index.css`.

---

## 7. Spacing discipline

Keep Tailwind's default spacing scale — **do not customize**. The problem wasn't the scale, it was inconsistent use. Add two rules codified in the primitive layer:

- **Page padding** is always `px-6 md:px-8` on the AppShell content wrapper. No page picks its own.
- **Vertical rhythm** between sections is `space-y-8` (32px) at the page level, `space-y-6` (24px) inside cards, `space-y-4` (16px) inside form groups. Nothing else.

---

## 7a. Public-share-page gradient rule

The share viewer (`ShareViewer`, `ShareBundleViewer`) is the only surface an unauthenticated stranger sees. The gradient-as-seal discipline from §1 still applies, with these specifics:

1. **Top stripe:** a 4px full-width `--signal-gradient` stripe runs across the very top of the page. This is the only always-on gradient surface on the share page. It acts as a branded seal — the same role the stripe plays on the upload-success toast (§8.1), rotated 90°. Below it sits a neutral header (`bg-surface`, border-bottom `border-border`) with the brand lockup, file name, and file-type icon.
2. **Primary CTA is solid, not gradient.** The Download / Open button uses `variant="primary"` (solid indigo). Rationale: Signal gradient is an *authority* seal; the CTA is a *utility* action. Keeping them visually separate reinforces hierarchy. Using the gradient on both would make the button look like decoration.
3. **Password-unlock button uses the gradient.** If the share is password-protected, the single `Unlock` button *is* an identity moment (same category as AuthPage login) — it gets the gradient. This is the one exception on share pages.
4. **Everything else is neutral surface.** File metadata (size, expiry, download counter) is `bg-surface-muted` chips with `font-mono` values. No gradient background on the card itself. No gradient on secondary buttons (Copy, Email, QR).
5. **Light/dark behavior matches the rest of the app.** The top stripe swaps to its dark-mode gradient variant via the `.dark --signal-gradient` override from §2; no special casing.

Apply rule to: `ShareViewer.tsx`, `ShareBundleViewer.tsx`. Out of scope for this rule: the admin-side `ShareOptionsModal` (that's an authenticated modal — follows the hero-moment rule in §8.3).

---

## 7b. Dark-mode boot behavior (no FOUC)

The existing `ThemeContext` initializes `darkMode` to `false` on render and only reads `localStorage` in a post-mount `useEffect`, which guarantees a flash-of-light on every load for users who saved dark. Phase 1 fixes this as foundation work — not a polish concern.

**Fix has three parts:**

### Part 1 — Inline boot script in `index.html`
Runs synchronously before React mounts. Reads stored preference; falls back to `prefers-color-scheme`. Applies `.dark` class on `<html>` *before* first paint.

```html
<!-- inside <head>, BEFORE any CSS or script tag that depends on it -->
<script>
  (function () {
    try {
      var stored = localStorage.getItem('theme');
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var dark = stored === 'dark' || (stored == null && prefersDark);
      if (dark) document.documentElement.classList.add('dark');
    } catch (_) { /* ignore, default to light */ }
  })();
</script>
```

### Part 2 — Rewrite `src/contexts/ThemeContext.tsx`
- Initialize `darkMode` from `document.documentElement.classList.contains('dark')` — the boot script has already set the class, so React's first render matches the DOM.
- Only write to `localStorage` on **user-initiated** toggle. On first load we must not auto-write `'light'` (that clobbers the "never chose, follow system" state).
- Subscribe to `window.matchMedia('(prefers-color-scheme: dark)')` change events so users who haven't explicitly toggled track their system setting live.
- Keep the public API unchanged: `useTheme() → { darkMode, toggleTheme }`. No consumer changes.

### Part 3 — CSS variable swap (not utility class ternaries)
Because all colors are now CSS variables (§2), the app no longer needs per-component `darkMode ? 'bg-gray-900' : 'bg-white'` ternaries. Components write `bg-surface` once; the variable resolves differently on `:root` vs `:root.dark`. This both eliminates FOUC-between-renders and shrinks the JSX.

**Phase 1 deliverable:** index.html script, rewritten ThemeContext, and a dark-mode smoke test in `ThemeContext.test.tsx` that verifies (a) first render matches the DOM class, (b) toggling writes localStorage, (c) system-change propagates when no localStorage value exists.

---

## 8. Hero moments (three concrete sketches)

These are the "one-thing-someone-will-remember" details. Execute them precisely.

### 8.1 Upload-success toast

**Position:** bottom-right, 24px offset, stacks upward.
**Size:** 360px wide, auto height, `rounded-xl`, `shadow-xl`.
**Surface:** dark-mode uses `var(--surface)` with `--signal-gradient` as a 2px left accent stripe. Light mode: white surface, same 2px gradient stripe.
**Layout:**
```
┌──┬────────────────────────────────────────┐
│▓▓│ ✓  invoice-2026-Q1.pdf                │
│▓▓│    2.4 MB · uploaded to /Documents    │
│▓▓│                                        │
│▓▓│ [Open] [Copy link]            [×]     │
└──┴────────────────────────────────────────┘
   ↑ 2px signal-gradient stripe
```
- Checkmark icon (`lucide:check`) in a 24px circle, filled with `success-soft`, stroke `success`.
- Filename in `body` weight 500. Metadata in `mono-xs` color `fg-subtle`. The "uploaded to /Documents" path is mono — makes it feel technical and trustworthy.
- Animation: slides in from right (220ms `out-expo`), left stripe fills from bottom to top in 480ms `out-expo` (1 second total impression), auto-dismisses at 5s unless hovered.

### 8.2 Empty file grid

**Trigger:** user lands on an empty folder / Favorites with nothing / Trash is empty.
**Layout:** centered, 480px max-width, `py-16` vertical padding.
**Anatomy:**
```
         ┌──────────────────┐
         │                  │  ← 88×88 squircle surface with
         │     [icon]       │     1px indigo-tinted border,
         │                  │     asymmetric radius (tl+br larger)
         └──────────────────┘
                                 ← h2 headline (28px, -0.02em tracking)
    No files here yet
                                 ← body-lg, fg-muted, max-w-sm
    Drop files anywhere on this
    page, or use the button above.

    ┌──────────────────────┐    ← secondary button (ghost variant)
    │  Learn about folders │       with `lucide:book-open` icon
    └──────────────────────┘
```
- The icon container uses `rounded-tl-2xl rounded-br-2xl rounded-tr-md rounded-bl-md` — asymmetric. Icon inside is `lucide:folder-open`, stroke `primary`, 32px.
- Below the icon squircle: a **faint signal-gradient glow** behind it, 160px diameter, `blur-3xl`, 15% opacity. Only in dark mode — in light mode, skip the glow.
- Copy is quiet, not apologetic. "No files here yet." not "It's empty here! 😔".
- Staggered entry: icon (0ms) → headline (60ms delay) → body (120ms delay) → CTA (180ms delay). Each fades up 8px with `fade-up` animation.

### 8.3 Share-link reveal card

**Trigger:** user generates a share link via ShareOptionsModal → modal transitions to "link ready" state.
**Design:** the entire modal content animates in place (same modal, new content) so the user feels continuity.
**Anatomy:**
```
┌────────────────────────────────────────────────┐
│  LINK READY                              [×]   │  ← overline weight
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │ 🔗  https://edge.cloud/s/k3j9-xq7m-2p1a │ │  ← mono-sm, full link,
│  │                                  [Copy] │ │     [Copy] button right-aligned,
│  └──────────────────────────────────────────┘ │     animates a flash of primary-soft
│                                                │     on copy
│  Expires Mar 12, 2026 · 5 downloads left      │  ← caption, fg-muted, mono for date
│                                                │
│  ┌─────────────┐  ┌───────────┐  ┌─────────┐ │
│  │ Open link ↗ │  │ QR code ▤ │  │ Email ✉ │ │  ← three ghost buttons, equal width
│  └─────────────┘  └───────────┘  └─────────┘ │
│                                                │
│  ──────────────────────────────────────────── │  ← hairline
│                                                │
│  Security notice                      [Manage]│  ← overline left, link right
│  Anyone with this link can view the file.     │  ← body-sm, fg-muted
│                                                │
└────────────────────────────────────────────────┘
```
- **The link row is the hero:** boxed in `surface-muted`, 1px hairline, `rounded-lg`. Link text is `mono-sm`. Copy button is primary outline. On click, the row briefly flashes `primary-soft` (220ms `out-expo`) — satisfying tactile feedback.
- Three action buttons below are equal-width ghost variants. Icons right-aligned.
- Animation: when the modal transitions from "generating" to "ready," the whole content block does a 280ms fade+rise (8px). The link row's box does a separate 400ms `out-expo` scale from 0.98 → 1.0 so it "clicks into place."

---

## 9. Do-not-do list

These are the specific failure modes that would turn Signal into generic SaaS. Reject them in code review.

- ❌ **Purple gradient on every button.** Primary buttons are solid indigo (`bg-primary`). The gradient is only on identity/upgrade/success surfaces.
- ❌ **System-font fallback as the primary body.** The Inter Variable import is load-blocking; until it loads we're on `-apple-system` — that's fine for 200ms, not as a permanent state. Preload the variable font file.
- ❌ **16px body copy.** Default is 15px. Use 17px (`body-lg`) only for marketing / modal descriptions.
- ❌ **Drop shadows with single large blur** (Material default). Always use the layered sharp+soft from §5.
- ❌ **Neutral gray borders.** Borders are indigo-tinted (`--border`) — never `slate-200` direct.
- ❌ **Body sans for file sizes / paths / hashes / timestamps.** Those are mono, always.
- ❌ **Cute copy.** "Oopsie!" / "No files yet — let's upload some! 🎉" is wrong tone. Signal is quiet and competent.

---

## 10. Snippet to paste into `tailwind.config.js`

```js
// Minimum paste-ready block. Full config in Phase 1.
theme: {
  extend: {
    colors: {
      bg:                'rgb(var(--bg) / <alpha-value>)',
      surface:           'rgb(var(--surface) / <alpha-value>)',
      'surface-muted':   'rgb(var(--surface-muted) / <alpha-value>)',
      'surface-sunken':  'rgb(var(--surface-sunken) / <alpha-value>)',
      fg:                'rgb(var(--fg) / <alpha-value>)',
      'fg-muted':        'rgb(var(--fg-muted) / <alpha-value>)',
      'fg-subtle':       'rgb(var(--fg-subtle) / <alpha-value>)',
      'fg-on-primary':   'rgb(var(--fg-on-primary) / <alpha-value>)',
      border:            'rgb(var(--border) / <alpha-value>)',
      'border-strong':   'rgb(var(--border-strong) / <alpha-value>)',
      'border-focus':    'rgb(var(--border-focus) / <alpha-value>)',
      primary:           'rgb(var(--primary) / <alpha-value>)',
      'primary-hover':   'rgb(var(--primary-hover) / <alpha-value>)',
      'primary-soft':    'rgb(var(--primary-soft) / <alpha-value>)',
      'primary-fg':      'rgb(var(--primary-fg) / <alpha-value>)',
      accent:            'rgb(var(--accent) / <alpha-value>)',
      success:           'rgb(var(--success) / <alpha-value>)',
      'success-soft':    'rgb(var(--success-soft) / <alpha-value>)',
      warning:           'rgb(var(--warning) / <alpha-value>)',
      'warning-soft':    'rgb(var(--warning-soft) / <alpha-value>)',
      danger:            'rgb(var(--danger) / <alpha-value>)',
      'danger-soft':     'rgb(var(--danger-soft) / <alpha-value>)',
      info:              'rgb(var(--info) / <alpha-value>)',
      'info-soft':       'rgb(var(--info-soft) / <alpha-value>)',
    },
    backgroundImage: {
      'signal-gradient': 'var(--signal-gradient)',
    },
    // fontFamily / fontSize / borderRadius / boxShadow / transitionDuration / transitionTimingFunction
    // from sections 3, 4, 5, 6 — inlined in the actual config.
  },
}
```

---

## 11. QA checklist per page (used in Phase 5 sweep)

- [ ] Light + dark both render; no hardcoded `bg-white` / `bg-gray-*` / `text-slate-*` literals.
- [ ] Body copy uses 15px `body`, not 16px default.
- [ ] All technical metadata (size, path, hash, timestamp, count) uses `font-mono`.
- [ ] Borders use `border-border` token, not `border-gray-200`.
- [ ] Focus ring visible on keyboard nav (`shadow-focus` applied via primitive).
- [ ] Animations disabled under `prefers-reduced-motion`.
- [ ] No generic AI-slop copy ("Oopsie!", excessive emoji, exclamation marks).
- [ ] Gradient used only on: AuthPage hero, upgrade CTAs (PricingPage recommended tier + upgrade banner), success toasts, hero-moment empty states in dark mode.
