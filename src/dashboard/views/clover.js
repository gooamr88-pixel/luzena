// Clover connection page: status, connect, reconnect, disconnect, manual sync.
import { formatDateTime, timeAgo } from "../../js/lib/format.js";
import { api, explain } from "../api.js";
import { can, state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, loadingBlock, pageHeader, toast, toastFailure } from "../ui.js";

const NONCE_KEY = "clover_oauth_nonce";
const ENVIRONMENTS = { sandbox: "Sandbox (testing)", na: "Production, North America", eu: "Production, Europe", la: "Production, Latin America" };

export function connectionBadge(connection) {
  if (!connection.connected) return badge("Not connected", "warn");
  if (connection.status === "needs_reauth") return badge("Reconnect needed", "bad");
  if (connection.syncing) return badge("Syncing", "info");
  if (connection.last_error_code) return badge("Last sync failed", "bad");
  return badge("Connected", "ok");
}

// Called once when the browser returns from Clover with ?code=...&merchant_id=...
// Returns a message for the owner. The code is sent to the backend, which does the token
// exchange; this page never sees a token.
export async function completeCloverReturn(params) {
  const nonce = sessionStorage.getItem(NONCE_KEY);
  sessionStorage.removeItem(NONCE_KEY);
  if (!nonce) {
    return { tone: "warn", text: "To connect Clover, press Connect Clover on this page and approve the request." };
  }
  try {
    const result = await api("POST", "/clover/complete", {
      code: params.get("code"),
      merchant_id: params.get("merchant_id"),
      client_id: params.get("client_id"),
      state: params.get("state"),
      nonce,
    });
    return { tone: "ok", text: result.message };
  } catch (failure) {
    return { tone: "bad", text: explain(failure) };
  }
}

export async function cloverView(outlet) {
  const region = h("div", {}, loadingBlock("Loading connection"));
  append(outlet, pageHeader({ title: "Clover connection" }), region);

  const reload = async () => {
    let data;
    try {
      data = await api("GET", "/clover");
    } catch (failure) {
      clear(region);
      append(region, errorBlock(failure, reload));
      return;
    }
    draw(data);
  };

  const run = async (button, busyLabel, work) => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await work();
    } catch (failure) {
      toastFailure(failure);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  const connect = (button) => run(button, "Opening Clover...", async () => {
    const start = await api("POST", "/clover/connect");
    sessionStorage.setItem(NONCE_KEY, start.nonce);
    location.assign(start.authorize_url);
  });

  const sync = (button) => run(button, "Syncing...", async () => {
    const result = await api("POST", "/clover/sync");
    toast(result.message, result.result === "synced" ? "ok" : "warn");
    await reload();
  });

  const disconnect = async (button) => {
    const confirmed = await confirmDialog({
      title: "Disconnect Clover?",
      body: [
        "This system will stop reading from and writing to Clover.",
        "The website keeps showing the menu as it is now, but prices and availability will no longer update, and items cannot be edited here.",
        "Nothing is deleted in Clover. You can reconnect at any time.",
      ],
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!confirmed) return;
    await run(button, "Disconnecting...", async () => {
      const result = await api("POST", "/clover/disconnect");
      toast(result.message);
      await reload();
    });
  };

  // The second way to connect: an API token the merchant creates in their own Clover
  // dashboard. It is sent once to the backend, which checks it with Clover and stores it
  // encrypted. This page keeps nothing: the field is cleared whatever the outcome.
  function tokenForm(reconnecting) {
    const merchant = h("input", {
      class: "d-input", id: "clover-merchant-id", name: "merchant_id", required: true, maxlength: 13,
      autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "13 letters and digits",
    });
    const token = h("input", {
      class: "d-input", id: "clover-api-token", name: "token", type: "password", required: true, maxlength: 200,
      autocomplete: "off", spellcheck: "false",
    });
    const message = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "d-btn d-btn-primary" }, reconnecting ? "Reconnect with this token" : "Connect with this token");
    const form = h("form", { class: "mt-4 space-y-4", novalidate: true },
      message,
      h("div", {}, h("label", { class: "d-label", for: "clover-merchant-id" }, "Merchant ID"), merchant,
        h("p", { class: "d-hint" }, "In Clover: Settings, then View all settings, then Merchants. Also in the address bar of the Clover dashboard.")),
      h("div", {}, h("label", { class: "d-label", for: "clover-api-token" }, "API token"), token,
        h("p", { class: "d-hint" }, "In Clover: Settings, then View all settings, then API tokens. Create a token with Inventory read and write, and Merchant read.")),
      submit);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      message.hidden = true;
      const merchantId = merchant.value.trim().toUpperCase();
      const value = token.value.trim();
      if (!/^[A-Z0-9]{13}$/.test(merchantId)) {
        message.textContent = "The merchant ID is 13 letters and digits.";
        message.hidden = false;
        merchant.focus();
        return;
      }
      if (value.length < 16) {
        message.textContent = "Paste the whole API token.";
        message.hidden = false;
        token.focus();
        return;
      }
      run(submit, "Checking with Clover...", async () => {
        try {
          const result = await api("POST", "/clover/connect-token", { merchant_id: merchantId, token: value });
          token.value = "";
          toast(result.message, "ok");
          await reload();
        } catch (failure) {
          token.value = "";
          message.textContent = explain(failure);
          message.hidden = false;
          token.focus();
        }
      });
    });

    return h("div", { class: "d-card mt-5 p-5" },
      h("h2", { class: "text-base" }, reconnecting ? "Enter a new Clover API token" : "Connect with a Clover API token"),
      h("p", { class: "mt-2 text-sm text-muted" },
        "For a restaurant connecting its own Clover account. The token is created by the account owner in Clover and can be deleted there at any time, which disconnects this website."),
      form);
  }

  function draw({ connection, configured, token_connect: tokenConnect }) {
    const manage = can("clover.manage");
    const row = (term, value) => h("div", { class: "flex flex-wrap justify-between gap-x-6 gap-y-1 border-b border-line py-3 last:border-b-0" },
      h("dt", { class: "text-muted" }, term), h("dd", { class: "text-right font-medium" }, value));
    const when = (value) => (value ? `${formatDateTime(value, state.locale)} (${timeAgo(value)})` : "Never");
    const button = (label, style, handler) => {
      const node = h("button", { type: "button", class: `d-btn ${style}` }, label);
      node.addEventListener("click", () => handler(node));
      return node;
    };

    clear(region);
    append(region, 
      !configured && !tokenConnect && h("div", { class: "d-alert d-alert-warn mb-5" },
        "Clover has not been set up for this website yet. The site administrator needs to finish the Clover settings before a restaurant can connect."),
      connection.status === "needs_reauth" && h("div", { class: "d-alert d-alert-bad mb-5" },
        "Clover no longer accepts the stored authorisation. Reconnect to resume syncing and editing. The website keeps showing the last synced menu."),

      h("div", { class: "d-card p-5" },
        h("div", { class: "flex flex-wrap items-center justify-between gap-3" },
          h("h2", { class: "text-base" }, "Connection"), connectionBadge(connection)),
        h("dl", { class: "mt-3 text-sm" },
          row("Status", !connection.connected ? "Not connected" : connection.status === "active" ? "Active" : "Needs reconnecting"),
          row("Merchant", connection.connected ? (connection.merchant_name ? `${connection.merchant_name} (${connection.merchant_id})` : connection.merchant_id) : "None"),
          row("Environment", connection.connected ? ENVIRONMENTS[connection.environment] ?? connection.environment : "None"),
          row("Connected", connection.connected ? when(connection.connected_at) : "Never"),
          row("Last sync", when(connection.last_sync_finished_at)),
          row("Last successful sync", when(connection.last_success_at)),
          row("Last error", connection.last_error_code
            ? h("span", { class: "text-bad" }, `${connection.last_error_code} at ${formatDateTime(connection.last_error_at, state.locale)}`)
            : "None")),
        h("div", { class: "mt-5 flex flex-wrap gap-2" },
          connection.connected && connection.status === "active" && can("menu.write") && button("Sync now", "d-btn-primary", sync),
          manage && configured && !connection.connected && button("Connect Clover", "d-btn-primary", connect),
          manage && configured && connection.connected && button("Reconnect", connection.status === "needs_reauth" ? "d-btn-primary" : "", connect),
          manage && connection.connected && button("Disconnect", "", disconnect))),

      manage && tokenConnect && (!connection.connected || connection.status === "needs_reauth")
        && tokenForm(connection.connected),

      h("div", { class: "d-card mt-5 p-5 text-sm" },
        h("h2", { class: "text-base" }, "How Clover and this dashboard work together"),
        h("ul", { class: "mt-3 list-disc space-y-2 pl-5 text-muted" },
          h("li", {}, h("strong", { class: "text-text" }, "Stored in Clover: "), "item names, prices, availability, categories and their order, modifier groups and modifiers. Saving these here writes to Clover immediately, so the register and online ordering change too."),
          h("li", {}, h("strong", { class: "text-text" }, "Stored by this website: "), "descriptions, photos, featured items, dietary labels, whether something is shown on the website, and archiving. Clover has no fields for these, so they never reach Clover."),
          h("li", {}, h("strong", { class: "text-text" }, "Nothing is published automatically: "), "an item imported from Clover stays hidden from the website until you show it in Items. Hiding or archiving an item here never changes or deletes it in Clover."),
          h("li", {}, "Changes made in Clover appear here after the next sync, which runs automatically and can be started with Sync now."))),
    );
  }

  await reload();
}
