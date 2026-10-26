// Stand-in for react-select v5 on Greenhouse's newer form (scripts/fixtures/greenhouse-remix.html), served as
// /assets/greenhouse-remix.js. The menu opens inside the field's container (role=listbox, aria-controls on the
// input while open); typing filters it; the screen-reader live region counts the results; an option is chosen
// on click, shown as .select__single-value, and copied into the hidden required input. Location and School
// are searched as you type and show nothing before that. The input loses any typed text when it loses focus.
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

for (const input of document.querySelectorAll("input.select__input[role=combobox]")) {
  const shell = input.closest(".select-shell");
  const log = shell.querySelector("[role=log]");
  const valueBox = shell.querySelector(".select__value-container");
  const proxy = shell.querySelector("input[aria-hidden=true]");
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
    if (proxy) proxy.value = text;
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
