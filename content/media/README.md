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
