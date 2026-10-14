// The emails Supabase Auth itself sends (a password reset, the security notices), in the
// restaurant's name and design, and the mail server it sends them through.
//
// Supabase Auth keeps these in each project's Auth settings, not in this repository, and
// `supabase config push` is never used here (it replaces the whole Auth configuration; see
// supabase/config.toml). So this script is how they are set, one project at a time, and
// the only place their words live.
//
//   PowerShell:  $env:SUPABASE_ACCESS_TOKEN = "<a token for the Supabase account>"
//                node scripts/auth-emails.mjs --project-ref <ref> --dry-run
//                node scripts/auth-emails.mjs --project-ref <ref>
//   With the mail server as well (Brevo's SMTP relay):
//                $env:SMTP_USER = "<login>@smtp-brevo.com"; $env:SMTP_PASS = "<Brevo SMTP key, xsmtpsib-...>"
//                node scripts/auth-emails.mjs --project-ref <ref> --smtp
//
// It changes only the fields named in `authEmailSettings` below (and, with --smtp, the
// mail server and the hourly limit), reads the settings back, and fails if anything else
// changed: the email sign-in switch, sign-ups, two-step sign-in. Secrets are read from the
// environment and never printed.
import { pathToFileURL } from "node:url";

export const RESTAURANT = {
  name: "Luzena Restaurant & Cafe",
  shortName: "Luzena",
  website: "https://luzenarestaurant.com/",
  sender: "info@luzenarestaurant.com",
};

const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// "one hour", "30 minutes": how long a link works, from the project's own setting.
export function lifetime(seconds) {
  if (seconds % 3600 === 0) return seconds === 3600 ? "one hour" : `${seconds / 3600} hours`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "one minute" : `${minutes} minutes`;
}

// One email: the restaurant's dark band, a heading, the words, an optional button with the
// link written out beneath it, and a footer. Inline styles and tables only, as mail
// programs require; no image, no script, nothing fetched. `{{ ... }}` are Supabase's own
// placeholders, filled in when the email is sent; nothing else in here is a placeholder.
function layout({ preview, title, paragraphs, button, after = [], restaurant }) {
  const p = (text, small = false) =>
    `<p style="margin:0 0 ${small ? 12 : 16}px;font-size:${small ? 13 : 15}px;line-height:1.6;color:${small ? "#6e645c" : "#2b211e"};">${text}</p>`;
  const action = button ? [
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;"><tr><td style="border-radius:6px;background:#c9a063;">`,
    `<a href="${button.href}" style="display:inline-block;padding:13px 22px;font-size:15px;font-weight:bold;color:#18120f;text-decoration:none;border-radius:6px;">${button.label}</a>`,
    "</td></tr></table>",
  ].join("") : "";
  const fallback = button?.showLink
    ? p(`If the button does not work, copy this link into your browser:<br><a href="${button.href}" style="color:#835f20;word-break:break-all;">${button.href}</a>`, true)
    : "";
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>`,
    '<body style="margin:0;padding:0;background:#f6f4f0;font-family:Arial,Helvetica,sans-serif;color:#2b211e;">',
    // What mail programs show beside the subject in the inbox list.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preview}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f0;padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6dfd3;border-radius:12px;overflow:hidden;">',
    '<tr><td style="background:#18120f;padding:22px 28px;">',
    '<p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a063;font-weight:bold;">Owner dashboard</p>',
    `<p style="margin:6px 0 0;font-size:20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${escapeHtml(restaurant.name)}</p>`,
    "</td></tr>",
    '<tr><td style="padding:26px 28px 10px;">',
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:normal;color:#18120f;font-family:Georgia,'Times New Roman',serif;">${title}</h1>`,
    ...paragraphs.map((text) => p(text)),
    action,
    ...after.map((text) => p(text, true)),
    fallback,
    "</td></tr>",
    '<tr><td style="padding:16px 28px 24px;border-top:1px solid #e6dfd3;">',
    `<p style="margin:0;font-size:12px;line-height:1.6;color:#6e645c;">${escapeHtml(restaurant.name)} &middot; <a href="${escapeHtml(restaurant.website)}" style="color:#835f20;">${escapeHtml(restaurant.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a><br>`,
    "This email was sent automatically to {{ .Email }}. Replies to it are not read.</p>",
    "</td></tr></table></td></tr></table></body></html>",
  ].join("");
}

// Which of Supabase's placeholders each email may use. Supabase fills in only some of them
// for each kind of email, and an email whose template names one it does not have is not
// sent at all; tests/auth-emails.test.js holds every template to this list.
export const PLACEHOLDERS = {
  recovery: ["ConfirmationURL", "Email"],
  invite: ["ConfirmationURL", "Email"],
  magic_link: ["ConfirmationURL", "Email"],
  confirmation: ["ConfirmationURL", "Email"],
  email_change: ["ConfirmationURL", "Email", "NewEmail"],
  reauthentication: ["Token", "Email"],
  password_changed_notification: ["Email"],
  email_changed_notification: ["Email", "OldEmail"],
  mfa_factor_enrolled_notification: ["Email"],
  mfa_factor_unenrolled_notification: ["Email"],
};

// Every email, keyed as Supabase names it: { subject, content }.
export function authEmails({ restaurant = RESTAURANT, dashboardUrl, linkSeconds }) {
  const dashboard = escapeHtml(dashboardUrl);
  const site = restaurant.shortName;
  const valid = lifetime(linkSeconds);
  const notYou = `If this was not you, open the <a href="${dashboard}" style="color:#835f20;">sign-in page</a> now, choose <strong>Forgot your password?</strong> to set a new one, and tell the restaurant's owner.`;
  return {
    recovery: {
      subject: `Reset your ${site} dashboard password`,
      content: layout({
        restaurant, title: "Reset your password",
        preview: `Choose a new password for the ${site} dashboard. The link works once, for ${valid}.`,
        paragraphs: [`We received a request to reset the password of the ${site} dashboard account for {{ .Email }}.`, "Choose a new password with the button below."],
        button: { label: "Choose a new password", href: "{{ .ConfirmationURL }}", showLink: true },
        after: [
          `The link works once and for ${valid}. If it has run out, choose <strong>Forgot your password?</strong> on the sign-in page to be sent another.`,
          "If you did not ask for this, you can ignore this email: your password stays as it is, and it cannot be changed without this link.",
        ],
      }),
    },
    password_changed_notification: {
      subject: `Your ${site} dashboard password was changed`,
      content: layout({
        restaurant, title: "Your password was changed",
        preview: `The password of your ${site} dashboard account was just changed.`,
        paragraphs: [`The password of the ${site} dashboard account for {{ .Email }} has just been changed.`, "If that was you, there is nothing more to do."],
        after: [notYou],
      }),
    },
    mfa_factor_enrolled_notification: {
      subject: `Two-step sign-in was turned on for your ${site} dashboard account`,
      content: layout({
        restaurant, title: "Two-step sign-in was turned on",
        preview: "From now on, signing in also asks for a code from your authenticator app.",
        paragraphs: [`Two-step sign-in was turned on for the ${site} dashboard account for {{ .Email }}.`, "From now on, signing in asks for your password and then for a code from your authenticator app."],
        after: [notYou],
      }),
    },
    mfa_factor_unenrolled_notification: {
      subject: `Two-step sign-in was turned off for your ${site} dashboard account`,
      content: layout({
        restaurant, title: "Two-step sign-in was turned off",
        preview: "Signing in now asks for your password only.",
        paragraphs: [`Two-step sign-in was turned off for the ${site} dashboard account for {{ .Email }}.`, "Signing in now asks for the password only. You can turn it on again under Security in the dashboard."],
        after: [notYou],
      }),
    },
    email_changed_notification: {
      subject: `Your ${site} dashboard sign-in address was changed`,
      content: layout({
        restaurant, title: "Your sign-in address was changed",
        preview: `The address you sign in to the ${site} dashboard with was changed.`,
        paragraphs: [`The ${site} dashboard account that signed in with {{ .OldEmail }} now signs in with {{ .Email }}.`],
        after: ["If this was not you, tell the restaurant's owner at once."],
      }),
    },
    email_change: {
      subject: `Confirm your new address for the ${site} dashboard`,
      content: layout({
        restaurant, title: "Confirm your new address",
        preview: `Confirm {{ .NewEmail }} as the address you sign in to the ${site} dashboard with.`,
        paragraphs: [`Confirm {{ .NewEmail }} as the address you sign in to the ${site} dashboard with.`],
        button: { label: "Confirm the new address", href: "{{ .ConfirmationURL }}", showLink: true },
        after: [`The link works once and for ${valid}. If you did not ask for this, ignore this email: nothing changes.`],
      }),
    },
    invite: {
      subject: `You have been invited to the ${site} dashboard`,
      content: layout({
        restaurant, title: "You have been invited",
        preview: `You have been invited to the ${site} dashboard.`,
        paragraphs: [`You have been invited to the ${site} dashboard. Open it with the button below.`],
        button: { label: "Open the dashboard", href: "{{ .ConfirmationURL }}", showLink: true },
        after: [`The link works once and for ${valid}.`],
      }),
    },
    magic_link: {
      subject: `Your ${site} dashboard sign-in link`,
      content: layout({
        restaurant, title: "Your sign-in link",
        preview: `Sign in to the ${site} dashboard. The link works once, for ${valid}.`,
        paragraphs: [`Sign in to the ${site} dashboard with the button below.`],
        button: { label: "Sign in", href: "{{ .ConfirmationURL }}", showLink: true },
        after: [`The link works once and for ${valid}. If you did not ask for it, ignore this email.`],
      }),
    },
    confirmation: {
      subject: `Confirm your address for the ${site} dashboard`,
      content: layout({
        restaurant, title: "Confirm your address",
        preview: `Confirm the address you will sign in to the ${site} dashboard with.`,
        paragraphs: [`Confirm {{ .Email }} as the address you sign in to the ${site} dashboard with.`],
        button: { label: "Confirm the address", href: "{{ .ConfirmationURL }}", showLink: true },
        after: [`The link works once and for ${valid}. If you did not ask for this, ignore this email.`],
      }),
    },
    reauthentication: {
      subject: `{{ .Token }} is your ${site} dashboard verification code`,
      content: layout({
        restaurant, title: "Your verification code",
        preview: `Your ${site} dashboard verification code.`,
        paragraphs: [
          "Enter this code to confirm that it is you:",
          '<span style="display:inline-block;padding:10px 16px;border-radius:6px;background:#f6f4f0;font-family:Consolas,Menlo,monospace;font-size:22px;letter-spacing:4px;color:#18120f;">{{ .Token }}</span>',
        ],
        after: [`The code works for ${valid}. If you did not ask for it, ignore this email.`],
      }),
    },
  };
}

// The Auth settings for one project: the subjects and templates above, and the
// security notices worth having on. Field names are the Management API's.
export function authEmailSettings(options) {
  const settings = {};
  for (const [kind, email] of Object.entries(authEmails(options))) {
    settings[`mailer_subjects_${kind}`] = email.subject;
    settings[`mailer_templates_${kind}_content`] = email.content;
  }
  settings.mailer_notifications_password_changed_enabled = true;
  settings.mailer_notifications_email_changed_enabled = true;
  settings.mailer_notifications_mfa_factor_enrolled_enabled = true;
  settings.mailer_notifications_mfa_factor_unenrolled_enabled = true;
  return settings;
}

// Fields this script may change. Anything else that differs afterwards is a failure.
const UNTOUCHED = ["external_email_enabled", "disable_signup", "mfa_totp_enroll_enabled", "mfa_totp_verify_enabled", "site_url", "uri_allow_list", "mailer_otp_exp", "password_min_length"];

async function main() {
  const args = process.argv.slice(2);
  const ref = args[args.indexOf("--project-ref") + 1];
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!args.includes("--project-ref") || !/^[a-z0-9]{20}$/.test(ref ?? "") || !token) {
    console.error("Usage: SUPABASE_ACCESS_TOKEN=... node scripts/auth-emails.mjs --project-ref <ref> [--smtp] [--dry-run]");
    process.exit(2);
  }
  const call = async (method, body) => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Supabase answered ${response.status}: ${String(data?.message ?? "").slice(0, 300)}`);
    return data;
  };

  const before = await call("GET");
  const settings = authEmailSettings({ dashboardUrl: before.site_url, linkSeconds: before.mailer_otp_exp });
  if (args.includes("--smtp")) {
    const { SMTP_USER: user, SMTP_PASS: pass } = process.env;
    if (!user || !pass) throw new Error("--smtp needs SMTP_USER and SMTP_PASS in the environment.");
    Object.assign(settings, {
      smtp_host: "smtp-relay.brevo.com", smtp_port: "587", smtp_user: user, smtp_pass: pass,
      smtp_admin_email: RESTAURANT.sender, smtp_sender_name: RESTAURANT.name,
      // One email to an address a minute, as before; 30 an hour in all, which Supabase
      // allows only once its own sender is replaced.
      smtp_max_frequency: 60, rate_limit_email_sent: 30,
    });
  }
  console.log(`Project ${ref}: site ${before.site_url}, links valid ${lifetime(before.mailer_otp_exp)}, ${Object.keys(settings).length} settings to write${args.includes("--smtp") ? " (with the mail server)" : ""}.`);
  if (args.includes("--dry-run")) {
    for (const key of Object.keys(settings)) console.log(`  ${key}${/pass/.test(key) ? " (secret)" : ""}`);
    return;
  }

  await call("PATCH", settings);
  // A project can take some seconds to report the new settings (PRODUCTION did, on
  // 2026-10-14), so the read-back is repeated for up to a minute before it counts as wrong.
  let after;
  let wrong = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10_000));
    after = await call("GET");
    wrong = Object.entries(settings).filter(([key, value]) => key !== "smtp_pass" && String(after[key]) !== String(value)).map(([key]) => key);
    if (wrong.length === 0) break;
  }
  const moved = UNTOUCHED.filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  console.log(wrong.length === 0 ? "Every setting reads back as written." : `NOT as written: ${wrong.join(", ")}`);
  console.log(moved.length === 0 ? `Unchanged, as they must be: ${UNTOUCHED.join(", ")}.` : `CHANGED, and must not have: ${moved.join(", ")}`);
  console.log(`Mail server: ${after.smtp_host ? `${after.smtp_host}:${after.smtp_port}, from "${after.smtp_sender_name}" <${after.smtp_admin_email}>` : "Supabase's own (only reaches the Supabase organisation's members)"}; at most ${after.rate_limit_email_sent} emails an hour.`);
  if (wrong.length > 0 || moved.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
