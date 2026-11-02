// The special offers carousel in the home page's hero. The owner manages the offers in the
// dashboard; the public-site function says which to show now, in which order.
//
// The carousel is not in the page until there is something to show: with no offers, or no
// answer, the hero is exactly as it was built. As with the site's photos, the last answer is
// remembered in the visitor's browser, so a returning visitor sees the offers at once; an
// offer remembered past its last day is left out on this side too.
//
// One slide is shown at a time, cross-fading into the next. It moves on by itself every
// INTERVAL_MS. It waits while the pointer or the keyboard is on it, while it is off screen
// and while the tab is hidden, and goes on from there. It stops, until the visitor presses
// play, once they press pause or move it themselves (arrows, dots, a swipe, the arrow
// keys), and from the start for a visitor who has asked their device for reduced motion.
import { offerStatus, validThrough } from "./lib/offers.js";
import { siteData } from "./lib/site-data.js";

const root = document.querySelector("[data-offers]");
const template = document.querySelector("[data-offer-template]");
const INTERVAL_MS = 7000;
const REMEMBERED = "luzena:site-offers:v1";
const IMAGE_WAIT_MS = 1500;

if (root && template) {
  const viewport = root.querySelector("[data-offers-viewport]");
  const dots = root.querySelector("[data-offers-dots]");
  const previous = root.querySelector("[data-offers-prev]");
  const next = root.querySelector("[data-offers-next]");
  const pause = root.querySelector("[data-offers-pause]");
  const { locale = "en-US" } = document.documentElement.dataset;
  const timeZone = root.dataset.timezone || undefined;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let slides = [];
  let current = 0;
  let shownKey = null;
  let timer = null;
  let startedAt = 0;
  let remaining = INTERVAL_MS;
  // Why it is not moving on by itself. Any one of them holds it.
  const holds = new Set(reducedMotion.matches ? ["stopped"] : []);

  const remembered = () => {
    try {
      const offers = JSON.parse(window.localStorage.getItem(REMEMBERED) ?? "null");
      return Array.isArray(offers) ? offers : null;
    } catch {
      return null;
    }
  };
  const remember = (offers) => {
    try {
      window.localStorage.setItem(REMEMBERED, JSON.stringify(offers));
    } catch {
      // Storage may be full or switched off; the page simply asks again next time.
    }
  };

  // One slide, from the template. Text goes in as text: nothing from the server is markup.
  function slide(offer, index, count) {
    const node = template.content.firstElementChild.cloneNode(true);
    const fill = (name, text) => {
      const element = node.querySelector(`[data-${name}]`);
      if (text) element.textContent = text;
      else element.remove();
    };
    node.setAttribute("aria-label", `${index + 1} of ${count}`);
    fill("badge", offer.badge);
    fill("highlight", offer.highlight);
    fill("title", offer.title);
    fill("description", offer.description);

    const photo = node.querySelector("[data-photo]");
    if (offer.image?.src) {
      photo.src = offer.image.src;
      if (offer.image.srcset) photo.srcset = offer.image.srcset;
      if (offer.image.width && offer.image.height) {
        photo.width = offer.image.width;
        photo.height = offer.image.height;
      }
      photo.alt = offer.image.alt ?? "";
      photo.loading = index === 0 ? "eager" : "lazy";
    } else {
      photo.remove();
      node.classList.add("offer-slide-plain");
    }

    const cta = node.querySelector("[data-cta]");
    if (offer.cta?.href) {
      cta.href = offer.cta.href;
      node.querySelector("[data-cta-label]").textContent = offer.cta.label;
      if (offer.cta.href.startsWith("https://")) {
        cta.target = "_blank";
        cta.rel = "noopener";
        node.querySelector("[data-cta-new-tab]").hidden = false;
      }
    } else {
      cta.remove();
    }

    const fine = offer.fine_print || validThrough(offer.ends_at, { locale, timeZone });
    if (fine) node.querySelector("[data-fine-text]").textContent = fine;
    else node.querySelector("[data-fine]").remove();
    return node;
  }

  function dot(index, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "offers-dot";
    button.setAttribute("aria-label", `Show offer ${index + 1} of ${count}`);
    button.addEventListener("click", () => choose(index));
    return button;
  }

  // Moves to a slide. The clock starts again from a full interval.
  function go(index, direction = index >= current ? "next" : "previous") {
    const count = slides.length;
    if (count === 0) return;
    current = (index + count) % count;
    viewport.dataset.direction = direction;
    slides.forEach((node, position) => {
      const active = position === current;
      node.toggleAttribute("data-active", active);
      node.toggleAttribute("inert", !active);
      node.setAttribute("aria-hidden", String(!active));
    });
    [...dots.children].forEach((button, position) => {
      if (position === current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
    remaining = INTERVAL_MS;
    schedule();
  }

  const moving = () => slides.length > 1 && holds.size === 0;

  // Sets the clock for what is left of the interval, if nothing holds it. The current dot's
  // progress bar runs and stops with it (data-playing, in main.css).
  function schedule() {
    clearTimeout(timer);
    root.toggleAttribute("data-playing", moving());
    root.toggleAttribute("data-stopped", holds.has("stopped"));
    // While it moves by itself, a screen reader is not told of each change; once it is
    // still, the slide the visitor moves to is read out.
    viewport.setAttribute("aria-live", moving() ? "off" : "polite");
    if (moving()) {
      startedAt = performance.now();
      timer = setTimeout(() => go(current + 1, "next"), remaining);
    }
  }

  // A pause for a moment (the pointer is on it, it is off screen): the clock keeps what
  // was left, and goes on from there.
  function hold(reason, on) {
    const was = moving();
    if (on) holds.add(reason);
    else holds.delete(reason);
    if (was && !moving()) remaining = Math.max(0, remaining - (performance.now() - startedAt));
    if (was !== moving()) schedule();
  }

  function showPauseState() {
    const stopped = holds.has("stopped");
    pause.querySelector("[data-pause-label]").textContent = stopped ? "Play offers" : "Pause offers";
  }

  // The visitor moved it: it stays where they put it until they press play.
  function choose(index, direction) {
    holds.add("stopped");
    showPauseState();
    go(index, direction);
  }

  // Resolves when the first slide's photo has loaded, or after a short limit.
  const firstPhotoReady = () => {
    const image = slides[0]?.querySelector("img");
    if (!image || (image.complete && image.naturalWidth > 0)) return Promise.resolve();
    return Promise.race([image.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS))]);
  };

  async function render(offers) {
    const live = (offers ?? []).filter((offer) => offer?.title && offerStatus(offer) === "live");
    const key = JSON.stringify(live);
    if (key === shownKey) return;
    shownKey = key;
    clearTimeout(timer);
    if (live.length === 0) {
      root.hidden = true;
      slides = [];
      return;
    }
    const keep = Math.min(current, live.length - 1);
    slides = live.map((offer, index) => slide(offer, index, live.length));
    viewport.replaceChildren(...slides);
    dots.replaceChildren(...live.map((_, index) => dot(index, live.length)));
    root.toggleAttribute("data-single", live.length === 1);
    current = keep;
    go(keep, "next");
    if (root.hidden) {
      await firstPhotoReady();
      root.hidden = false;
    }
  }

  previous.addEventListener("click", () => choose(current - 1, "previous"));
  next.addEventListener("click", () => choose(current + 1, "next"));
  pause.addEventListener("click", () => {
    hold("stopped", !holds.has("stopped"));
    showPauseState();
  });
  showPauseState();

  root.addEventListener("pointerenter", () => hold("pointer", true));
  root.addEventListener("pointerleave", () => hold("pointer", false));
  root.addEventListener("focusin", () => hold("focus", true));
  root.addEventListener("focusout", (event) => { if (!root.contains(event.relatedTarget)) hold("focus", false); });
  document.addEventListener("visibilitychange", () => hold("hidden", document.hidden));
  new IntersectionObserver(([entry]) => hold("offscreen", !entry.isIntersecting), { threshold: 0.3 }).observe(root);

  root.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target.closest("input, textarea")) return;
    event.preventDefault();
    choose(current + (event.key === "ArrowRight" ? 1 : -1), event.key === "ArrowRight" ? "next" : "previous");
  });

  // A swipe across the card moves it; a mostly vertical one is left to scroll the page.
  let start = null;
  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    start = { x: event.clientX, y: event.clientY };
  });
  viewport.addEventListener("pointerup", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    choose(current + (dx < 0 ? 1 : -1), dx < 0 ? "next" : "previous");
  });
  viewport.addEventListener("pointercancel", () => { start = null; });

  const before = remembered();
  if (before) render(before);
  siteData().then((body) => {
    if (!body || !Array.isArray(body.offers)) return;
    remember(body.offers);
    return render(body.offers);
  });
}
