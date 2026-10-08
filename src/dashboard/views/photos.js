// The website's own photos: the home page's main photo, the "our story" photo, the gallery,
// and the photo of each menu category on the home page. Each starts as a photo the website
// chooses by itself; the owner replaces it here, and the public pages show the change
// within about a minute, with no deployment.
import { MAX_HOME_CATEGORIES } from "../../js/lib/home.js";
import { api } from "../api.js";
import { optimiseImage, optimiseSitePhoto } from "../image.js";
import { state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, icon, loadingBlock, pageHeader, toast, toastFailure } from "../ui.js";

// The photos the website was built with, written into the page by the build.
const starting = document.documentElement.dataset;
const startingGallery = (starting.defaultGallery ?? "").split(/\s+/).filter(Boolean);
// The photos a category or a dish without one of its own is given, in the website's order.
const startingDishes = (starting.defaultDishPhotos ?? "").split(/\s+/).filter(Boolean);
// The longer side a category tile's photo needs: a tile is never wider than about 300 px on
// screen. How many tiles the home page shows is MAX_HOME_CATEGORIES, shared with the page.
const CATEGORY_EDGE = 960;

// A stored photo's address. Paths in the bucket get the bucket's address in front; the demo
// hands over addresses that are already whole.
const address = (path) => (/^(blob:|https?:|\/)/.test(path) ? path : `${state.storageBase}/${path}`);
const thumb = (photo) => address(photo.small_path ?? photo.path);

const SIZES = { hero: { edge: 1920, smallEdge: 800 }, story: { edge: 1600, smallEdge: 640 }, gallery: { edge: 1600, smallEdge: 640 } };
const ACCEPT = "image/jpeg,image/png,image/webp";

export async function photosView(outlet) {
  const region = h("div", {}, loadingBlock("Loading photos"));
  append(outlet,
    pageHeader({ title: "Website photos" }),
    h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
      "The photos on the public website. A change you make here is on the website within about a minute. Until you choose a photo of your own, the website shows the photo it started with."),
    region);

  let photos;
  let limits = { gallery: 24 };
  // The menu's categories, or null when they could not be read: the rest of the page does
  // not depend on them.
  let categories = null;

  const failed = (failure) => (failure?.details ? toastFailure(failure) : toast(failure?.message ?? "The photo could not be uploaded.", "bad"));

  // Shrinks one photo in the browser, twice (a full size and one for phones), and sends both.
  async function upload(slot, file, alt) {
    const made = await optimiseSitePhoto(file, SIZES[slot]);
    const form = new FormData();
    form.append("slot", slot);
    form.append("alt", alt);
    form.append("width", String(made.width));
    form.append("height", String(made.height));
    form.append("file", made.file);
    if (made.small) {
      form.append("small_width", String(made.smallWidth));
      form.append("file_small", made.small);
    }
    const result = await api("POST", "/site/photos", form);
    photos = result.photos;
    return result;
  }

  // A button that opens the file picker. The real control is hidden; the label is the
  // button, and `peer` moves the focus ring onto it.
  function picker(id, text, { primary = false, multiple = false, onFiles }) {
    const input = h("input", { type: "file", id, class: "peer sr-only", accept: ACCEPT, multiple });
    const label = h("label", {
      for: id,
      class: `d-btn ${primary ? "d-btn-primary" : ""} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:pointer-events-none peer-disabled:opacity-55`,
    }, text);
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      if (files.length === 0) return;
      input.disabled = true;
      try {
        await onFiles(files, (progress) => { label.textContent = progress; });
      } catch (failure) {
        failed(failure);
      }
      draw();
      // The page was drawn again; the keyboard goes back to the button that was used.
      document.getElementById(id)?.focus();
    });
    return [input, label];
  }

  // The words that describe a photo to someone who cannot see it, with their own Save.
  function description(photo, id) {
    const input = h("input", { class: "d-input", id, type: "text", maxlength: 200, value: photo.alt ?? "", placeholder: "What the photo shows" });
    const save = h("button", { type: "submit", class: "d-btn shrink-0", disabled: true }, "Save");
    input.addEventListener("input", () => { save.disabled = input.value.trim() === (photo.alt ?? ""); });
    const form = h("form", { class: "min-w-0" },
      h("label", { class: "d-label", for: id }, "Description", !photo.alt && badge("Missing", "warn")),
      h("div", { class: "flex gap-2" }, input, save));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const result = await api("PATCH", `/site/photos/${photo.id}`, { alt: input.value.trim() });
        photos = result.photos;
        toast(result.message);
        draw();
      } catch (failure) {
        toastFailure(failure);
        save.disabled = false;
      }
    });
    return form;
  }

  async function remove(photo, question) {
    if (!(await confirmDialog({ ...question, danger: true }))) return;
    try {
      const result = await api("DELETE", `/site/photos/${photo.id}`);
      photos = result.photos;
      toast(result.message);
    } catch (failure) {
      toastFailure(failure);
    }
    draw();
  }

  // The hero and the story: one photo each.
  function single(slot, { title, where, advice, shape, fallback }) {
    const photo = photos[slot];
    const [input, choose] = picker(`photo-${slot}`, photo ? "Replace photo" : "Choose a photo", {
      primary: true,
      onFiles: async ([file], progress) => {
        progress("Uploading...");
        // A new photo shows something else, so it starts without the old one's description.
        toast((await upload(slot, file, "")).message);
      },
    });
    const shown = photo ? thumb(photo) : fallback;
    return h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": `photos-${slot}` },
      h("div", { class: "flex flex-wrap items-start justify-between gap-3" },
        h("div", {},
          h("h2", { id: `photos-${slot}`, class: "d-title" }, title),
          h("p", { class: "mt-1 text-sm text-muted" }, where)),
        photo ? badge("Your photo", "ok") : badge("Starting photo")),
      h("div", { class: "mt-5 grid gap-5 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" },
        h("div", { class: `d-photo-frame ${shape}` },
          shown
            ? h("img", { src: shown, alt: photo ? photo.alt || "Your photo" : "The photo the website started with", loading: "lazy", decoding: "async" })
            : h("p", { class: "flex size-full items-center justify-center p-4 text-center text-sm text-muted" }, "No photo")),
        h("div", { class: "min-w-0 space-y-4" },
          h("p", { class: "text-sm text-muted" }, advice),
          h("div", { class: "flex flex-wrap gap-2" }, input, choose,
            photo && h("button", {
              type: "button", class: "d-btn d-btn-quiet",
              onClick: () => remove(photo, {
                title: "Go back to the starting photo?",
                body: ["Your photo is removed from the website and deleted. The website shows the photo it started with again."],
                confirmLabel: "Remove my photo",
              }),
            }, "Use the starting photo")),
          photo && description(photo, `alt-${slot}`),
          h("p", { class: "d-hint" }, "JPEG, PNG or WebP. Photos are resized automatically before upload."))));
  }

  function gallery() {
    const own = photos.gallery;
    const room = limits.gallery - own.length;
    const [input, add] = picker("photo-gallery", "Add photos", {
      primary: true, multiple: true,
      onFiles: async (files, progress) => {
        const chosen = files.slice(0, room);
        for (const [index, file] of chosen.entries()) {
          progress(`Uploading ${index + 1} of ${chosen.length}...`);
          await upload("gallery", file, "");
        }
        toast(chosen.length === 1 ? "Photo added to the gallery." : `${chosen.length} photos added to the gallery.`);
        if (files.length > chosen.length) toast(`The gallery holds ${limits.gallery} photos, so ${files.length - chosen.length} were left out.`, "warn");
      },
    });
    if (room <= 0) input.disabled = true;

    const move = async (index, delta) => {
      const ids = own.map((photo) => photo.id);
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      try {
        photos = (await api("POST", "/site/photos/reorder", { ids })).photos;
      } catch (failure) {
        toastFailure(failure);
      }
      draw();
      // Keep the keyboard on the photo that moved: on the same arrow, or on the other one
      // when the photo has reached the end and that arrow is switched off.
      const arrows = [delta < 0 ? "earlier" : "later", delta < 0 ? "later" : "earlier"];
      const moved = arrows.map((arrow) => region.querySelector(`[data-move="${ids[index + delta]}:${arrow}"]`));
      moved.find((button) => button && !button.disabled)?.focus();
    };

    const tile = (photo, index) => h("li", { class: "flex flex-col gap-3 rounded-xl border border-line bg-surface p-3" },
      h("div", { class: "d-photo-frame relative aspect-[4/3]" },
        h("img", { src: thumb(photo), alt: photo.alt || `Gallery photo ${index + 1}`, loading: "lazy", decoding: "async" }),
        h("span", { class: "absolute top-2 left-2 rounded-full bg-night/80 px-2 py-0.5 text-[0.72rem] font-semibold text-white" }, String(index + 1))),
      description(photo, `alt-${photo.id}`),
      h("div", { class: "mt-auto flex items-center justify-between gap-2" },
        h("div", { class: "flex" },
          h("button", { type: "button", class: "d-icon-btn", disabled: index === 0, "aria-label": `Move photo ${index + 1} earlier`, dataset: { move: `${photo.id}:earlier` }, onClick: () => move(index, -1) }, icon("up")),
          h("button", { type: "button", class: "d-icon-btn", disabled: index === own.length - 1, "aria-label": `Move photo ${index + 1} later`, dataset: { move: `${photo.id}:later` }, onClick: () => move(index, 1) }, icon("down"))),
        h("button", {
          type: "button", class: "d-btn d-btn-quiet d-btn-sm",
          onClick: () => remove(photo, {
            title: "Remove this photo from the gallery?",
            body: ["It is taken off the website and deleted.", own.length === 1 ? "It is your last one, so the gallery will show the website's starting photos again." : "The other photos stay as they are."],
            confirmLabel: "Remove photo",
          }),
        }, "Remove", h("span", { class: "sr-only" }, ` photo ${index + 1}`))));

    return h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "photos-gallery" },
      h("div", { class: "flex flex-wrap items-start justify-between gap-3" },
        h("div", {},
          h("h2", { id: "photos-gallery", class: "d-title" }, "Gallery"),
          h("p", { class: "mt-1 text-sm text-muted" }, "The Gallery page, in this order. The first eight are also the row of photos on the home page.")),
        h("div", { class: "flex items-center gap-3" },
          h("span", { class: "text-sm text-muted" }, `${own.length} of ${limits.gallery}`), input, add)),
      own.length === 0
        ? h("div", { class: "mt-5" },
            h("div", { class: "d-alert d-alert-info" }, startingGallery.length > 0
              ? "The gallery is showing the photos the website started with. Add your own and they take the place of all of these."
              : "The gallery has no photos yet. Add your own."),
            startingGallery.length > 0 && h("ul", { class: "mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", "aria-label": "Starting photos" },
              startingGallery.map((src, index) => h("li", { class: "d-photo-frame aspect-[4/3]" },
                h("img", { src, alt: `Starting photo ${index + 1}`, loading: "lazy", decoding: "async" })))))
        : h("ol", { class: "mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3", "aria-label": "Your gallery photos, in order" }, own.map(tile)));
  }

  // The menu's categories, each with the photo its tile on the home page shows. A category
  // without one of its own borrows a dish's photo, then a starting photo, exactly as the
  // website does, so what is drawn here is what a visitor sees.
  function categorySection() {
    const listed = categories.filter((category) => !category.archived && !category.removed_from_clover);
    let place = 0;

    const card = (category) => {
      const hasDishes = (category.on_website_count ?? category.item_count) > 0;
      const eligible = !category.web_hidden && hasDishes;
      const position = eligible ? place++ : null;
      const onHome = position !== null && position < MAX_HOME_CATEGORIES;
      const own = category.image_path;
      const borrowed = category.dish_image_path;
      const fallback = startingDishes.length > 0 ? startingDishes[(position ?? 0) % startingDishes.length] : null;
      const shown = own ? address(own) : borrowed ? address(borrowed) : fallback;
      const why = category.web_hidden ? "Hidden on the website"
        : !hasDishes ? "No dishes on the website"
        : !onHome ? `Not among the first ${MAX_HOME_CATEGORIES}` : null;

      const [input, choose] = picker(`photo-category-${category.id}`, own ? "Replace" : "Choose a photo", {
        primary: !own,
        onFiles: async ([file], progress) => {
          progress("Uploading...");
          const form = new FormData();
          form.append("file", await optimiseImage(file, CATEGORY_EDGE));
          const result = await api("POST", `/categories/${category.id}/image`, form);
          categories = result.categories;
          toast(result.message);
        },
      });
      choose.classList.add("d-btn-sm");
      // The label is the button's whole name, so it says which category it is for.
      append(choose, h("span", { class: "sr-only" }, ` for ${category.name}`));

      const removeOwn = async () => {
        if (!(await confirmDialog({
          title: `Remove the photo of ${category.name}?`,
          body: ["Your photo is taken off the website and deleted.", borrowed
            ? "The category shows the photo of one of its dishes again."
            : "The category shows one of the website's starting photos again."],
          confirmLabel: "Remove my photo", danger: true,
        }))) return;
        try {
          const result = await api("DELETE", `/categories/${category.id}/image`);
          categories = result.categories;
          toast(result.message);
        } catch (failure) {
          toastFailure(failure);
        }
        draw();
      };

      return h("li", { class: "flex flex-col gap-3 rounded-xl border border-line bg-surface p-3", dataset: { category: category.id } },
        h("div", { class: "d-photo-frame relative aspect-[5/4]" },
          shown
            ? h("img", { src: shown, alt: "", loading: "lazy", decoding: "async" })
            : h("p", { class: "flex size-full items-center justify-center p-3 text-center text-sm text-muted" }, "A green tile, no photo"),
          onHome && h("span", { class: "absolute top-2 left-2 rounded-full bg-night/80 px-2 py-0.5 text-[0.72rem] font-semibold text-white" },
            String(position + 1), h("span", { class: "sr-only" }, " on the home page"))),
        h("div", { class: "min-w-0" },
          h("h3", { class: "truncate text-[0.98rem] font-semibold", title: category.name }, category.name),
          h("p", { class: "mt-1 flex flex-wrap gap-1.5" },
            own ? badge("Your photo", "ok") : borrowed ? badge("From one of its dishes") : badge("Starting photo"),
            why && badge(why, "warn"))),
        h("div", { class: "mt-auto flex flex-wrap items-center gap-2" }, input, choose,
          own && h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm", onClick: removeOwn },
            "Remove", h("span", { class: "sr-only" }, ` the photo of ${category.name}`))));
    };

    return h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "photos-categories" },
      h("h2", { id: "photos-categories", class: "d-title" }, "Menu categories"),
      h("p", { class: "mt-1 max-w-3xl text-sm text-muted" },
        `The category tiles on the home page. A category without a photo of its own shows the photo of one of its dishes, or one of the website's starting photos. The home page shows the first ${MAX_HOME_CATEGORIES} categories that have dishes on the website; their order is set on the `,
        h("a", { href: "#/categories", class: "font-medium text-brand hover:underline" }, "Categories page"), "."),
      listed.length === 0
        ? h("div", { class: "d-alert d-alert-info mt-5" }, "There are no categories yet. They come from Clover, once it is connected and the menu has been imported.")
        : h("ul", { class: "mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4", "aria-label": "Menu categories, in the website's order" }, listed.map(card)),
      listed.length > 0 && h("p", { class: "d-hint mt-4" }, "JPEG, PNG or WebP, wider than it is tall. Photos are resized automatically before upload."));
  }

  function draw() {
    clear(region);
    append(region, h("div", { class: "space-y-5" },
      single("hero", {
        title: "Home page: main photo",
        where: "The large photo at the top of the home page, behind the headline.",
        advice: "Use a wide photo, at least 1920 pixels across. It is darkened so the words on it can be read, and phones show the middle of it, so keep what matters away from the edges.",
        shape: "aspect-[16/9]", fallback: starting.defaultHero,
      }),
      single("story", {
        title: "Our story photo",
        where: "Beside \"Our story\" on the home page, and on the About page.",
        advice: "A photo of the dining room, the kitchen or the team works well here. At least 1200 pixels on its longer side.",
        shape: "aspect-[4/3]", fallback: starting.defaultStory,
      }),
      categories && categorySection(),
      gallery()));
  }

  try {
    // The categories are asked for alongside. If they cannot be read, the section is left
    // out and the rest of the page works as before.
    const [answer, menu] = await Promise.all([
      api("GET", "/site/photos"),
      api("GET", "/categories").catch(() => null),
    ]);
    photos = answer.photos;
    limits = answer.limits ?? limits;
    categories = menu?.categories ?? null;
    draw();
  } catch (failure) {
    clear(region);
    append(region, errorBlock(failure, () => { clear(outlet); photosView(outlet); }));
  }
}
