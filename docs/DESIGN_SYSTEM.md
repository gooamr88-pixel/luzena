# Design system

Two themes share one codebase: the public website (light, warm, built on the logo) and the
owner dashboard (light, dense, neutral). Tokens live at the top of `src/styles/main.css` and
`src/styles/dashboard.css` in `@theme` blocks; components are classes in `@layer components`.

## Where the look comes from

Everything is derived from the logo file the client supplied (`content/media/logo.svg`,
exported from their PDF with the text converted to outlines):

| In the logo | Value | Used on the site as |
|---|---|---|
| Wordmark "LUZENA" | `#BC4749` terracotta red | `brand`: primary buttons, prices, rules, current page |
| Tagline and leaves | `#606C38` olive green | `olive`: small spaced-capital labels, tags, focus ring |
| Artboard | `#F6F4F0` warm off-white | `paper`: the page background |
| Tagline font | Open Sauce One Bold | The site's sans-serif (it is open source) |
| Wordmark font | Hello Paris Serif | **Not used.** It is a commercial font. Headings use Playfair Display, a free serif with the same high-contrast character. |

The logo is drawn for a light background, which is why the site is light. The red wordmark
would lose contrast on a dark page.

The leaf mark alone is the favicon (`public/favicon.svg`).

## Public website

### Colour

| Token | Value | Use | On `paper` | On `sand` |
|---|---|---|---|---|
| `paper` | `#f6f4f0` | Page background | | |
| `sand` | `#efebe3` | Alternate sections, page headers, footer | | |
| `sand-deep` | `#e2dcd0` | Image placeholders, skeletons | | |
| `ink` | `#2b211e` | Headings, emphasised text | 14.28 | 13.19 |
| `body` | `#4b403b` | Body text | 9.12 | 8.43 |
| `muted` | `#6e645c` | Secondary text | 5.25 | 4.85 |
| `brand` | `#bc4749` | Buttons, prices, accents | 4.62 | **4.27** |
| `brand-dark` | `#a23b3d` | Button hover | 5.92 | 5.47 |
| `olive` | `#606c38` | Labels, focus ring | 5.17 | 4.77 |
| `olive-dark` | `#4d572c` | Tag text | 7.04 | 6.51 |
| `night` | `#1c1513` | Only over photos: hero scrim, gallery viewer | | |
| `danger` | `#9b1c1c` | Form errors, "Unavailable today" | 7.42 | 6.86 |
| `success` | `#2f6b3f` | Confirmations | 5.80 | 5.36 |

White text on `brand` is 5.08, on `brand-dark` 6.50, on `olive` 5.68.

These ratios are computed from the hex values with the WCAG formula. WCAG AA needs 4.5 for
normal text and 3 for large text. Separately, an automated WCAG 2.2 AA scan (axe-core) runs
in a real browser against every page and reports the contrast of the text as rendered
(`npm run test:browser`).

**Never fade text with `opacity` to show a state.** Opacity lowers contrast invisibly: the
tokens above all pass, and the scan still failed an out-of-stock menu item that was drawn at
60% opacity (its name fell to 4.11 and its "Unavailable today" tag to 3.26). Use a token
instead: an out-of-stock item sets its name and price in `muted` and keeps its `danger` tag
at full strength (`.menu-item-unavailable`). Only its photo is faded.

**One rule follows from the numbers: do not set normal-size text in `brand` on a `sand`
surface** (4.27, below 4.5). Today `brand` appears on `sand` only as a button background
under white text, as large decorative numerals, and as a hover colour. On `paper` it passes
at 4.62, and is used there for prices, the current navigation link and open job titles. If
you need red body-size text on `sand`, use `brand-dark`.

`danger` is deliberately a different red from `brand`, so an error never reads as decoration.

### Typography

| Role | Font | Notes |
|---|---|---|
| Display | Playfair Display (variable) | Headings, item names, prices |
| Text | Open Sauce One 400/500/600/700 | Everything else |

Both are self-hosted through `@fontsource`, so no request goes to a font CDN.

| Class | Size |
|---|---|
| `.h-display` | `clamp(2.5rem, 6.6vw, 4.75rem)`, line-height 1.06 |
| `.h-section` | `clamp(1.9rem, 4vw, 2.9rem)`, line-height 1.12 |
| `.lead` | 1.125rem |
| body | 1rem, line-height 1.625 |
| `.eyebrow` | 0.75rem, bold, uppercase, 0.22em tracking, olive: set like the logo's tagline |

Headings use `text-wrap: balance`; paragraphs use `text-wrap: pretty`.

### Layout

- `.container-x`: max width 75rem, gutters 1.25rem (2rem from 640 px).
- `.section`: vertical padding 4rem (6rem from 640 px).
- `--header-h`: the sticky header's height, 4.75rem and 5.5rem from 1024 px. The sticky menu
  category bar and the hero height read it, so they stay aligned if it changes.
- Breakpoints: Tailwind's defaults plus `xs` at 24rem. Mobile-first; the navigation switches
  from a full-screen panel to a bar at `lg` (64rem).
- Square corners throughout. No shadows, no glass. One gradient: the scrim that keeps hero
  text readable over a photo.

### The hero has two forms

| When | Form |
|---|---|
| `hero.image` is set | Photo filling the first screen (capped at 54rem), dark scrim, white text, `.btn-on-photo` for the secondary button |
| No hero photo yet | Text-only hero on `sand`, centred, in the logo's colours |

### Components

| Component | Class | Notes |
|---|---|---|
| Buttons | `.btn` + `.btn-primary` / `.btn-outline` / `.btn-on-photo`, `.btn-sm` | 48 px tall (44 px small). Uppercase, bold, tracked. |
| Text link | `.text-link` | Underlined in the brand colour |
| Header | `.site-header`, `.nav-link`, `.icon-button` | Sticky, with the logo. Current page marked with `aria-current`. |
| Mobile navigation | `.mobile-nav` | A native `<dialog>`: focus is trapped and Escape closes it |
| Page header | `.page-hero` | Eyebrow, title, optional lead, on `sand` |
| Panel | `.panel` | Bordered translucent white block; reads as a card on both `paper` and `sand` |
| Hours | `hours` partial, `.hours-row` | One row per day, day left and time right, then a line per service ("Breakfast: every day, 8 AM to 12 PM") |
| Menu item | `.menu-item*`, `.tag` | Name, dotted leader, price in brand red; description; olive dietary tags. Out of stock: `.menu-item-unavailable` |
| Category chips | `.chip` | Sticky, horizontally scrollable; current category filled with the brand colour. Only the row of chips scrolls to follow the reader, never the page. |
| Job roles | `details.position` | Native disclosure per role, grouped by department |
| Coming soon | `coming-soon` partial | Stands in for address, phone and hours until a location is added |
| Form field | `.field-label`, `.field-input`, `.field-hint`, `.field-error` | 48 px inputs, white on the page |
| Alert | `.alert` + `.alert-error` / `.alert-success` | |
| Skeleton | `.skeleton` | Menu loading state |
| Gallery | `.gallery-tile`, `.lightbox` | Tiles are buttons; the viewer is the site's one dark surface |
| Footer | `.site-footer` | Logo, address, hours, links, social |

### States

- **Loading**: skeleton rows on the Menu page; "Sending..." on the application button.
- **Empty**: no location shows the "coming soon" panel; an empty gallery is left out of the
  navigation; the home page's featured strip simply does not appear.
- **Error**: "Menu temporarily unavailable. Please try again shortly." with Try again (and
  Call, when there is a phone number); field-level messages on the form.
- **Focus**: 2 px olive outline, 3 px offset, on every interactive element.
- **Hover**: colour change only. Gallery tiles scale 4%.
- **Motion**: 200 ms colour transitions. `prefers-reduced-motion` disables animation and
  smooth scrolling.

### Images

`{{picture "file.jpg" ...}}` outputs AVIF, WebP and JPEG at 480, 800, 1200 and 1920 px with
`width` and `height` set, so pages do not shift as photos load. SVG files (the logo) are
copied as they are. The hero is loaded eagerly with high priority; everything else is lazy.

## Owner dashboard

A work tool: neutral surface, dense, rounded corners. It uses the site's two fonts and shows
the logo in the sidebar and on the sign-in card, but keeps a neutral dark accent so status
colours (green, amber, red) carry the meaning.

| Token | Value | Use |
|---|---|---|
| `canvas` / `surface` | `#f6f5f2` / `#ffffff` | Page / cards |
| `line`, `line-strong` | `#e4e1da`, `#cfcbc1` | Borders |
| `text`, `muted` | `#1c1a17`, `#6a655c` | Text |
| `accent` | `#1c1a17` | Primary buttons, current navigation |
| `focus` | `#606c38` | Focus ring (the logo's olive) |
| `ok`, `warn`, `bad`, `info` (+ `-bg`) | greens, ambers, reds, blues | Status badges and alerts |

Components: `.d-btn` (+ `-primary`, `-danger`, `-quiet`, `-sm`), `.d-icon-btn`, `.d-card`,
`.d-input`, `.d-label`, `.d-hint`, `.d-error`, `.d-badge-*`, `.d-alert-*`, `.d-table`,
`.d-switch`, `.d-nav-link`, `.d-dialog`, `.d-drawer`, `.d-skeleton`, and `.d-source`.

Patterns that matter:

- **`.d-source`**: a small "Clover" or "Website" tag beside every field label, so the owner
  always knows whether saving changes the register or only the website.
- **Switches never guess.** A switch stays where it is, disabled, until the server answers,
  and is then redrawn from the server's response.
- **Sidebar on desktop, drawer on phones.** The item table becomes a list of cards below
  768 px; the editor's save bar is fixed to the bottom of the screen on phones.
- **Destructive actions** open a confirmation dialog that states the effect, and focus
  starts on Cancel.
- **Website preview** in the item editor uses the public site's own rendering function and
  palette. The six `.menu-item` rules exist in both stylesheets and must be kept identical.
- Every view has loading, empty and error states; failures are explained with `explain()`,
  which says what did and did not change.

## Accessibility

Built in: semantic landmarks and one `h1` per page, a skip link, labelled controls, visible
focus, `aria-current` on navigation, `aria-live` regions for the menu and for save status,
native `<dialog>` and `<details>` for every overlay and disclosure, keyboard alternatives to
drag-and-drop (move up/down buttons), alt text required by the content check.

Touch targets: at least 44 px on the public site. The dashboard is denser: buttons are 36 to
40 px tall and switches 24 px, which meets the WCAG 2.2 AA minimum (24 px) but not the
larger 44 px guideline.

Not yet done: an automated axe scan and a manual screen-reader pass. See TESTING.md.
