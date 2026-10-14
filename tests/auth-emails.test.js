// The emails Supabase Auth sends in the restaurant's name (scripts/auth-emails.mjs). Supabase
// fills in its own placeholders when it sends one; a template that names a placeholder that
// email does not have is not sent at all. So every template is held to the placeholders its
// kind of email has, and to what a mail program will show.
import { describe, expect, it } from "vitest";
import { authEmails, authEmailSettings, lifetime, PLACEHOLDERS, RESTAURANT } from "../scripts/auth-emails.mjs";

const DASHBOARD = "https://luzenarestaurant.com/dashboard/";
const emails = authEmails({ dashboardUrl: DASHBOARD, linkSeconds: 3600 });
const placeholders = (text) => [...text.matchAll(/\{\{\s*\.?([A-Za-z]*)\s*\}\}/g)].map((match) => match[1]);

describe("the emails Supabase Auth sends", () => {
  it("are one for each kind Supabase has, and no other", () => {
    expect(Object.keys(emails).sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
  });

  it("use only the placeholders Supabase fills in for that kind of email, written as Supabase writes them", () => {
    for (const [kind, email] of Object.entries(emails)) {
      for (const text of [email.subject, email.content]) {
        for (const name of placeholders(text)) expect(PLACEHOLDERS[kind], `${kind}: {{ .${name} }}`).toContain(name);
        // Every "{{" is one of those, closed, with the dot Go templates need.
        expect(text.split("{{").length - 1, kind).toBe(placeholders(text).length);
        expect(text.split("}}").length, kind).toBe(text.split("{{").length);
        expect(text, kind).not.toMatch(/\{\{(?! \.[A-Za-z]+ \}\})/);
      }
    }
  });

  it("carry the link or the code the person needs, where they need it", () => {
    for (const kind of ["recovery", "invite", "magic_link", "confirmation", "email_change"]) {
      const { content } = emails[kind];
      // In the button, and written out for a mail program that does not show buttons.
      expect(content.match(/href="\{\{ \.ConfirmationURL \}\}"/g), kind).toHaveLength(2);
      expect(content, kind).toContain(">{{ .ConfirmationURL }}</a>");
    }
    expect(emails.reauthentication.content).toContain("{{ .Token }}");
    expect(emails.reauthentication.subject).toBe("{{ .Token }} is your Luzena dashboard verification code");
    // A notice has no link to act on; it points to the sign-in page, on this project.
    for (const kind of ["password_changed_notification", "mfa_factor_enrolled_notification", "mfa_factor_unenrolled_notification"]) {
      expect(emails[kind].content, kind).not.toContain("ConfirmationURL");
      expect(emails[kind].content, kind).toContain(`href="${DASHBOARD}"`);
    }
  });

  it("say what the password reset is, how long its link works, and what to do if it was not asked for", () => {
    const { subject, content } = emails.recovery;
    expect(subject).toBe("Reset your Luzena dashboard password");
    expect(content).toContain("We received a request to reset the password of the Luzena dashboard account for {{ .Email }}.");
    expect(content).toContain(">Choose a new password</a>");
    expect(content).toContain("The link works once and for one hour.");
    expect(content).toContain("If you did not ask for this, you can ignore this email");
    expect(content).toContain("Choose a new password for the Luzena dashboard. The link works once, for one hour.");
  });

  it("follow the project's own link lifetime", () => {
    expect(lifetime(3600)).toBe("one hour");
    expect(lifetime(7200)).toBe("2 hours");
    expect(lifetime(1800)).toBe("30 minutes");
    expect(lifetime(60)).toBe("one minute");
    expect(authEmails({ dashboardUrl: DASHBOARD, linkSeconds: 1800 }).recovery.content).toContain("The link works once and for 30 minutes.");
  });

  it("are self-contained: no image, no script, no style sheet, nothing fetched, the restaurant's name escaped", () => {
    for (const [kind, { subject, content }] of Object.entries(emails)) {
      expect(content, kind).not.toMatch(/<script|<img|<link|<style|url\(|@import|javascript:/i);
      expect(content, kind).toContain("Luzena Restaurant &amp; Cafe");
      expect(content, kind).not.toContain("Restaurant & Cafe");
      expect(content, kind).toMatch(/^<!doctype html><html lang="en">/);
      // The only addresses in an email: the restaurant's website, the dashboard, and Supabase's link.
      const links = [...content.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      for (const link of links) expect(["https://luzenarestaurant.com/", DASHBOARD, "{{ .ConfirmationURL }}"], `${kind}: ${link}`).toContain(link);
      expect(subject.length, kind).toBeLessThanOrEqual(80);
      expect(subject, kind).not.toMatch(/[\r\n<>]/);
    }
  });

  it("are written to the project with the security notices on, and nothing else", () => {
    const settings = authEmailSettings({ dashboardUrl: DASHBOARD, linkSeconds: 3600 });
    const keys = Object.keys(settings);
    expect(keys.filter((key) => !/^mailer_(subjects|templates|notifications)_/.test(key))).toEqual([]);
    expect(keys.filter((key) => key.startsWith("mailer_notifications_")).sort()).toEqual([
      "mailer_notifications_email_changed_enabled", "mailer_notifications_mfa_factor_enrolled_enabled",
      "mailer_notifications_mfa_factor_unenrolled_enabled", "mailer_notifications_password_changed_enabled",
    ]);
    expect(Object.values(settings).filter((value) => typeof value === "boolean").every(Boolean)).toBe(true);
    expect(settings.mailer_templates_recovery_content).toBe(emails.recovery.content);
    expect(RESTAURANT.sender).toBe("info@luzenarestaurant.com");
  });
});
