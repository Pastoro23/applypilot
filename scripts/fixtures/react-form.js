// Synthetic React 19 controlled form for scripts/test-extension.mjs, bundled there with vite from the repo's
// own react and react-dom. Every text field is controlled, so a value that React didn't see is reverted.
import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function Field({ id, label, type = "text", value, onChange, required }) {
  return h(
    "div",
    { className: "field" },
    h("label", { htmlFor: id }, label, required ? h("span", { className: "asterisk" }, "*") : null),
    h("input", { id, name: id, type, value, "aria-required": required ? "true" : undefined, onChange: (e) => onChange(id, e.target.value) }),
  );
}

function App() {
  const [v, setV] = useState({ first_name: "", last_name: "", email: "", phone: "" });
  const [phoneKey, setPhoneKey] = useState(0);
  const on = (id, value) => setV((s) => ({ ...s, [id]: value }));
  useEffect(() => {
    globalThis.__reactState = v;
  }, [v]);
  useEffect(() => {
    // Remounts the phone input with an empty value, like a re-render that drops what was typed.
    globalThis.__rerenderPhone = () => {
      setPhoneKey((k) => k + 1);
      setV((s) => ({ ...s, phone: "" }));
    };
  }, []);
  return h(
    "main",
    null,
    h("h1", null, "Help Desk Technician"),
    h(
      "form",
      { id: "application-form", onSubmit: (e) => e.preventDefault() },
      h(Field, { id: "first_name", label: "First Name", value: v.first_name, onChange: on, required: true }),
      h(Field, { id: "last_name", label: "Last Name", value: v.last_name, onChange: on, required: true }),
      h(Field, { id: "email", label: "Email", type: "email", value: v.email, onChange: on, required: true }),
      h(Field, { key: `phone-${phoneKey}`, id: "phone", label: "Phone", type: "tel", value: v.phone, onChange: on }),
      h(
        "div",
        { className: "field", id: "resume_fieldset" },
        h("label", { htmlFor: "resume" }, "Resume/CV", h("span", { className: "asterisk" }, "*")),
        h("input", { id: "resume", name: "resume", type: "file", "aria-required": "true" }),
      ),
      h("button", { id: "submit", type: "submit" }, "Submit application"),
    ),
  );
}

createRoot(document.getElementById("app")).render(h(App));
