// Account security: two-step sign-in with an authenticator app.
//
// This is Supabase Auth's own multi-factor sign-in, used through its client. Supabase makes
// the secret, shows it once here as a QR code for the owner's app to read, and checks every
// code. This page keeps none of it: not in the dashboard's state, not in the browser's
// storage, and it is never sent to this system's own backend. Once it is on, the backend
// refuses any session that has not entered a code (see session.ts).
import { state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, h, loadingBlock, pageHeader, toast } from "../ui.js";
import { formatDateTime } from "../../js/lib/format.js";

const CODE = /^[0-9]{6}$/;
// What Supabase's answers are turned into for the owner. Its own wording is not shown.
const TRY_AGAIN = "That code was not accepted. Codes change every 30 seconds: enter the one showing now.";

export async function securityView(outlet) {
  const region = h("div", {}, loadingBlock("Loading security settings"));
  append(outlet,
    pageHeader({ title: "Account security" }),
    h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
      "How this account signs in to the dashboard. These settings are for your own account, ", state.me?.user.email ?? "", ", and no one else's."),
    region);
  const mfa = state.supabase.auth.mfa;

  // The page is drawn from what Supabase says is on the account, asked afresh each time.
  async function load() {
    const { data, error } = await mfa.listFactors();
    if (error) throw new Error("The security settings could not be read. Check your connection and try again.");
    return { on: (data.totp ?? [])[0] ?? null, unfinished: (data.all ?? []).filter((factor) => factor.status !== "verified") };
  }

  function explain() {
    return h("div", { class: "mt-4 space-y-2 text-sm text-muted" },
      h("p", {}, "With two-step sign-in, signing in takes your password and a six-digit code from an app on your phone. Someone who learns your password still cannot get in."),
      h("p", {}, "This dashboard holds job applicants' details and controls what the website shows, so it is worth turning on."));
  }

  // Step two of turning it on: Supabase has made a secret; the owner's app has to learn it
  // and prove it by giving a code.
  function setup(factor) {
    const code = h("input", {
      class: "d-input max-w-40 text-center font-mono text-lg tracking-[0.3em]", id: "setup-code", name: "code", type: "text",
      inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, required: true, "aria-describedby": "setup-code-hint",
    });
    const message = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
    const confirm = h("button", { type: "submit", class: "d-btn d-btn-primary" }, "Turn on");
    const cancel = h("button", { type: "button", class: "d-btn d-btn-quiet" }, "Cancel");
    const qr = String(factor.totp.qr_code ?? "");
    const form = h("form", { class: "mt-5 space-y-5", novalidate: true },
      h("ol", { class: "space-y-5 text-sm" },
        h("li", {},
          h("p", { class: "font-semibold text-text" }, "1. Open an authenticator app on your phone"),
          h("p", { class: "mt-1 text-muted" }, "Google Authenticator, Microsoft Authenticator, 1Password and Authy all work. Install one if you have none.")),
        h("li", {},
          h("p", { class: "font-semibold text-text" }, "2. Add this account to it"),
          h("p", { class: "mt-1 text-muted" }, "Scan this code with the app:"),
          h("img", {
            class: "mt-3 size-44 rounded-lg border border-line bg-white p-2", alt: "QR code to scan with your authenticator app",
            src: qr.startsWith("data:") ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`, width: 176, height: 176,
          }),
          h("p", { class: "mt-3 text-muted" }, "Or type this key into the app instead:"),
          h("p", { class: "mt-1" }, h("code", { class: "rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[0.9rem] break-all text-text", dataset: { setupKey: "" } }, factor.totp.secret)),
          h("p", { class: "d-hint" }, "It is shown this once. Anyone who has it can make your codes, so do not share it.")),
        h("li", {},
          h("label", { class: "block font-semibold text-text", for: "setup-code" }, "3. Enter the six-digit code the app shows"),
          h("div", { class: "mt-2" }, code),
          h("p", { class: "d-hint", id: "setup-code-hint" }, "This proves the app is set up before anything is switched on."))),
      message,
      h("div", { class: "flex flex-wrap gap-2" }, confirm, cancel));

    cancel.addEventListener("click", async () => {
      // The half-made factor is taken off the account again.
      await mfa.unenroll({ factorId: factor.id }).catch(() => {});
      draw();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      message.hidden = true;
      const entered = code.value.replace(/\s+/g, "");
      if (!CODE.test(entered)) {
        message.textContent = "Enter the six digits the app shows.";
        message.hidden = false;
        return code.focus();
      }
      confirm.disabled = true;
      const { error } = await mfa.challengeAndVerify({ factorId: factor.id, code: entered });
      confirm.disabled = false;
      if (error) {
        message.textContent = TRY_AGAIN;
        message.hidden = false;
        code.value = "";
        return code.focus();
      }
      toast("Two-step sign-in is on. You will be asked for a code each time you sign in.");
      draw();
    });
    return form;
  }

  async function begin(panel, unfinished, trigger) {
    // One setup at a time: a second press would start a second one.
    trigger.hidden = true;
    clear(panel);
    append(panel, loadingBlock("Preparing"));
    // An attempt that was started and left, here or in another tab, is cleared away first.
    for (const stale of unfinished) await mfa.unenroll({ factorId: stale.id }).catch(() => {});
    const { data, error } = await mfa.enroll({ factorType: "totp", friendlyName: `Authenticator app ${new Date().toISOString().slice(0, 16)}` });
    clear(panel);
    if (error || !data?.totp) {
      trigger.hidden = false;
      append(panel, h("div", { class: "d-alert d-alert-bad mt-4", role: "alert" },
        "Two-step sign-in could not be started. It may be switched off for this website: see SECURITY.md, or ask the site administrator."));
      return;
    }
    append(panel, setup(data));
    panel.querySelector("#setup-code")?.focus();
  }

  async function turnOff(factor) {
    const sure = await confirmDialog({
      title: "Turn off two-step sign-in?",
      body: ["Signing in will need only your password again.", "You can turn it back on at any time; your app will need to be set up again."],
      confirmLabel: "Turn off", danger: true,
    });
    if (!sure) return;
    const { error } = await mfa.unenroll({ factorId: factor.id });
    if (error) toast("It could not be turned off. Sign out, sign in again with a code, and try once more.", "bad");
    else toast("Two-step sign-in is off.");
    draw();
  }

  async function draw() {
    clear(region);
    append(region, loadingBlock("Loading security settings"));
    let account;
    try {
      account = await load();
    } catch (failure) {
      clear(region);
      append(region, errorBlock(failure, draw));
      return;
    }
    const panel = h("div", {});
    clear(region);
    append(region, h("div", { class: "space-y-5" },
      h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "two-step-title" },
        h("div", { class: "flex flex-wrap items-start justify-between gap-3" },
          h("h2", { id: "two-step-title", class: "d-title" }, "Two-step sign-in"),
          account.on ? badge("On", "ok") : badge("Off", "warn")),
        account.on
          ? h("div", {},
              h("p", { class: "mt-3 text-sm text-muted" }, "Signing in to this account takes your password and a code from your authenticator app.",
                account.on.created_at ? ` Turned on ${formatDateTime(account.on.created_at, state.locale)}.` : ""),
              h("div", { class: "mt-5" }, h("button", { type: "button", class: "d-btn", onClick: () => turnOff(account.on) }, "Turn off two-step sign-in")))
          : h("div", {}, explain(),
              h("div", { class: "mt-5" }, h("button", { type: "button", class: "d-btn d-btn-primary", onClick: (event) => begin(panel, account.unfinished, event.currentTarget) }, "Turn on two-step sign-in"))),
        panel),
      h("section", { class: "d-card p-5 sm:p-6", "aria-labelledby": "lost-title" },
        h("h2", { id: "lost-title", class: "d-title" }, "If you lose your phone"),
        h("div", { class: "mt-3 space-y-2 text-sm text-muted" },
          h("p", {}, "Without the app you cannot sign in, and there is no code by email or text message. The site administrator can remove two-step sign-in from your account in Supabase; you then sign in with your password and set it up again."),
          h("p", {}, "Moving to a new phone? Turn two-step sign-in off here first, then on again with the new phone.")))));
  }

  await draw();
}
