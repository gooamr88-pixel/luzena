// Sign-in, password reset request, and setting a new password. Authentication itself is
// Supabase Auth; this file only draws the forms.
import { state } from "../state.js";
import { append, clear, h } from "../ui.js";

const restaurantName = document.documentElement.dataset.restaurantName || "Restaurant";
const logoUrl = document.documentElement.dataset.logo || "";

function shell(app, title, intro, form) {
  clear(app);
  // The public site's dark hero: the logo in white over the glow and the leaf, with the
  // form on a card beneath it.
  append(app, h("main", { class: "d-auth" },
    h("div", { class: "d-leaf absolute top-1/2 -right-28 -z-10 size-[26rem] -translate-y-1/2 opacity-[0.07] sm:right-[6%] sm:size-[32rem]", "aria-hidden": "true" }),
    h("div", { class: "w-full max-w-sm" },
      h("div", { class: "d-dark mb-7 text-center" },
        logoUrl
          ? h("img", { src: logoUrl, alt: restaurantName, class: "d-logo-light mx-auto h-16 w-auto" })
          : h("p", { class: "font-display text-3xl" }, restaurantName),
        h("p", { class: "d-section-title mt-4" }, "Owner dashboard")),
      h("div", { class: "d-card p-6 sm:p-8" },
        h("h1", { class: "text-[1.75rem] sm:text-[1.75rem]" }, title),
        intro && h("p", { class: "mt-2 text-sm text-muted" }, intro),
        form))));
}

function field(id, label, attributes) {
  const input = h("input", { class: "d-input", id, name: id, required: true, ...attributes });
  return { input, node: h("div", {}, h("label", { class: "d-label", for: id }, label), input) };
}

async function withBusy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

export function loginView(app, notice) {
  const email = field("email", "Email", { type: "email", autocomplete: "username", inputmode: "email" });
  const password = field("password", "Password", { type: "password", autocomplete: "current-password" });
  const message = h("div", { class: `d-alert ${notice ? "d-alert-info" : "d-alert-bad"}`, role: "alert", hidden: !notice }, notice ?? "");
  const submit = h("button", { type: "submit", class: "d-btn d-btn-primary w-full" }, "Sign in");
  const form = h("form", { class: "mt-6 space-y-4" }, message, email.node, password.node, submit,
    h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm w-full", onClick: () => resetRequestView(app) }, "Forgot your password?"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    message.hidden = true;
    withBusy(submit, "Signing in...", async () => {
      const { error } = await state.supabase.auth.signInWithPassword({
        email: email.input.value.trim(), password: password.input.value,
      });
      if (error) {
        // One message for every failure, so the form does not reveal which emails exist.
        message.className = "d-alert d-alert-bad";
        message.textContent = error.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : "The email or password is not correct.";
        message.hidden = false;
        password.input.value = "";
        password.input.focus();
      }
    });
  });
  shell(app, "Sign in", null, form);
  email.input.focus();
}

function resetRequestView(app) {
  const email = field("email", "Email", { type: "email", autocomplete: "username", inputmode: "email" });
  const message = h("div", { class: "d-alert d-alert-info", role: "status", hidden: true });
  const submit = h("button", { type: "submit", class: "d-btn d-btn-primary w-full" }, "Send reset link");
  const form = h("form", { class: "mt-6 space-y-4" }, message, email.node, submit,
    h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm w-full", onClick: () => loginView(app) }, "Back to sign in"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(submit, "Sending...", async () => {
      await state.supabase.auth.resetPasswordForEmail(email.input.value.trim(), {
        redirectTo: `${location.origin}/dashboard/`,
      });
      // Same answer whether or not the address has an account.
      message.textContent = "If that address has an account, a reset link is on its way.";
      message.hidden = false;
    });
  });
  shell(app, "Reset password", "Enter your email and we will send you a link to set a new password.", form);
  email.input.focus();
}

export function setPasswordView(app) {
  const password = field("new-password", "New password", { type: "password", autocomplete: "new-password", minlength: 12 });
  const confirm = field("confirm-password", "Repeat the new password", { type: "password", autocomplete: "new-password", minlength: 12 });
  const message = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "d-btn d-btn-primary w-full" }, "Save password");
  const form = h("form", { class: "mt-6 space-y-4" }, message, password.node,
    h("p", { class: "d-hint -mt-2" }, "At least 12 characters."), confirm.node, submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    message.hidden = true;
    const fail = (text) => { message.textContent = text; message.hidden = false; };
    if (password.input.value.length < 12) return fail("Use at least 12 characters.");
    if (password.input.value !== confirm.input.value) return fail("The two passwords do not match.");
    withBusy(submit, "Saving...", async () => {
      const { error } = await state.supabase.auth.updateUser({ password: password.input.value });
      if (error) return fail("The password could not be saved. Request a new reset link and try again.");
      // Signing out ends the recovery session; the owner signs in with the new password.
      state.passwordChanged = true;
      await state.supabase.auth.signOut();
    });
  });
  shell(app, "Set a new password", null, form);
  password.input.focus();
}

// The second step of signing in, for an account that has two-step sign-in on: the password
// was right, and now the code from the authenticator app is asked for. Supabase Auth checks
// the code; a right one raises the session to the level the backend requires. Until then
// nothing of the dashboard is drawn, and the backend would refuse this session anyway.
export function secondStepView(app, onVerified) {
  const code = field("code", "Code from your authenticator app", {
    type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6,
  });
  code.input.classList.add("text-center", "font-mono", "text-lg", "tracking-[0.3em]");
  const message = h("div", { class: "d-alert d-alert-bad", role: "alert", hidden: true });
  const submit = h("button", { type: "submit", class: "d-btn d-btn-primary w-full" }, "Verify");
  const form = h("form", { class: "mt-6 space-y-4", novalidate: true }, message, code.node, submit,
    h("button", { type: "button", class: "d-btn d-btn-quiet d-btn-sm w-full", onClick: () => state.supabase.auth.signOut() }, "Sign out"));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    message.hidden = true;
    const fail = (text) => {
      message.textContent = text;
      message.hidden = false;
      code.input.value = "";
      code.input.focus();
    };
    const entered = code.input.value.replace(/\s+/g, "");
    if (!/^[0-9]{6}$/.test(entered)) return fail("Enter the six digits the app shows.");
    withBusy(submit, "Checking...", async () => {
      const mfa = state.supabase.auth.mfa;
      const factors = await mfa.listFactors();
      const factor = (factors.data?.totp ?? [])[0];
      if (factors.error || !factor) return fail("The code could not be checked. Check your connection and try again.");
      const { error } = await mfa.challengeAndVerify({ factorId: factor.id, code: entered });
      // One message whatever the reason, as for a wrong password.
      if (error) return fail("That code was not accepted. Codes change every 30 seconds: enter the one showing now.");
      await onVerified();
    });
  });
  shell(app, "Enter your code", "Two-step sign-in is on for this account. Open your authenticator app and enter the six-digit code it shows for this website.", form);
  code.input.focus();
}
