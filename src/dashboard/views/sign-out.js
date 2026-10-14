// Signing out of the dashboard, after asking. The question says which account is signed in
// and as what, what it takes to come back, and offers to end this account's sessions on
// every other device too (Supabase Auth's "global" sign-out), for someone who signed in on a
// shared or lost device. The safe answer, staying signed in, has the focus.
import { roleName } from "../roles.js";
import { state } from "../state.js";
import { h, icon, openDialog } from "../ui.js";

// Whether this account has two-step sign-in on, as Supabase Auth reports it. If the
// question cannot be answered the dialog simply does not mention the code.
async function hasTwoStep() {
  try {
    const { data, error } = await state.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return !error && data?.nextLevel === "aal2";
  } catch {
    return false;
  }
}

// Resolves once the dialog has closed: true when the account was signed out.
export async function askToSignOut() {
  const twoStep = await hasTwoStep();
  const email = state.me?.user.email ?? "";
  const role = state.me?.role;
  // A page with edits not yet saved (the item editor) says so here, in the same question,
  // rather than in a second one after it.
  const unsaved = state.leaveGuard;
  return new Promise((resolve) => {
    let signedOut = false;
    const everywhere = h("input", { type: "checkbox", id: "sign-out-everywhere", class: "mt-0.5 size-4 shrink-0", "aria-describedby": "sign-out-everywhere-hint" });
    const problem = h("div", { class: "d-alert d-alert-bad mt-4", role: "alert", hidden: true });
    const stay = h("button", { type: "button", class: "d-btn", onClick: () => dialog.close() }, "Stay signed in");
    const leave = h("button", { type: "button", class: `d-btn ${unsaved ? "d-btn-danger" : "d-btn-primary"}` }, icon("signOut", 16),
      unsaved ? "Discard changes and sign out" : "Sign out");

    leave.addEventListener("click", async () => {
      problem.hidden = true;
      leave.disabled = true;
      stay.disabled = true;
      const label = leave.lastChild.textContent;
      leave.lastChild.textContent = "Signing out...";
      const scope = everywhere.checked ? "global" : "local";
      // Signing out leaves the page: it must not then ask about the edits a second time.
      state.leaveGuard = null;
      const { error } = (await state.supabase.auth.signOut({ scope }).catch((failure) => ({ error: failure }))) ?? {};
      if (error) {
        state.leaveGuard = unsaved;
        // Nothing has changed: the account is still signed in here, and says so.
        problem.textContent = scope === "global"
          ? "You could not be signed out of your other devices: the sign-in service could not be reached. Check your connection and try again, or sign out of this device only."
          : "You could not be signed out: the sign-in service could not be reached. Check your connection and try again.";
        problem.hidden = false;
        leave.disabled = false;
        stay.disabled = false;
        leave.lastChild.textContent = label;
        return;
      }
      signedOut = true;
      dialog.close();
    });

    const dialog = openDialog(
      h("div", { class: "p-6" },
        h("div", { class: "flex items-start gap-4" },
          h("span", { class: "flex size-11 shrink-0 items-center justify-center rounded-full bg-warn-bg text-warn", "aria-hidden": "true" }, icon("signOut", 20)),
          h("div", { class: "min-w-0" },
            h("h2", { class: "d-title text-lg", id: "sign-out-title" }, "Sign out of the dashboard?"),
            h("p", { class: "mt-2 text-sm text-muted" }, "You are signed in as ",
              h("strong", { class: "break-all text-text" }, email), role ? ` (${roleName(role)})` : "", "."),
            h("p", { class: "mt-2 text-sm text-muted" }, twoStep
              ? "To come back you will need your password and a code from your authenticator app."
              : "To come back you will need your password."))),
        unsaved && h("div", { class: "d-alert d-alert-warn mt-4", role: "alert", dataset: { unsaved: "" } },
          "You have changes on this page that are not saved. Signing out now discards them."),
        h("label", { class: "mt-5 flex items-start gap-2.5 rounded-md border border-line px-3 py-3 text-sm", for: "sign-out-everywhere" }, everywhere,
          h("span", {}, h("span", { class: "font-medium" }, "Also sign out on my other devices"),
            h("span", { class: "mt-0.5 block text-[0.82rem] text-muted", id: "sign-out-everywhere-hint" },
              "Ends every session of this account, for example on a phone or a shared computer. Use it if you signed in somewhere you should not stay signed in."))),
        problem,
        h("div", { class: "mt-6 flex flex-wrap justify-end gap-2" }, stay, leave)),
      { label: "Sign out of the dashboard?", onClose: () => resolve(signedOut) },
    );
    stay.focus();
  });
}
