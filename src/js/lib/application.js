// How a job application's answers and stages are worded, for the dashboard.
//
// The same values and labels as supabase/functions/_shared/public/application-fields.ts,
// which the form handler and the notification email use. tests/frontend.test.js fails if
// the two drift apart.

export const STATUSES = ["new", "reviewing", "shortlisted", "interview", "hired", "rejected"];

export const LABELS = {
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

export const label = (field, value) => (value === null || value === undefined ? "" : LABELS[field]?.[value] ?? value);

// "248 kB", "1.4 MB": the size of a CV, for the download button.
export function fileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
