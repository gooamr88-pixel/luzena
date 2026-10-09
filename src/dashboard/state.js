// Shared, in-memory state of the dashboard. Nothing here is persisted by this code; the
// Supabase client keeps its own session.
export const state = {
  supabase: null,
  apiBase: "",
  me: null,
  locale: document.documentElement.dataset.locale || "en-US",
  // Set by a view that has unsaved edits. Navigation asks it before leaving.
  leaveGuard: null,
  // True between a successful password change and the sign-out that follows it.
  passwordChanged: false,
};

export const currency = () => state.me?.restaurant.currency ?? "USD";
export const can = (permission) => state.me?.permissions.includes(permission) ?? false;
