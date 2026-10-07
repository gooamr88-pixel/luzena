// Scroll reveal for the public pages: a block below the first screen fades up into place
// as it comes into view, and the cards of a row follow one another.
//
// Nothing is hidden by the stylesheet or the markup. This file hides a block only when it
// is certain to show it again: it runs only where the browser can report what is on screen,
// only for visitors who have not asked for reduced motion, and never touches a block that
// is already on screen when the page opens. So without it, or if it fails, the page is
// simply all there.
const STAGGER_STEPS = 5;
const SETTLE_MS = 1100;

// A block is revealed as one piece, unless it is a row of a few cards: then each card is.
// Not a row that scrolls sideways, though: its cards beyond the edge of the screen would
// wait, unseen, until someone scrolled to them.
const isRow = (element) =>
  (element.matches("ul, ol") || element.classList.contains("grid")) &&
  element.childElementCount >= 2 && element.childElementCount <= 12 &&
  !["auto", "scroll"].includes(getComputedStyle(element).overflowX);

const skipped = (element) =>
  element.matches("template, script, dialog, [aria-hidden='true']") ||
  // The menu is drawn by its own script, and a form is not shown piece by piece.
  element.matches("[data-menu], [data-menu-nav], form") ||
  element.querySelector("[data-menu], form") !== null;

function blocks() {
  const found = [];
  const add = (element, step = 0) => {
    if (!skipped(element)) found.push({ element, step });
  };
  const scopes = document.querySelectorAll("main section, main > div:not(.page-hero)");
  for (const scope of scopes) {
    if (scope.closest(".hero, .page-hero, dialog") || scope.parentElement.closest("main section")) continue;
    // The page's content sits in a centred column; a section without one is laid out by
    // its own children (the home page's story: a photo beside the words).
    const columns = scope.matches(".container-x") ? [scope] : [...scope.querySelectorAll(":scope > .container-x")];
    const parents = columns.length > 0 ? columns : [scope];
    for (const parent of parents) {
      for (const child of parent.children) {
        if (skipped(child)) continue;
        if (isRow(child)) [...child.children].forEach((card, index) => add(card, Math.min(index, STAGGER_STEPS)));
        else add(child);
      }
    }
  }
  return found;
}

export function startReveal() {
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const settle = (element) => {
    // The classes go once the movement is over, so the block's own hover effects, which
    // these classes override while they are on it, work again.
    element.classList.remove("reveal", "reveal-in", ...Array.from({ length: STAGGER_STEPS + 1 }, (_, step) => `reveal-${step}`));
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.classList.add("reveal-in");
      setTimeout(settle, SETTLE_MS, entry.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.01 });

  const fold = window.innerHeight * 0.92;
  for (const { element, step } of blocks()) {
    // Already on the first screen: it stays as it is. Hiding it now would be a flicker.
    // A block that is not drawn at all yet (the dishes, until the menu has loaded) has no
    // place on the page; it fades in when it is given one.
    const drawn = element.getClientRects().length > 0;
    if (drawn && element.getBoundingClientRect().top < fold) continue;
    element.classList.add("reveal", `reveal-${step}`);
    observer.observe(element);
  }
}
