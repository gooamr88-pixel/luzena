// Loads the public menu. The URL is written into the page at build time; the browser never
// talks to Clover and holds no credentials.

export function menuSettings() {
  const { menuUrl = "", currency = "USD", locale = "en-US" } = document.documentElement.dataset;
  return { menuUrl, currency, locale };
}

export async function fetchMenu(url) {
  if (!url) throw new Error("Menu endpoint is not configured");
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Menu request failed with ${response.status}`);
  const menu = await response.json();
  if (!menu || !Array.isArray(menu.categories)) throw new Error("Menu response has an unexpected shape");
  return menu;
}
