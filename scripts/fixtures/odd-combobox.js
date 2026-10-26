// A react-select-like combobox that misbehaves on purpose, for scripts/test-extension.mjs (served as
// /assets/odd-combobox.js). Typing filters a listbox drawn inside the field's own box; clicking an option chooses it.
// Each [data-odd] wrapper says how the page lies or differs:
//   data-odd: the options, as a JSON list.
//   data-swap: a JSON map from the option clicked to the option the page keeps instead.
//   data-show: a JSON map from the option kept to the text the field shows afterwards (default: the option itself).
//   data-log: a JSON map from the option clicked to the label react-select's screen-reader log names it by
//     ("option United States, selected.").
//   data-open="never": no list ever opens (its script is broken).
//   data-markup="rs57": react-select before 5.8: the menu and its options carry ids but no roles.
// window.__odd holds what each field's page state ended up as.
window.__odd = {};
for (const wrap of document.querySelectorAll("[data-odd]")) {
  const input = wrap.querySelector("input[role=combobox]");
  const hidden = wrap.querySelector("input[type=hidden]");
  const valueBox = wrap.querySelector(".select__value-container");
  const log = wrap.querySelector("[role=log]");
  const options = JSON.parse(wrap.dataset.odd);
  const swap = JSON.parse(wrap.dataset.swap || "{}");
  const show = JSON.parse(wrap.dataset.show || "{}");
  const said = JSON.parse(wrap.dataset.log || "{}");
  const old = wrap.dataset.markup === "rs57";
  const listId = `react-select-${input.id}-listbox`;
  let menu = null;
  const close = () => {
    menu?.remove();
    menu = null;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-controls");
  };
  const choose = (clicked) => {
    const kept = swap[clicked] || clicked;
    window.__odd[input.id] = kept;
    valueBox.querySelector(".select__placeholder, .select__single-value")?.remove();
    const single = document.createElement("div");
    single.className = "select__single-value";
    single.textContent = show[kept] ?? kept;
    valueBox.prepend(single);
    if (hidden) hidden.value = kept;
    input.value = "";
    if (log) log.textContent = `option ${said[clicked] || clicked}, selected.`;
    close();
  };
  const open = (filter) => {
    if (wrap.dataset.open === "never") return;
    close();
    menu = document.createElement("div");
    menu.id = listId;
    menu.className = "select__menu";
    if (!old) menu.setAttribute("role", "listbox");
    const q = filter.trim().toLowerCase();
    options
      .filter((o) => o.toLowerCase().includes(q))
      .forEach((text, i) => {
        const el = document.createElement("div");
        el.className = "select__option";
        el.id = `react-select-${input.id}-option-${i}`;
        if (!old) el.setAttribute("role", "option");
        el.textContent = text;
        el.addEventListener("click", () => choose(text));
        menu.append(el);
      });
    wrap.append(menu);
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", listId);
  };
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") open(input.value);
    if (e.key === "Escape") close();
  });
}
