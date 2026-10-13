// The three roles, in the words the dashboard uses for them, and what each may do.
//
// This is what the Team page SHOWS. What a role may actually do is decided by the server
// (supabase/functions/_shared/dashboard/session.ts) on every request, and nothing here can
// change that. tests/team.test.js compares the table below with the server's own list,
// permission by permission, so the page cannot promise something the server refuses or
// leave out something it allows.

export const ROLE_NAMES = { owner: "Owner", manager: "Manager", staff: "Staff" };

export const ROLE_SUMMARIES = {
  owner: "Everything, including the Clover connection and who else has access.",
  manager: "Runs the menu, the website's photos and hiring. Cannot change the Clover connection, export applications or manage the team.",
  staff: "Can look at the menu in the dashboard. Cannot change anything, and cannot see job applications.",
};

// Each line is one thing a person can do, with the server permission that allows it.
export const CAPABILITIES = [
  { permission: "menu.read", label: "See the menu in the dashboard" },
  { permission: "menu.write", label: "Change items, categories, modifiers and labels" },
  { permission: "site.manage", label: "Change the website's photos and the allergy notice" },
  { permission: "clover.sync", label: "Sync the menu from Clover" },
  { permission: "clover.manage", label: "Connect or disconnect Clover" },
  { permission: "applications.read", label: "Read job applications" },
  { permission: "applications.cv", label: "Download an applicant's CV" },
  { permission: "applications.manage", label: "Change an application's status, add notes, delete it" },
  { permission: "applications.message", label: "Email an applicant from the dashboard" },
  { permission: "applications.export", label: "Export applications to a file" },
  { permission: "activity.read", label: "See the activity log" },
  { permission: "team.manage", label: "Invite people, change roles, remove access" },
];

// Which roles hold each permission: the same table the server keeps. Kept here only so the
// page can be drawn before the server is asked anything, and checked against the server's
// by a test.
export const ROLE_PERMISSIONS = {
  owner: CAPABILITIES.map((capability) => capability.permission),
  manager: ["menu.read", "menu.write", "site.manage", "clover.sync", "applications.read", "applications.cv", "applications.manage", "applications.message", "activity.read"],
  staff: ["menu.read"],
};

export const roleName = (role) => ROLE_NAMES[role] ?? role;
