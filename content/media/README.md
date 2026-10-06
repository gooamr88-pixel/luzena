# Production photos

Put the restaurant's real photos in this folder, then reference them by file name in
`content/site.json`.

`logo.svg` is already here. It was exported from the client's logo PDF with the lettering
converted to outlines (so it needs no font), the background removed, and the canvas cropped
to the artwork. To replace it, keep the name `logo.svg` or update `logo` in `site.json`.

| Field in `site.json` | What it is | Recommended |
|---|---|---|
| `logo` | Restaurant logo | SVG, or PNG at least 400 px wide, transparent background |
| `hero.image` | Large photo at the top of the home page | Landscape, at least 1920 px wide |
| `ogImage` | Preview image when the site is shared | Landscape, at least 1200 px wide |
| `about.image` | Photo beside the restaurant's story | At least 1200 px wide |
| `locations[].image` | Photo of the location | At least 1200 px wide |
| `careers.image` | Photo on the Join Our Team page | At least 1200 px wide |
| `gallery[].image` | Gallery photos, each with `alt` text | At least 1200 px on the long edge |

The build resizes every photo to several widths and encodes AVIF, WebP and JPEG, so upload
the best originals you have. JPEG and PNG sources work.

Every photo needs alt text in `site.json` (`imageAlt`, or `alt` for gallery entries): one
short sentence describing what is in the photo, for people using a screen reader.

Photos of menu items do not go here. The owner uploads those in the dashboard.

## Placeholder photos (`placeholder-*.jpg`)

The restaurant's own photos have not arrived. On 2026-10-06 the instruction was to show
placeholder photos on the live site until they do, instead of the photo-less layouts. The
eight files named `placeholder-*` are those placeholders:

| File | Shown as |
|---|---|
| `placeholder-hero.jpg` | Home page hero; also a default dish photo |
| `placeholder-story.jpg` | "Our story" on the home page and the About page |
| `placeholder-location.jpg` | `locations[0].image`. Not on screen at present: the map takes its place. |
| `placeholder-gallery-1.jpg` to `-5.jpg` | Gallery page and the home page photo strip; four of them are also default dish photos |

**They are not photos of this restaurant, its dining room or its food.** They are copies of
the stock photos that came with the design template (see `content/sample-media/NOTICE.md`),
and whether each may be used commercially was never checked. Replace them as soon as real
photos exist: put the real file here, change the name in `content/site.json`, write its alt
text, delete the placeholder. `tests/frontend.test.js` and `tests/browser/public.spec.js`
allow only `placeholder-*` names today and must be widened to the new names.

`defaultDishPhotos` in `site.json` lists the photos the home page gives to a menu category
or a featured dish that has no photo of its own. A placeholder there sits beside a real
dish's name and price without showing that dish. Empty the list to go back to green tiles
and text-only cards; the owner's own dish photos, uploaded in the dashboard, always win.
