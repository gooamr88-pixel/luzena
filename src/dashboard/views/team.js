// Team and access: who may open this restaurant's dashboard, and as what.
//
// Only an owner is shown this page, and only an owner is answered by the routes it calls.
// Everything on it is drawn from the server's answer and redrawn from the answer to each
// change, so the page never shows a role or an invitation the server has not confirmed.
//
// An invitation here carries no password and no secret. The server makes the person an
// account without a password; they choose their own through the sign-in page, sign in, and
// accept. That is why there is nothing on this page to copy and send to anyone.
import { formatDateTime, timeAgo } from "../../js/lib/format.js";
import { api } from "../api.js";
import { CAPABILITIES, ROLE_PERMISSIONS, ROLE_SUMMARIES, ROLE_TONE, roleName } from "../roles.js";
import { state } from "../state.js";
import { append, badge, clear, confirmDialog, errorBlock, formDialog, h, icon, loadingBlock, pageHeader, toast, toastFailure } from "../ui.js";

// Asked before anyone is given the owner role, by invitation or by a change of role: an
// owner can do everything, including taking the asker's own access away.
const confirmOwner = (who, restaurant, invited) => confirmDialog({
  title: invited ? `Invite ${who} as an owner?` : `Make ${who} an owner?`,
  body: [
    `An owner can do everything in the ${restaurant} dashboard that you can: connect or disconnect Clover, export job applications, invite people, and change anyone's role or remove anyone's access, yours included.`,
    "Only make someone an owner if you would trust them with the whole dashboard. You can change it later.",
  ],
  confirmLabel: invited ? "Invite as owner" : "Make owner",
});
// "2 owners, 1 manager, 3 staff"
const roleCounts = (members) => ["owner", "manager", "staff"]
  .map((role) => [role, members.filter((member) => member.role === role).length])
  .filter(([, count]) => count > 0)
  .map(([role, count]) => (role === "staff" ? `${count} staff` : `${count} ${roleName(role).toLowerCase()}${count === 1 ? "" : "s"}`))
  .join(", ");
const INVITATION_STATUS = {
  pending: ["Waiting", "info"],
  expired: ["Expired", "warn"],
  revoked: ["Cancelled", ""],
};

const day = (value) => new Intl.DateTimeFormat(state.locale, { dateStyle: "medium" }).format(new Date(value));
const roleChoices = (roles) => roles.map((role) => ({ value: role, label: roleName(role) }));
// "Manager: runs the menu... Staff: can look at the menu...", under the list of roles.
const roleNotes = (roles) => roles.map((role) => `${roleName(role)}: ${ROLE_SUMMARIES[role]}`).join(" ");

export async function teamView(outlet) {
  const region = h("div", {}, loadingBlock("Loading the team"));
  const invite = h("button", { type: "button", class: "d-btn d-btn-primary", disabled: true }, icon("userPlus", 16), "Invite someone");
  append(outlet,
    pageHeader({ title: "Team & access", actions: invite }),
    h("p", { class: "-mt-3 mb-6 max-w-2xl text-sm text-muted" },
      `Who can sign in to the ${state.me.restaurant.name} dashboard, and what each person can do there. Only owners see this page.`),
    region);

  let team = null;

  // Runs one change, shows the server's message, and redraws from the server's answer. The
  // button that started it is off meanwhile, so a second press cannot send it twice.
  async function change(button, work) {
    button.disabled = true;
    try {
      const result = await work();
      team = result.team;
      toast(result.message, result.email_sent === false ? "warn" : "ok");
      draw();
    } catch (failure) {
      toastFailure(failure);
      button.disabled = false;
      // Someone else may have changed the team meanwhile: show what is true now.
      if ([404, 409, 410].includes(failure.status)) load();
    }
  }

  function openInvite() {
    formDialog({
      title: "Invite someone",
      intro: `They get an email saying you invited them to the ${state.me.restaurant.name} dashboard and how to sign in. They choose their own password: none is sent, and you never see it. The invitation stays open for ${team.limits.invitation_days} days.`,
      submitLabel: "Send invitation",
      fields: [
        { name: "email", label: "Their email address", type: "email", required: true, maxlength: 254, placeholder: "name@example.com", inputmode: "email" },
        // Manager to begin with: the role that gives everything is never the default.
        { name: "role", label: "Role", options: roleChoices(team.roles), value: team.roles.includes("manager") ? "manager" : team.roles[0], required: true, hint: roleNotes(team.roles) },
      ],
      onSubmit: async (values) => {
        if (values.role === "owner" && !(await confirmOwner(values.email.trim(), state.me.restaurant.name, true))) return false;
        const result = await api("POST", "/team/invitations", { email: values.email.trim(), role: values.role });
        team = result.team;
        toast(result.message, result.email_sent === false ? "warn" : "ok");
        draw();
      },
    });
  }
  invite.addEventListener("click", openInvite);

  function memberRow(member) {
    const you = member.id === team.you;
    const name = member.email ?? "Address not recorded yet";
    const actions = [];
    // Anyone but yourself, owners included. The server keeps at least one owner whatever
    // is asked, and nobody can change their own access.
    if (!you && team.roles.length > 0) {
      const changeRole = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Change role", h("span", { class: "sr-only" }, ` of ${name}`));
      changeRole.addEventListener("click", () => {
        formDialog({
          title: `Change ${name}'s role`,
          intro: `What ${name} can do in the ${state.me.restaurant.name} dashboard. It takes effect the next time they do anything.`,
          submitLabel: "Save role",
          fields: [{ name: "role", label: "Role", options: roleChoices(team.roles), value: member.role, required: true, hint: roleNotes(team.roles) }],
          onSubmit: async (values) => {
            if (values.role === "owner" && member.role !== "owner" && !(await confirmOwner(name, state.me.restaurant.name, false))) return false;
            const result = await api("PATCH", `/team/members/${member.id}`, { role: values.role });
            team = result.team;
            toast(result.message);
            draw();
          },
        });
      });
      const remove = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Remove access", h("span", { class: "sr-only" }, ` of ${name}`));
      remove.addEventListener("click", async () => {
        const confirmed = await confirmDialog({
          title: `Remove ${name}'s access?`,
          body: [
            `${name} will no longer be able to open the ${state.me.restaurant.name} dashboard, starting now, including on a device where they are signed in.`,
            member.role === "owner" ? `${name} is an owner. The restaurant keeps its other owners, you among them.` : null,
            "Nothing else is deleted: the menu, the applications and the record of what they changed all stay. You can invite them again later.",
          ].filter(Boolean),
          confirmLabel: "Remove access", danger: true,
        });
        if (confirmed) change(remove, () => api("DELETE", `/team/members/${member.id}`));
      });
      actions.push(changeRole, remove);
    }
    return h("li", { class: "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 sm:px-5", dataset: { member: member.id } },
      h("div", { class: "min-w-0" },
        h("p", { class: "flex flex-wrap items-center gap-2 font-semibold" },
          h("span", { class: "break-all" }, name), you && badge("You")),
        h("p", { class: "mt-0.5 text-[0.82rem] text-muted" },
          `Joined ${day(member.joined_at)}`,
          member.invited_by_email ? `, invited by ${member.invited_by_email}` : "",
          member.last_seen_at ? `. Last opened the dashboard ${timeAgo(member.last_seen_at)}.` : ". Has not opened the dashboard yet."),
        you && h("p", { class: "mt-0.5 text-[0.82rem] text-muted" }, "Your own access is changed by another owner, never by you, so nobody locks themselves out by mistake.")),
      h("div", { class: "flex flex-wrap items-center gap-2" }, badge(roleName(member.role), ROLE_TONE[member.role]), actions));
  }

  function invitationRow(invitation) {
    const [label, tone] = INVITATION_STATUS[invitation.status] ?? [invitation.status, ""];
    const open = invitation.status === "pending" || invitation.status === "expired";
    const actions = [];
    if (open) {
      const resend = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Send again", h("span", { class: "sr-only" }, ` to ${invitation.email}`));
      resend.addEventListener("click", () => change(resend, () => api("POST", `/team/invitations/${invitation.id}/resend`)));
      const cancel = h("button", { type: "button", class: "d-btn d-btn-sm" }, "Cancel invitation", h("span", { class: "sr-only" }, ` to ${invitation.email}`));
      cancel.addEventListener("click", async () => {
        const confirmed = await confirmDialog({
          title: `Cancel the invitation to ${invitation.email}?`,
          body: [
            `${invitation.email} will not be able to accept it, and gets no access to the ${state.me.restaurant.name} dashboard.`,
            "You can invite them again later.",
          ],
          confirmLabel: "Cancel invitation", cancelLabel: "Keep it", danger: true,
        });
        if (confirmed) change(cancel, () => api("DELETE", `/team/invitations/${invitation.id}`));
      });
      actions.push(resend, cancel);
    }
    const when = invitation.status === "pending"
      ? `Open until ${day(invitation.expires_at)}.`
      : invitation.status === "expired"
        ? `Ran out on ${day(invitation.expires_at)}. Send it again to open it for another ${team.limits.invitation_days} days.`
        : `Cancelled on ${day(invitation.revoked_at)}. It can no longer be accepted.`;
    return h("li", { class: "flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 sm:px-5", dataset: { invitation: invitation.id } },
      h("div", { class: "min-w-0" },
        h("p", { class: "font-semibold break-all" }, invitation.email),
        h("p", { class: "mt-0.5 text-[0.82rem] text-muted" },
          `Invited as ${roleName(invitation.role)}`,
          invitation.invited_by_email ? ` by ${invitation.invited_by_email}` : "",
          ` on ${formatDateTime(invitation.created_at, state.locale)}. `, when),
        open && invitation.email_status === "failed" && h("p", { class: "mt-1 text-[0.82rem] font-medium text-bad" },
          "The invitation email could not be sent. Send it again, or tell them to open the dashboard and choose \"Forgot your password?\" with this address.")),
      h("div", { class: "flex flex-wrap items-center gap-2" }, badge(label, tone), actions));
  }

  function rolesTable() {
    const roles = ["owner", "manager", "staff"];
    return h("section", { class: "d-card mt-5", "aria-labelledby": "roles-title" },
      h("div", { class: "p-5 sm:p-6" },
        h("h2", { id: "roles-title", class: "d-title" }, "What each role can do"),
        h("p", { class: "mt-1 text-sm text-muted" }, "Checked by the server on every action, whatever a person's screen shows.")),
      h("div", { class: "overflow-x-auto border-t border-line" },
        h("table", { class: "d-table" },
          h("caption", { class: "sr-only" }, "What an owner, a manager and a member of staff can do"),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "In the dashboard"), roles.map((role) => h("th", { scope: "col", class: "text-center" }, roleName(role))))),
          h("tbody", {}, CAPABILITIES.map((capability) => h("tr", {},
            h("th", { scope: "row", class: "text-left font-normal" }, capability.label),
            roles.map((role) => {
              const allowed = ROLE_PERMISSIONS[role].includes(capability.permission);
              return h("td", { class: `text-center ${allowed ? "font-semibold text-ok" : "text-muted"}` }, allowed ? "Yes" : "No");
            })))))));
  }

  function draw() {
    invite.disabled = team.roles.length === 0;
    const waiting = team.invitations.filter((invitation) => invitation.status === "pending").length;
    clear(region);
    append(region,
      h("section", { class: "d-card", "aria-labelledby": "members-title" },
        h("div", { class: "flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6" },
          h("h2", { id: "members-title", class: "d-title" }, "People with access"),
          h("p", { class: "text-sm text-muted", dataset: { roleCounts: "" } },
            `${team.members.length === 1 ? "1 person" : `${team.members.length} people`}: ${roleCounts(team.members)}`)),
        h("ul", { class: "divide-y divide-line border-t border-line" }, team.members.map(memberRow))),

      h("section", { class: "d-card mt-5", "aria-labelledby": "invitations-title" },
        h("div", { class: "flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6" },
          h("h2", { id: "invitations-title", class: "d-title" }, "Invitations"),
          h("p", { class: "text-sm text-muted" }, waiting === 0 ? "None waiting" : waiting === 1 ? "1 waiting" : `${waiting} waiting`)),
        team.invitations.length === 0
          ? h("p", { class: "border-t border-line px-5 py-6 text-sm text-muted sm:px-6" },
              "No invitations are waiting. Use \"Invite someone\" to give an owner, a manager or a member of staff their own sign-in, so that nobody shares yours.")
          : h("ul", { class: "divide-y divide-line border-t border-line" }, team.invitations.map(invitationRow))),

      rolesTable());
  }

  async function load() {
    try {
      team = await api("GET", "/team");
      draw();
    } catch (failure) {
      clear(region);
      append(region, errorBlock(failure, () => { clear(region); append(region, loadingBlock("Loading the team")); load(); }));
    }
  }

  await load();
}
