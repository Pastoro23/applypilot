// Stand-in for react-select v5 on Greenhouse's newer form (scripts/fixtures/greenhouse-remix.html), served as
// /assets/greenhouse-remix.js. The menu opens inside the field's container (role=listbox, aria-controls on the
// input while open); typing filters it; the screen-reader live region counts the results; an option is chosen
// on click and shown as .select__single-value. The hidden required input is there only while nothing is chosen, as
// react-select renders it. Location and School are searched as you type and show nothing before that. The input
// loses any typed text when it loses focus. greenhouse-real.jsx is the same form built from the real library.
const STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland",
  "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];
const COUNTRIES = ["Afghanistan", "Åland Islands", "Canada", "Nigeria", "United Kingdom", "United States", "United States Minor Outlying Islands"];
const DIAL = { Afghanistan: "+93", "Åland Islands": "+358", Canada: "+1", Nigeria: "+234", "United Kingdom": "+44", "United States": "+1", "United States Minor Outlying Islands": "+1" };
const OPTIONS = {
  country: COUNTRIES.map((c) => `${c} ${DIAL[c]}`),
  "degree--0": [
    "High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Master of Business Administration (M.B.A.)",
    "Juris Doctor (J.D.)", "Doctor of Medicine (M.D.)", "Doctor of Philosophy (Ph.D.)", "Engineer's Degree", "Other",
  ],
  "discipline--0": [
    "Accounting", "Business Administration", "Computer Engineering", "Computer Science", "Information Technology",
    "Information Systems", "Theology", "Other",
  ],
  question_9601406101: COUNTRIES,
  question_9601407101: [...STATES, "I am not located in the United States"],
};
const SEARCH = {
  "candidate-location": [
    "Grayson, Georgia, United States", "Grayson, Kentucky, United States", "Graysonia, Arkansas, United States",
    "Atlanta, Georgia, United States", "Lawrenceville, Georgia, United States",
  ],
  "school--0": [
    "Georgia Piedmont Technical College", "Georgia State University", "Georgia Institute of Technology",
    "Gwinnett Technical College", "Other",
  ],
};

function wire(input) {
  const shell = input.closest(".select-shell");
  const log = shell.querySelector("[role=log]");
  const valueBox = shell.querySelector(".select__value-container");
  const listId = `react-select-${input.id}-listbox`;
  const async = Object.hasOwn(SEARCH, input.id);
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-controls");
  };
  const choose = (text) => {
    valueBox.querySelector(".select__placeholder, .select__single-value")?.remove();
    const single = document.createElement("div");
    single.className = "select__single-value";
    single.textContent = text;
    valueBox.prepend(single);
    shell.querySelector(":scope > input[aria-hidden=true]")?.remove();
    input.value = "";
    log.textContent = `option ${text}, selected.`;
    close();
  };
  const render = (q) => {
    close();
    const query = q.trim().toLowerCase();
    const pool = async ? (query.length >= 2 ? SEARCH[input.id] : []) : OPTIONS[input.id] || [];
    const key = (o) => (input.id === "candidate-location" ? o.split(",")[0] : o).toLowerCase();
    const hits = pool.filter((o) => (input.id === "candidate-location" ? key(o).startsWith(query.split(",")[0].trim()) : key(o).includes(query)));
    menu = document.createElement("div");
    menu.className = "select__menu";
    const list = document.createElement("div");
    list.className = "select__menu-list";
    list.id = listId;
    list.setAttribute("role", "listbox");
    hits.forEach((text, i) => {
      const el = document.createElement("div");
      el.className = "select__option";
      el.id = `react-select-${input.id}-option-${i}`;
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", "false");
      el.textContent = text;
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", () => choose(text));
      list.append(el);
    });
    if (!hits.length) {
      const none = document.createElement("div");
      none.className = "select__menu-notice";
      none.textContent = async && query.length < 2 ? "Type to search" : "No options";
      list.append(none);
    }
    menu.append(list);
    shell.append(menu);
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", listId);
    log.textContent = hits.length ? `${hits.length} results found ${hits.join(" ").toLowerCase()}` : "no results found";
  };
  const open = (q) => (async && q.trim().length >= 2 ? setTimeout(() => document.activeElement === input && render(input.value), 250) : render(q));
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") open(input.value);
    if (e.key === "Escape") close();
  });
  shell.querySelector(".select__control").addEventListener("mousedown", (e) => {
    if (e.target !== input) e.preventDefault();
    input.focus();
    open(input.value);
  });
  input.addEventListener("blur", () => {
    input.value = "";
    close();
  });
}
for (const input of document.querySelectorAll("input.select__input[role=combobox]")) wire(input);

// The resume widget: a chosen file shows its name and a Remove button in place of the buttons and the file input,
// which leave the page with them, as Greenhouse's React widget does.
// A test can set window.__remix before filling:
//   ignoreChange: the hidden input ignores a change event a script sent (a real file picker's still counts);
//   acceptDrop: with ignoreChange, a file dropped on the upload box is taken instead;
//   parseAfterMs: that long after the file is taken, the page "reads" it and resets the form to what it found
//     (everything empty except parsedFirstName), like Greenhouse's autofill from a resume;
//   remount: the reset puts new elements in place of the old ones, as a React re-mount does.
const upload = document.querySelector(".file-upload");
const resumeInput = document.getElementById("resume");
const cfg = () => window.__remix || {};
function showFile(name) {
  const wrap = upload.querySelector(".file-upload__wrapper");
  wrap.querySelector(".button-container")?.remove();
  wrap.querySelector(".file-upload__filename")?.remove();
  const row = document.createElement("div");
  row.className = "file-upload__filename";
  const span = document.createElement("span");
  span.textContent = name;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button";
  remove.setAttribute("aria-label", "Remove file");
  remove.textContent = "×";
  row.append(span, remove);
  wrap.prepend(row);
  window.__resumeTaken = (window.__resumeTaken || 0) + 1;
  if (cfg().parseAfterMs) setTimeout(parse, cfg().parseAfterMs);
}
function clearField(el) {
  if (el.matches("input.select__input")) {
    const shell = el.closest(".select-shell");
    const box = shell.querySelector(".select__value-container");
    box.querySelector(".select__single-value")?.remove();
    if (!box.querySelector(".select__placeholder")) {
      const ph = document.createElement("div");
      ph.className = "select__placeholder";
      ph.id = `react-select-${el.id}-placeholder`;
      ph.textContent = "Select...";
      box.prepend(ph);
    }
    if (el.getAttribute("aria-required") === "true" && !shell.querySelector(":scope > input[aria-hidden=true]")) {
      const proxy = document.createElement("input");
      proxy.required = true;
      proxy.tabIndex = -1;
      proxy.setAttribute("aria-hidden", "true");
      proxy.value = "";
      shell.append(proxy);
    }
    el.value = "";
  } else if (el.type === "checkbox" || el.type === "radio") el.checked = false;
  else if (el.type !== "file") el.value = "";
}
function parse() {
  window.__parsed = (window.__parsed || 0) + 1;
  const form = document.getElementById("application-form");
  if (cfg().remount) {
    const old = form.querySelector(".application--questions");
    const fresh = old.cloneNode(true);
    for (const el of fresh.querySelectorAll("*")) {
      for (const a of [...el.attributes]) if (a.name.startsWith("data-applypilot")) el.removeAttribute(a.name);
      el.removeAttribute("style");
    }
    old.replaceWith(fresh);
    for (const el of fresh.querySelectorAll("input,select,textarea")) clearField(el);
    for (const input of fresh.querySelectorAll("input.select__input[role=combobox]")) wire(input);
  } else for (const el of form.querySelectorAll("input,select,textarea")) clearField(el);
  if (cfg().parsedFirstName) document.getElementById("first_name").value = cfg().parsedFirstName;
}
resumeInput.addEventListener("change", (e) => {
  if (cfg().ignoreChange && !e.isTrusted) return;
  if (resumeInput.files[0]) showFile(resumeInput.files[0].name);
});
upload.addEventListener("dragover", (e) => e.preventDefault());
upload.addEventListener("drop", (e) => {
  e.preventDefault();
  if (cfg().ignoreChange && !cfg().acceptDrop) return;
  const f = e.dataTransfer?.files?.[0];
  if (f) showFile(f.name);
});
