// ApplyPilot page library. Injected into application tabs with
// chrome.scripting.executeScript({ files: ["page-lib.js"] }) and called through globalThis.__applypilot.
// assistant() is the popup's manual mode and never presses Submit. The batch runner uses the rest; only
// pressSubmit() ever clicks a Submit button, once, after the rules that can be checked in the page hold again.
(() => {
  const VERSION = "3.0.0";
  const previous = globalThis.__applypilot;
  if (previous && previous.version === VERSION) return;

  // ---------------------------------------------------------------------------------------------
  // Helpers shared by the manual assistant and the batch functions.

  const sensitive =
    /gender|race|ethnic|disability|veteran|sexual|pronoun|religion|marital|criminal|convict|salary|compensation|pay expectation|social security|ssn|birth|attest|certif|signature|captcha|password/i;
  const map = [
    ["firstName", /first.?name|given.?name|fname|given-name/i],
    ["lastName", /last.?name|family.?name|surname|lname|family-name/i],
    ["fullName", /full.?name|^name$/i],
    ["email", /e.?mail/i],
    ["phone", /phone|mobile|telephone|\btel\b/i],
    ["city", /^city$|locality|address-level2/i],
    ["state", /^state$|province|region|address-level1/i],
    ["postalCode", /zip|postal/i],
    ["country", /^country$|country-name/i],
    ["linkedIn", /linkedin/i],
  ];
  const recordFields = [
    ["company", /company|employer|organi[sz]ation/i],
    ["title", /job.?title|position.?title|^role\b|^title$/i],
    ["school", /school|university|institution/i],
    ["degree", /degree|qualification/i],
    ["field", /field.?of.?study|major/i],
    ["description", /description|responsibilit|duties|summary/i],
    ["startMonth", /start.*month|from.*month/i],
    ["startYear", /start.*year|from.*year/i],
    ["endMonth", /end.*month|to.*month/i],
    ["endYear", /end.*year|to.*year/i],
    ["city", /city/i],
    ["state", /state|province/i],
  ];
  const alias = {
    us: "united states",
    usa: "united states",
    "u.s.": "united states",
    "u.s.a.": "united states",
    uk: "united kingdom",
  };
  const WORK = "work experience|employment|work history";
  const EDU = "education|school";

  // A field's own label/attributes are trusted first; surrounding container text is only a fallback,
  // so "Last name" inside a "First name / Last name" group is not filled with the first name.
  const own = (f) => {
    const l = f.labels ? Array.from(f.labels).map((x) => x.textContent || "") : [];
    const by = (f.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "");
    return [...l, ...by, f.getAttribute("aria-label"), f.placeholder, f.name, f.id, f.autocomplete]
      .filter(Boolean)
      .map((x) =>
        String(x)
          .replace(/\s+/g, " ")
          .replace(/[\s*:]+$/, "")
          .trim(),
      )
      .filter(Boolean);
  };
  const near = (f) =>
    (
      f.closest("fieldset,[role=group],.form-group,.question,[data-automation-id*=formField]")?.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  const desc = (f) => [...own(f), near(f)].filter(Boolean).join(" ");
  const match = (f, rules) => {
    const parts = own(f);
    const hit = rules.find(([, p]) => parts.some((x) => p.test(x)));
    if (hit) return hit;
    const n = near(f);
    return n ? rules.find(([, p]) => p.test(n)) : undefined;
  };
  // Eligibility answers: booleans are used as-is; free text must be unambiguous, otherwise the user answers.
  const yn = (b, s, yes, no) => {
    if (typeof b === "boolean") return b;
    const t = String(s ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return null;
    // Hedged or unconfirmed wording is never turned into a Yes or No.
    if (/not sure|unsure|don'?t know|do not know|unknown|uncertain|unclear|maybe|depends|confirm|\btbd\b|\?/.test(t)) return null;
    if (/^(yes|y|true)$/.test(t)) return true;
    if (/^(no|n|false)$/.test(t)) return false;
    const n = no.test(t),
      y = yes.test(t.replace(new RegExp(no.source, "g"), ""));
    return y && !n ? true : n && !y ? false : null;
  };
  // The question itself (label or legend), without the answer options, so "No, I need a visa" doesn't
  // change how the question is read.
  const question = (f) => {
    const g = f.closest("fieldset,[role=radiogroup],[role=group],.form-group,.question,[data-automation-id*=formField]");
    if (!g) {
      const t = (f.type || "").toLowerCase();
      if (["radio", "checkbox"].includes(t)) return "";
      return [...(f.labels ? Array.from(f.labels).map((x) => x.textContent || "") : []), f.getAttribute("aria-label") || ""]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }
    const optionLabels = [];
    g.querySelectorAll("input[type=radio],input[type=checkbox]").forEach((x) => optionLabels.push(...Array.from(x.labels || [])));
    const w = document.createTreeWalker(g, NodeFilter.SHOW_TEXT);
    let s = "";
    for (let n; (n = w.nextNode()); ) {
      if (n.parentElement?.closest("option,select,script,style")) continue;
      if (optionLabels.some((l) => l.contains(n))) continue;
      s += " " + n.textContent;
    }
    return s.replace(/\s+/g, " ").trim().slice(0, 240).toLowerCase();
  };
  // Answers depend on how the question is worded: "Can you work WITHOUT sponsorship?" flips the answer.
  // Anything that isn't clearly one of the known shapes goes to the user.
  const eligibility = (q, aQ, sQ, authorized, needsSponsor) => {
    if (sQ) {
      if (/without (\w+ ){0,3}sponsor|no (\w+ ){0,2}sponsor|not (require|need)\w* (\w+ ){0,3}sponsor/.test(q)) {
        if (needsSponsor === null) return null;
        if (!aQ) return !needsSponsor;
        if (authorized === null) return null;
        return authorized && !needsSponsor;
      }
      if (aQ || /\b(not|never|unable|cannot|can't)\b/.test(q)) return null;
      if (/\b(require|need)\w*\b.*\bsponsor|\bsponsor\w*\b.*\b(require|need)/.test(q)) return needsSponsor;
      return null;
    }
    if (/\b(not|never|unable|cannot|can't)\b|unauthori/.test(q)) return null;
    return authorized;
  };
  const empty = (f) => {
    const t = (f.type || "").toLowerCase();
    if (t === "file") return !f.files?.length;
    if (["radio", "checkbox"].includes(t)) {
      const n = f.name;
      return n ? !document.querySelector(`input[name="${CSS.escape(n)}"]:checked`) : !f.checked;
    }
    return !String(f.value || "").trim();
  };
  const required = (f) => f.required || f.getAttribute("aria-required") === "true";
  const mark = (f, c) => {
    f.style.outline = `2px solid ${c}`;
    f.style.outlineOffset = "2px";
  };
  const fire = (f) => {
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // Exact value/text first, then whole-word matches only, so "US" never selects "Australia" or "Belarus".
  const pick = (f, v) => {
    const n = v.toLowerCase().replace(/\s+/g, " ").trim(),
      os = Array.from(f.options || []),
      txt = (x) => x.textContent.replace(/\s+/g, " ").trim().toLowerCase();
    const exact = (w) => w && os.find((x) => x.value.toLowerCase() === w || txt(x) === w);
    const word = (w) => {
      if (!w) return;
      const r = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      return os.find((x) => x.value && r.test(txt(x)));
    };
    return exact(n) || exact(alias[n]) || word(n) || word(alias[n]);
  };
  const set = (f, v) => {
    let ok = false;
    if (f.tagName === "SELECT") {
      const o = pick(f, v);
      if (o) {
        f.value = o.value;
        ok = true;
      }
    } else if (!["radio", "checkbox", "file"].includes((f.type || "").toLowerCase())) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f), "value")?.set;
      setter ? setter.call(f, v) : (f.value = v);
      ok = true;
    }
    if (ok) {
      fire(f);
      mark(f, "#2f7df6");
    }
    return ok;
  };
  const choice = (f, a) => {
    if (f.tagName === "SELECT") return set(f, a);
    if ((f.type || "").toLowerCase() === "radio") {
      const g = f.name
        ? Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(f.name)}"]`))
        : [f];
      const o = g.find((x) =>
        new RegExp(`^${a}$`, "i").test((x.labels?.[0]?.textContent || x.value || "").trim()),
      );
      if (o) {
        o.click();
        mark(o, "#2f7df6");
        return true;
      }
    }
    return false;
  };
  const sectionRoots = (kind) =>
    Array.from(document.querySelectorAll("fieldset,[role=group],section,div"))
      .filter(
        (x) =>
          new RegExp(kind, "i").test(
            (
              x.getAttribute("aria-label") ||
              x.querySelector(":scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4")
                ?.textContent ||
              ""
            ).trim(),
          ) && x.querySelector("input,select,textarea"),
      )
      .filter(
        (x, i, a) =>
          !a.some(
            (y, j) =>
              j !== i &&
              x.contains(y) &&
              new RegExp(kind, "i").test(
                (
                  y.getAttribute("aria-label") ||
                  y.querySelector(":scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4")
                    ?.textContent ||
                  ""
                ).trim(),
              ),
          ),
      );
  // One gate for every filler, so section filling can never touch what the main loop would refuse.
  const allowed = (f) => {
    const t = (f.type || "").toLowerCase();
    return (
      !f.disabled &&
      !f.readOnly &&
      !["hidden", "password", "submit", "button", "reset", "image"].includes(t) &&
      !sensitive.test(desc(f))
    );
  };
  // A "current job" box is recognised by its own label only, never by surrounding section text.
  const isCurrentBox = (f) =>
    (f.type || "").toLowerCase() === "checkbox" && own(f).some((x) => /current|present|still work/i.test(x));
  // Fields are walked in page order. When a field type repeats (a second "Company"), the next record starts,
  // so several entries inside one section each get their own record.
  const fillRecords = (root, records, start, onSet, skip) => {
    let i = start,
      seen = new Set(),
      n = 0;
    for (const f of root.querySelectorAll("input,select,textarea")) {
      if (!allowed(f) || skip?.(f)) continue;
      const t = (f.type || "").toLowerCase();
      const key = isCurrentBox(f) ? "current" : ["checkbox", "radio", "file"].includes(t) ? null : match(f, recordFields)?.[0];
      if (!key) continue;
      if (seen.has(key)) {
        i++;
        seen = new Set();
      }
      seen.add(key);
      const r = records[i];
      if (!r) break;
      if (!empty(f)) continue;
      if (key === "current") {
        if (r.current && !f.checked) {
          f.click();
          mark(f, "#2f7df6");
          n++;
          onSet?.(f, "1");
        }
        continue;
      }
      const v = r.current && /^end/.test(key) ? "" : String(r[key] ?? "").trim();
      if (v && set(f, v)) {
        n++;
        onSet?.(f, f.tagName === "SELECT" ? undefined : v);
      }
    }
    return { n, next: seen.size ? i + 1 : i };
  };
  const fillSections = (roots, records, onSet, skip) => {
    let n = 0,
      at = 0;
    for (const root of roots) {
      if (at >= records.length) break;
      const r = fillRecords(root, records, at, onSet, skip);
      n += r.n;
      at = r.next;
    }
    return n;
  };
  // A control that submits a form could be the final submission whatever its label says.
  const submitsForm = (b) => {
    if (b.tagName === "INPUT") return ["submit", "image"].includes((b.type || "").toLowerCase());
    if (b.tagName === "BUTTON") return (b.getAttribute("type") || "submit").toLowerCase() === "submit" && !!b.form;
    return false;
  };
  const bytesOf = (b64) => {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  };

  // ---------------------------------------------------------------------------------------------
  // Manual mode (popup). Fills blank fields; never presses Submit.

  async function assistant(data, savedResume, advance) {
    let filled = 0,
      resumeAttached = false;
    const blockers = [];
    const authorized = yn(
      data.workAuthorized,
      data.workAuthorization,
      /\bauthori[sz]ed\b|\bcitizen\b|permanent resident|green card/,
      /\bnot\s+(legally\s+)?authori[sz]ed|\bunauthori[sz]ed|\bno\b|\bnon-?citizen|\brequires?\s+(a\s+)?visa/,
    );
    const needsSponsor = yn(
      data.requiresSponsorship,
      data.sponsorship,
      /\b(require|need)s?\b|\bsponsorship required\b/,
      /\b(not|never|don't|doesn't|won't|will not|do not|does not)\s+(require|need)|\bwithout sponsorship|\bno sponsorship( needed| required)?/,
    );
    const skills = Array.isArray(data.skills)
      ? data.skills
          .map((x) => String(x).trim())
          .filter(Boolean)
          .join(", ")
      : String(data.skills || "").trim();
    const recordRoots = [...sectionRoots(WORK), ...sectionRoots(EDU)];
    filled += fillSections(sectionRoots(WORK), data.workHistory || []);
    filled += fillSections(sectionRoots(EDU), data.education || []);
    for (const f of document.querySelectorAll("input,select,textarea")) {
      const t = (f.type || "").toLowerCase();
      if (f.disabled || f.readOnly || ["hidden", "password", "submit", "button", "reset", "image"].includes(t)) continue;
      // Job and school fields belong to their records; never fill them with home address or contact details.
      if (recordRoots.some((r) => r.contains(f)) && match(f, recordFields)) continue;
      const d = desc(f);
      if (sensitive.test(d)) {
        if (empty(f) && required(f)) blockers.push(d.slice(0, 90) || "Sensitive question");
        continue;
      }
      if (t === "file" && savedResume && /resume|cv|curriculum/i.test(d) && empty(f)) {
        try {
          const u = String(savedResume.dataUrl || "");
          const file = new File([bytesOf(u.slice(u.indexOf(",") + 1))], savedResume.name, { type: savedResume.type });
          const dt = new DataTransfer();
          dt.items.add(file);
          f.files = dt.files;
          fire(f);
          mark(f, "#2f7df6");
          resumeAttached = true;
          filled++;
        } catch {
          blockers.push("Resume upload");
        }
        continue;
      }
      if (!empty(f)) continue;
      const m = match(f, map);
      if (m) {
        const v = String(data[m[0]] || "").trim();
        if (v && set(f, v)) filled++;
        continue;
      }
      if (skills && match(f, [["skills", /skills|technologies|expertise/i]])) {
        if (set(f, skills)) filled++;
        continue;
      }
      const q = question(f);
      const aQ = /authori[sz]ed|authori[sz]ation|legally.*work|eligible to work|right to work/.test(q);
      const sQ = /sponsor|visa/.test(q);
      if (aQ || sQ) {
        const a = eligibility(q, aQ, sQ, authorized, needsSponsor);
        if (a === null) blockers.push(sQ ? "Visa sponsorship: answer this yourself" : "Work authorization: answer this yourself");
        else if (choice(f, a ? "yes" : "no")) filled++;
      }
    }
    for (const f of document.querySelectorAll("input,select,textarea"))
      if (!f.disabled && required(f) && empty(f)) {
        const label = (desc(f) || "Required question").slice(0, 90);
        if (!blockers.includes(label)) blockers.push(label);
        mark(f, "#f5b84b");
      }
    const label = (b) => (b.textContent || b.value || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const visible = (b) => {
      const r = b.getBoundingClientRect(),
        st = getComputedStyle(b);
      return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const buttons = Array.from(
      document.querySelectorAll("button,input[type=submit],input[type=button],input[type=image],a[role=button],[role=button]"),
    ).filter((b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true");
    const final = buttons.find((b) => /submit|apply now|send application|finish|complete application/i.test(label(b)));
    const finalCues =
      /review (and|&) submit|by (clicking|submitting)|electronic signature|i (hereby )?(certify|attest)|submit (your|my) application/i.test(
        (document.body?.innerText || "").slice(0, 20000),
      );
    const nexts = buttons.filter((b) => /^(next|continue|save and continue|save & continue)$/i.test(label(b)));
    let advanced = false,
      nextNote = "";
    if (final || finalCues) nextNote = "This looks like the last step. Review it and submit yourself.";
    else if (nexts.length !== 1) nextNote = nexts.length ? "Several Next buttons found. Move on yourself." : "No Next button found.";
    else if (submitsForm(nexts[0])) nextNote = "This Next button sends the form, so press it yourself after checking.";
    else if (advance && !blockers.length) {
      nexts[0].click();
      advanced = true;
    }
    if (final) mark(final, "#f5b84b");
    return {
      filled,
      blockers: [...new Set(blockers)],
      resumeAttached,
      advanced,
      final: !!(final || finalCues),
      canAdvance: !nextNote,
      nextNote,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Batch mode. Every selector and text below is an uncalibrated hint: the generic rules decide, so a
  // wrong hint ends as "needs you", never as a wrong click.

  const ADAPTERS = {
    greenhouse: {
      formRoot: ["form#application-form", "form#application_form"],
      resumeInput: ["#resume_fieldset input[type=file]", "input[type=file]#resume"],
      submitSelector: ["input#submit_app", "button[type=submit]"],
      confirmUrl: /\/confirmation(\b|\/|\?|$)/i,
      errorSelectors: [".field-error", ".error", "[aria-invalid=true]", "[role=alert]"],
      dropZone: ["[class*='drop-zone' i]", "[class*='dropzone' i]"],
    },
    lever: {
      formRoot: ["form#application-form", "form[action$='/apply']"],
      resumeInput: ["input[type=file][name=resume]", "#resume-upload-input"],
      submitSelector: ["#btn-submit", "[data-qa=btn-submit]"],
      confirmUrl: /\/thanks(\/|\?|$)/i,
      errorSelectors: [".error-message", "[aria-invalid=true]", "[role=alert]"],
      dropZone: [],
    },
    ashby: {
      formRoot: ["form", "[class*='application-form']"],
      resumeInput: ["input[type=file][id*='resume' i]", "[name='_systemfield_resume'] input[type=file]"],
      submitSelector: ["button[class*='submit-button']"],
      confirmUrl: null,
      errorSelectors: ["[class*='error']", "[aria-invalid=true]", "[role=alert]"],
      dropZone: ["[class*='drop-zone' i]", "[class*='dropzone' i]"],
    },
  };
  const HOSTS = new Map([
    ["job-boards.greenhouse.io", "greenhouse"],
    ["boards.greenhouse.io", "greenhouse"],
    ["jobs.lever.co", "lever"],
    ["jobs.eu.lever.co", "lever"],
    ["jobs.ashbyhq.com", "ashby"],
  ]);
  const adapterFor = (ats) => (typeof ats === "string" && Object.hasOwn(ADAPTERS, ats) ? ADAPTERS[ats] : null);
  const BOARD_TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
  const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;

  const RESUME = /resume|cv|curriculum/i;
  const NOT_RESUME = /autofill|parse|cover/i;
  const CLOSED = /no longer (accepting|available)|job (is )?closed|position has been filled/i;
  const ALREADY = /already (applied|submitted)/i;
  const ACCOUNT = /create (an |your )?account|sign (in|up) to (apply|continue)|log ?in to (apply|continue)/i;
  const LOGIN_PATH = /\/(log-?in|sign-?in|sign_in|sign-?up|users\/sign_in)(\/|$)/i;
  const ATTEST_CONTROL =
    /certif(y|ication that)|attest|hereby|acknowledge|i agree|agree to|consent|terms|signature|true,? (and )?(correct|accurate|complete)/i;
  const ATTEST_TEXT =
    /\b(i|you) (hereby )?(certify|attest|declare|swear|affirm)\b|by (clicking|submitting|pressing|applying)[^.]{0,120}\b(certify|attest|declare|swear|affirm|confirm that)\b|electronic signature/i;
  const TYPED_NAME = /signature|type (your )?(full |legal )*name|initials/i;
  const DEMOGRAPHIC =
    /gender|race|ethnic|hispanic|latin[oax]|veteran|disability|sexual orientation|transgender|pronoun|self[- ]identif|equal employment|\beeo\b/i;
  const SENSITIVE =
    /salary|compensation|pay expectation|social security|\bssn\b|date of birth|birth ?date|criminal|convict|felony|religion|marital|passport/i;
  const PRIVACY = /privacy (notice|policy)|personal (data|information)|data protection/i;
  const NEXT = /^(next|continue|next step|save (and|&) continue)$/i;
  const SUBMIT = /^submit( (your|my))?( job)? application$|^submit$/i;
  const SUCCESS =
    /thank you for (applying|your application)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application/i;
  const CODE_STEP = /enter the (verification |security )?code|we sent (you )?(a|an) (code|email)|verify your email/i;
  const ROBOT = /i'?m not a robot|verify you are human/i;
  const BUSY = /uploading|spinner|progress/i;
  const STAR = /[*✱]\s*$|\(required\)/i;
  const AUTH_Q = /authori[sz]ed|authori[sz]ation|legally.*work|eligible to work|right to work/;
  const SPON_Q = /sponsor|visa/;
  const NOT_SELF = /refer|reference|manager|supervisor|emergency|recruiter|friend|spouse|partner|parent|guardian|hiring|interviewer|company|employer/i;
  const LOCATION = /\blocation\b|\bcity\b/i;
  const PLACEHOLDER = /^(select|choose|pick|search|start typing|type to search|please select)\b/i;
  const TEXTLIKE = ["text", "email", "tel", "url", "search", "textarea"];
  const IDENTITY = map.filter(([k]) => ["firstName", "lastName", "fullName", "email", "phone"].includes(k));
  const APPROVED = ["profile", "record", "eligibility", "cover_letter", "resume"];
  const CHALLENGE_FRAMES = [
    (s) => /recaptcha\/(api2|enterprise)\/bframe/i.test(s),
    (s) => /recaptcha\/(api2|enterprise)\/anchor/i.test(s) && !/size=invisible/i.test(s),
    (s) => /hcaptcha\.com/i.test(s) && /frame=(checkbox|challenge)/i.test(s),
    (s) => /challenges\.cloudflare\.com/i.test(s),
  ];
  const CAPTCHA_MARKERS = ".grecaptcha-badge,[data-sitekey],.g-recaptcha,.h-captcha,.cf-turnstile";
  const CAPTCHA_SCRIPT = /recaptcha\/api\.js|recaptcha\/enterprise\.js|hcaptcha\.com\/1\/api\.js|turnstile/i;
  const US_STATES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
    DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
    IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
    NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
    RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
    VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  };

  const COPY = {
    already_clicked: "ApplyPilot already pressed Submit on this page.",
    form_not_found: "Couldn't find the application form.",
    ambiguous_form: "Found more than one application form.",
    closed: "The posting looks closed.",
    form_in_iframe: "The form is inside a frame.",
    wrong_page: "This page isn't the job you approved.",
    job_closed: "The posting looks closed.",
    already_applied: "The site says you already applied.",
    password_field: "The page asks for a password.",
    captcha: "The page shows a CAPTCHA.",
    account_required: "The site wants you to sign in or create an account.",
    attestation: "The form asks you to certify or sign something.",
    demographic: "A demographic question needs you",
    sensitive_question: "A personal question needs you",
    multi_step: "The form has more than one page.",
    unanswered_required: "Needs your answer",
    site_value_on_required: "Check the answer the site filled in",
    other_file_required: "The form wants another file",
    cover_letter_file_required: "The form wants a cover letter file.",
    value_reset: "An answer was cleared after filling",
    unstable_form: "The form kept changing while ApplyPilot checked it.",
    validation_errors: "The form shows an error.",
    resume_field_missing: "Couldn't find the resume upload.",
    ambiguous_resume_field: "Found more than one resume upload.",
    resume_not_attached: "Your resume didn't attach.",
    resume_mismatch: "The attached file isn't this job's resume.",
    resume_unverified: "Couldn't check the attached resume.",
    other_file_attached: "Another file is attached to the form.",
    no_or_ambiguous_submit: "Couldn't find exactly one Submit application button.",
    submit_disabled: "The Submit button stayed disabled.",
    adapter_mismatch: "The page doesn't look the way ApplyPilot expects for this site.",
    unverifiable_choice: "Couldn't confirm a Yes/No answer",
    not_audited: "ApplyPilot hasn't checked this page yet.",
    audit_failed: "The last check found something that needs you.",
    url_changed: "The page changed after ApplyPilot checked it.",
    fingerprint_changed: "The form changed after ApplyPilot checked it.",
    submit_changed: "The Submit button changed after ApplyPilot checked it.",
    relaxations_changed: "Something new appeared on the page after ApplyPilot checked it.",
  };
  const clip = (s, n) => {
    const t = norm(s);
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const B = (code, label) => ({ code, text: label ? `${COPY[code].replace(/\.$/, "")}: ${clip(label, 120)}` : COPY[code] });

  const state = { root: null, filled: new Map(), audit: null, flagged: [], fillFlagged: [], watching: false, armed: null, peterListener: false };
  const api = {
    version: VERSION,
    clicked: !!previous?.clicked,
    assistant,
    findForm,
    fill,
    audit,
    pressSubmit,
    armSupervised,
    readOutcome,
    watchForConfirmation,
    bannerNeedsYou,
    snapshot,
  };

  function norm(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }
  function simple(s) {
    return norm(s).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  function hasWord(text, w) {
    return !!w && ` ${simple(text)} `.includes(` ${simple(w)} `);
  }
  function digits(s) {
    return String(s ?? "").replace(/\D+/g, "");
  }
  function fnv1a(s) {
    let h = 0x811c9dc5;
    const t = String(s);
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Same rules as parseAtsUrl() in ats.js; a page-side copy because this is a classic script.
  function pageJobKey(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const ats = HOSTS.get(u.hostname.toLowerCase());
    if (!ats) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    let board = "",
      id = "";
    if (ats === "greenhouse") {
      if (parts[0] === "embed" && parts[1] === "job_app" && parts.length === 2) {
        board = u.searchParams.get("for") || "";
        id = u.searchParams.get("token") || "";
      } else if (parts[1] === "jobs") {
        board = parts[0];
        id = parts[2] || "";
      }
    } else {
      board = parts[0] || "";
      id = parts[1] || "";
    }
    if (!BOARD_TOKEN.test(board) || !JOB_ID.test(id)) return null;
    return `${ats}:${board.toLowerCase()}:${id}`;
  }
  const atsOfHost = () => HOSTS.get(location.hostname.toLowerCase()) || "";

  function visible(el) {
    if (!el || !el.isConnected || typeof el.getBoundingClientRect !== "function") return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) !== 0;
  }
  // A frame counts as a shown challenge only when it is at least min x min, on the page and not faded out.
  function shown(el, min = 30) {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < min || r.height < min) return false;
    if (r.bottom + scrollY < 0 || r.right + scrollX < 0) return false;
    for (let e = el.parentElement; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) === 0) return false;
    return true;
  }
  function textOf(el, skip = "select,option,textarea,script,style,[role=listbox],[role=option]") {
    if (!el) return "";
    let s = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) if (!n.parentElement?.closest(skip)) s += " " + n.textContent;
    return norm(s);
  }
  const pageText = () => (document.body?.innerText || "").slice(0, 50000);
  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      const i = e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) + 1 : 1;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${i})`);
    }
    return ["html", ...parts].join(" > ");
  }
  function labelEls(f) {
    const ls = f.labels ? Array.from(f.labels) : [];
    const by = (f.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    return [...ls, ...by];
  }
  // Like own(), but label text skips option lists, so a label that wraps a select still reads as the question.
  function labelTexts(f) {
    return [
      ...labelEls(f).map((l) => textOf(l)),
      f.getAttribute("aria-label"),
      f.getAttribute("placeholder"),
      f.getAttribute("name"),
      f.id,
      f.getAttribute("autocomplete"),
    ]
      .filter(Boolean)
      .map((x) => norm(x).replace(/[\s*:✱]+$/, "").trim())
      .filter(Boolean);
  }
  // What a field is called, without placeholder hints such as "Add a cover letter or anything else".
  const nameTexts = (f) => [...labelEls(f).map((l) => textOf(l)), f.getAttribute("aria-label"), f.getAttribute("name"), f.id].filter(Boolean).join(" ");
  const strictMatch = (f, rules) => {
    const parts = labelTexts(f);
    return rules.find(([, p]) => parts.some((x) => p.test(x)));
  };
  function typeOf(f) {
    if (f.tagName === "INPUT") return (f.type || "text").toLowerCase();
    if (f.tagName === "SELECT") return "select";
    if (f.tagName === "TEXTAREA") return "textarea";
    if (f.tagName === "BUTTON") return "button";
    return (f.getAttribute("role") || f.tagName).toLowerCase();
  }
  const isCombo = (f) =>
    f.getAttribute("role") === "combobox" ||
    f.getAttribute("aria-haspopup") === "listbox" ||
    f.getAttribute("aria-autocomplete") === "list";
  const isButtonLike = (b) => b.matches("button,input[type=submit],input[type=button],input[type=image],input[type=reset],[role=button]");
  function btnLabel(b) {
    const t = b.tagName === "INPUT" ? b.value || b.getAttribute("aria-label") : b.innerText || b.getAttribute("aria-label") || b.textContent;
    return norm(t).replace(/[^\p{L}\p{N})]+$/u, "");
  }
  const groupOf = (f) =>
    f.name ? Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(f.name)}"]`)) : [f];
  const pressedOf = (b) => b.getAttribute("aria-pressed") ?? b.getAttribute("aria-checked");
  // The value a field shows, read the same way when it is filled and when it is checked again.
  function comboValue(f) {
    const labels = labelEls(f);
    let e = f.parentElement;
    for (let i = 0; e && i < 3; i++, e = e.parentElement) {
      if (labels.some((l) => e.contains(l)) || e.matches("form,fieldset")) break;
      const t = e.querySelector("[role=listbox]") ? textOf(e) : norm(e.innerText);
      if (t) return PLACEHOLDER.test(t) || t === norm(f.getAttribute("placeholder")) ? "" : t;
    }
    return norm(f.value);
  }
  function ctlValue(f) {
    const t = typeOf(f);
    if (t === "checkbox" || t === "radio") return f.checked ? "1" : "0";
    if (t === "file") return Array.from(f.files || [], (x) => `${x.name}:${x.size}`).join("|");
    if (isCombo(f)) return `${f.value ?? ""}|${comboValue(f)}`;
    if (f.tagName === "INPUT" || f.tagName === "SELECT" || f.tagName === "TEXTAREA") return String(f.value ?? "");
    return `${f.getAttribute("aria-pressed")}|${f.getAttribute("aria-checked")}|${f.getAttribute("aria-selected")}`;
  }
  function readFor(f) {
    if (f.tagName === "INPUT" && ["checkbox", "radio"].includes(typeOf(f))) return f.checked ? "1" : "0";
    if (isCombo(f)) return comboValue(f);
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(f.tagName)) return String(pressedOf(f));
    return ctlValue(f);
  }
  function shownValue(f) {
    const t = typeOf(f);
    if (t === "select") return norm(f.selectedOptions?.[0]?.textContent || f.value);
    if (t === "radio" || t === "checkbox") return f.checked ? norm(f.labels?.[0]?.textContent || f.value || "Yes") : "";
    if (t === "file") return Array.from(f.files || [], (x) => x.name).join(", ");
    if (isCombo(f)) return comboValue(f);
    if (!["INPUT", "TEXTAREA"].includes(f.tagName)) return pressedOf(f) === "true" ? btnLabel(f) : "";
    return clip(f.value, 200);
  }
  function isRequired(f) {
    if (f.required || f.getAttribute("aria-required") === "true") return true;
    return labelEls(f).some(
      (l) => STAR.test(textOf(l)) || !!l.querySelector(".required,.asterisk,[class*='required' i]:not([class*='not-required' i])"),
    );
  }
  function groupLabelEl(f) {
    const g = f.closest("fieldset,[role=radiogroup],[role=group]");
    if (!g) return null;
    const by = (g.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id))[0];
    return g.querySelector(":scope > legend") || by || g.querySelector(":scope > label, :scope > [class*='label' i]") || null;
  }
  const controlsIn = (root) =>
    Array.from(new Set(root.querySelectorAll("input,select,textarea,button,[role=button],[role=combobox],[role=checkbox],[role=radio],[role=switch]")));
  const valueSig = (root) => (root ? fnv1a(controlsIn(root).map(ctlValue).join("\u0001")) : "");

  function fieldBox(el, root) {
    const box = el.closest("fieldset,[role=group],.field,.form-group,.application-question,.question,li,[class*='field' i],[class*='upload' i]");
    if (box && box !== root && root.contains(box)) return box;
    const up = el.parentElement?.parentElement;
    return up && up !== root && root.contains(up) ? up : el.parentElement || el;
  }
  function commonAncestor(a, b) {
    let p = a;
    while (p && !p.contains(b)) p = p.parentElement;
    return p;
  }
  function fileTexts(f) {
    const mine = labelTexts(f).join(" ");
    const g = f.closest("fieldset");
    const grp = f.closest("[role=group]");
    const named = f.parentElement?.closest("[name]:not(form):not(input)");
    const group = [g ? textOf(g.querySelector(":scope > legend")) : "", grp?.getAttribute("aria-label") || "", named?.getAttribute("name") || ""].join(" ");
    return { mine, group };
  }
  function resumeInputs(scope) {
    return Array.from(scope.querySelectorAll("input[type=file]")).filter((f) => {
      const { mine, group } = fileTexts(f);
      if (NOT_RESUME.test(mine) || /autofill|parse/i.test(group)) return false;
      return RESUME.test(mine) || (RESUME.test(group) && !/cover/i.test(group));
    });
  }
  function emailInputs(scope) {
    return Array.from(scope.querySelectorAll("input")).filter((f) => {
      const t = typeOf(f);
      if ((t !== "email" && t !== "text") || !visible(f)) return false;
      return t === "email" || labelTexts(f).some((x) => /e.?mail/i.test(x));
    });
  }
  // The form root holds both a visible email field and the resume upload. Adapter hints are tried first and
  // only count when they hold both too.
  function locate(adapter) {
    const emails = emailInputs(document),
      resumes = resumeInputs(document);
    if (!emails.length || !resumes.length) return null;
    const holds = (r) => emails.some((e) => r.contains(e)) && resumes.some((x) => r.contains(x));
    for (const sel of adapter?.formRoot || []) {
      const hits = Array.from(document.querySelectorAll(sel)).filter(holds);
      if (hits.length === 1) return { root: hits[0] };
    }
    const roots = [];
    for (const e of emails)
      for (const r of resumes) {
        const f = e.closest("form");
        const root = f && f.contains(r) ? f : commonAncestor(e, r);
        if (root && !roots.includes(root)) roots.push(root);
      }
    const inner = roots.filter((r) => !roots.some((o) => o !== r && r.contains(o)));
    return inner.length === 1 ? { root: inner[0] } : { reason: "ambiguous_form" };
  }
  function currentRoot(adapter) {
    if (state.root?.isConnected) return state.root;
    const found = locate(adapter);
    state.root = found?.root || null;
    return state.root;
  }
  function multiStep(root) {
    const nexts = controlsIn(root).filter((b) => isButtonLike(b) && visible(b) && NEXT.test(btnLabel(b)));
    const stepper =
      !!root.querySelector("[class*='stepper' i],[aria-label*='step ' i]") || /\bstep \d+ (of|\/) \d+\b/i.test(root.innerText || "");
    return nexts.length > 0 || stepper;
  }
  const alreadyClicked = () =>
    !!(api.clicked || document.documentElement.dataset.applypilotSubmitted || document.documentElement.dataset.applypilotPeterClicked);

  function waitFor(test, timeoutMs, everyMs = 200) {
    return new Promise((resolve) => {
      let done = false,
        queued = false;
      const check = () => {
        queued = false;
        let ok = false;
        try {
          ok = !!test();
        } catch {}
        if (ok) finish(true);
      };
      const mo = new MutationObserver(() => {
        if (!queued) {
          queued = true;
          setTimeout(check, 30);
        }
      });
      const finish = (v) => {
        if (done) return;
        done = true;
        mo.disconnect();
        clearInterval(iv);
        clearTimeout(to);
        resolve(v);
      };
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const iv = setInterval(check, everyMs);
      const to = setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }
  // Resolves once neither the DOM nor any control value has changed for ms (or after maxMs regardless).
  function quiet(root, ms, maxMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      let last = start,
        sig = valueSig(root);
      const mo = new MutationObserver(() => (last = Date.now()));
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const iv = setInterval(() => {
        const now = Date.now(),
          s = valueSig(root);
        if (s !== sig) {
          sig = s;
          last = now;
        }
        if (now - last >= ms || now - start >= maxMs) {
          clearInterval(iv);
          mo.disconnect();
          resolve(now - last >= ms);
        }
      }, 100);
    });
  }
  function post(kind, extra = {}) {
    const msg = { type: "AP_PAGE_EVENT", kind, url: location.href, text: "", fingerprint: "", ...extra };
    try {
      const r = globalThis.chrome?.runtime?.sendMessage?.(msg);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {}
  }

  // ---- findForm --------------------------------------------------------------------------------

  async function findForm({ ats, timeoutMs = 20000 } = {}) {
    const adapter = adapterFor(ats);
    let res = null;
    await waitFor(
      () => {
        res = locate(adapter);
        if (res?.root) return true;
        if (CLOSED.test(pageText())) {
          res = { reason: "closed" };
          return true;
        }
        return false;
      },
      timeoutMs,
      250,
    );
    const inIframe = window.top !== window;
    if (res?.root) {
      state.root = res.root;
      return { ok: true, reason: "", text: "", rootPath: cssPath(res.root), inIframe, multiStep: multiStep(res.root) };
    }
    const framed = Array.from(document.querySelectorAll("iframe")).some((f) =>
      /greenhouse\.io|lever\.co|ashbyhq\.com|job_app/i.test(f.getAttribute("src") || ""),
    );
    const reason = res?.reason === "closed" ? "closed" : res?.reason === "ambiguous_form" ? "ambiguous_form" : framed ? "form_in_iframe" : "form_not_found";
    return { ok: false, reason, text: COPY[reason], rootPath: "", inIframe: inIframe || framed, multiStep: false };
  }

  // ---- fill ------------------------------------------------------------------------------------

  function setText(f, v) {
    if (!set(f, v)) return false;
    f.dispatchEvent(new FocusEvent("blur"));
    f.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return true;
  }
  function record(el, source, intended) {
    const read = intended === undefined ? readFor(el) : intended;
    const t = typeOf(el);
    const native = ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
    const pair = native ? null : choicePairs(state.root || document.body).find((p) => p.yes === el || p.no === el);
    const entry = {
      el,
      label: clip(labelOf(el), 120),
      type: isCombo(el) ? "combobox" : native ? t : "choice",
      required: pair ? pair.required : el.tagName === "INPUT" && t === "radio" ? groupOf(el).some(isRequired) : isRequired(el),
      value: t === "file" ? shownValue(el) || clip(el.dataset.applypilotFile || "", 200) : shownValue(el) || clip(read, 200),
      source,
      hash: fnv1a(read),
      phone: strictMatch(el, IDENTITY)?.[0] === "phone" ? digits(read) : "",
    };
    el.setAttribute("data-applypilot-filled", entry.hash);
    state.filled.set(el, entry);
  }
  function labelOf(f) {
    if (f.tagName === "INPUT" && typeOf(f) === "radio") return textOf(groupLabelEl(f)) || question(f) || f.name;
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(f.tagName)) {
      const pair = choicePairs(state.root || document.body).find((p) => p.yes === f || p.no === f);
      if (pair) return pair.label;
    }
    return labelTexts(f)[0] || question(f) || f.getAttribute("name") || f.id || typeOf(f);
  }
  function untouchable(f) {
    const q = [...labelTexts(f), question(f)].join(" ");
    return DEMOGRAPHIC.test(q) || SENSITIVE.test(q) || sensitive.test(q) || attestationControl(f);
  }
  function attestationControl(f) {
    const t = typeOf(f);
    const own = labelTexts(f).join(" ");
    if (t === "checkbox" || t === "switch") return ATTEST_CONTROL.test(`${own} ${question(f)} ${f.tagName === "INPUT" ? "" : textOf(f)}`);
    if (TEXTLIKE.includes(t)) return TYPED_NAME.test(own) || ATTEST_CONTROL.test(own);
    if (t === "select" || t === "radio") return ATTEST_CONTROL.test(`${own} ${question(f)}`);
    return false;
  }
  const stateCode = (s) => {
    const t = norm(s);
    if (US_STATES[t.toUpperCase()]) return t.toUpperCase();
    return Object.keys(US_STATES).find((k) => US_STATES[k].toLowerCase() === t.toLowerCase()) || "";
  };
  // Every spelling of an approved value that an option may show: "US" also accepts "United States", "GA" "Georgia".
  function variants(key, value) {
    const v = norm(value).toLowerCase();
    if (!v) return [];
    const out = [v];
    if (Object.hasOwn(alias, v)) out.push(alias[v]);
    if (key === "state") {
      const c = stateCode(value);
      if (c) out.push(c.toLowerCase(), US_STATES[c].toLowerCase());
    }
    return [...new Set(out)];
  }
  function setSelect(f, key, v) {
    for (const w of variants(key, v)) if (set(f, w)) return true;
    return false;
  }
  function safeToClick(el) {
    return !submitsForm(el) && !el.closest("a[href]") && !el.matches("input[type=submit],input[type=image],input[type=reset]");
  }
  function listOptions(input) {
    const ids = `${input.getAttribute("aria-controls") || ""} ${input.getAttribute("aria-owns") || ""}`.split(/\s+/).filter(Boolean);
    let boxes = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!boxes.length) boxes = Array.from(document.querySelectorAll("[role=listbox]")).filter(visible);
    if (boxes.length !== 1) return [];
    return Array.from(boxes[0].querySelectorAll("[role=option]")).filter(visible);
  }
  function press(el) {
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
  }
  function typeInto(input, v) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (input.tagName !== "INPUT") return;
    if (setter) setter.call(input, v);
    else input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // Picks the single option the approved answer names, then reads the field back. The retry opens the list
  // with ArrowDown and clicks again; it never sends Enter, which a page could treat as submitting the form.
  async function chooseOption(input, typed, accept, readBack = accept) {
    if (input.tagName !== "INPUT") return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      input.focus();
      if (attempt === 0) typeInto(input, typed);
      else input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true, cancelable: true }));
      await waitFor(() => listOptions(input).length > 0, 3000, 100);
      const hits = listOptions(input).filter((o) => accept(norm(o.textContent)));
      if (hits.length !== 1 || !safeToClick(hits[0])) continue;
      press(hits[0]);
      if (await waitFor(() => !listOptions(input).length && readBack(comboValue(input)), 1000, 100)) {
        input.blur();
        return true;
      }
    }
    if (norm(input.value)) typeInto(input, "");
    input.blur();
    return false;
  }
  // Yes/No answered with a pair of buttons. A pair is the nearest container holding exactly one Yes and one No.
  function choicePairs(root) {
    const btns = Array.from(root.querySelectorAll("button,[role=button],[role=radio]")).filter(
      (b) => b.tagName !== "INPUT" && visible(b) && /^(yes|no)$/i.test(btnLabel(b)),
    );
    const pairs = [];
    for (const yes of btns.filter((b) => /^yes$/i.test(btnLabel(b)))) {
      let box = yes.parentElement;
      while (box && root.contains(box) && btns.filter((b) => box.contains(b)).length < 2) box = box.parentElement;
      if (!box || !root.contains(box)) continue;
      const inBox = btns.filter((b) => box.contains(b));
      const no = inBox.filter((b) => /^no$/i.test(btnLabel(b)));
      if (inBox.length !== 2 || no.length !== 1) continue;
      let field = box;
      while (field !== root && field.parentElement && textOf(field).replace(/\b(yes|no)\b/gi, "").trim().length < 3) field = field.parentElement;
      const labelEl = field.querySelector("label,legend,[class*='label' i],[class*='question' i]");
      const raw = textOf(labelEl && !labelEl.contains(yes) ? labelEl : field).replace(/\b(yes|no)\b/gi, " ");
      pairs.push({
        yes,
        no: no[0],
        box,
        field,
        label: norm(raw).replace(/[\s*:✱]+$/, "") || "Yes/No question",
        question: norm(raw).toLowerCase().slice(0, 240),
        required: STAR.test(norm(raw)) || field.getAttribute("aria-required") === "true" || box.getAttribute("aria-required") === "true",
      });
    }
    return pairs;
  }
  const pairHasState = (p) => pressedOf(p.yes) !== null && pressedOf(p.no) !== null;
  const pairValue = (p) => (pressedOf(p.yes) === "true" ? p.yes : pressedOf(p.no) === "true" ? p.no : null);
  async function clickChoiceButton(pair, answer) {
    const btn = answer ? pair.yes : pair.no,
      other = answer ? pair.no : pair.yes;
    if (!pairHasState(pair) || !safeToClick(btn)) return false;
    if (pressedOf(btn) !== "true") {
      btn.click();
      await waitFor(() => pressedOf(btn) === "true", 1000, 100);
    }
    return pressedOf(btn) === "true" && pressedOf(other) !== "true";
  }
  function dropZoneFor(input, root, adapter) {
    for (const sel of adapter?.dropZone || []) {
      const z = input.closest(sel);
      if (z && root.contains(z) && z.querySelectorAll("input[type=file]").length === 1) return z;
    }
    return null;
  }
  function busyIn(box) {
    if (/uploading/i.test(textOf(box))) return true;
    return Array.from(box.querySelectorAll("*")).some(
      (e) =>
        visible(e) &&
        (BUSY.test(e.getAttribute("class") || "") || e.getAttribute("role") === "progressbar" || e.getAttribute("aria-busy") === "true"),
    );
  }
  const exactTextIn = (box, name) => Array.from(box.querySelectorAll("*")).some((e) => norm(e.innerText) === name);

  async function attachResume(root, adapter, resume, out, block) {
    const inputs = resumeInputs(root);
    if (!inputs.length) return block("resume_field_missing"), null;
    if (inputs.length > 1) return block("ambiguous_resume_field", null, inputs[1]), null;
    const input = inputs[0];
    const hinted = hintMatches(root, adapter?.resumeInput);
    if (hinted.length && (hinted.length !== 1 || hinted[0] !== input)) return block("adapter_mismatch", null, input), null;
    out.resumeInputPath = cssPath(input);
    if (!resume?.b64 || !resume.name) return block("resume_not_attached", null, input), input;
    const cur = input.files?.[0];
    if (!(cur && cur.name === resume.name && cur.size === resume.size)) {
      const file = new File([bytesOf(resume.b64)], resume.name, { type: resume.type || "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      mark(input, "#2f7df6");
      // Only drop when the change event alone didn't take, so a widget that handles both doesn't get two files.
      const zone = dropZoneFor(input, root, adapter);
      const box = fieldBox(input, root);
      if (zone && !(await waitFor(() => textOf(box).includes(resume.name), 1000, 100)))
        zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    await sleep(300);
    const box = fieldBox(input, root);
    let calm = 0;
    const settled = await waitFor(
      () => {
        const ok = (input.files?.[0]?.name === resume.name || textOf(box).includes(resume.name)) && !busyIn(box);
        calm = ok ? calm + 1 : 0;
        return calm >= 2;
      },
      20000,
      250,
    );
    if (!settled) return block("resume_not_attached", null, input), input;
    input.dataset.applypilotFile = resume.name;
    record(input, "resume");
    return input;
  }
  function hintMatches(root, sels) {
    for (const sel of sels || []) {
      const m = Array.from(root.querySelectorAll(sel));
      if (m.length) return m;
    }
    return [];
  }
  function identityPass(root, p, recordRoots) {
    let fixed = 0;
    for (const f of root.querySelectorAll("input")) {
      const t = typeOf(f);
      if (!["text", "email", "tel"].includes(t) || f.disabled || f.readOnly || isCombo(f) || untouchable(f)) continue;
      if (recordRoots.some((r) => r.contains(f)) || NOT_SELF.test(labelTexts(f).join(" "))) continue;
      const m = strictMatch(f, IDENTITY);
      if (!m) continue;
      const want = norm(p[m[0]]);
      if (!want) continue;
      const same = m[0] === "phone" ? digits(f.value) === digits(want) : f.value === want;
      if (!same) {
        if (setText(f, want)) {
          record(f, "profile", want);
          fixed++;
        }
      } else if (!state.filled.has(f)) record(f, "site", f.value);
    }
    return fixed;
  }

  async function fill({ profile, resume, coverLetter = "", ats } = {}) {
    const out = { filled: [], blockers: [], resumeInputPath: "" };
    state.fillFlagged = [];
    const block = (code, label, el) => {
      out.blockers.push(B(code, label));
      if (el) state.fillFlagged.push(el);
    };
    if (alreadyClicked()) {
      block("already_clicked");
      return out;
    }
    const adapter = adapterFor(ats);
    const root = currentRoot(adapter);
    if (!root) {
      block("form_not_found");
      return out;
    }
    const p = profile || {};
    state.filled = new Map();

    // 1. This job's resume, then let any resume parser on the page finish.
    const resumeInput = await attachResume(root, adapter, resume, out, block);
    await quiet(root, 1000, 5000);

    // 2. Cover letter: a text box is filled from the approved letter; a required file upload goes to you.
    for (const f of root.querySelectorAll("input[type=file]")) {
      if (f !== resumeInput && /cover/i.test(nameTexts(f)) && isRequired(f)) block("cover_letter_file_required", null, f);
    }
    const letter = String(coverLetter || "").trim();
    if (letter)
      for (const f of root.querySelectorAll("textarea")) {
        if (f.disabled || f.readOnly || norm(f.value) || untouchable(f)) continue;
        if (/cover.?letter/i.test(nameTexts(f)) && setText(f, letter)) record(f, "cover_letter", letter);
      }

    // Work and education records, through the same filler the manual assistant uses.
    const work = sectionRoots(WORK).filter((r) => root.contains(r)),
      edu = sectionRoots(EDU).filter((r) => root.contains(r));
    const recordRoots = [...work, ...edu];
    const onRecord = (f, v) => record(f, "record", v);
    // The batch gate is wider than the manual one, so a record field asking about you personally is still left alone.
    fillSections(work, p.workHistory || [], onRecord, untouchable);
    fillSections(edu, p.education || [], onRecord, untouchable);

    // 3-7. Text fields, native selects and radios, matched on each field's own label only.
    const authorized = typeof p.workAuthorized === "boolean" ? p.workAuthorized : null;
    const needsSponsor = typeof p.requiresSponsorship === "boolean" ? p.requiresSponsorship : null;
    const answerFor = (q) => {
      const aQ = AUTH_Q.test(q),
        sQ = SPON_Q.test(q);
      return aQ || sQ ? eligibility(q, aQ, sQ, authorized, needsSponsor) : null;
    };
    const skills = (Array.isArray(p.skills) ? p.skills : String(p.skills || "").split(","))
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join(", ");
    const combos = [],
      locations = [],
      doneRadios = new Set();
    for (const f of root.querySelectorAll("input,select,textarea")) {
      const t = typeOf(f);
      if (f.disabled || f.readOnly || ["hidden", "password", "submit", "button", "reset", "image", "file", "checkbox"].includes(t)) continue;
      if (recordRoots.some((r) => r.contains(f)) && match(f, recordFields)) continue;
      if (untouchable(f)) continue;
      if (isCombo(f)) {
        if (!recordRoots.some((r) => r.contains(f))) combos.push(f);
        continue;
      }
      if (t === "radio") {
        const group = groupOf(f);
        if (group.some((x) => doneRadios.has(x))) continue;
        group.forEach((x) => doneRadios.add(x));
        if (group.some((x) => x.checked)) continue;
        const a = answerFor(question(f));
        if (typeof a === "boolean" && choice(f, a ? "yes" : "no")) {
          const c = group.find((x) => x.checked);
          if (c) record(c, "eligibility", "1");
        }
        continue;
      }
      if (norm(f.value)) continue;
      if (f.tagName === "TEXTAREA" && /cover.?letter/i.test(nameTexts(f))) continue;
      const lt = labelTexts(f).join(" ");
      const m = NOT_SELF.test(lt) ? undefined : strictMatch(f, map);
      if (t === "select") {
        if (m) {
          const v = norm(p[m[0]]);
          if (v && setSelect(f, m[0], v)) record(f, "profile");
          continue;
        }
        const a = answerFor(question(f) || lt.toLowerCase());
        if (typeof a === "boolean" && set(f, a ? "yes" : "no")) record(f, "eligibility");
        continue;
      }
      if (!TEXTLIKE.includes(t)) continue;
      if (m) {
        const v = norm(p[m[0]]);
        if (v && setText(f, v)) record(f, "profile", v);
        continue;
      }
      if (skills && strictMatch(f, [["skills", /skills|technologies|expertise/i]])) {
        if (setText(f, skills)) record(f, "profile", skills);
        continue;
      }
      if (LOCATION.test(lt) && t !== "textarea") locations.push(f);
    }

    // 5. Comboboxes, only for fixed approved answers (country, state, Yes/No), with exact option match and read-back.
    for (const f of combos) {
      if (comboValue(f)) continue;
      const lt = labelTexts(f).join(" ");
      if (NOT_SELF.test(lt)) continue;
      const m = strictMatch(f, map);
      let wants = null,
        source = "profile";
      if (m && (m[0] === "country" || m[0] === "state")) wants = variants(m[0], p[m[0]]);
      else if (!m || m[0] === "city") {
        const a = answerFor(question(f) || lt.toLowerCase());
        if (typeof a === "boolean") {
          wants = [a ? "yes" : "no"];
          source = "eligibility";
        } else if (LOCATION.test(lt)) {
          locations.push(f);
          continue;
        }
      }
      if (!wants?.length) continue;
      const typed = norm(m ? p[m[0]] : wants[0]);
      const ok = await chooseOption(f, typed || wants[0], (t) => wants.includes(t.toLowerCase()));
      if (ok) record(f, source);
      else if (isRequired(f)) block("unanswered_required", labelOf(f), f);
    }

    // 6. Yes/No button pairs; the pressed state must be readable before and after the click.
    for (const pair of choicePairs(root)) {
      const q = pair.question;
      if (DEMOGRAPHIC.test(q) || SENSITIVE.test(q) || sensitive.test(q) || ATTEST_CONTROL.test(q) || pairValue(pair)) continue;
      const a = answerFor(q);
      if (typeof a !== "boolean") continue;
      if (await clickChoiceButton(pair, a)) record(a ? pair.yes : pair.no, "eligibility", "true");
      else block("unverifiable_choice", pair.label, pair.field);
    }

    // 8. Required location autocomplete: one option that starts with the city and names the state.
    for (const f of locations) {
      if (!isRequired(f) || (isCombo(f) ? comboValue(f) : norm(f.value))) continue;
      const city = norm(p.city),
        st = stateCode(p.state);
      const starts = (t) => !!city && t.toLowerCase().startsWith(city.toLowerCase());
      const ok =
        !!city &&
        !!st &&
        (await chooseOption(
          f,
          `${city}, ${st}`,
          (t) => starts(t) && (hasWord(t, st) || hasWord(t, US_STATES[st])),
          (v) => starts(v),
        ));
      if (ok) record(f, "profile");
      else block("unanswered_required", labelOf(f), f);
    }

    // 9. Identity pass: a resume parser may have rewritten name, email or phone.
    await quiet(root, 1000, 5000);
    if (identityPass(root, p, recordRoots)) {
      await quiet(root, 1000, 4000);
      identityPass(root, p, recordRoots);
    }

    out.filled = Array.from(state.filled.values(), ({ label, type, required, value, source }) => ({ label, type, required, value, source })).slice(0, 60);
    return out;
  }

  // ---- audit (R3-R8) ---------------------------------------------------------------------------

  function units(root) {
    const out = [],
      seen = new Set();
    for (const f of root.querySelectorAll("input,select,textarea,[role=combobox]:not(input),[role=checkbox]:not(input),[role=switch]")) {
      if (seen.has(f)) continue;
      const t = typeOf(f);
      if (["hidden", "submit", "button", "reset", "image", "password"].includes(t)) continue;
      if (f.tagName === "INPUT" && t === "radio") {
        const group = groupOf(f).filter((x) => root.contains(x));
        group.forEach((x) => seen.add(x));
        out.push({ kind: "radio", els: group, first: f });
        continue;
      }
      seen.add(f);
      out.push({ kind: t === "file" ? "file" : t === "checkbox" || t === "switch" ? "check" : "single", els: [f], first: f });
    }
    for (const pair of choicePairs(root)) out.push({ kind: "pair", els: [pair.yes, pair.no], first: pair.yes, pair });
    return out;
  }
  function unitText(u) {
    const f = u.first;
    if (u.kind === "pair") return u.pair.question;
    if (u.kind === "radio") return [question(f), textOf(groupLabelEl(f)), ...u.els.flatMap(labelTexts)].join(" ");
    return [...labelTexts(f), question(f), f.tagName === "INPUT" ? "" : textOf(f)].join(" ");
  }
  function unitRequired(u) {
    if (u.kind === "pair") return u.pair.required;
    if (u.kind === "radio") {
      const g = u.first.closest("fieldset,[role=radiogroup],[role=group]");
      return u.els.some(isRequired) || STAR.test(textOf(groupLabelEl(u.first))) || g?.getAttribute("aria-required") === "true";
    }
    return isRequired(u.first);
  }
  function unitChosen(u) {
    if (u.kind === "pair") return pairValue(u.pair);
    if (u.kind === "radio") return u.els.find((x) => x.checked) || null;
    return u.first;
  }
  function unitEmpty(u) {
    const f = u.first;
    if (u.kind === "pair" || u.kind === "radio") return !unitChosen(u);
    if (u.kind === "check") return f.tagName === "INPUT" ? !f.checked : f.getAttribute("aria-checked") !== "true";
    if (u.kind === "file") return !f.files?.length;
    if (isCombo(f)) return !comboValue(f);
    return !norm(f.value);
  }
  function unitShown(u) {
    const c = unitChosen(u);
    if (!c) return [];
    if (u.kind === "pair") return [btnLabel(c)];
    if (u.kind === "radio") return [norm(c.labels?.[0]?.textContent || ""), c.value];
    if (typeOf(c) === "select") return [c.value, norm(c.selectedOptions?.[0]?.textContent || "")];
    if (isCombo(c)) return [comboValue(c)];
    return [norm(c.value)];
  }
  function unitLabel(u) {
    if (u.kind === "pair") return u.pair.label;
    return clip(labelOf(u.first), 120);
  }
  function profileValues(p = {}) {
    const vals = [p.firstName, p.lastName, p.fullName, p.legalName, p.email, p.phone, p.city, p.state, p.postalCode, p.country, p.linkedIn];
    for (const r of [...(Array.isArray(p.workHistory) ? p.workHistory : []), ...(Array.isArray(p.education) ? p.education : [])])
      if (r && typeof r === "object") vals.push(...Object.values(r).filter((v) => typeof v === "string"));
    const out = new Set();
    for (const v of vals) for (const w of variants("state", v)) out.add(w);
    return out;
  }
  function equalsProfile(shownVals, p) {
    const pv = profileValues(p);
    const phone = digits(p?.phone);
    return shownVals.some((v) => {
      const t = norm(v).toLowerCase();
      return !!t && (pv.has(t) || (phone.length >= 7 && digits(t) === phone));
    });
  }
  function captchaState() {
    let challenge = false,
      marker = false;
    for (const fr of document.querySelectorAll("iframe")) {
      const src = fr.getAttribute("src") || "";
      if (CHALLENGE_FRAMES.some((t) => t(src)) && shown(fr)) challenge = true;
      else if (/recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(src)) marker = true;
    }
    if (ROBOT.test(pageText())) challenge = true;
    if (document.querySelector(CAPTCHA_MARKERS)) marker = true;
    if (Array.from(document.scripts).some((s) => CAPTCHA_SCRIPT.test(s.getAttribute("src") || ""))) marker = true;
    return { challenge, marker };
  }
  function errorsIn(scope, adapter, ignore) {
    const sels = new Set(["[aria-invalid=true]", "[role=alert]", ...(adapter?.errorSelectors || [])]);
    const out = new Set();
    for (const sel of sels)
      for (const el of scope.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        if (el.matches("[aria-invalid=true]")) {
          out.add(el);
          continue;
        }
        if (el.querySelector("input,select,textarea,button") || !norm(el.innerText)) continue;
        if (ignore && ignore.test(el.innerText)) continue;
        out.add(el);
      }
    return [...out];
  }
  function roleShown(role) {
    const r = simple(role);
    if (!r) return false;
    return [document.title, ...Array.from(document.querySelectorAll("h1,h2"), (h) => h.innerText)].some((t) =>
      ` ${simple(t)} `.includes(` ${r} `),
    );
  }
  function submitButton(root, adapter, resumeInput) {
    const all = Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],input[type=image],[role=button]")).filter((b) =>
      SUBMIT.test(btnLabel(b)),
    );
    const inRoot = all.filter((b) => root.contains(b) && visible(b));
    if (inRoot.length !== 1 || all.some((b) => !root.contains(b))) return { code: "no_or_ambiguous_submit" };
    const b = inRoot[0];
    if (b.closest("nav,header,[role=dialog]")) return { code: "no_or_ambiguous_submit", el: b };
    if (resumeInput && !(resumeInput.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING))
      return { code: "no_or_ambiguous_submit", el: b };
    for (const sel of adapter?.submitSelector || []) {
      const m = Array.from(document.querySelectorAll(sel)).filter(visible);
      if (m.length) {
        if (m.length !== 1 || m[0] !== b) return { code: "adapter_mismatch", el: b };
        break;
      }
    }
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return { code: "submit_disabled", el: b };
    return { el: b };
  }
  function notices(root) {
    const t = norm(root.innerText || "");
    const out = [];
    const re = new RegExp(PRIVACY.source, "gi");
    for (let m; (m = re.exec(t)) && out.length < 3; ) {
      const start = Math.max(t.lastIndexOf(".", m.index) + 1, m.index - 160);
      const end = t.indexOf(".", m.index);
      out.push(clip(t.slice(start, end < 0 ? m.index + 160 : end + 1), 200));
    }
    return [...new Set(out)];
  }

  // Everything that can be checked without waiting. pressSubmit() runs this again right before its click.
  function syncChecks(job, settings) {
    const adapter = adapterFor(job?.ats);
    const allowInvisible = settings?.allowInvisibleCaptcha !== false;
    const allowOptional = settings?.allowOptionalSensitiveBlank !== false;
    const blockers = [],
      flagged = [],
      relax = new Set();
    const add = (code, label, el, text) => {
      blockers.push(text ? { code, text } : B(code, label));
      if (el) flagged.push(el);
    };
    const res = { blockers, flagged, relaxations: [], report: [], fingerprint: "", submitEl: null, resumeInput: null, resumeFile: null, verifiedBy: "" };
    if (alreadyClicked()) add("already_clicked");

    // R3 right page
    const key = pageJobKey(location.href);
    if (!key || !job?.jobKey || key !== job.jobKey) add("wrong_page");
    else if (!roleShown(job.role)) add("wrong_page", null, null, "The page doesn't show the role you approved.");
    const text = pageText();
    if (CLOSED.test(text)) add("job_closed");
    if (ALREADY.test(text)) add("already_applied");

    // R4 hard blockers
    if (document.querySelector("input[type=password]")) add("password_field", null, document.querySelector("input[type=password]"));
    const cap = captchaState();
    if (cap.challenge || (cap.marker && !allowInvisible)) add("captcha");
    else if (cap.marker) relax.add("invisible_captcha");
    if (ACCOUNT.test(text) || LOGIN_PATH.test(location.pathname)) add("account_required");

    const root = currentRoot(adapter);
    if (!root) {
      add("form_not_found");
      res.relaxations = [...relax];
      return res;
    }
    if (window.top !== window) add("form_in_iframe");
    if (ATTEST_TEXT.test(norm(root.innerText || ""))) add("attestation");
    if (multiStep(root)) add("multi_step");

    const resumeEls = resumeInputs(root);
    const resumeInput = resumeEls.length === 1 ? resumeEls[0] : null;
    const all = units(root);
    for (const f of document.querySelectorAll("input,select,textarea"))
      if (!root.contains(f) && visible(f) && !["hidden", "submit", "button", "reset", "image"].includes(typeOf(f)))
        all.push({ kind: typeOf(f) === "checkbox" ? "check" : typeOf(f) === "file" ? "file" : "single", els: [f], first: f, outside: true });
    for (const u of all) {
      const q = unitText(u);
      const req = unitRequired(u),
        isEmpty = unitEmpty(u);
      const kind = DEMOGRAPHIC.test(q) ? "demographic" : SENSITIVE.test(q) ? "sensitive_question" : "";
      if (kind) {
        u.skip = true;
        // Optional ones may stay blank; ApplyPilot never fills or clicks them either way.
        if (!allowOptional || req || !isEmpty) add(kind, unitLabel(u), u.first);
        else relax.add("optional_sensitive_blank");
        continue;
      }
      const attest =
        u.kind === "pair" ? ATTEST_CONTROL.test(q) : u.kind === "radio" ? ATTEST_CONTROL.test(`${question(u.first)} ${textOf(groupLabelEl(u.first))}`) : attestationControl(u.first);
      if (attest) {
        u.skip = true;
        // An unticked optional consent box is fine; a typed signature or name always goes to you.
        const typed = u.kind === "single" && TEXTLIKE.includes(typeOf(u.first)) && !isCombo(u.first);
        if (typed || req || !isEmpty) add("attestation", unitLabel(u), u.first);
      }
    }

    // R5 every required question has an approved answer
    for (const u of all) {
      if (u.skip || u.outside) continue;
      const req = unitRequired(u);
      if (u.kind === "file") {
        if (u.first === resumeInput || resumeEls.includes(u.first) || !req) continue;
        if (/cover/i.test(nameTexts(u.first))) add("cover_letter_file_required", null, u.first);
        else add("other_file_required", unitLabel(u), u.first);
        continue;
      }
      if (u.kind === "pair" && req && !pairHasState(u.pair)) {
        add("unverifiable_choice", unitLabel(u), u.pair.field);
        continue;
      }
      if (!req) continue;
      if (unitEmpty(u)) {
        add("unanswered_required", unitLabel(u), u.first);
        continue;
      }
      const chosen = unitChosen(u);
      const source = chosen ? state.filled.get(chosen)?.source : "";
      if (APPROVED.includes(source)) continue;
      if (!equalsProfile(unitShown(u), job?.profile)) add("site_value_on_required", unitLabel(u), u.first);
    }

    // R6 values held, no visible errors
    const tracked = new Set();
    for (const entry of state.filled.values()) {
      tracked.add(entry.el);
      const el = entry.el;
      let held = el.isConnected && root.contains(el);
      if (held) {
        const now = readFor(el);
        held = entry.phone ? digits(now).endsWith(entry.phone) || (digits(now).length >= 7 && entry.phone.endsWith(digits(now))) : fnv1a(now) === entry.hash;
      }
      if (!held) add("value_reset", entry.label, el.isConnected ? el : null);
    }
    for (const el of root.querySelectorAll("[data-applypilot-filled]"))
      if (!tracked.has(el) && fnv1a(readFor(el)) !== el.getAttribute("data-applypilot-filled")) add("value_reset", labelOf(el), el);
    const errs = errorsIn(root, adapter);
    if (errs.length) add("validation_errors", null, errs[0]);

    // R7 this job's own resume
    if (!resumeEls.length) add("resume_field_missing");
    else if (resumeEls.length > 1) add("ambiguous_resume_field", null, resumeEls[1]);
    else {
      const hinted = hintMatches(root, adapter?.resumeInput);
      if (hinted.length && (hinted.length !== 1 || hinted[0] !== resumeInput)) add("adapter_mismatch", null, resumeInput);
      const f = resumeInput.files?.[0];
      const want = job?.resume || {};
      if (f) {
        if (f.name !== want.name || f.size !== want.size) add("resume_mismatch", null, resumeInput);
        else {
          res.resumeFile = f;
          res.verifiedBy = "file";
        }
      } else {
        const box = fieldBox(resumeInput, root);
        const boxText = textOf(box);
        if (want.name && exactTextIn(box, want.name) && !/error|failed|could ?n[o']t|try again|too large|invalid/i.test(boxText) && !busyIn(box))
          res.verifiedBy = "chip";
        else add("resume_not_attached", null, resumeInput);
      }
    }
    for (const f of root.querySelectorAll("input[type=file]"))
      if (!resumeEls.includes(f) && f.files?.length) add("other_file_attached", labelOf(f), f);
    res.resumeInput = resumeInput;

    // R8 exactly one real Submit button
    const sb = submitButton(root, adapter, resumeInput);
    if (sb.code) add(sb.code, null, sb.el);
    else res.submitEl = sb.el;

    res.relaxations = [...relax];
    res.fingerprint = fingerprintOf(root, resumeInput, res.submitEl || sb.el || null);
    res.report = reportOf(all.filter((u) => !u.outside), root);
    return res;
  }
  function fingerprintOf(root, resumeInput, submit) {
    const parts = [location.href];
    for (const c of controlsIn(root))
      parts.push([c.tagName, typeOf(c), c.getAttribute("name") || "", c.id || "", isRequired(c) ? 1 : 0, visible(c) ? 1 : 0, fnv1a(ctlValue(c))].join(","));
    const f = resumeInput?.files?.[0];
    parts.push(f ? `${f.name}:${f.size}` : "");
    parts.push(submit ? `${cssPath(submit)}|${btnLabel(submit)}` : "");
    parts.push(String(document.querySelectorAll("iframe").length));
    return fnv1a(parts.join("\n"));
  }
  function reportOf(all, root) {
    const rows = [];
    for (const u of all) {
      const chosen = unitChosen(u);
      const entry = chosen ? state.filled.get(chosen) : null;
      const isEmpty = unitEmpty(u);
      const sensitiveRow = u.skip && !entry;
      rows.push({
        label: unitLabel(u),
        type: u.kind === "pair" ? "choice" : u.kind === "radio" ? "radio" : isCombo(u.first) ? "combobox" : typeOf(u.first),
        required: unitRequired(u),
        value: sensitiveRow || isEmpty ? "" : clip(entry?.value || unitShown(u).find(Boolean) || "", 200),
        source: entry?.source || (isEmpty ? "" : "site"),
      });
    }
    for (const n of notices(root)) rows.push({ label: "Notice", type: "notice", required: false, value: n, source: "page" });
    return rows.slice(0, 60);
  }
  async function fullCheck(job, settings) {
    const c = syncChecks(job, settings);
    if (c.resumeFile) {
      try {
        if ((await sha256Hex(await c.resumeFile.arrayBuffer())) !== job?.resume?.sha256) {
          c.blockers.push(B("resume_mismatch"));
          c.resumeFile = null;
        }
      } catch {
        c.blockers.push(B("resume_unverified"));
        c.resumeFile = null;
      }
    }
    return c;
  }
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((b) => {
      const k = `${b.code}\u0000${b.text}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  };

  async function audit({ job, settings } = {}) {
    const adapter = adapterFor(job?.ats);
    await quiet(currentRoot(adapter), 1500, 8000);
    // A disabled Submit is given a few seconds, since some forms enable it only after validating.
    await waitFor(() => {
      const root = currentRoot(adapter);
      if (!root) return true;
      const r = resumeInputs(root);
      return submitButton(root, adapter, r.length === 1 ? r[0] : null).code !== "submit_disabled";
    }, 5000);
    const a = await fullCheck(job, settings);
    await sleep(1500);
    const b = await fullCheck(job, settings);
    if (a.fingerprint !== b.fingerprint) b.blockers.push(B("unstable_form"));
    const blockers = dedupe(b.blockers).slice(0, 10);
    state.flagged = b.flagged;
    state.audit = {
      ok: blockers.length === 0,
      job,
      settings,
      href: location.href,
      fingerprint: b.fingerprint,
      submitEl: b.submitEl,
      resumeFile: b.resumeFile,
      verifiedBy: b.verifiedBy,
      relaxations: b.relaxations,
    };
    return {
      fingerprint: b.fingerprint,
      blockers,
      report: b.report,
      relaxations: b.relaxations,
      submit: b.submitEl ? { path: cssPath(b.submitEl), label: btnLabel(b.submitEl) } : null,
      resumeVerifiedBy: b.verifiedBy,
    };
  }

  // ---- pressSubmit (R10) and supervised mode (R11) ---------------------------------------------

  // The audited state must still hold; anything else is refused. Synchronous, so nothing can change between
  // the last check and the click.
  function recheck(fingerprint) {
    const a = state.audit;
    if (!a) return { code: "not_audited" };
    if (!a.ok) return { code: "audit_failed" };
    if (location.href !== a.href) return { code: "url_changed" };
    const c = syncChecks(a.job, a.settings);
    if (c.blockers.length) return { code: c.blockers[0].code, text: c.blockers[0].text };
    if (!fingerprint || c.fingerprint !== fingerprint || fingerprint !== a.fingerprint) return { code: "fingerprint_changed" };
    if (!c.submitEl || c.submitEl !== a.submitEl) return { code: "submit_changed" };
    if (c.verifiedBy !== a.verifiedBy || (a.verifiedBy === "file" && c.resumeFile !== a.resumeFile)) return { code: "resume_mismatch" };
    if (c.relaxations.some((x) => !a.relaxations.includes(x))) return { code: "relaxations_changed" };
    return { button: c.submitEl };
  }
  function pressSubmit(fingerprint) {
    const refuse = (code, text) => ({ clicked: false, reason: code, text: text || COPY[code] || code });
    if (alreadyClicked()) return refuse("already_clicked");
    const r = recheck(fingerprint);
    if (!r.button) return refuse(r.code, r.text);
    api.clicked = true;
    document.documentElement.dataset.applypilotSubmitted = String(Date.now());
    r.button.scrollIntoView({ block: "center" });
    r.button.click();
    return { clicked: true };
  }
  function armSupervised(fingerprint) {
    if (alreadyClicked()) return { armed: false, reason: "already_clicked", text: COPY.already_clicked };
    const r = recheck(fingerprint);
    if (!r.button) return { armed: false, reason: r.code, text: r.text || COPY[r.code] || r.code };
    const btn = r.button;
    btn.style.outline = "3px solid #1f9d55";
    btn.style.outlineOffset = "3px";
    showBanner("ok", "Everything matches what you approved. Click Submit application yourself.", []);
    state.armed = { fingerprint, button: btn, job: state.audit.job, settings: state.audit.settings };
    if (!state.peterListener) {
      state.peterListener = true;
      // Capture phase on the document, so the snapshot is taken before the page reacts and a re-rendered
      // Submit button still counts. Only a real click counts.
      document.addEventListener(
        "click",
        (e) => {
          const armed = state.armed;
          if (!armed || !e.isTrusted || api.clicked || !(e.target instanceof Element)) return;
          const b = e.target.closest("button,input[type=submit],input[type=button],[role=button]");
          if (!b || (b !== armed.button && !(state.root?.contains(b) && SUBMIT.test(btnLabel(b))))) return;
          const at = new Date().toISOString();
          let now = "";
          try {
            now = syncChecks(armed.job, armed.settings).fingerprint;
          } catch {}
          state.peterClick = { at, fingerprintAtClick: now };
          document.documentElement.dataset.applypilotPeterClicked = at;
          post("peter_click", { fingerprint: now, at, matches: now === armed.fingerprint });
        },
        true,
      );
    }
    btn.scrollIntoView({ block: "center" });
    return { armed: true, reason: "", submit: { path: cssPath(btn), label: btnLabel(btn) } };
  }

  // ---- outcome detection (section 10) ----------------------------------------------------------

  function confirmationText() {
    let best = document.body;
    for (;;) {
      const next = Array.from(best.children).find((c) => SUCCESS.test(c.innerText || ""));
      if (!next) break;
      best = next;
    }
    const block = best.parentElement && best.parentElement !== document.body && best.parentElement !== document.documentElement ? best.parentElement : best;
    return clip(block.innerText || best.innerText || "", 300);
  }
  function classify(adapter) {
    const text = pageText();
    if (captchaState().challenge || CODE_STEP.test(text))
      return { outcome: "check", code: "challenge", reason: "A CAPTCHA or verification step appeared after Submit" };
    if (ALREADY.test(text)) return { outcome: "check", code: "already_applied", reason: "The site says you already applied. Check this one." };
    const root = state.root?.isConnected ? state.root : locate(adapter)?.root || null;
    const gone = !root || !visible(root);
    const urlHit = !!adapter?.confirmUrl?.test(location.pathname + location.search);
    const errs = errorsIn(root || document.body, adapter, SUCCESS).length > 0;
    if ((urlHit || gone) && SUCCESS.test(text) && !errs)
      return {
        outcome: "submitted",
        code: "confirmed",
        reason: "",
        confirmationText: confirmationText(),
        url: location.href,
        confirmationKind: urlHit ? "url" : "in_page_only",
      };
    if (!gone && errs)
      return { outcome: "check", code: "form_errors", reason: "The form showed errors after Submit — probably not sent. Finish it in the open tab." };
    return null;
  }
  const silent = () => ({ outcome: "check", code: "no_confirmation", reason: "Submit pressed, no confirmation seen", confirmationText: "", url: location.href, confirmationKind: "" });

  function observeOutcome(adapter, onStable, waitMs, accept = () => true) {
    let lastKey = "",
      since = 0,
      current = null,
      done = false,
      queued = false;
    const stop = () => {
      done = true;
      mo.disconnect();
      clearInterval(iv);
      clearTimeout(to);
    };
    const tick = () => {
      queued = false;
      if (done) return;
      const c = classify(adapter);
      const r = c && accept(c) ? c : null;
      const key = r ? `${r.outcome}:${r.code}` : "";
      if (key !== lastKey) {
        lastKey = key;
        since = Date.now();
        current = r;
        return;
      }
      if (r && Date.now() - since >= (r.code === "form_errors" ? 3000 : 1000)) {
        stop();
        onStable({ confirmationText: "", url: location.href, confirmationKind: "", ...r });
      }
    };
    const mo = new MutationObserver(() => {
      if (!queued) {
        queued = true;
        setTimeout(tick, 50);
      }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const iv = setInterval(tick, 250);
    const to = waitMs
      ? setTimeout(() => {
          if (done) return;
          stop();
          onStable(current && current.code !== "confirmed" ? { confirmationText: "", url: location.href, confirmationKind: "", ...current } : silent());
        }, waitMs)
      : 0;
    tick();
  }
  function readOutcome({ ats, waitMs = 45000 } = {}) {
    const adapter = adapterFor(ats) || adapterFor(atsOfHost());
    if (!pageJobKey(location.href)) return Promise.resolve(silent());
    return new Promise((resolve) => observeOutcome(adapter, resolve, waitMs));
  }
  function watchForConfirmation({ ats } = {}) {
    if (state.watching) return { watching: true };
    state.watching = true;
    const adapter = adapterFor(ats) || adapterFor(atsOfHost());
    observeOutcome(
      adapter,
      (r) => post("confirmed", { text: r.confirmationText, confirmationKind: r.confirmationKind }),
      0,
      (r) => r.outcome === "submitted",
    );
    return { watching: true };
  }

  // ---- banners and snapshot --------------------------------------------------------------------

  const BANNER_ID = "applypilot-banner";
  function showBanner(tone, title, items) {
    document.getElementById(BANNER_ID)?.remove();
    const host = document.createElement("div");
    host.id = BANNER_ID;
    host.style.cssText = "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;";
    const sr = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `.box{font:14px/1.4 system-ui,sans-serif;max-width:340px;padding:12px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25);background:#fff;color:#1d2433;border-left:6px solid ${
      tone === "ok" ? "#1f9d55" : "#f5b84b"
    }}strong{display:block;margin-bottom:4px}ul{margin:6px 0 8px;padding-left:18px}li{margin:2px 0}button{font:inherit;border:1px solid #c5ccd8;background:#f4f6fa;border-radius:6px;padding:2px 10px;cursor:pointer}`;
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "status");
    const h = document.createElement("strong");
    h.textContent = title;
    box.append(h);
    if (items.length) {
      const ul = document.createElement("ul");
      for (const t of items) {
        const li = document.createElement("li");
        li.textContent = t;
        ul.append(li);
      }
      box.append(ul);
    }
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = "Hide";
    hide.addEventListener("click", () => host.remove());
    box.append(hide);
    sr.append(style, box);
    document.documentElement.append(host);
    return host;
  }
  function bannerNeedsYou(reasons = []) {
    const items = (Array.isArray(reasons) ? reasons : [])
      .map((r) => (typeof r === "string" ? r : r?.text || r?.code || ""))
      .map((t) => clip(t, 200))
      .filter(Boolean)
      .slice(0, 10);
    showBanner("warn", "ApplyPilot filled what it could and didn't submit. These need you:", items);
    for (const el of [...state.flagged, ...state.fillFlagged]) if (el?.isConnected && el.style) mark(el, "#f5b84b");
    return { shown: true, count: items.length };
  }
  // Structure only, for calibration fixtures: no values, no scripts.
  function snapshot() {
    const adapter = adapterFor(atsOfHost());
    const root = currentRoot(adapter);
    const scope = root || document.body;
    const controls = [],
      buttons = [];
    for (const c of controlsIn(scope).slice(0, 400)) {
      if (isButtonLike(c) && !isCombo(c)) {
        buttons.push({
          tag: c.tagName.toLowerCase(),
          type: c.getAttribute("type") || "",
          label: clip(btnLabel(c), 80),
          disabled: !!c.disabled || c.getAttribute("aria-disabled") === "true",
          visible: visible(c),
        });
        continue;
      }
      controls.push({
        tag: c.tagName.toLowerCase(),
        type: typeOf(c),
        role: c.getAttribute("role") || "",
        name: c.getAttribute("name") || "",
        id: c.id || "",
        label: clip(labelTexts(c).find((x) => x !== c.getAttribute("name") && x !== c.id) || "", 120),
        required: isRequired(c),
        visible: visible(c),
        options: c.tagName === "SELECT" ? Array.from(c.options).slice(0, 60).map((o) => clip(o.textContent, 80)) : [],
      });
    }
    const hostOf = (s) => {
      try {
        return new URL(s, location.href).hostname;
      } catch {
        return "";
      }
    };
    return {
      version: VERSION,
      url: location.origin + location.pathname,
      title: clip(document.title, 200),
      headings: Array.from(document.querySelectorAll("h1,h2"), (h) => clip(h.innerText, 120)).filter(Boolean).slice(0, 10),
      rootFound: !!root,
      rootPath: root ? cssPath(root) : "",
      inIframe: window.top !== window,
      multiStep: root ? multiStep(root) : false,
      controls,
      buttons,
      listOptions: Array.from(document.querySelectorAll("[role=option]")).filter(visible).slice(0, 60).map((o) => clip(o.textContent, 80)),
      iframes: Array.from(document.querySelectorAll("iframe"), (f) => hostOf(f.getAttribute("src") || "")),
      captcha: captchaState(),
    };
  }

  globalThis.__applypilot = api;
})();
