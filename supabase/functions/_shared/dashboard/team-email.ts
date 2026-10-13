// The email that tells someone they have been invited to a restaurant's dashboard.
//
// It carries no password and no invitation token: there is neither. What lets the reader
// in is signing in to their own account, which Supabase Auth checks. The email only says
// who invited them, as what, and how to get in.
//
// For an account nobody has signed in to yet it may carry one link made by Supabase Auth
// for choosing a password. That link works once and for a short time, so the email never
// depends on it: the way that always works ("Forgot your password?") is spelled out too.
import type { EmailMessage } from "../types.ts";

export const ROLE_NAMES: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Staff" };

// What each role can do, in the words the dashboard's team page uses.
export const ROLE_SUMMARIES: Record<string, string> = {
  manager: "You will be able to manage the menu and the website's photos, and read and handle job applications.",
  staff: "You will be able to look at the menu as the dashboard shows it. You will not be able to change anything.",
};

export interface InvitationEmail {
  restaurantName: string;
  role: string;
  inviterEmail: string | null;
  // The dashboard's sign-in page, opened on "set up your access" with the address filled in.
  welcomeUrl: string;
  // Supabase Auth's own single-use link for choosing a password, when one was made.
  passwordLink: string | null;
  // Whether the address had an account before it was invited.
  hasAccount: boolean;
  expiresAt: string;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// "20 October 2026": a date a person reads, in the email's own language.
const longDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso));

export function invitationEmail(invitation: InvitationEmail): Pick<EmailMessage, "subject" | "text" | "html"> {
  const role = ROLE_NAMES[invitation.role] ?? invitation.role;
  const from = invitation.inviterEmail ? `${invitation.inviterEmail} has invited you` : "You have been invited";
  const opening = `${from} to the ${invitation.restaurantName} dashboard as ${role}.`;
  const summary = ROLE_SUMMARIES[invitation.role] ?? "";
  const expires = `This invitation is open until ${longDate(invitation.expiresAt)}.`;

  // Three ways in, depending on what the account already has.
  let steps: string[];
  let button: { label: string; url: string };
  let afterButton: string;
  if (invitation.hasAccount) {
    steps = [
      "Open the dashboard and sign in with this email address and the password you already have.",
      "You will be asked to accept the invitation.",
    ];
    button = { label: "Open the dashboard", url: invitation.welcomeUrl };
    afterButton = "If you do not remember your password, choose \"Forgot your password?\" on the sign-in page.";
  } else if (invitation.passwordLink) {
    steps = [
      "Choose your password with the button below.",
      "Sign in with this email address and that password.",
      "You will be asked to accept the invitation.",
    ];
    button = { label: "Choose your password", url: invitation.passwordLink };
    afterButton = "The button works once, and only for a short time. If it has stopped working, open the dashboard, choose "
      + `"Forgot your password?" and enter this email address: ${invitation.welcomeUrl}`;
  } else {
    steps = [
      "Open the dashboard with the button below.",
      "Ask for a link to choose your password, and follow it.",
      "Sign in. You will be asked to accept the invitation.",
    ];
    button = { label: "Set up your access", url: invitation.welcomeUrl };
    afterButton = "No password is ever sent by email. You choose your own.";
  }

  const text = [
    `INVITATION to the ${invitation.restaurantName} dashboard`,
    "",
    opening,
    summary,
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `${button.label}:`,
    button.url,
    "",
    afterButton,
    "",
    expires,
    "If you were not expecting this, you can ignore it: nothing happens unless you sign in and accept.",
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");

  const html = [
    '<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f6f4f0;font-family:Arial,Helvetica,sans-serif;color:#2b211e;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f0;padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6dfd3;border-radius:12px;overflow:hidden;">',
    '<tr><td style="background:#18120f;padding:22px 28px;">',
    '<p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a063;font-weight:bold;">Dashboard invitation</p>',
    `<p style="margin:6px 0 0;font-size:20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${escapeHtml(invitation.restaurantName)}</p>`,
    "</td></tr>",
    '<tr><td style="padding:26px 28px 6px;">',
    `<p style="margin:0 0 12px;font-size:16px;line-height:1.5;">${escapeHtml(opening)}</p>`,
    summary ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#6e645c;">${escapeHtml(summary)}</p>` : "",
    '<ol style="margin:0 0 6px;padding-left:20px;font-size:14px;line-height:1.6;">',
    ...steps.map((step) => `<li style="margin-bottom:4px;">${escapeHtml(step)}</li>`),
    "</ol>",
    "</td></tr>",
    '<tr><td style="padding:14px 28px 26px;">',
    `<a href="${escapeHtml(button.url)}" style="display:inline-block;background:#c9a063;color:#18120f;font-size:15px;font-weight:bold;text-decoration:none;padding:13px 22px;border-radius:6px;">${escapeHtml(button.label)}</a>`,
    `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#6e645c;">${escapeHtml(afterButton)}</p>`,
    `<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#6e645c;">${escapeHtml(expires)} If you were not expecting this, you can ignore it: nothing happens unless you sign in and accept.</p>`,
    "</td></tr>",
    "</table></td></tr></table></body></html>",
  ].join("");

  return { subject: `You have been invited to the ${invitation.restaurantName} dashboard`, text, html };
}
