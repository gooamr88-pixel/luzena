// Behaviour shared by every public page: the mobile navigation.
const dialog = document.getElementById("mobile-nav");
const openButton = document.querySelector("[data-nav-open]");

if (dialog && openButton) {
  // <dialog>.showModal() gives focus trapping, Escape to close, and makes the rest of the
  // page inert, without any custom focus management.
  openButton.addEventListener("click", () => dialog.showModal());
  dialog.querySelector("[data-nav-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => openButton.focus());
  // The panel only exists below the lg breakpoint. Close it if the window grows past it.
  window.matchMedia("(min-width: 64rem)").addEventListener("change", (event) => {
    if (event.matches && dialog.open) dialog.close();
  });
}
