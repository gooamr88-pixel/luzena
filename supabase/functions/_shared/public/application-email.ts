// The email that tells the restaurant a job application has arrived.
//
// It is a notification, not the record: the application is already in the database, and the
// email links to it in the dashboard, where the reader has to sign in. So it carries a
// summary only. The CV is not attached and the applicant's free text is not quoted: those
// stay behind the sign-in.
import type { EmailMessage } from "../types.ts";
import { label } from "./application-fields.ts";

export interface ApplicationSummary {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  position: string;
  employmentType: string;
  availability: string[];
  startWhen: string;
  experienceLevel: string;
  workAuthorized: boolean;
  hasCv: boolean;
  hasMessage: boolean;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function applicationEmail(
  restaurantName: string,
  application: ApplicationSummary,
  dashboardUrl: string,
): Pick<EmailMessage, "subject" | "text" | "html"> {
  const rows: [string, string][] = [
    ["Name", application.fullName],
    ["Position", application.position],
    ["Email", application.email],
    ["Phone", application.phone],
    ["Looking for", label("employment_type", application.employmentType)],
    ["Available", application.availability.map((slot) => label("availability", slot)).join(", ")],
    ["Can start", label("start_when", application.startWhen)],
    ["Experience", label("experience_level", application.experienceLevel)],
    ["Authorized to work in the US", application.workAuthorized ? "Yes" : "No"],
    ["Resume / CV", application.hasCv ? "Uploaded. Download it in the dashboard." : "Not provided"],
    ["Introduction", application.hasMessage ? "Written. Read it in the dashboard." : "Not provided"],
  ];
  const width = Math.max(...rows.map(([term]) => term.length)) + 2;

  const text = [
    `NEW JOB APPLICATION for ${restaurantName}`,
    "",
    `${application.fullName} has applied for ${application.position}.`,
    "",
    ...rows.map(([term, value]) => `${`${term}:`.padEnd(width)} ${value}`),
    "",
    "Open the full application, download the CV and set its status:",
    dashboardUrl,
    "You will be asked to sign in.",
    "",
    `Reference: ${application.id}`,
  ].join("\n");

  const cell = "padding:9px 0;border-bottom:1px solid #e6dfd3;font-size:14px;line-height:1.45;vertical-align:top;";
  const html = [
    '<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f6f4f0;font-family:Arial,Helvetica,sans-serif;color:#2b211e;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f0;padding:24px 12px;"><tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6dfd3;border-radius:12px;overflow:hidden;">',
    '<tr><td style="background:#18120f;padding:22px 28px;">',
    '<p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c9a063;font-weight:bold;">New job application</p>',
    `<p style="margin:6px 0 0;font-size:20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${escapeHtml(restaurantName)}</p>`,
    "</td></tr>",
    '<tr><td style="padding:26px 28px 8px;">',
    `<p style="margin:0 0 18px;font-size:16px;line-height:1.5;"><strong>${escapeHtml(application.fullName)}</strong> has applied for <strong>${escapeHtml(application.position)}</strong>.</p>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">',
    ...rows.map(([term, value]) =>
      `<tr><td style="${cell}color:#6e645c;width:42%;padding-right:12px;">${escapeHtml(term)}</td><td style="${cell}font-weight:bold;">${escapeHtml(value)}</td></tr>`),
    "</table>",
    "</td></tr>",
    '<tr><td style="padding:20px 28px 26px;">',
    `<a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#c9a063;color:#18120f;font-size:15px;font-weight:bold;text-decoration:none;padding:13px 22px;border-radius:6px;">Open the application</a>`,
    '<p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#6e645c;">You will be asked to sign in to the dashboard. The full application, the CV and the applicant\'s own words are kept there, not in this email.</p>',
    `<p style="margin:14px 0 0;font-size:12px;color:#6e645c;">Reference: ${escapeHtml(application.id)}</p>`,
    "</td></tr>",
    "</table></td></tr></table></body></html>",
  ].join("");

  return { subject: `New Job Application — ${application.fullName} — ${application.position}`, text, html };
}
