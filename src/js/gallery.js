// Gallery lightbox. Tiles are real buttons, the viewer is a <dialog>, and the arrow keys
// move between photos, so it works with a keyboard and a screen reader.
//
// The tiles are looked up each time, not once: site-media.js replaces them when the owner
// has a gallery of their own in the dashboard.
const lightbox = document.querySelector("[data-lightbox]");
const grid = document.querySelector("[data-gallery]");
const stage = lightbox.querySelector("[data-lightbox-stage]");
const caption = lightbox.querySelector("[data-lightbox-caption]");
const count = lightbox.querySelector("[data-lightbox-count]");
const tiles = () => [...grid.querySelectorAll("[data-gallery-open]")];
let current = 0;

function show(index) {
  const all = tiles();
  current = (index + all.length) % all.length;
  const picture = all[current].querySelector("picture").cloneNode(true);
  const image = picture.querySelector("img");
  // The tile asked for a thumbnail-sized source; the viewer wants the full width.
  for (const source of picture.querySelectorAll("source")) source.sizes = "100vw";
  image.sizes = "100vw";
  image.loading = "eager";
  image.removeAttribute("class");
  stage.replaceChildren(picture);
  caption.textContent = image.alt;
  count.textContent = `Photo ${current + 1} of ${all.length}`;
}

grid.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-gallery-open]");
  if (!tile) return;
  show(tiles().indexOf(tile));
  lightbox.showModal();
});

lightbox.querySelector("[data-lightbox-close]").addEventListener("click", () => lightbox.close());
lightbox.querySelector("[data-lightbox-prev]").addEventListener("click", () => show(current - 1));
lightbox.querySelector("[data-lightbox-next]").addEventListener("click", () => show(current + 1));
lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") show(current - 1);
  if (event.key === "ArrowRight") show(current + 1);
});
// Clicking the dark area around the photo closes the viewer.
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) lightbox.close();
});
// Focus goes back to the photo that was on screen, not the one that opened the viewer. The
// browser restores focus to the opener as it closes the dialog, so ours has to come after.
lightbox.addEventListener("close", () => setTimeout(() => tiles()[current]?.focus(), 0));
