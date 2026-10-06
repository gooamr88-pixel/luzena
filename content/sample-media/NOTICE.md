# Sample photos: not the restaurant's

The photos in this folder are stock images copied from the open-source "Grilli" restaurant
template (github.com/codewithsadee/grilli, MIT licence), which the earlier build of this site
was based on. They are here only so layouts can be reviewed before the client's own photos
arrive.

- This folder is used by the sample profile only (`npm run dev`, `npm run build:sample`,
  `npm run build:demo`). A production build (`npm run build`) reads `content/media/` and
  never this folder.
- The template's licence covers its code. Whether each stock photo may be used commercially
  was not checked.
- **Since 2026-10-06 copies of eight of them ARE published**, by instruction, as
  placeholders on the live site until the restaurant's own photos arrive. Those copies are
  `content/media/placeholder-*.jpg` (see the README there). The licence question is still
  open, and they do not show this restaurant.

Delete this folder once the real photos are in `content/media/`, if you no longer need the
sample profile to look realistic. The sample build then falls back to generated placeholders.
