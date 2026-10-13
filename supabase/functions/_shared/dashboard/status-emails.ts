// The email an applicant is sent when their application moves to a new stage, if the
// person moving it chooses to tell them (the dashboard offers it, ticked, and shows this
// text before anything is saved). Written here, on the server, so that the words are the
// same whoever sends them and nothing typed goes into them. "New" has none: an application
// is only ever put back to New by the restaurant, for its own reasons.
//
// No imports, on purpose: the dashboard's demo build reads this same file to show the same
// text (src/dashboard/demo.js), so there is one copy of every word.

type Template = (who: { first: string; position: string }, restaurant: string) => { subject: string; body: string };

const regards = (restaurant: string) => `Kind regards,\n${restaurant}`;

const STATUS_EMAILS: Record<string, Template> = {
  reviewing: ({ first, position }, restaurant) => ({
    subject: `Your application for the ${position} position`,
    body: `Dear ${first},\n\nThank you for applying for the ${position} position at ${restaurant}. We are now reviewing your application, and we will be in touch about the next step.\n\n${regards(restaurant)}`,
  }),
  shortlisted: ({ first, position }, restaurant) => ({
    subject: `Your application for the ${position} position: the next step`,
    body: `Dear ${first},\n\nThank you for your application for the ${position} position at ${restaurant}. We are pleased to let you know that you have been shortlisted for the next step of our hiring process.\n\nWe will contact you soon with the details.\n\n${regards(restaurant)}`,
  }),
  interview: ({ first, position }, restaurant) => ({
    subject: `Interview for the ${position} position`,
    body: `Dear ${first},\n\nThank you for your application for the ${position} position at ${restaurant}. We would like to invite you to an interview.\n\nWe will contact you shortly to agree a day and time. If you prefer, reply to this email with the days and times that suit you.\n\n${regards(restaurant)}`,
  }),
  hired: ({ first, position }, restaurant) => ({
    subject: `Welcome to ${restaurant}`,
    body: `Dear ${first},\n\nWe are delighted to let you know that we would like to welcome you to our team in the ${position} position.\n\nWe will be in touch shortly about your start date and the next steps. In the meantime, you can reply to this email with any questions.\n\n${regards(restaurant)}`,
  }),
  rejected: ({ first, position }, restaurant) => ({
    subject: `Your application for the ${position} position`,
    body: `Dear ${first},\n\nThank you for your interest in the ${position} position at ${restaurant}, and for the time you put into your application.\n\nAfter careful consideration, we have decided not to move forward with your application at this time. We wish you every success in your job search.\n\n${regards(restaurant)}`,
  }),
};

export interface Applicant {
  full_name: string;
  position: string;
}

// The email for one status, or null for a status that has none.
export function statusEmail(status: string, application: Applicant, restaurantName: string): { subject: string; body: string } | null {
  const template = Object.prototype.hasOwnProperty.call(STATUS_EMAILS, status) ? STATUS_EMAILS[status] : undefined;
  if (!template) return null;
  const name = String(application.full_name ?? "").trim();
  return template({ first: name.split(/\s+/)[0] || name, position: String(application.position ?? "").trim() }, restaurantName);
}

// Every status's email for one application, for the dashboard to show before it is sent.
export function statusEmails(application: Applicant, restaurantName: string): Record<string, { subject: string; body: string } | null> {
  return Object.fromEntries(Object.keys(STATUS_EMAILS).map((status) => [status, statusEmail(status, application, restaurantName)]));
}
