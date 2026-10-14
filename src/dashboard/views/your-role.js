// "Your role": what the signed-in account is in this restaurant's dashboard, and what that
// lets it do. Drawn from the server's own answer for this session (`/me`: the role and the
// list of permissions the server checks on every request), so it can never promise
// something the server would refuse.
import { CAPABILITIES, ROLE_SUMMARIES, ROLE_TONE, roleName } from "../roles.js";
import { state } from "../state.js";
import { badge, h, icon } from "../ui.js";

export function yourRoleSection() {
  const { role, permissions, restaurant } = state.me;
  const allowed = CAPABILITIES.filter((capability) => permissions.includes(capability.permission));
  const refused = CAPABILITIES.filter((capability) => !permissions.includes(capability.permission));
  const list = (entries, yes) => h("ul", { class: "mt-2 space-y-1.5 text-sm" }, entries.map((capability) =>
    h("li", { class: "flex items-start gap-2" },
      h("span", { class: `mt-0.5 shrink-0 ${yes ? "text-ok" : "text-muted"}`, "aria-hidden": "true" }, yes ? "✓" : "–"),
      h("span", { class: yes ? "" : "text-muted" }, capability.label))));
  return h("section", { class: "d-card mb-5 p-5 sm:p-6", id: "your-role", "aria-labelledby": "your-role-title" },
    h("div", { class: "flex flex-wrap items-center gap-3" },
      h("span", { class: "flex size-9 items-center justify-center rounded-md bg-sand text-brand", "aria-hidden": "true" }, icon("team", 18)),
      h("h2", { id: "your-role-title", class: "d-title" }, "Your role"),
      badge(roleName(role), ROLE_TONE[role])),
    h("p", { class: "mt-3 text-sm" }, `You are signed in as ${role === "owner" ? "an owner" : role === "manager" ? "a manager" : "a member of staff"} of ${restaurant.name}. `,
      h("span", { class: "text-muted" }, ROLE_SUMMARIES[role] ?? "")),
    h("div", { class: "mt-4 grid gap-5 sm:grid-cols-2" },
      h("div", {}, h("h3", { class: "d-section-title" }, "You can"), list(allowed, true)),
      refused.length > 0 && h("div", {}, h("h3", { class: "d-section-title" }, "You cannot"), list(refused, false))),
    h("p", { class: "mt-4 text-[0.82rem] text-muted" }, role === "owner"
      ? "Owners decide who else has access, and as what, on the Team page."
      : "This is checked by the server on every action. If you need to do more, ask an owner of the restaurant."));
}
