// Home page photo strip: the two arrow buttons. The strip scrolls by touch, trackpad and
// keyboard without this file; the buttons appear only once it runs and only when there are
// more photos than fit.
const strip = document.querySelector("[data-strip]");
const controls = document.querySelector("[data-strip-controls]");

if (strip && controls) {
  const previous = controls.querySelector("[data-strip-prev]");
  const next = controls.querySelector("[data-strip-next]");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // A button at the end of its travel is marked, not disabled: a disabled button would drop
  // the keyboard focus of the person who has just pressed it.
  const update = () => {
    const end = strip.scrollWidth - strip.clientWidth;
    controls.hidden = end <= 1;
    previous.setAttribute("aria-disabled", String(strip.scrollLeft <= 1));
    next.setAttribute("aria-disabled", String(strip.scrollLeft >= end - 1));
  };
  const move = (direction) => strip.scrollBy({
    left: direction * strip.clientWidth * 0.8,
    behavior: reducedMotion.matches ? "auto" : "smooth",
  });

  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  strip.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(strip);
  update();
}
