// Synthetic react-select-like combobox for scripts/test-extension.mjs (served as /assets/combobox.js).
// Typing filters a listbox rendered in a portal at the end of <body>; an option is chosen on mousedown,
// after which the input is cleared and the choice is shown in a separate "single value" element.
// data-filter="city" searches like a location autocomplete: only the text before the first comma counts.
for (const wrap of document.querySelectorAll("[data-combobox]")) {
  const input = wrap.querySelector("input[role=combobox]");
  const hidden = wrap.querySelector("input[type=hidden]");
  const valueBox = wrap.querySelector(".select__value-container");
  const options = JSON.parse(wrap.dataset.combobox);
  const listId = `${input.id}-listbox`;
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
    hidden.value = text;
    input.value = "";
    close();
  };
  const open = (filter) => {
    close();
    menu = document.createElement("div");
    menu.id = listId;
    menu.setAttribute("role", "listbox");
    const q = (wrap.dataset.filter === "city" ? filter.split(",")[0] : filter).trim().toLowerCase();
    for (const text of options.filter((o) => o.toLowerCase().includes(q))) {
      const el = document.createElement("div");
      el.setAttribute("role", "option");
      el.textContent = text;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(text);
      });
      menu.append(el);
    }
    document.body.append(menu);
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", listId);
  };
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") open(input.value);
  });
}
