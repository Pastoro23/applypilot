// Greenhouse's newer (Remix) application form rebuilt from the real libraries Greenhouse ships (react-select 5.10.1,
// whose dist files Select-aab027f3 and index-641ee5b8 are the ones in Greenhouse's vendor bundle, and
// react-select-async-paginate) with React, for scripts/test-extension.mjs (bundled there with vite, served as
// /assets/greenhouse-real.js into greenhouse-real.html). Nothing here imitates react-select: every dropdown is the
// library. The markup follows a saved job page: the same ids, labels (label for=, aria-labelledby), classNamePrefix
// "select", instanceId/inputId (react-select-country-placeholder, react-select-country-listbox), react-select's hidden
// required inputs, the attribute-less <div> Greenhouse puts around each control and its "Toggle flyout" button. The
// residence and state questions use the saved page's own option lists, and the degree list is the board's own
// (boards-api.greenhouse.io/v1/boards/agency/education/degrees).
//
// What Greenhouse adds around the library, as other autofill projects found it on the live site:
//   - Its select keeps menuIsOpen itself. react-select's own onMenuOpen/onMenuClose change nothing, so typing alone
//     never opens a list. A key-up in the control opens it and Escape closes it; a mouse-up on the attribute-less
//     <div> toggles it unless the event was default-prevented; the "Toggle flyout" button toggles it on click; a
//     choice closes it, and so does leaving the field.
//   - School and Discipline are react-select-async-paginate over the board's education API (100 per page, 300 ms
//     debounce, filtered by the server, so no client filter). They load only while the menu is open.
//   - The phone country picker lists "United States +1" and, once chosen, shows intl-tel-input's flag (a <div> with
//     class "iti__flag iti__us", no text) and "+1".
//   - Location (City) asks the geocoder as you type (no client filter) and lists "Grayson, GA, USA". A choice is
//     confirmed with the geocoder before the field takes it, so the value lands a moment after the click.
//   - The resume upload checks the file's type, then takes its input and buttons out of the page at once. The file's
//     name and a "Remove file" button appear only after its upload answers; on a board that uploads to S3 a progress
//     bar shows meanwhile. A file of the wrong type gets "Invalid file format selected." and stays unattached.
//
// A test can set window.__gh before this script runs:
//   menu: unset (default, as above, with the phone country picker and Location (City) also opening as you type, the
//     way the live page behaved), "greenhouse" (no list opens as you type, those two included) or "library"
//     (react-select's own menu state: typing opens every list).
//   menuStaysOpen: leaving a field doesn't close its list (only a choice, Escape or a toggle does).
//   phoneDisplay: "iti" (default: flag <div> and "+1"), "label" ("United States +1"), "dial" ("+1") or "flag"
//     ("🇺🇸 +1"): what the phone country picker shows once a country is chosen.
//   phoneLabelName: each phone option's label is the country's name alone ("United States", which react-select's
//     screen-reader log reads out), and the list draws the dialling code after it ("United States +1").
//   phoneOptionText: "emoji" draws each phone option as text with its flag first ("🇺🇸 United States +1").
//   toggleOn: "mousedown": the "Toggle flyout" button opens its list on a mouse press, as react-select's own indicator
//     does, and the control's key-up and mouse-up open nothing.
//   phoneDefault: an ISO code the phone country picker starts with, as if the site chose it.
//   phoneSwap: an ISO code the site keeps in the phone country picker whichever country is chosen.
//   locationDebounceMs, locationLatencyMs: the geocoder waits this long after the last keystroke, then this long
//     again for the "network" (default 250 and 250). locationConfirmMs: how long the confirmation of a chosen place
//     takes (default 1500).
//   hydrateAfterMs: the form is server-rendered markup with no script behind it until then.
//   keepFileInput: the upload widget's file input stays in the page (the same element) after a file is chosen.
//   rejectFiles: the upload widget ignores any file (nothing is shown).
//   uploadQuiet: while it uploads, the widget keeps its buttons and input and shows nothing new until the name.
//   busyAttr: while it uploads, the widget marks its box aria-busy="true" (and changes nothing else when uploadQuiet).
//   allowedTypes: the file types the upload takes (default pdf, doc, docx, txt, rtf), in its accept list too.
//   chipAfterMs: how long after the file is taken its name appears (default 1800). s3: the board uploads to S3
//     (data-allow-s3="true"), with a progress bar for uploadMs (default 2500) before the name appears.
//   acceptDrop: the upload box also takes a file dropped on it.
//   parseAfterMs: that long after the file is taken, the page puts a fresh form in place of the questions (new
//     elements, every answer cleared), as an autofill can.
import { Fragment, useEffect, useRef, useState } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import Select, { components } from "react-select";
import { AsyncPaginate } from "react-select-async-paginate";

const cfg = globalThis.__gh || {};
const own = cfg.menu !== "library";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flag = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
// The phone country list: "Name +code", searched by name, value the ISO code.
const PHONE = [
  ["AF", "Afghanistan", "93"], ["AX", "Åland Islands", "358"], ["AL", "Albania", "355"], ["DZ", "Algeria", "213"],
  ["AS", "American Samoa", "1"], ["AD", "Andorra", "376"], ["AO", "Angola", "244"], ["AR", "Argentina", "54"],
  ["AM", "Armenia", "374"], ["AU", "Australia", "61"], ["AT", "Austria", "43"], ["BS", "Bahamas", "1"],
  ["BD", "Bangladesh", "880"], ["BE", "Belgium", "32"], ["BR", "Brazil", "55"], ["CA", "Canada", "1"],
  ["CN", "China", "86"], ["CO", "Colombia", "57"], ["DK", "Denmark", "45"], ["EG", "Egypt", "20"],
  ["FR", "France", "33"], ["GE", "Georgia", "995"], ["DE", "Germany", "49"], ["GH", "Ghana", "233"],
  ["GR", "Greece", "30"], ["GU", "Guam", "1"], ["IN", "India", "91"], ["IE", "Ireland", "353"], ["IL", "Israel", "972"],
  ["IT", "Italy", "39"], ["JM", "Jamaica", "1"], ["JP", "Japan", "81"], ["KE", "Kenya", "254"], ["MX", "Mexico", "52"],
  ["NL", "Netherlands", "31"], ["NZ", "New Zealand", "64"], ["NG", "Nigeria", "234"], ["NO", "Norway", "47"],
  ["PK", "Pakistan", "92"], ["PH", "Philippines", "63"], ["PL", "Poland", "48"], ["PT", "Portugal", "351"],
  ["PR", "Puerto Rico", "1"], ["ZA", "South Africa", "27"], ["KR", "South Korea", "82"], ["ES", "Spain", "34"],
  ["SE", "Sweden", "46"], ["CH", "Switzerland", "41"], ["UA", "Ukraine", "380"], ["AE", "United Arab Emirates", "971"],
  ["GB", "United Kingdom", "44"], ["US", "United States", "1"], ["UM", "United States Minor Outlying Islands", "1"],
  ["UY", "Uruguay", "598"], ["VN", "Vietnam", "84"], ["ZW", "Zimbabwe", "263"],
].map(([value, name, dial]) => ({ value, label: cfg.phoneLabelName ? name : `${name} +${dial}`, dial: `+${dial}`, flag: flag(value) }));
// The list shows each country's flag and "Name +code"; the chosen country shows as intl-tel-input's flag and "+code".
const flagDiv = (o) => <div className={`iti__flag iti__${o.value.toLowerCase()}`} />;
const phoneLabel = (o, { context }) => {
  if (context !== "value")
    return cfg.phoneOptionText === "emoji" ? (
      `${o.flag} ${cfg.phoneLabelName ? `${o.label} ${o.dial}` : o.label}`
    ) : (
      <>
        {flagDiv(o)}
        <span>{cfg.phoneLabelName ? `${o.label} ${o.dial}` : o.label}</span>
      </>
    );
  const shown = cfg.phoneDisplay || "iti";
  if (shown === "label") return o.label;
  if (shown === "dial") return o.dial;
  if (shown === "flag") return `${o.flag} ${o.dial}`;
  return (
    <>
      {flagDiv(o)}
      <span>{o.dial}</span>
    </>
  );
};

const list = (labels) => labels.map((label, i) => ({ value: String(i + 1), label }));
// The board's own degree list: no apostrophes in "Bachelors", "Masters" or "Associates".
const DEGREES = list([
  "Associates Degree", "Bachelors Degree", "Certificate", "Doctor of Medicine (M.D.)", "Doctor of Philosophy (Ph.D.)", "Engineer's Degree",
  "High School", "Juris Doctor (J.D.)", "Master of Business Administration (M.B.A.)", "Masters Degree", "Other", "Primary Education",
  "Secondary Education",
]);
// The saved page's own lists for "What country are you currently a resident of?" and the state question.
const RESIDENCE = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan",
  "The Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina",
  "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic",
  "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Democratic Republic of Congo", "Costa Rica", "Côte d’Ivoire", "Croatia", "Cuba",
  "Cyprus", "Czech Republic", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "East Timor (Timor-Leste)", "Ecuador", "Egypt",
  "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "The Gambia", "Georgia",
  "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hong Kong", "Hungary", "Iceland",
  "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo",
  "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar",
  "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia, Federated States of",
  "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar (Burma)", "Namibia", "Nauru", "Nepal", "Netherlands",
  "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine State",
  "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda",
  "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia",
  "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa",
  "South Korea", "Spain", "Sri Lanka", "Sudan", "Sudan, South", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania",
  "Thailand", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates",
  "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe",
].map((label, i) => ({ value: String(71316552101 + i * 1000), label }));
const STATES = [
  "I am not located in the United States of America currently", "AL", "AK", "AS", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "GU",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "PR", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VI", "VA", "WA", "WV", "WI", "WY",
].map((label, i) => ({ value: String(71316751101 + i * 1000), label }));
const DISCIPLINES = list([
  "Accounting", "African Studies", "Agriculture", "Anthropology", "Applied Health Services", "Architecture", "Art", "Asian Studies",
  "Biology", "Business", "Business Administration", "Chemistry", "Classical Languages", "Communications & Film", "Computer Engineering",
  "Computer Science", "Dentistry", "Developing Nations", "Discipline Unknown", "Earth Sciences", "Economics", "Education",
  "Electronics", "Engineering", "English Studies", "Environmental Studies", "European Studies", "Fashion", "Finance", "Fine Arts",
  "General Studies", "Health Services", "History", "Human Resources Management", "Humanities", "Industrial Arts & Carpentry",
  "Information Systems", "Information Technology", "International Relations", "Journalism", "Languages", "Latin American Studies",
  "Law", "Linguistics", "Manufacturing & Mechanics", "Mathematics", "Medicine", "Middle Eastern Studies", "Naval Science",
  "North American Studies", "Nuclear Technics", "Operations Research & Strategy", "Organizational Theory", "Philosophy",
  "Physical Education", "Physical Sciences", "Physics", "Political Science", "Psychology", "Public Policy", "Public Service",
  "Religious Studies", "Russian & Soviet Studies", "Scandinavian Studies", "Science", "Slavic Studies", "Social Science",
  "Social Sciences", "Sociology", "Speech", "Statistics & Decision Theory", "Urban Studies", "Veterinary Medicine", "Other",
]);
const SCHOOLS = list([
  "Georgia Piedmont Technical College", "Georgia State University", "Georgia Institute of Technology", "Gwinnett Technical College",
  "Georgia Gwinnett College", "University of Georgia", "Other",
]);
// The geocoder's labels for places in the U.S.: "City, ST, USA".
const PLACES = [
  "Grayson, GA, USA", "Grayson, KY, USA", "Grayson, LA, USA", "Graysonia, AR, USA", "Grayson County, TX, USA", "Union City, NJ, USA",
  "Union, KY, USA", "Atlanta, GA, USA", "Lawrenceville, GA, USA", "Springfield, IL, USA", "Springfield, MO, USA", "Toronto, ON, Canada",
].map((label, i) => ({ value: `place-${i}`, label }));

// The board's education API: names containing the search term, 100 a page.
const paginate = (all) => async (search, _loaded, { page }) => {
  await sleep(cfg.eduLatencyMs ?? 200);
  const hits = all.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()));
  return { options: hits.slice((page - 1) * 100, page * 100), hasMore: hits.length > page * 100, additional: { page: page + 1 } };
};
const loadSchools = paginate(SCHOOLS);
const loadDisciplines = paginate(DISCIPLINES);

const Arrow = () => (
  <svg className="svg-icon" fill="none" height="20" width="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path className="icon--primary-color" d="M11.45 16.07 5.91 9.14C5.54 8.68 5.87 8 6.46 8h11.08c.59 0 .92.68.55 1.14l-5.54 6.93a.7.7 0 0 1-1.1 0Z" />
  </svg>
);
// Keys that never open the list: moving focus, choosing, and modifiers.
const QUIET_KEYS = new Set(["Tab", "Enter", "NumpadEnter", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"]);
// Greenhouse's attribute-less <div> around the control: a mouse-up toggles the list, a key-up opens it, Escape closes it.
const toggleDown = cfg.toggleOn === "mousedown";
const Control = (props) => {
  const fly = props.selectProps.ghFlyout;
  return (
    <div
      onMouseUp={fly && !toggleDown ? (e) => !e.defaultPrevented && fly.set((o) => !o) : undefined}
      onKeyUp={fly ? (e) => (e.code === "Escape" ? fly.set(false) : !toggleDown && !QUIET_KEYS.has(e.code) && fly.set(true)) : undefined}
    >
      <components.Control {...props} />
    </div>
  );
};
const Input = (props) => <components.Input {...props} enterKeyHint="done" />;
// Greenhouse's IconButton: it reacts to click only (or to a mouse press, under toggleOn), and keeps its mouse-up from
// toggling the list a second time.
const Toggle = ({ selectProps, innerProps }) => {
  const fly = selectProps.ghFlyout;
  return (
    <button
      type="button"
      className="icon-button icon-button--sm"
      aria-label="Toggle flyout"
      tabIndex={-1}
      onMouseUp={fly ? (e) => e.preventDefault() : undefined}
      onClick={fly && !toggleDown ? () => fly.set((o) => !o) : undefined}
      onMouseDown={
        fly
          ? toggleDown
            ? (e) => {
                e.preventDefault();
                fly.set((o) => !o);
              }
            : undefined
          : innerProps.onMouseDown
      }
    >
      <Arrow />
    </button>
  );
};
const WITH_TOGGLE = { Control, Input, IndicatorSeparator: null, DropdownIndicator: Toggle };
const NO_TOGGLE = { Control, Input, IndicatorSeparator: null, DropdownIndicator: null, LoadingIndicator: null };
const ignore = () => {};

// openOnType: the phone country picker and Location (City) also open their list as you type (on the live page they
// were the two dropdowns ApplyPilot's typing reached; the others never opened).
function GHSelect({ id, label, required = false, placeholder = "Select...", paginate: paged = false, toggle = true, openOnType = false, value, onChange, onInputChange, ...rest }) {
  const [open, setOpen] = useState(false);
  const Component = paged ? AsyncPaginate : Select;
  const typed = own && openOnType && cfg.menu !== "greenhouse";
  const menu = own
    ? { menuIsOpen: open, ghFlyout: { set: setOpen }, onMenuOpen: ignore, onMenuClose: ignore, onBlur: () => !cfg.menuStaysOpen && setOpen(false) }
    : {};
  const inputChange = (v, meta) => {
    if (typed && meta.action === "input-change" && v) setOpen(true);
    onInputChange?.(v, meta);
  };
  return (
    <div className="select">
      <div className="select__container">
        <label id={`${id}-label`} htmlFor={id} className="label select__label">
          {label}
          {required ? <span aria-hidden="true">*</span> : null}
        </label>
        <Component
          className="select-shell"
          classNamePrefix="select"
          instanceId={id}
          inputId={id}
          aria-labelledby={`${id}-label`}
          aria-errormessage={`${id}-error`}
          aria-invalid={false}
          required={required}
          placeholder={placeholder}
          value={value}
          onChange={(v, meta) => {
            if (own) setOpen(false);
            onChange(v, meta);
          }}
          onInputChange={inputChange}
          components={toggle ? WITH_TOGGLE : NO_TOGGLE}
          {...(paged ? { additional: { page: 1 }, debounceTimeout: 300 } : {})}
          {...menu}
          {...rest}
        />
      </div>
    </div>
  );
}

// Location (City): the geocoder answers what was typed (two letters at least); a chosen place is confirmed with it
// before the field takes it. The "Locate me" button beside it must never be pressed.
function LocationSelect({ value, onChange }) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef(0);
  const search = (q, { action }) => {
    if (action !== "input-change") return;
    clearTimeout(timer.current);
    const query = q.split(",")[0].trim().toLowerCase();
    if (query.length < 2) {
      setOptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(
      () =>
        setTimeout(() => {
          setOptions(PLACES.filter((p) => p.label.toLowerCase().startsWith(query)));
          setLoading(false);
        }, cfg.locationLatencyMs ?? 250),
      cfg.locationDebounceMs ?? 250,
    );
  };
  const confirm = (v) => {
    globalThis.__locationPicks = (globalThis.__locationPicks || 0) + 1;
    if (!v) return onChange(v);
    setTimeout(() => onChange(v), cfg.locationConfirmMs ?? 1500);
  };
  return (
    <GHSelect
      id="candidate-location"
      label="Location (City)"
      required
      placeholder=""
      toggle={false}
      openOnType
      options={options}
      isLoading={loading}
      filterOption={null}
      onInputChange={search}
      value={value}
      onChange={confirm}
    />
  );
}

function TextInput({ id, label, required = true, type = "text", autoComplete, value, onChange, maxLength = 255 }) {
  return (
    <div className="text-input-wrapper">
      <div className="input-wrapper">
        <label id={`${id}-label`} htmlFor={id} className="label label">
          {label}
          {required ? <span aria-hidden="true">*</span> : null}
        </label>
        <input
          id={id}
          className="input input__single-line"
          aria-label={label}
          aria-describedby={`${id}-description ${id}-error ${id}-help`}
          aria-invalid="false"
          aria-errormessage={`${id}-error`}
          aria-required={required ? "true" : "false"}
          type={type}
          maxLength={type === "number" ? undefined : maxLength}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(id, e.target.value)}
        />
      </div>
    </div>
  );
}

const TYPES = cfg.allowedTypes || ["pdf", "doc", "docx", "txt", "rtf"];
const FileIcon = () => (
  <svg width="13" height="16" viewBox="0 0 13 16" aria-hidden="true">
    <path d="M1 0h7l5 5v11H1z" />
  </svg>
);
// Greenhouse's upload: the input's change event hands the file over; the type is checked first. Once a file is
// taken the buttons and the input leave the page, and the file's name and a Remove button appear after its upload
// answers (a progress bar meanwhile when the board uploads to S3).
function FileUpload({ id, label, file, setFile, onTaken }) {
  const input = useRef(null);
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const take = (f) => {
    if (!f || cfg.rejectFiles) return;
    if (!TYPES.includes(f.name.split(".").pop().toLowerCase())) {
      setError("Invalid file format selected.");
      return;
    }
    setError("");
    globalThis.__resumeTaken = (globalThis.__resumeTaken || 0) + 1;
    setPhase("uploading");
    const done = () => {
      setFile(f);
      setPhase("idle");
      onTaken();
    };
    if (cfg.s3) {
      const total = cfg.uploadMs ?? 2500;
      for (let t = 250; t < total; t += 250) setTimeout(() => setProgress(Math.round((100 * t) / total)), t);
      setTimeout(done, total);
    } else setTimeout(done, cfg.chipAfterMs ?? 1800);
  };
  const drop = cfg.acceptDrop
    ? {
        onDragOver: (e) => e.preventDefault(),
        onDrop: (e) => {
          e.preventDefault();
          globalThis.__drops = (globalThis.__drops || 0) + 1;
          take(e.dataTransfer?.files?.[0]);
        },
      }
    : {};
  const fileInput = (
    <input ref={input} id={id} className="visually-hidden" type="file" accept={TYPES.map((t) => `.${t}`).join(",")} onChange={(e) => take(e.target.files?.[0])} />
  );
  let body;
  if (file)
    body = (
      <div className="file-upload__filename">
        <FileIcon />
        <p className="body body__secondary">{file.name}</p>
        <button
          type="button"
          className="icon-button icon-button--sm"
          aria-label="Remove file"
          onClick={() => {
            setFile(null);
            setProgress(0);
          }}
        >
          ×
        </button>
      </div>
    );
  else if (phase === "uploading" && !cfg.uploadQuiet)
    body = cfg.s3 ? (
      <div className="file-upload__progressbar">
        <span style={{ width: `${progress}%` }} />
      </div>
    ) : null;
  else
    body = (
      <div className="button-container">
        <div className="secondary-button">
          <div>
            <button type="button" className="btn btn--pill" onClick={() => input.current?.click()}>
              Attach
            </button>
            <label className="visually-hidden" htmlFor={id}>
              Attach
            </label>
            {cfg.keepFileInput ? null : fileInput}
          </div>
        </div>
        <div className="secondary-button">
          <button type="button" className="btn btn--pill" data-testid={`${id}-dropbox`}>
            Dropbox
          </button>
        </div>
        <div className="secondary-button">
          <button type="button" className="btn btn--pill">
            Google Drive
          </button>
        </div>
        <div className="secondary-button">
          <div>
            <button type="button" className="btn btn--pill" data-testid={`${id}-text`}>
              Enter manually
            </button>
            <label className="visually-hidden" htmlFor={`${id}_text`}>
              Enter manually
            </label>
          </div>
        </div>
        <p id="accepted-filetypes" className="file-upload__filetypes">
          Accepted file types: {TYPES.join(", ")}
        </p>
      </div>
    );
  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- the saved page's own markup
    <div role="group" aria-labelledby={`upload-label-${id}`} aria-required="true" className="file-upload" data-allow-s3={cfg.s3 ? "true" : "false"} {...drop}>
      <div id={`upload-label-${id}`} className="label upload-label">
        {label}
        <span className="required">*</span>
      </div>
      <div className="file-upload__wrapper" aria-busy={cfg.busyAttr && phase === "uploading" ? "true" : undefined}>
        {cfg.keepFileInput ? fileInput : null}
        {body}
      </div>
      {error ? (
        <p id={`${id}-error`} className="helper-text helper-text--error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const PRIVACY = "question_9601409101[]";
const NO_TEXT = { first_name: "", last_name: "", email: "", phone: "", "start-year--0": "", "end-year--0": "", question_9601408101: "" };
const NO_PICK = { country: PHONE.find((o) => o.value === cfg.phoneDefault) || null };
function App() {
  const [text, setText] = useState(NO_TEXT);
  const [pick, setPick] = useState(NO_PICK);
  const [file, setFile] = useState(null);
  const [privacy, setPrivacy] = useState(false);
  // A new key puts new elements in place of every question when the page "reads" the resume.
  const [epoch, setEpoch] = useState(0);
  const onTaken = () => {
    if (!cfg.parseAfterMs) return;
    setTimeout(() => {
      globalThis.__parsed = (globalThis.__parsed || 0) + 1;
      setText(NO_TEXT);
      setPick(NO_PICK);
      setPrivacy(false);
      setEpoch((n) => n + 1);
    }, cfg.parseAfterMs);
  };
  const onText = (id, v) => setText((s) => ({ ...s, [id]: v }));
  const swap = (id, v) => (id === "country" && v && cfg.phoneSwap ? PHONE.find((o) => o.value === cfg.phoneSwap) : v);
  const select = (id) => ({ id, value: pick[id] || null, onChange: (v) => setPick((s) => ({ ...s, [id]: swap(id, v) })) });
  useEffect(() => {
    globalThis.__ghState = { ...Object.fromEntries(Object.entries(pick).map(([k, v]) => [k, v?.label || ""])), ...text, resume: file?.name || "", privacy };
  });
  return (
    <form method="get" action="/acme/jobs/4012345" id="application-form" className="application--form" data-discover="true" onSubmit={(e) => e.preventDefault()}>
      <Fragment key={epoch}>
        <div className="application--questions">
          <div className="field-wrapper">
            <TextInput id="first_name" label="First Name" autoComplete="given-name" value={text.first_name} onChange={onText} />
          </div>
          <div className="field-wrapper">
            <TextInput id="last_name" label="Last Name" autoComplete="family-name" value={text.last_name} onChange={onText} />
          </div>
          <div className="field-wrapper">
            <TextInput id="email" label="Email" autoComplete="email" value={text.email} onChange={onText} />
          </div>
          <div>
            <fieldset className="phone-input">
              <legend className="visually-hidden">Phone</legend>
              <div className="phone-input__country">
                <GHSelect {...select("country")} label="Country" required placeholder="" openOnType options={PHONE} formatOptionLabel={phoneLabel} />
              </div>
              <div className="phone-input__phone">
                <TextInput id="phone" label="Phone" type="tel" value={text.phone} onChange={onText} />
              </div>
            </fieldset>
          </div>
          <div className="field-wrapper">
            <LocationSelect {...select("candidate-location")} />
            <button type="button" className="btn--tertiary">
              Locate me
            </button>
          </div>
          <div className="field-wrapper">
            <FileUpload id="resume" label="Resume/CV" file={file} setFile={setFile} onTaken={onTaken} />
          </div>
        </div>
        <div className="education--container">
          <div className="education--form">
            <hr />
            <div className="education--header">
              <p className="body body--medium">Education</p>
            </div>
            <GHSelect {...select("school--0")} label="School" paginate loadOptions={loadSchools} />
            <GHSelect {...select("degree--0")} label="Degree" required options={DEGREES} />
            <GHSelect {...select("discipline--0")} label="Discipline" required paginate loadOptions={loadDisciplines} />
            <div className="education--half-width-container">
              <div className="education--date-container">
                <TextInput id="start-year--0" label="Start date year" type="number" value={text["start-year--0"]} onChange={onText} />
              </div>
              <div className="education--date-container">
                <TextInput id="end-year--0" label="End date year" type="number" value={text["end-year--0"]} onChange={onText} />
              </div>
            </div>
          </div>
          <button className="add-another-button" type="button">
            Add another
          </button>
        </div>
        <div className="application--questions">
          <hr />
          <div className="field-wrapper">
            <GHSelect {...select("question_9601406101")} label="What country are you currently a resident of?" required options={RESIDENCE} />
          </div>
          <div className="field-wrapper">
            <GHSelect
              {...select("question_9601407101")}
              label={'If you are currently based in United States, please confirm your current state of residence. If you are based outside of the United States, select "I am not located in the United States".'}
              required
              options={STATES}
            />
          </div>
          <div className="field-wrapper">
            <TextInput id="question_9601408101" label="LinkedIn Profile" value={text.question_9601408101} onChange={onText} />
          </div>
          <div className="field-wrapper">
            <fieldset className="checkbox" id={PRIVACY} aria-required="true">
              <legend className="label checkbox__description">
                Please acknowledge that you have read and agree to our Privacy Policy. <span className="required">*</span>
              </legend>
              <div className="checkbox__wrapper">
                <div className="checkbox__input">
                  <input
                    description="Please acknowledge that you have read and agree to our Privacy Policy."
                    required
                    type="checkbox"
                    id={`${PRIVACY}_71316806101`}
                    name={PRIVACY}
                    aria-describedby={`${PRIVACY}-description ${PRIVACY}-error`}
                    aria-invalid="false"
                    aria-errormessage={`${PRIVACY}-error`}
                    value="71316806101"
                    checked={privacy}
                    onChange={(e) => setPrivacy(e.target.checked)}
                  />
                </div>
                <label htmlFor={`${PRIVACY}_71316806101`}>Yes</label>
              </div>
            </fieldset>
            <div className="body body__secondary">
              <div id={`${PRIVACY}-description`} className="question-description">
                <p>
                  By clicking &quot;Submit Application&quot;, you agree to the company&apos;s{" "}
                  <a className="c-link" href="/privacy" target="_blank">
                    Privacy Policy
                  </a>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </Fragment>
      <div className="application--submit">
        <button type="submit" className="btn btn--pill" aria-disabled="false">
          Submit application
        </button>
      </div>
    </form>
  );
}

const container = document.getElementById("app");
if (cfg.hydrateAfterMs) {
  container.innerHTML = renderToString(<App />);
  setTimeout(() => hydrateRoot(container, <App />), cfg.hydrateAfterMs);
} else createRoot(container).render(<App />);
