// Job application form. Validation here is for the applicant's convenience only; the
// server validates everything again and is the one that decides.
const form = document.querySelector("[data-apply-form]");
const submitButton = form.querySelector("[data-apply-submit]");
const errorBox = form.querySelector("[data-apply-error]");
const successBox = document.querySelector("[data-apply-success]");
const { api = "", restaurant = "" } = document.documentElement.dataset;
const startedAt = Date.now();

const MAX_CV_BYTES = 5 * 1024 * 1024;
const GENERIC_ERROR = "We could not submit your application right now. Please try again later.";

const RULES = {
  full_name: (value) => (value.trim().length < 2 ? "Enter your full name." : ""),
  position: (value) => (value === "" ? "Choose the position you are applying for." : ""),
  email: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()) ? "" : "Enter a valid email address."),
  phone: (value) => (/^\+?[0-9 ()\-.]{7,25}$/.test(value.trim()) ? "" : "Enter a phone number we can reach you on."),
  message: (value) => (value.length > 3000 ? "Keep the message under 3000 characters." : ""),
  cv: (_, input) => {
    const file = input.files?.[0];
    if (!file) return "";
    if (!/\.(pdf|doc|docx)$/i.test(file.name)) return "Upload your CV as a PDF, DOC or DOCX file.";
    return file.size > MAX_CV_BYTES ? "The CV is too large. The maximum size is 5 MB." : "";
  },
  consent: (_, input) => (input.checked ? "" : "Please confirm that we may contact you about this application."),
};

function setFieldError(name, message) {
  const input = form.elements[name];
  const error = document.getElementById(`${name}-error`);
  if (!input || !error) return;
  error.textContent = message;
  error.hidden = message === "";
  if (message) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id);
  } else {
    input.removeAttribute("aria-invalid");
    if (name !== "cv") input.removeAttribute("aria-describedby");
    else input.setAttribute("aria-describedby", "cv-hint");
  }
}

function validate() {
  let firstInvalid = null;
  for (const [name, rule] of Object.entries(RULES)) {
    const input = form.elements[name];
    const message = rule(input.value ?? "", input);
    setFieldError(name, message);
    if (message && !firstInvalid) firstInvalid = input;
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

// Clear a field's error as soon as the applicant fixes it.
form.addEventListener("input", (event) => {
  const name = event.target.name;
  if (RULES[name] && event.target.getAttribute("aria-invalid") === "true") {
    setFieldError(name, RULES[name](event.target.value ?? "", event.target));
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const firstInvalid = validate();
  if (firstInvalid) return firstInvalid.focus();
  if (!api) return showFormError(GENERIC_ERROR);

  const data = new FormData(form);
  data.set("restaurant", restaurant);
  data.set("started_at", String(startedAt));
  if (!form.elements.cv.files?.length) data.delete("cv");

  submitButton.disabled = true;
  const originalLabel = submitButton.textContent;
  submitButton.textContent = "Sending...";
  try {
    const response = await fetch(`${api}/job-application`, { method: "POST", body: data, signal: AbortSignal.timeout(60_000) });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      form.hidden = true;
      successBox.hidden = false;
      successBox.focus();
      return;
    }
    const fields = body?.error?.fields ?? {};
    let focused = false;
    for (const [name, message] of Object.entries(fields)) {
      setFieldError(name, message);
      if (!focused && form.elements[name]) {
        form.elements[name].focus();
        focused = true;
      }
    }
    if (!focused) showFormError(body?.error?.message ?? GENERIC_ERROR);
  } catch {
    showFormError("We could not reach the server. Check your connection and try again. Your details are still in the form.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = originalLabel;
  }
});
