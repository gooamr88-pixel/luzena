// Sign-in, password reset request, and setting a new password. Authentication itself is
// Supabase Auth; this file only draws the forms.
import { state } from "../state.js";
import { append, clear, h } from "../ui.js";

const restaurantName = document.documentElement.dataset.restaurantName || "Restaurant";
const logoUrl = document.documentElement.dataset.logo || "";

function shell(app, title, intro, form) {
  clear(app);
  append(app, h("main", { class: "flex min-h-dvh items-center justify-center p-4" },
    h("div", { class: "d-card w-full max-w-sm p-6 sm:p-8" },
      logoUrl && h("img", { src: logoUrl, alt: restaurantName, class: "mb-6 h-14 w-auto" }),
      h("p", { class: "text-[0.7rem] font-semibold tracking-widest text-muted uppercase" }, logoUrl ? "Owner dashboard" : `${restaurantName} dashboard`),
      h("h1", { class: "mt-1 text-2xl" }, title),
      intro && h("p", { class: "mt-2 text-sm text-muted" }, intro),
      form)));
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
      await state.supabase.auth.signOut();
    });
  });
  shell(app, "Set a new password", null, form);
  password.input.focus();
}
