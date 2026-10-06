// Job application form. Validation here is for the applicant's convenience only; the
// server validates everything again and is the one that decides.
const form = document.querySelector("[data-apply-form]");
const submitButton = form.querySelector("[data-apply-submit]");
const errorBox = form.querySelector("[data-apply-error]");
const successBox = document.querySelector("[data-apply-success]");
const { api = "", restaurant = "" } = document.documentElement.dataset;
const startedAt = Date.now();
// One id for this visit to the form. If the answer to a send is lost and the applicant
// presses the button again, the server sees the same id and keeps one application.
const submissionId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : "";

const MAX_CV_BYTES = 5 * 1024 * 1024;
const GENERIC_ERROR = "We could not submit your application right now. Please try again later.";

const chosen = (message) => (value) => (value === "" ? message : "");
const within = (limit, name) => (value) => (value.length > limit ? `Keep ${name} under ${limit} characters.` : "");

// One rule per question, in the order the questions appear, so the first one that fails is
// the first one on the page.
const RULES = {
  full_name: (value) => (value.trim().length < 2 ? "Enter your full name." : ""),
  email: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) ? "" : "Enter a valid email address."),
  phone: (value) => (/^\+?[0-9 ()\-.]{7,25}$/.test(value.trim()) ? "" : "Enter a phone number we can reach you on."),
  position: chosen("Choose the position you are applying for."),
  employment_type: chosen("Choose full-time, part-time or either."),
  start_when: chosen("Choose when you could start."),
  availability: () => (form.querySelector('input[name="availability"]:checked') ? "" : "Choose at least one time you could work."),
  experience_level: chosen("Choose how much experience you have."),
  experience: within(2000, "your experience"),
  cv: (_, input) => {
    const file = input.files?.[0];
    if (!file) return "";
    if (!/\.(pdf|doc|docx)$/i.test(file.name)) return "Upload your CV as a PDF, DOC or DOCX file.";
    return file.size > MAX_CV_BYTES ? "The CV is too large. The maximum size is 5 MB." : "";
  },
  work_authorized: chosen("Answer whether you are authorized to work in the United States."),
  message: within(2000, "your introduction"),
  consent: (_, input) => (input.checked ? "" : "Please confirm that we may contact you about this application."),
};

// A question is one control, or a group of boxes that share a name.
const controlsOf = (name) => {
  const found = form.elements[name];
  if (!found) return [];
  return found instanceof RadioNodeList ? [...found] : [found];
};

function setFieldError(name, message) {
  const controls = controlsOf(name);
  const error = document.getElementById(`${name}-error`);
  if (controls.length === 0 || !error) return;
  error.textContent = message;
  error.hidden = message === "";
  // A group is described by its <fieldset>, which already names the hint and the error.
  const described = controls.length === 1
    ? [document.getElementById(`${name}-hint`)?.id, message && error.id].filter(Boolean).join(" ")
    : null;
  for (const control of controls) {
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
    if (described === null) continue;
    if (described) control.setAttribute("aria-describedby", described);
    else control.removeAttribute("aria-describedby");
  }
}

const check = (name) => {
  const [first] = controlsOf(name);
  return first ? RULES[name](first.value ?? "", first) : "";
};

function validate() {
  let firstInvalid = null;
  for (const name of Object.keys(RULES)) {
    const message = check(name);
    setFieldError(name, message);
    if (message && !firstInvalid) [firstInvalid] = controlsOf(name);
  }
  return firstInvalid;
}

function showFormError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  errorBox.focus();
}

// "Apply" buttons on the position cards preselect that position.
for (const link of document.querySelectorAll("[data-apply-for]")) {
  link.addEventListener("click", () => {
    form.elements.position.value = link.dataset.applyFor;
    setFieldError("position", "");
  });
}

// Clear a question's error as soon as the applicant fixes it.
form.addEventListener("input", (event) => {
  const name = event.target.name;
  if (RULES[name] && event.target.getAttribute("aria-invalid") === "true") setFieldError(name, check(name));
});

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.textContent = busy ? "Sending..." : "Send application";
  if (busy) form.setAttribute("aria-busy", "true");
  else form.removeAttribute("aria-busy");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  // A second press while the first is on its way does nothing.
  if (submitButton.disabled) return;
  errorBox.hidden = true;
  const firstInvalid = validate();
  if (firstInvalid) return firstInvalid.focus();
  if (!api) return showFormError(GENERIC_ERROR);

  const data = new FormData(form);
  data.set("restaurant", restaurant);
  data.set("started_at", String(startedAt));
  if (submissionId) data.set("submission_id", submissionId);
  if (!form.elements.cv.files?.length) data.delete("cv");

  setBusy(true);
  try {
    const response = await fetch(`${api}/job-application`, { method: "POST", body: data, signal: AbortSignal.timeout(60_000) });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      form.hidden = true;
      successBox.hidden = false;
      successBox.focus();
      successBox.scrollIntoView({ block: "center" });
      return;
    }
    const fields = body?.error?.fields ?? {};
    let focused = false;
    for (const [name, message] of Object.entries(fields)) {
      setFieldError(name, message);
      const [first] = controlsOf(name);
      if (!focused && first) {
        first.focus();
        focused = true;
      }
    }
    if (!focused) showFormError(body?.error?.message ?? GENERIC_ERROR);
  } catch {
    showFormError("We could not reach the server. Check your connection and try again. Your details are still in the form.");
  } finally {
    setBusy(false);
  }
});
