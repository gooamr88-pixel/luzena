// The choices an applicant picks from, and the stages an application moves through.
// One list for the form handler, the notification email and the dashboard API. The values
// are also check constraints in the database (migration 20261006000700), and the labels
// are repeated for the browser in src/js/lib/application.js; a test keeps the two in step.

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "either"] as const;
export const AVAILABILITY = ["weekday_days", "weekday_evenings", "weekend_days", "weekend_evenings", "late_nights"] as const;
export const START_WHEN = ["immediately", "two_weeks", "one_month", "later"] as const;
export const EXPERIENCE_LEVELS = ["none", "under_1", "1_2", "3_5", "over_5"] as const;
export const STATUSES = ["new", "reviewing", "shortlisted", "interview", "hired", "rejected"] as const;

export type ApplicationStatus = (typeof STATUSES)[number];

export const LABELS: Record<string, Record<string, string>> = {
  employment_type: { full_time: "Full-time", part_time: "Part-time", either: "Full-time or part-time" },
  availability: {
    weekday_days: "Weekday days", weekday_evenings: "Weekday evenings", weekend_days: "Weekend days",
    weekend_evenings: "Weekend evenings", late_nights: "Late nights",
  },
  start_when: { immediately: "Immediately", two_weeks: "Within two weeks", one_month: "Within a month", later: "Later than a month" },
  experience_level: {
    none: "No experience yet", under_1: "Less than 1 year", "1_2": "1 to 2 years", "3_5": "3 to 5 years", over_5: "More than 5 years",
  },
  status: {
    new: "New", reviewing: "Reviewing", shortlisted: "Shortlisted", interview: "Interview", hired: "Hired", rejected: "Rejected",
  },
};

export const label = (field: string, value: string | null | undefined): string =>
  (value === null || value === undefined ? "" : LABELS[field]?.[value] ?? value);
