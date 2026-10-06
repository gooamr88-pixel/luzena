import type { CloverEnvironment } from "../types.ts";

// Hosts from Clover's OAuth and REST documentation (checked 2026-10-04).
// `web` serves the merchant-facing authorize page; `api` serves tokens and the REST API.
export const CLOVER_HOSTS: Record<CloverEnvironment, { web: string; api: string }> = {
  sandbox: { web: "https://sandbox.dev.clover.com", api: "https://apisandbox.dev.clover.com" },
  na: { web: "https://www.clover.com", api: "https://api.clover.com" },
  eu: { web: "https://www.eu.clover.com", api: "https://api.eu.clover.com" },
  la: { web: "https://www.la.clover.com", api: "https://api.la.clover.com" },
};

export const USER_AGENT = "luzna-web/0.1 (restaurant website integration)";

// Documented limits: 16 requests/second and 5 concurrent requests per token.
export const MAX_CONCURRENT_PER_TOKEN = 3;
// Documented maximum page size for inventory list endpoints.
export const PAGE_LIMIT = 1000;
// Stops a runaway pagination loop. 50 pages of 1000 is far beyond a restaurant menu.
export const MAX_PAGES = 50;
