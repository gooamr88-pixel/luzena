# Design system

Two themes share one codebase: the public website (warm, dark-accented, photo-led) and the
owner dashboard (light, dense, neutral). Tokens live at the top of `src/styles/main.css` and
`src/styles/dashboard.css` in `@theme` blocks; components are classes in `@layer components`.

## Where the look comes from

The public site follows the home page design supplied on 2026-10-06: a dark hero with the
site header lying over it, cream pages, gold buttons and accents, photo tiles and cards with
rounded corners, and a forest green "visit us" band. It replaced the light
cream/terracotta/olive theme that had been derived from the logo's own colours.

What still comes from the logo file the client supplied (`content/media/logo.svg`):

| In the logo | Used on the site as |
|---|---|
| Artboard `#F6F4F0` | `paper`: the page background |
| Tagline font, Open Sauce One | The site's sans-serif (it is open source) |
| Wordmark font, Hello Paris Serif | **Not used.** It is a commercial font. Headings use Playfair Display, a free serif with the same high-contrast character. |
| Leaves, olive `#606C38` | `olive`: dietary tags and the sample banner. The leaf shape alone is the favicon (`public/favicon.svg`) and, without its background, the watermark on dark surfaces (`public/leaf.svg`). |
| Wordmark red `#BC4749` | **Not used as a colour.** The logo is drawn for a light ground; the header, footer and phone menu are dark, so it is shown there as a single white shape (`.logo-light`). Its own colours appear only in the generated share image. |

## Public website

### Colour

| Token | Value | Use | On `paper` | On `sand` |
|---|---|---|---|---|
| `paper` | `#f6f4f0` | Page background | | |
| `sand` | `#efebe3` | Alternate sections, the careers band | | |
| `sand-deep` | `#e2dcd0` | Image placeholders, skeletons | | |
| `ink` | `#2b211e` | Headings, emphasised text | 14.28 | 13.19 |
| `body` | `#4b403b` | Body text | 9.12 | 8.43 |
| `muted` | `#6e645c` | Secondary text | 5.25 | 4.85 |
| `brand` | `#835f20` | Accent TEXT: small capital labels, prices, arrow links, the focus ring | 5.28 | 4.88 |
| `brand-dark` | `#6b4d18` | Hover for accent text | 7.08 | 6.54 |
| `gold` | `#c9a063` | Accent FILL: primary buttons, rules, icons on dark | too low for text | too low for text |
| `gold-light` | `#dbb87e` | Primary button hover | | |
| `olive` | `#606c38` | Sample banner, tag borders | 5.17 | 4.77 |
| `olive-dark` | `#4d572c` | Dietary tag text | 7.04 | 6.51 |
| `night` | `#18120f` | Header, hero, page headers, footer, phone menu, photo viewer | | |
| `forest` | `#1c2a22` | The "visit us" band, photo-less tiles and panels | | |
| `forest-light` | `#2a3d31` | The light end of a forest gradient | | |
| `danger` | `#9b1c1c` | Form errors, "Unavailable today" | 7.42 | 6.86 |
| `success` | `#2f6b3f` | Confirmations | 5.80 | 5.36 |

These ratios are computed from the hex values with the WCAG formula. WCAG AA needs 4.5 for
normal text and 3 for large text. Separately, an automated WCAG 2.2 AA scan (axe-core) runs
in a real browser against every page and reports the contrast of the text as rendered
(`npm run test:browser`).

**Gold is a fill, never text on a light surface.** It is far too light to read on `paper`.
Accent text on light uses `brand`, the same hue taken down to bronze, which passes on
`paper`, `sand` and white (5.80).

**Buttons are night text on gold (7.68), not white on gold.** The supplied design shows
white lettering on the gold buttons; that is 2.42 and fails AA, so the lettering is dark.

**The dark scope.** Inside a dark surface the text tokens are re-pointed:

| Token | Becomes | On `night` | On `forest` |
|---|---|---|---|
| `ink` | `#ffffff` | 18.55 | 14.96 |
| `body` | `#e4dcd2` | 13.66 | 11.02 |
| `muted` | `#b8ada1` | 8.42 | 6.79 |
| `brand` | `#c9a063` (gold) | 7.68 | 6.19 |
| `brand-dark` | `#dbb87e` | | |

So headings, `.eyebrow`, `.btn-outline`, `.text-link`, `.icon-button` and every border drawn
from `ink` read correctly on dark without a second set of classes, and `text-brand` is
always the readable accent. The header, footer, page headers, phone menu and photo viewer
are in the scope already; put the class `on-dark` on any other dark block.

**Never fade text with `opacity` to show a state.** Opacity lowers contrast invisibly: the
tokens above all pass, and the scan still failed an out-of-stock menu item that was drawn at
60% opacity (its name fell to 4.11 and its "Unavailable today" tag to 3.26). Use a token
instead: an out-of-stock item sets its name and price in `muted` and keeps its `danger` tag
at full strength (`.menu-item-unavailable`). Only its photo is faded.

`danger` is deliberately not the accent, so an error never reads as decoration.

### Typography

| Role | Font | Notes |
|---|---|---|
| Display | Playfair Display (variable) | Headings, menu item names and prices |
| Text | Open Sauce One 400/500/600/700 | Everything else, including dish names on the home page cards |

Both are self-hosted through `@fontsource`, so no request goes to a font CDN.

| Class | Size |
|---|---|
| `.h-display` | `clamp(2.5rem, 6vw, 4.75rem)`, line-height 1.05. Inside `.page-hero`: `clamp(2.25rem, 5vw, 3.75rem)` |
| `.h-section` | `clamp(1.85rem, 3.2vw, 2.6rem)`, line-height 1.14 |
| `.lead` | 1.125rem |
| body | 1rem, line-height 1.625 |
| `.eyebrow` | 0.75rem, semibold, uppercase, 0.2em tracking, `brand` |

Headings use `text-wrap: balance`; paragraphs use `text-wrap: pretty`. Section titles and
button labels on the home page are in Title Case, as in the supplied design.

### Layout

- `.container-x`: max width 75rem, gutters 1.25rem (2rem from 640 px).
- `.section`: vertical padding 3.5rem (5rem from 640 px). Home page sections that follow one
  another on the same background carry top padding only.
- `--header-h`: the sticky header's height, 4.5rem and 5.25rem from 1024 px. The sticky menu
  category bar and the hero read it, so they stay aligned if it changes.
- Breakpoints: Tailwind's defaults plus `xs` at 24rem. Mobile-first; the navigation switches
  from a full-screen panel to a bar at `lg` (64rem). "Home" joins the bar at `xl`.
- Corners: 6 px on buttons and fields, 12 px on cards, tiles and photos, 16 px on large
  panels, full on chips and round buttons.
- Shadows: `shadow-card` at rest and `shadow-lift` on hover, on tiles and cards only.
- On phones, the row of dish cards and the photo strip scroll sideways and bleed to the
  screen edge, so the next card peeks in. Only those rows scroll; the page never does.

### The header

Sticky, `night`, on every page. On the home page it carries `.site-header-overlay`: the hero
is pulled up underneath it, and it starts clear and settles into its solid form over the
first 7rem of scrolling. That is a CSS scroll-driven animation, so there is no script that
could fail and leave white links over a cream page. A browser without scroll-driven
animations shows the solid header from the start.

### The hero has two forms

Both are white text on dark, with the same three buttons (View Menu, Order Online, Get
Directions).

| When | Form |
|---|---|
| `hero.image` is set | The photo behind a scrim that is darkest on the left, under the text |
| No hero photo yet | The same dark block with a warm glow (`.glow`) and the logo's leaf as a watermark (`.leaf-mark`) |

### The home page

| Section | Source | Without its data |
|---|---|---|
| Hero | `hero` in the content file | See above |
| "Fresh Flavors for Every Taste": up to six category tiles | The live menu's categories. A tile borrows the photo of one of its dishes, else one of `defaultDishPhotos`. | With neither, a tile is forest green with the leaf. With fewer than two categories, or no menu, the section is hidden. |
| "Most Popular Dishes": one row of four cards | The dishes marked as featured in the dashboard. A dish without a photo is given one of `defaultDishPhotos`. | With no default photos, photos are all or nothing: if any of the four has one, a dish without gets the leaf; if none has, the cards are text only. With no featured dish, the section is hidden. |
| "Our story" | `about` | With `about.image`: the photo runs to the left screen edge, and `about.values` are a row of icons. Without: the values are a forest green panel beside the text. |
| "A Look Inside": photo strip with arrow buttons | `gallery` (first eight) | Hidden |
| "Visit Us" | The first location | Right-hand column: the Google map (`.map-frame`) if `mapsEmbedUrl` is set, else the location's photo, else the hours day by day. Beside the address, phone, hours and buttons from 1024 px, where it takes the height of that column; below them on smaller screens, at 4:3. |
| "Join Our Team" | Fixed | |

A photo from the menu that fails to load is replaced by the next choice (a default photo,
then the leaf), so a deleted photo never leaves a broken image.

The map is Google's page in a frame. It loads lazily, so Google is contacted only when a
visitor scrolls near it, and the security policy allows frames from `www.google.com` only.

### Components

| Component | Class | Notes |
|---|---|---|
| Buttons | `.btn` + `.btn-primary` / `.btn-outline` / `.btn-on-photo` / `.btn-light`, `.btn-sm` | 48 px tall (44 px small). An icon inside is sized to the text. `.btn-light` is the white second button on a dark surface. |
| Text link | `.text-link` | Underlined in the accent |
| Arrow link | `.arrow-link` | Accent text ending in an arrow that steps forward on hover |
| Icon | `icon` partial | Called with a `name`: arrow-right, arrow-left, pin, phone, mail, clock, utensils, bag, leaf, cup, heart, users, instagram, menu, close. Always decorative. |
| Header | `.site-header`, `.site-header-overlay`, `.nav-link`, `.icon-button`, `.logo-light` | Current page marked with `aria-current` and a gold underline |
| Mobile navigation | `.mobile-nav` | A native `<dialog>`: focus is trapped and Escape closes it |
| Home hero | `.hero`, `.glow`, `.leaf-mark` | |
| Page header | `.page-hero` | Eyebrow, title, optional lead, on `night` with the glow and the leaf |
| Panel | `.panel`, `.panel-dark` | White card on light; translucent card on dark |
| Photo frame | `.media` | Rounded, clipped, with a placeholder colour |
| Map | `.map-frame` | The Google map's frame: the shape and corners of a photo |
| Category tile | `.category-tile` | Home page. Filled by `featured.js` from a `<template>`. |
| Dish card | `.dish-card` | Home page. Filled by `featured.js` from a `<template>`. The whole card is one link to its category on the menu page. |
| Feature | `.feature`, `.feature-icon` | An icon in a ring over a short label |
| Detail row | `.detail-row` | Address, phone or hours with its icon |
| Sideways rows | `.snap-row`, `.strip`, `.round-button` | The strip's arrows are shown by `strip.js` only when there is more to see; at the end of its travel an arrow is marked `aria-disabled`, not disabled, so it keeps the keyboard focus |
| Hours | `hours` partial, `.hours-row` | One row per day, day left and time right, then a line per service ("Breakfast: every day, 8 AM to 12 PM") |
| Menu item | `.menu-item*`, `.tag` | Name, dotted leader, price in the accent; description; olive dietary tags. Out of stock: `.menu-item-unavailable` |
| Category chips | `.chip` | Sticky, horizontally scrollable pills; the current category is filled with `night`. Only the row of chips scrolls to follow the reader, never the page. |
| Job roles | `details.position` | Native disclosure per role, grouped by department |
| Coming soon | `coming-soon` partial | Stands in for address, phone and hours until a location is added |
| Form field | `.field-label`, `.field-input`, `.field-hint`, `.field-error` | 48 px inputs, white on the page |
| Choice | `.choice` | One of several boxes to tick, as a 48 px row that is all target; tinted when ticked, red-edged when the group is in error |
| Application form | on `/careers/` | A white `.panel` on `sand`. Questions in `<fieldset>` groups, each with an eyebrow `<legend>`: About you, The role, Your experience, A little more. Two columns from 640 px, one below. A sticky column beside it says how applying works. Errors appear under each question and focus goes to the first; the button says "Sending..." and cannot be pressed twice; a sent application replaces the form with a confirmation panel. |
| Alert | `.alert` + `.alert-error` / `.alert-success` | |
| Skeleton | `.skeleton` | Menu loading state |
| Gallery | `.gallery-tile`, `.lightbox` | Tiles are buttons; the viewer is a dark `<dialog>` |
| Footer | `.site-footer` | `night`: logo, order button, social links, address, hours, page links |

### States

- **Loading**: skeleton rows on the Menu page; "Sending..." on the application button.
- **Empty**: no location shows the "coming soon" panel; an empty gallery is left out of the
  navigation; the home page's two menu sections simply do not appear.
- **Error**: "Menu temporarily unavailable. Please try again shortly." with Try again (and
  Call, when there is a phone number); field-level messages on the form.
- **Focus**: 2 px outline in `brand`, 3 px offset, on every interactive element: bronze on
  light surfaces, gold on dark ones.
- **Hover**: colour change on buttons and links; tiles and cards lift their shadow and their
  photo scales 5% (gallery tiles 4%); arrows step 3 px forward.
- **Motion**: 200 ms colour transitions, 300 to 500 ms on tiles and cards.
  `prefers-reduced-motion` disables animation, smooth scrolling and the strip's glide.

### Images

`{{picture "file.jpg" ...}}` outputs AVIF, WebP and JPEG at 480, 800, 1200 and 1920 px with
`width` and `height` set, so pages do not shift as photos load. SVG files (the logo) are
copied as they are. The hero is loaded eagerly with high priority; everything else is lazy.
Photos of dishes come from the menu (the owner uploads them in the dashboard) and are shown
at the size they were stored.

## Owner dashboard

The public site's own design language, set denser because it is a tool people work in all
day: the same two fonts, the same paper, ink, gold and night, the same buttons, cards and
corners. Since 2026-10-06 it no longer has a neutral palette of its own. The one thing it
adds is status colours (green, amber, red, blue), which carry meaning and are never used for
decoration.

| Token | Value | Use |
|---|---|---|
| `canvas` / `surface` / `sand` | `#f6f4f0` / `#ffffff` / `#efebe3` | Page / cards / hover and thumbnails. `canvas` is the public site's `paper`. |
| `line`, `line-strong` | `#e6dfd3`, `#d0c6b6` | Borders |
| `text`, `muted` | `#2b211e`, `#6e645c` | Text: the public site's `ink` and `muted` |
| `gold`, `gold-light` | `#c9a063`, `#dbb87e` | Primary buttons (night text on gold, 7.68), the current page in the sidebar |
| `brand`, `brand-dark` | `#835f20`, `#6b4d18` | Accent text and links, small capital labels, ticked checkboxes; `focus` is the same colour |
| `night` | `#18120f` | Sidebar, phone drawer, sign-in screen, toasts |
| `ok`, `warn`, `bad`, `info` (+ `-bg`) | greens, ambers, reds, blues | Status badges, alerts, switches that are on |

Inside `.d-dark` (sidebar, drawer, sign-in screen) `text`, `muted`, `line`, `brand` and
`focus` are re-pointed for a dark ground, as `on-dark` does on the public site.

| Part | How it is drawn |
|---|---|
| Sidebar (`.d-sidebar`) | Night with a warm glow, the logo in white (`.d-logo-light`), a gold "Dashboard" label. The current page is brighter, with a gold bar and a gold icon. A drawer on screens under 1024 px. |
| Top bar (`.d-topbar`) | White, blurred, sticky. The signed-in account's initial in a ring, its address, Sign out. |
| Page title | `h1` in the display serif, as on the public site. Card and dialog headings (`.d-title`) stay in the sans-serif, which reads better at working sizes. |
| Small label (`.d-section-title`) | The public site's eyebrow: small, spaced capitals in `brand` |
| Cards (`.d-card`) | The public site's card: white, 12 px corners, `shadow-card`. A card that is a link lifts and takes a gold border on hover. |
| Buttons (`.d-btn` + `-primary`, `-danger`, `-quiet`, `-sm`) | The public site's shapes at 40 px (36 px small). Primary is gold with night text; the plain button turns `brand` on hover; danger is red. |
| Fields (`.d-input`, `.d-label`, `.d-hint`, `.d-error`) | 40 px, 6 px corners, `brand` border in focus |
| Tables (`.d-table`) | Spaced-capital column heads on `canvas`, hairline rows |
| Facts (`.d-facts`) | A list of term and value, one per line, used for the Clover connection |
| States | Empty and error blocks carry an icon in a ring (`.d-state-icon`): the leaf, or a warning triangle in red |
| Sign-in (`.d-auth`) | The public site's dark hero (glow and leaf) with the logo in white over a white card |
| Filter pills (`.d-pills`, `.d-pill`) | A row of buttons with a count in each; the one in force is filled with `night`. Scrolls sideways on a phone. Used for the stages of job applications. |
| Timeline (`.d-timeline`) | What happened to something, newest first: gold dots joined by a hairline. Used for an application's history. |
| Sidebar count (`.d-nav-count`) | A gold number beside a sidebar link: how many are waiting. Used for new applications. |
| Stage badges | An application's stage: New (blue), Reviewing (amber), Shortlisted and Interview (`.d-badge-accent`, gold: going well, not finished), Hired (green), Rejected (plain) |
| Also | `.d-icon-btn`, `.d-badge-*`, `.d-alert-*`, `.d-switch`, `.d-nav-link`, `.d-dialog`, `.d-drawer`, `.d-skeleton`, `.d-source` |

Icons are the dashboard's own small set in `src/dashboard/ui.js`, drawn at the public
site's stroke weight; the fork and knife and the leaf are the public site's drawings.

Patterns that matter:

- **`.d-source`**: a small "Clover" or "Website" tag beside every field label, so the owner
  always knows whether saving changes the register or only the website.
- **Switches never guess.** A switch stays where it is, disabled, until the server answers,
  and is then redrawn from the server's response.
- **Sidebar on desktop, drawer below 1024 px.** The item table becomes cards below 1280 px
  (two to a row from 768 px), so no name or action ever wraps; its "Updated" column appears
  from 1536 px. The item filters sit two to a row on phones, three on a laptop, six on a
  wide screen. The editor's save bar is fixed to the bottom of the screen on phones.
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
