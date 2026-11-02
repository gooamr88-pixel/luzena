// The answer of the public-site function: the photos the owner has chosen in the dashboard
// and the special offers to show. Asked for once per page, however many scripts need it.
// Null when there is no backend or no answer; each script then keeps what the page was
// built with.
const { siteUrl = "" } = document.documentElement.dataset;
let answer = null;

export function siteData() {
  if (!siteUrl) return Promise.resolve(null);
  answer ??= fetch(siteUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return answer;
}
