// Shows the photos the owner has chosen in the dashboard in place of the ones the page was
// built with: the home page's hero photo, the "our story" photo, and the gallery.
//
// The page works without this. Every photo it was built with is already in the HTML, and
// stays whenever nothing has been chosen, the answer is late, or it never comes.
const { siteUrl = "" } = document.documentElement.dataset;
const hero = document.querySelector('[data-site-photo="hero"]');

// The hero photo is held back until the answer is in, so a visitor never watches one photo
// turn into another. The stylesheet shows it by itself after two seconds if this never runs.
const revealHero = () => hero?.setAttribute("data-photo-ready", "");

async function chosenPhotos() {
  if (!siteUrl) return null;
  const response = await fetch(siteUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
  if (!response.ok) return null;
  const body = await response.json();
  return body && typeof body.photos === "object" ? body.photos : null;
}

// Points one <picture> at a chosen photo. The built photo's <source> elements go: a browser
// would otherwise keep preferring them to the new <img>.
function show(picture, photo) {
  const image = picture.querySelector("img");
  if (!image) return;
  for (const source of picture.querySelectorAll("source")) source.remove();
  if (photo.srcset) image.srcset = photo.srcset;
  else image.removeAttribute("srcset");
  image.alt = photo.alt ?? "";
  if (photo.width && photo.height) {
    image.width = photo.width;
    image.height = photo.height;
  }
  image.src = photo.src;
}

function showGallery(list, photos) {
  const template = list.parentElement.querySelector("[data-gallery-template]");
  if (!template) return;
  // The home page's strip shows the first eight; the gallery page shows them all.
  const shown = list.dataset.siteGallery === "strip" ? photos.slice(0, 8) : photos;
  list.replaceChildren(...shown.map((photo, index) => {
    const item = template.content.cloneNode(true);
    show(item.querySelector("picture"), photo);
    // The gallery page's viewer finds its photos by this number.
    item.querySelector("[data-gallery-open]")?.setAttribute("data-gallery-open", String(index));
    return item;
  }));
  // The strip's arrows depend on how many photos there are.
  list.dispatchEvent(new Event("scroll"));
}

async function apply() {
  const photos = await chosenPhotos();
  if (!photos) return;
  for (const slot of document.querySelectorAll("[data-site-photo]")) {
    const photo = photos[slot.dataset.sitePhoto];
    const picture = slot.querySelector("picture");
    if (photo?.src && picture) show(picture, photo);
  }
  if (Array.isArray(photos.gallery) && photos.gallery.length > 0) {
    for (const list of document.querySelectorAll("[data-site-gallery]")) showGallery(list, photos.gallery.filter((photo) => photo?.src));
  }
}

apply().catch(() => {}).finally(revealHero);
