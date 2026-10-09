// Shows the photos the owner has chosen in the dashboard in place of the ones the page was
// built with: the home page's hero photo, the "our story" photo, and the gallery.
//
// No visitor should see one photo turn into another. So every photo the owner can change is
// held back (invisible, its space kept) until this script knows which photo belongs there
// AND that photo has finished loading; only then is it shown. To make that quick, the
// answer is remembered in the visitor's browser: on the next visit the owner's photos are
// put in place at once, before the server has been asked again, and usually come straight
// from the browser's cache.
//
// The page works without this. Every photo it was built with is in the HTML. If this script
// never runs, the stylesheet shows the built photos by itself after two seconds; if it runs
// but the answer is late, never comes or a photo will not load, each photo is shown anyway
// after WAIT_LIMIT_MS, so nothing is left blank.
const { siteUrl = "" } = document.documentElement.dataset;
const WAIT_LIMIT_MS = 5000;
// What the server said last time, kept in this browser. Only public photo addresses.
const REMEMBERED = "luzena:site-photos:v1";

// From here on this script, not the stylesheet's timer, decides when the photos appear.
document.documentElement.setAttribute("data-site-media", "");

const slots = [...document.querySelectorAll("[data-site-photo]")]
  .map((slot) => ({ slot, built: slot.querySelector("picture")?.cloneNode(true) ?? null }))
  .filter((entry) => entry.built);
const galleries = [...document.querySelectorAll("[data-site-gallery]")]
  .map((list) => ({ list, built: [...list.children].map((child) => child.cloneNode(true)) }));

const reveal = (element) => element.setAttribute("data-photo-ready", "");
const revealAll = () => {
  for (const { slot } of slots) reveal(slot);
  for (const { list } of galleries) reveal(list);
};
// Whatever happens below, nothing stays hidden for longer than this.
setTimeout(revealAll, WAIT_LIMIT_MS);

function remembered() {
  try {
    const photos = JSON.parse(window.localStorage.getItem(REMEMBERED) ?? "null");
    return photos && typeof photos === "object" ? photos : null;
  } catch {
    return null;
  }
}

function remember(photos) {
  try {
    window.localStorage.setItem(REMEMBERED, JSON.stringify(photos));
  } catch {
    // Storage may be full or switched off; the page simply asks again next time.
  }
}

async function chosenPhotos() {
  if (!siteUrl) return null;
  const response = await fetch(siteUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
  if (!response.ok) return null;
  const body = await response.json();
  return body && typeof body.photos === "object" ? body.photos : null;
}

// Resolves once every photo inside `element` has loaded (or failed to), or after the limit.
function loaded(element) {
  const images = [...element.querySelectorAll("img")];
  const each = images.map((image) => (image.complete && image.naturalWidth > 0 ? null : image.decode().catch(() => {})));
  return Promise.race([Promise.all(each), new Promise((resolve) => setTimeout(resolve, WAIT_LIMIT_MS))]);
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

function galleryItems(list, photos) {
  const template = list.parentElement.querySelector("[data-gallery-template]");
  if (!template) return null;
  // The home page's strip shows the first eight; the gallery page shows them all.
  const shown = list.dataset.siteGallery === "strip" ? photos.slice(0, 8) : photos;
  return shown.map((photo, index) => {
    const item = template.content.cloneNode(true);
    show(item.querySelector("picture"), photo);
    // The gallery page's viewer finds its photos by this number.
    item.querySelector("[data-gallery-open]")?.setAttribute("data-gallery-open", String(index));
    return item;
  });
}

// Puts `content` in place of what `element` shows, held back until it has loaded. Nothing is
// done when it is what is there already, so a photo already on screen is never reloaded.
async function replace(element, key, put) {
  if (element.dataset.photoKey === key) return reveal(element);
  element.removeAttribute("data-photo-ready");
  element.dataset.photoKey = key;
  put();
  await loaded(element);
  // A newer answer may have replaced it meanwhile; that one reveals itself.
  if (element.dataset.photoKey === key) reveal(element);
}

// Shows the photos of one answer: the owner's where there is one, the built photo where not.
function render(photos) {
  const work = [];
  for (const { slot, built } of slots) {
    const photo = photos?.[slot.dataset.sitePhoto];
    work.push(photo?.src
      ? replace(slot, `owner:${photo.src}`, () => show(slot.querySelector("picture"), photo))
      : replace(slot, "built", () => slot.querySelector("picture").replaceWith(built.cloneNode(true))));
  }
  const chosen = Array.isArray(photos?.gallery) ? photos.gallery.filter((photo) => photo?.src) : [];
  for (const { list, built } of galleries) {
    const items = chosen.length > 0 ? galleryItems(list, chosen) : null;
    work.push(items
      ? replace(list, `owner:${chosen.map((photo) => photo.src).join(" ")}`, () => list.replaceChildren(...items))
      : replace(list, "built", () => list.replaceChildren(...built.map((child) => child.cloneNode(true)))));
    // The strip's arrows depend on how many photos there are.
    list.dispatchEvent(new Event("scroll"));
  }
  return Promise.all(work);
}

// The built photos start out as what is there.
for (const { slot } of slots) slot.dataset.photoKey = "built";
for (const { list } of galleries) list.dataset.photoKey = "built";

const before = remembered();
if (before) render(before);

chosenPhotos()
  .then((photos) => {
    if (!photos) return before ? null : revealAll();
    remember(photos);
    return render(photos);
  })
  .catch(() => (before ? null : revealAll()));
