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
  // change how the question is read. Batch mode also reads Lever's question cards and, for options with no
  // group element, the nearest box that holds only that question's options.
  const MANUAL_GROUPS = "fieldset,[role=radiogroup],[role=group],.form-group,.question,[data-automation-id*=formField]";
  const BATCH_GROUPS = "fieldset,[role=radiogroup],[role=group],.form-group,.question,.application-question,[data-automation-id*=formField]";
  const optionsBox = (f) => {
    const same = f.name ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(f.name)}"]`)) : [f];
    let box = f.parentElement;
    while (box && !same.every((x) => box.contains(x))) box = box.parentElement;
    for (let i = 0; box && box !== document.body && i < 4; i++, box = box.parentElement) {
      if (Array.from(box.querySelectorAll("input,select,textarea")).some((x) => !same.includes(x) && x.type !== "hidden")) return null;
      if (optionText(box, same)) return box;
    }
    return null;
  };
  const labelledBy = (x) =>
    (x.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  // The box each option sits in on its own ("<div><input> <span>Yes, I will require sponsorship</span></div>"), when
  // every option of the group has one and they sit side by side.
  const optionWrappers = (options, g) => {
    if (options.length < 2) return [];
    const ws = options.map((x) => {
      let w = x;
      while (w.parentElement && w.parentElement !== g && !options.some((o) => o !== x && w.parentElement.contains(o))) w = w.parentElement;
      return w;
    });
    return ws.every((w, i) => w !== options[i] && w.parentElement === ws[0].parentElement) ? ws : [];
  };
  const optionText = (g, options) => {
    const own = [...optionWrappers(options, g)];
    options.forEach((x) => own.push(...Array.from(x.labels || []), ...labelledBy(x)));
    const w = document.createTreeWalker(g, NodeFilter.SHOW_TEXT);
    let s = "";
    for (let n; (n = w.nextNode()); ) {
      if (n.parentElement?.closest("option,select,script,style")) continue;
      if (own.some((l) => l.contains(n))) continue;
      s += " " + n.textContent;
    }
    return s.replace(/\s+/g, " ").trim().slice(0, 240).toLowerCase();
  };
  // What an option itself says: its label, aria-labelledby or aria-label, or the box it sits in on its own. Never its
  // value, which a site may set to "Yes" on "Yes, I will require sponsorship".
  const ownOptionText = (x, group) => {
    const named = norm([...Array.from(x.labels || []), ...labelledBy(x)].map((l) => l.textContent || "").join(" ") || x.getAttribute("aria-label"));
    if (named) return named;
    const i = group.indexOf(x);
    let g = group[0]?.parentElement;
    while (g && !group.every((o) => g.contains(o))) g = g.parentElement;
    const box = i >= 0 && g ? optionWrappers(group, g)[i] : null;
    return box ? norm(box.textContent) : "";
  };
  const question = (f, manual = false) => {
    let g = f.closest(manual ? MANUAL_GROUPS : BATCH_GROUPS);
    if (!g) {
      const t = (f.type || "").toLowerCase();
      if (["radio", "checkbox"].includes(t)) {
        g = manual ? null : optionsBox(f);
        if (!g) return "";
      } else
        return [...(f.labels ? Array.from(f.labels).map((x) => x.textContent || "") : []), f.getAttribute("aria-label") || ""]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
    }
    return optionText(g, Array.from(g.querySelectorAll("input[type=radio],input[type=checkbox]")));
  };
  // Answers depend on how the question is worded: "Can you work WITHOUT sponsorship?" flips the answer. So does a
  // question that says which answer means what ("Indicate no if you will require sponsorship"), one that asks two
  // things at once, and one that asks whether you need authorization rather than whether you have it ("Do you
  // require work authorization?", "...on OPT?"). Anything that isn't clearly one of the known shapes goes to the user.
  const SAYS_ANSWER = /\byes\b|\bno\b(?!( [\w-]+){0,2} sponsor)/;
  const EITHER_OR = /,\s*or\b|\bor (are|do|does|will|would|can|could|have|has|is|am|you|i)\b/;
  const NEEDS_AUTH =
    /\b(needs?|needed|needing|require[sd]?|requiring|petition|support|obtain|status)\b|\b(opt|cpt|ead|stem|tn|h-? ?1-? ?b|h-? ?1|o-? ?1|e-? ?3|l-? ?1|f-? ?1|j-? ?1)\b/;
  const eligibility = (q, aQ, sQ, authorized, needsSponsor) => {
    // "(Yes/No)" only says the question takes one of the two.
    if (SAYS_ANSWER.test(q.replace(/\byes\s*(\/|or)\s*no\b/g, " "))) return null;
    if (sQ) {
      if (aQ && (EITHER_OR.test(q) || /\b(indicate|whether|if)\b/.test(q))) return null;
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
    if (/\b(not|never|unable|cannot|can't)\b|unauthori/.test(q) || NEEDS_AUTH.test(q)) return null;
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
      const hits = g.filter((x) => new RegExp(`^${a}$`, "i").test(ownOptionText(x, g)));
      const o = hits.length === 1 ? hits[0] : null;
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
  // so several entries inside one section each get their own record. Batch mode passes stricter matchers.
  const fillRecords = (root, records, start, onSet, skip, { isCurrent = isCurrentBox, put = (f, key, v) => set(f, v) } = {}) => {
    let i = start,
      seen = new Set(),
      n = 0;
    for (const f of root.querySelectorAll("input,select,textarea")) {
      if (!allowed(f) || skip?.(f)) continue;
      const t = (f.type || "").toLowerCase();
      const key = isCurrent(f) ? "current" : ["checkbox", "radio", "file"].includes(t) ? null : match(f, recordFields)?.[0];
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
      if (v && put(f, key, v)) {
        n++;
        onSet?.(f, f.tagName === "SELECT" ? undefined : v);
      }
    }
    return { n, next: seen.size ? i + 1 : i };
  };
  const fillSections = (roots, records, onSet, skip, opts) => {
    let n = 0,
      at = 0;
    for (const root of roots) {
      if (at >= records.length) break;
      const r = fillRecords(root, records, at, onSet, skip, opts);
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
      const q = question(f, true);
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
  const AUTH_Q = /authori[sz]ed|authori[sz]ation|legally.*work|(eligible|allowed|permitted|entitled) to (legally )?work|right to work/;
  const SPON_Q = /sponsor|visa/;
  // Your Yes/No flags mean working in the U.S. for any employer. A question is answered only when every word in it
  // belongs to a plain U.S. work-authorization or sponsorship question: another place ("Ontario", "the country where
  // this role is based"), another condition ("weekends", "a classified environment", "as a U.S. person") or any word
  // ApplyPilot doesn't expect goes to you.
  const US_NAME = /(^|[^a-z])(the )?(united states( of america)?|u\.\s?s\.(\s?a\.)?|u\.s(?![a-z])|usa|america)(?![a-z])/g;
  const US_WORK_WORDS = new Set(
    `are is do does will would can could have has you your i am currently presently now still legally lawfully legal valid
    authorized authorised eligible permitted allowed entitled able right authorization authorisation permission eligibility
    work working employment employed be to for in within the a an of and or not no yes any employer employers company us
    without need needs needed require requires required sponsor sponsorship sponsored visa visas status immigration future
    at this time full part basis on such as e g eg h1b h1 tn opt cpt ead stem o1 e3 l1 f1 j1 petition support obtain accept
    position role job please confirm indicate whether if that`.split(/\s+/),
  );
  // Common in sponsorship questions only ("in order to", "at any point", "from an employer"). "Permanent" and "hold"
  // stay out of authorization questions: "authorized on a permanent basis" is not what your flag says.
  const SPONSOR_WORDS = new Set(
    `order requiring needing from either point continue continuing sponsoring maintain hold permanent employ commence`.split(/\s+/),
  );
  function usWorkQuestion(q, aQ, sQ) {
    const words = norm(
      String(q)
        .toLowerCase()
        .replace(US_NAME, "$1us")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b([a-z]) ?(\d)([a-z]?)\b/g, "$1$2$3"),
    ).split(" ");
    if (!words[0] || !words.every((w) => US_WORK_WORDS.has(w) || (sQ && SPONSOR_WORDS.has(w)) || /^\d+$/.test(w))) return false;
    return !aQ || words.some((w) => ["work", "working", "employment", "employed"].includes(w));
  }
  // The question names the U.S. itself; "us" as in "require us to sponsor you" does not.
  const namesUS = (q) =>
    q.search(US_NAME) >= 0 ||
    /\b(in|within|inside|throughout|across) (the )?us\b|\bus[- ](based|work|employment|employers?|persons?|citizens?|compan(y|ies)|visas?|immigration|government)\b/.test(q);
  const COMPANY_SUFFIX = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "group", "holdings"]);
  // The approved job's company, written as "company" so "require Acme to sponsor your visa" reads like any other.
  function withoutCompany(q, company) {
    const words = String(company ?? "").toLowerCase().match(/[a-z0-9]+/g) || [];
    const names = [words];
    if (words.length > 1 && COMPANY_SUFFIX.has(words[words.length - 1])) names.push(words.slice(0, -1));
    let t = String(q);
    for (const w of names) {
      const name = w.join(" ");
      if (name.length < 2 || (w.length === 1 && (US_WORK_WORDS.has(name) || SPONSOR_WORDS.has(name)))) continue;
      t = t.replace(new RegExp(`(^|[^a-z0-9])${w.join("[^a-z0-9]+")}(?![a-z0-9])`, "g"), "$1company");
    }
    return t;
  }
  // Batch mode ticks only a box that says, in full, that this is your current job. "You may contact my current
  // employer" or "I am currently subject to a non-compete" are questions for you.
  const CURRENT_JOB =
    /^(i )?(currently|still) work here$|^(i )?work here currently$|^(this is my )?current (job|role|position|employer|company)$|^(i am )?currently (working|employed) here$|^present$|^current$/;
  const NOT_SELF = /refer|reference|manager|supervisor|emergency|recruiter|friend|spouse|partner|parent|guardian|hiring|interviewer|company|employer/i;
  // The heading over a group of short fields that belong to someone else ("Professional reference", "Emergency
  // contact"). Narrower than NOT_SELF, since a job title such as "IT Support Manager" can head a form.
  const OTHER_PERSON =
    /\b(refer(ence|ee|ral|rer)s?|referred|emergency|next of kin|spouse|parent|guardian|relatives?|friends?|(manager|supervisor|employer)('s)? (contact|details|information|info)|(alternate|alternative|secondary|additional|backup) contact( person)?)\b/i;
  // A heading that is itself someone's role ("Supervisor", "Current manager", "Hiring manager you spoke with"). Read
  // from the start of each heading, so a job title such as "IT Support Manager" doesn't count.
  const OTHER_ROLE = /^(your |most recent |current |former |previous |direct |immediate )?(supervisor|manager|hiring manager|reporting manager)s?\b/i;
  // Your own location field, by its short name: not "Which office location are you applying for?".
  const LOCATION_FIELD = [["location", /^(current |your |home )?location( \(city\)| city)?$|^(current |home )?city$|^city,? (and )?state$/]];
  const PLACEHOLDER = /^(select|choose|pick|search|start typing|type to search|please select)\b/i;
  const TEXTLIKE = ["text", "email", "tel", "url", "search", "textarea"];
  // Profile fields are matched on a whole short name ("Email", "Mobile phone", name="first_name"), never on a
  // word inside a question such as "Which email ticketing tools have you used?".
  const PROFILE_FIELDS = [
    ["firstName", /^(legal |preferred )?first ?name$|^given ?name$|^fname$/],
    ["lastName", /^(legal )?last ?name$|^family ?name$|^surname$|^lname$/],
    ["fullName", /^(your )?(full |legal )?name$|^full legal name$/],
    ["email", /^(your )?e-? ?mail( address)?$/],
    ["phone", /^(your )?((mobile|cell|home|primary|contact) )?(phone|telephone|tel)( number| no)?$|^(mobile|cell)( number)?$/],
    ["city", /^(current )?city$|^address level2$/],
    ["state", /^(state|province|region)$|^state ?(\/|or) ?province$|^address level1$/],
    ["postalCode", /^(zip|postal)( ?code)?$|^zip ?\/ ?postal( code)?$|^postcode$/],
    ["country", /^country( of residence)?$|^country name$/],
    ["linkedIn", /^linked ?in( profile)?( url| link)?$/],
  ];
  const IDENTITY = PROFILE_FIELDS.filter(([k]) => ["firstName", "lastName", "fullName", "email", "phone"].includes(k));
  const SKILLS = [["skills", /^(key |technical |relevant |core |your )?skills( (and|&) (technologies|expertise|tools))?$|^technologies$|^(areas of )?expertise$/]];
  const COUNTRY_NAMES = [
    ["united states", "united states of america", "usa", "us", "u.s.", "u.s.a."],
    ["united kingdom", "uk", "u.k.", "great britain", "united kingdom of great britain and northern ireland"],
  ];
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
    you_clicked: "You pressed Submit on this page yourself.",
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

  const state = {
    root: null,
    rootSeen: false,
    successBefore: null,
    href: "",
    filled: new Map(),
    audit: null,
    flagged: [],
    fillFlagged: [],
    watching: false,
    armed: null,
    clickListener: false,
    peterClick: null,
    clickPath: "",
  };
  const api = {
    version: VERSION,
    clicked: !!previous?.clicked,
    assistant,
    findForm,
    fill,
    audit,
    pressSubmit,
    armSupervised,
    clickState,
    disarm,
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
  // Whose details a field asks for, read from the legend or heading of each box it sits in inside the form: the
  // heading nearest before it at each level, so a flat list under "Emergency contact" counts too.
  function ownerParts(f, root) {
    const heads = "legend,h1,h2,h3,h4,h5,h6,[role=heading]";
    const parts = [textOf(groupLabelEl(f))];
    for (let child = f, e = f.parentElement; e && root.contains(e); child = e, e = e.parentElement) {
      if (e !== root) {
        parts.push(e.getAttribute("aria-label") || "");
        for (const id of (e.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) parts.push(textOf(document.getElementById(id)));
      }
      for (let c = child.previousElementSibling; c; c = c.previousElementSibling) {
        const head = c.matches(heads) ? c : c.querySelector("input,select,textarea") ? null : c.querySelector(heads);
        if (head) {
          parts.push(textOf(head));
          break;
        }
      }
      if (e === root) break;
    }
    return parts.map(norm).filter(Boolean);
  }
  const forSomeoneElse = (f, root) => {
    if (NOT_SELF.test(labelTexts(f).join(" "))) return true;
    const parts = ownerParts(f, root);
    return OTHER_PERSON.test(parts.join(" ")) || parts.some((p) => OTHER_ROLE.test(p));
  };
  // What a field is called, without placeholder hints such as "Add a cover letter or anything else".
  const nameTexts = (f) => [...labelEls(f).map((l) => textOf(l)), f.getAttribute("aria-label"), f.getAttribute("name"), f.id].filter(Boolean).join(" ");
  // Short names only: label text, aria-label and placeholder as written; name, id and autocomplete as words
  // ("job_application[first_name]" reads "first name"). Anything that reads as a question is left out.
  function fieldNames(f) {
    const words = (x) =>
      norm(x)
        .toLowerCase()
        .replace(/\s*\((required|optional)\)$/, "")
        .replace(/[\s*:✱]+$/, "")
        .trim();
    const code = (x) => {
      const t = String(x || ""),
        m = t.match(/\[([^\]]*)\]$/);
      return norm((m ? m[1] : t).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")).toLowerCase();
    };
    return [
      ...labelEls(f).map((l) => words(textOf(l))),
      words(f.getAttribute("aria-label")),
      words(f.getAttribute("placeholder")),
      code(f.getAttribute("name")),
      code(f.id),
      code(f.getAttribute("autocomplete")),
    ].filter((x) => x && x.length <= 40 && !x.includes("?"));
  }
  const profileField = (f, rules = PROFILE_FIELDS) => {
    const names = fieldNames(f);
    return rules.find(([, p]) => names.some((x) => p.test(x)));
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
  const REQUIRED_MARK = ".required,.asterisk,[class*='required' i]:not([class*='not-required' i])";
  function isRequired(f) {
    if (f.required || f.getAttribute("aria-required") === "true") return true;
    return labelEls(f).some((l) => STAR.test(textOf(l)) || !!l.querySelector(REQUIRED_MARK));
  }
  // The question a group of options answers: a fieldset legend, the group's aria-labelledby, or Lever's
  // .application-label on its question card. A label that holds a control is an option's label, not the question's.
  const GROUPS = "fieldset,[role=radiogroup],[role=group],.application-question";
  function groupLabelEl(f) {
    const g = f.closest(GROUPS);
    if (!g) return null;
    const by = (g.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id))[0];
    const cands = [g.querySelector(":scope > legend"), by, ...g.querySelectorAll(":scope > label, :scope > [class*='label' i]")];
    return cands.find((el) => el && !el.querySelector("input,select,textarea,[role=combobox],[role=radio],[role=checkbox]")) || null;
  }
  // Checkbox groups and uploads often carry the required mark on the question, not on each control.
  function groupRequired(f) {
    const g = f.closest(GROUPS);
    if (!g) return false;
    if (g.getAttribute("aria-required") === "true") return true;
    const l = groupLabelEl(f);
    return !!l && (STAR.test(textOf(l)) || !!l.querySelector(REQUIRED_MARK));
  }
  // A required group with an upload is also answered by a filled text box in it ("or paste your cover letter").
  const fileRequired = (f) =>
    isRequired(f) || (groupRequired(f) && !controlsIn(f.closest(GROUPS)).some((x) => x !== f && ["text", "textarea"].includes(typeOf(x)) && !!norm(x.value)));
  const coverFile = (f) => /cover/i.test(`${nameTexts(f)} ${textOf(groupLabelEl(f))}`);
  const checkedOf = (x) => (x.tagName === "INPUT" ? x.checked : x.getAttribute("aria-checked") === "true");
  // Checkboxes that answer one question: the same name, a group holding nothing but checkboxes, or (Greenhouse's
  // classic form names each option on its own) a labelled box holding nothing but checkboxes. ARIA checkboxes in one
  // role=group are one question too. A box that is required on its own stays its own question.
  function checkGroup(f, root) {
    if (f.tagName !== "INPUT") {
      const g = f.closest("[role=group],fieldset");
      const all = g && root.contains(g) ? controlsIn(g).filter((x) => typeOf(x) !== "hidden") : [];
      return all.length > 1 && all.every((x) => x.tagName !== "INPUT" && ["checkbox", "switch"].includes(typeOf(x))) ? all : [f];
    }
    const named = f.name ? Array.from(root.querySelectorAll(`input[type=checkbox][name="${CSS.escape(f.name)}"]`)) : [];
    const g = f.closest(GROUPS);
    const ctl = g && root.contains(g) ? controlsIn(g).filter((x) => typeOf(x) !== "hidden") : [];
    const onlyBoxes = (list) => list.length > 1 && list.every((x) => x.tagName === "INPUT" && typeOf(x) === "checkbox");
    let boxes = named.length > 1 ? named : onlyBoxes(ctl) ? ctl : [f];
    if (boxes.length === 1 && !g) {
      for (let box = f.parentElement, i = 0; box && box !== root && root.contains(box) && i < 4; box = box.parentElement, i++) {
        const inBox = controlsIn(box).filter((x) => typeOf(x) !== "hidden");
        if (!inBox.every((x) => x.tagName === "INPUT" && typeOf(x) === "checkbox")) break;
        if (onlyBoxes(inBox) && questionLabelIn(box, inBox)) {
          boxes = inBox;
          break;
        }
      }
    }
    return boxes.some(isRequired) ? [f] : boxes;
  }
  // The question a set of options answers, also where no fieldset or group element marks it: the nearest box that
  // holds all the options and, besides them, at most one optional text box, with the label written before the
  // options. Its star or required mark makes the whole question required. The text box answers the question only
  // when it says it is the "Other" or "self-describe" answer; a profile field such as LinkedIn never does.
  const OTHER_ANSWER = /\bother\b|please (specify|describe|explain)|self[- ]?describe/;
  function optionsQuestion(els, root) {
    let box = els[0].parentElement;
    while (box && box !== root && root.contains(box) && !els.every((x) => box.contains(x))) box = box.parentElement;
    for (let i = 0; box && box !== root && root.contains(box) && i < 4; i++, box = box.parentElement) {
      const rest = controlsIn(box).filter((x) => !els.includes(x) && typeOf(x) !== "hidden" && !isButtonLike(x));
      if (rest.length > 1 || rest.some((x) => !TEXTLIKE.includes(typeOf(x)) || isCombo(x) || isRequired(x))) return null;
      const label = questionLabelIn(box, els);
      if (!label) continue;
      const required =
        box.getAttribute("aria-required") === "true" || STAR.test(textOf(label)) || label.matches(REQUIRED_MARK) || !!label.querySelector(REQUIRED_MARK);
      const extra = rest[0];
      const companion = extra && !profileField(extra) && fieldNames(extra).some((x) => OTHER_ANSWER.test(x)) ? extra : null;
      return { box, label, companion, required };
    }
    return null;
  }
  function questionLabelIn(box, els) {
    const own = new Set(els.flatMap(labelEls));
    for (const el of box.querySelectorAll("legend,label,div,span,p,h3,h4,h5,h6")) {
      if (el.contains(els[0])) continue;
      if (!(el.compareDocumentPosition(els[0]) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (own.has(el) || el.querySelector("input,select,textarea,[role=checkbox],[role=radio],[role=switch]") || !textOf(el)) continue;
      return el;
    }
    return null;
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
    if (state.root) sawRoot();
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
  // Which click it was: ApplyPilot's own, or only yours.
  const clickedCode = () => (api.clicked || document.documentElement.dataset.applypilotSubmitted ? "already_clicked" : "you_clicked");

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
      sawRoot();
      listenForClicks();
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
      required: pair ? pair.required : el.tagName === "INPUT" && t === "radio" ? groupOf(el).some(isRequired) || groupRequired(el) : isRequired(el),
      value: t === "file" ? shownValue(el) || clip(el.dataset.applypilotFile || "", 200) : shownValue(el) || clip(read, 200),
      source,
      hash: fnv1a(read),
      phone: profileField(el, IDENTITY)?.[0] === "phone" ? digits(read) : "",
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
    if (key === "country") for (const names of COUNTRY_NAMES) if (out.some((x) => names.includes(x))) out.push(...names);
    if (key === "state") {
      const c = stateCode(value);
      if (c) out.push(c.toLowerCase(), US_STATES[c].toLowerCase());
    }
    return [...new Set(out)];
  }
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  // A work or education record value as a select may show it: a month as its number, name or short name, a degree
  // with " degree" after it ("Bachelor's" is "Bachelor's Degree").
  function recordVariants(key, value) {
    const v = norm(value).toLowerCase().replace(/[\u2018\u2019]/g, "'");
    if (!v) return [];
    const out = [...variants(key, value), v];
    if (/month$/i.test(key)) {
      const n = /^\d{1,2}$/.test(v) ? Number(v) : MONTHS.findIndex((m) => m === v || m.slice(0, 3) === v.replace(/\.$/, "")) + 1;
      if (n >= 1 && n <= 12) out.push(String(n), String(n).padStart(2, "0"), MONTHS[n - 1], MONTHS[n - 1].slice(0, 3));
    }
    if (key === "degree") out.push(`${v} degree`);
    return [...new Set(out)];
  }
  // A native select takes only the one option whose text is exactly an approved spelling, so "United States" never
  // becomes "United States Minor Outlying Islands" and "Yes" never becomes "Yes, I am a U.S. citizen". A matching
  // value counts only on an option with no text of its own. A profile or record value may drop a trailing note in
  // brackets ("Georgia (GA)"); a Yes/No answer ("answer") never does, so "Yes (U.S. citizen)" is not your answer. A
  // record value with no option showing it may still match one option's own value (month 3 is value="3").
  function selectOption(f, wants, mode = "profile") {
    const clean = (t) => norm(t).toLowerCase().replace(/[\u2018\u2019]/g, "'");
    const bare = (t) => t.replace(/\s*\([^)]*\)$/, "").trim();
    const options = Array.from(f.options || []).filter((o) => !o.disabled);
    const hits = options.filter((o) => {
      const t = clean(o.textContent);
      const shown = mode === "record" ? [t, t.replace(/\.$/, "")] : [t];
      return wants.some((w) => !!w && (shown.includes(w) || (mode !== "answer" && bare(t) === w) || (!t && o.value.toLowerCase() === w)));
    });
    if (hits.length || mode !== "record") return hits.length === 1 ? hits[0] : null;
    const byValue = options.filter((o) => o.value && wants.includes(clean(o.value)));
    return byValue.length === 1 ? byValue[0] : null;
  }
  function setSelectStrict(f, wants, mode) {
    const o = selectOption(f, wants, mode);
    if (!o) return false;
    f.value = o.value;
    fire(f);
    mark(f, "#2f7df6");
    return true;
  }
  function strictCurrentBox(f) {
    if (f.tagName !== "INPUT" || typeOf(f) !== "checkbox") return false;
    const names = [...labelEls(f).map((l) => textOf(l)), f.getAttribute("aria-label") || ""]
      .map((x) => norm(x).toLowerCase().replace(/[\s*:✱.]+$/, ""))
      .filter(Boolean);
    return names.some((x) => CURRENT_JOB.test(x)) && !names.some((x) => /contact|may|permission|subject|agreement|visa|authori/.test(x));
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
      if (recordRoots.some((r) => r.contains(f)) || forSomeoneElse(f, root)) continue;
      const m = profileField(f, IDENTITY);
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

  async function fill({ profile, resume, coverLetter = "", ats, company = "", usPosting = false } = {}) {
    const out = { filled: [], blockers: [], resumeInputPath: "" };
    state.fillFlagged = [];
    const block = (code, label, el) => {
      out.blockers.push(B(code, label));
      if (el) state.fillFlagged.push(el);
    };
    if (alreadyClicked()) {
      block(clickedCode());
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
    const letter = String(coverLetter || "").trim();
    if (letter)
      for (const f of root.querySelectorAll("textarea")) {
        if (f.disabled || f.readOnly || norm(f.value) || untouchable(f)) continue;
        if (/cover.?letter/i.test(nameTexts(f)) && setText(f, letter)) record(f, "cover_letter", letter);
      }
    for (const f of root.querySelectorAll("input[type=file]")) {
      if (f !== resumeInput && coverFile(f) && fileRequired(f)) block("cover_letter_file_required", null, f);
    }

    // Work and education records, through the same filler the manual assistant uses.
    const work = sectionRoots(WORK).filter((r) => root.contains(r)),
      edu = sectionRoots(EDU).filter((r) => root.contains(r));
    const recordRoots = [...work, ...edu];
    const onRecord = (f, v) => record(f, "record", v);
    const strict = { isCurrent: strictCurrentBox, put: (f, key, v) => (f.tagName === "SELECT" ? setSelectStrict(f, recordVariants(key, v), "record") : set(f, v)) };
    // The batch gate is wider than the manual one, so a record field asking about you personally is still left alone.
    fillSections(work, p.workHistory || [], onRecord, untouchable, strict);
    fillSections(edu, p.education || [], onRecord, untouchable, strict);

    // 3-7. Text fields, native selects and radios, matched on each field's own label only.
    const authorized = typeof p.workAuthorized === "boolean" ? p.workAuthorized : null;
    const needsSponsor = typeof p.requiresSponsorship === "boolean" ? p.requiresSponsorship : null;
    // Your flags are about the U.S.: a question that names no country is answered only for a U.S. posting.
    const answerFor = (raw) => {
      const q = withoutCompany(String(raw ?? "").toLowerCase().replace(/\((required|optional)\)/g, " "), company);
      const aQ = AUTH_Q.test(q),
        sQ = SPON_Q.test(q);
      if ((!aQ && !sQ) || !usWorkQuestion(q, aQ, sQ)) return null;
      if (!usPosting && !namesUS(q)) return null;
      return eligibility(q, aQ, sQ, authorized, needsSponsor);
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
      // Records never use radios, so a Yes/No question whose legend says "employment" (and so reads as a work
      // section) is still answered here.
      if (t !== "radio" && recordRoots.some((r) => r.contains(f)) && match(f, recordFields)) continue;
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
      // A text area is a question to answer in your own words, never a profile field.
      // So is a field for someone else's details, such as a reference's name or an emergency contact's phone.
      const other = forSomeoneElse(f, root);
      const m = other || t === "textarea" ? undefined : profileField(f);
      if (t === "select") {
        if (m) {
          const v = norm(p[m[0]]);
          if (v && setSelectStrict(f, variants(m[0], v))) record(f, "profile");
          continue;
        }
        const a = answerFor(question(f) || lt.toLowerCase());
        if (typeof a === "boolean" && setSelectStrict(f, [a ? "yes" : "no"], "answer")) record(f, "eligibility");
        continue;
      }
      if (!TEXTLIKE.includes(t)) continue;
      if (m) {
        const v = norm(p[m[0]]);
        if (v && setText(f, v)) record(f, "profile", v);
        continue;
      }
      if (other) continue;
      if (skills && profileField(f, SKILLS)) {
        if (setText(f, skills)) record(f, "profile", skills);
        continue;
      }
      if (t !== "textarea" && profileField(f, LOCATION_FIELD)) locations.push(f);
    }

    // 5. Comboboxes, only for fixed approved answers (country, state, Yes/No), with exact option match and read-back.
    for (const f of combos) {
      if (comboValue(f)) continue;
      const lt = labelTexts(f).join(" ");
      if (forSomeoneElse(f, root)) continue;
      const m = profileField(f);
      let wants = null,
        source = "profile";
      if (m && (m[0] === "country" || m[0] === "state")) wants = variants(m[0], p[m[0]]);
      else if (!m || m[0] === "city") {
        const a = answerFor(question(f) || lt.toLowerCase());
        if (typeof a === "boolean") {
          wants = [a ? "yes" : "no"];
          source = "eligibility";
        } else if (profileField(f, LOCATION_FIELD)) {
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
      const options =
        f.tagName === "INPUT" && t === "radio"
          ? groupOf(f).filter((x) => root.contains(x))
          : t === "checkbox" || t === "switch"
            ? checkGroup(f, root).filter((x) => x === f || !seen.has(x))
            : null;
      if (options) {
        options.forEach((x) => seen.add(x));
        const asked = optionsQuestion(options, root);
        // An "Other" text box answers the same question, so it is checked with it, not on its own.
        if (asked?.companion && seen.has(asked.companion)) asked.companion = null;
        if (asked?.companion) seen.add(asked.companion);
        out.push({ kind: t === "radio" ? "radio" : "check", els: options, first: f, question: asked });
        continue;
      }
      seen.add(f);
      out.push({ kind: t === "file" ? "file" : "single", els: [f], first: f });
    }
    for (const pair of choicePairs(root)) out.push({ kind: "pair", els: [pair.yes, pair.no], first: pair.yes, pair });
    return out;
  }
  function unitText(u) {
    const f = u.first;
    if (u.kind === "pair") return u.pair.question;
    const asked = textOf(u.question?.label);
    if (u.kind === "radio") return [question(f), textOf(groupLabelEl(f)), asked, ...u.els.flatMap(labelTexts)].join(" ");
    if (u.kind === "check")
      return [...u.els.flatMap(labelTexts), question(f), textOf(groupLabelEl(f)), asked, ...u.els.map((x) => (x.tagName === "INPUT" ? "" : textOf(x)))].join(" ");
    return [...labelTexts(f), question(f), f.tagName === "INPUT" ? "" : textOf(f)].join(" ");
  }
  // The group's required mark covers a checkbox question only when the group holds nothing else.
  const wholeGroup = (u) => {
    const g = u.first.closest(GROUPS);
    return !!g && controlsIn(g).every((x) => typeOf(x) === "hidden" || u.els.includes(x));
  };
  function unitRequired(u) {
    if (u.kind === "pair") return u.pair.required;
    if (u.els.some(isRequired)) return true;
    if (u.kind === "radio") return groupRequired(u.first) || !!u.question?.required;
    if (u.kind === "check") return (wholeGroup(u) && groupRequired(u.first)) || !!u.question?.required;
    if (u.kind === "file") return fileRequired(u.first);
    return false;
  }
  function unitChosen(u) {
    if (u.kind === "pair") return pairValue(u.pair);
    // What ApplyPilot typed into a box is never your answer to the question beside it.
    const c = u.question?.companion;
    const other = c && norm(c.value) && !state.filled.has(c) ? c : null;
    if (u.kind === "radio") return u.els.find((x) => x.checked) || other;
    if (u.kind === "check") return u.els.find(checkedOf) || other;
    return u.first;
  }
  function unitEmpty(u) {
    const f = u.first;
    if (u.kind === "pair" || u.kind === "radio" || u.kind === "check") return !unitChosen(u);
    if (u.kind === "file") return !f.files?.length;
    if (isCombo(f)) return !comboValue(f);
    return !norm(f.value);
  }
  function unitShown(u) {
    const c = unitChosen(u);
    if (!c) return [];
    if (u.kind === "pair") return [btnLabel(c)];
    if (u.kind === "radio" || (u.kind === "check" && c.tagName === "INPUT")) return [norm(c.labels?.[0]?.textContent || ""), c.value];
    if (u.kind === "check") return [textOf(c)];
    if (typeOf(c) === "select") return [c.value, norm(c.selectedOptions?.[0]?.textContent || "")];
    if (isCombo(c)) return [comboValue(c)];
    return [norm(c.value)];
  }
  function unitLabel(u) {
    if (u.kind === "pair") return u.pair.label;
    const g = (u.kind === "check" && (u.els.length > 1 || groupRequired(u.first)) ? textOf(groupLabelEl(u.first)) : "") || textOf(u.question?.label);
    return clip(g.replace(/[\s*:✱]+$/, "") || labelOf(u.first), 120);
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
  // Frames in the page and in open or closed shadow roots, since a challenge widget may live in either.
  function allFrames() {
    const out = [];
    const walk = (scope) => {
      for (const el of scope.querySelectorAll("*")) {
        if (el.tagName === "IFRAME") out.push(el);
        let sr = el.shadowRoot;
        if (!sr && globalThis.chrome?.dom?.openOrClosedShadowRoot) {
          try {
            sr = globalThis.chrome.dom.openOrClosedShadowRoot(el);
          } catch {}
        }
        if (sr) walk(sr);
      }
    };
    walk(document);
    return out;
  }
  function captchaState() {
    let challenge = false,
      marker = false;
    for (const fr of allFrames()) {
      const src = fr.getAttribute("src") || "";
      if (CHALLENGE_FRAMES.some((t) => t(src)) && shown(fr)) challenge = true;
      else if (/recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(src)) marker = true;
    }
    // A widget box shown on the page is a visible challenge, whatever its frame is hidden in. A box bound to a
    // button (invisible reCAPTCHA on Submit) is not.
    for (const el of document.querySelectorAll(".cf-turnstile,.h-captcha,.g-recaptcha")) {
      if (el.getAttribute("data-size") === "invisible" || el.matches("button,input,a,[role=button],form,label")) continue;
      if (Array.from(el.querySelectorAll("button,input:not([type=hidden]),[role=button]")).some(visible)) continue;
      if (shown(el)) challenge = true;
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

  // Custom widgets ApplyPilot never fills: ARIA radio groups, rich text boxes, menu buttons, signature pads. Only
  // the outermost one that isn't part of a field already checked, or of a combobox or upload's own box.
  const WIDGETS =
    "[aria-required=true],[role=radiogroup],[role=radio],[role=textbox],[role=listbox],[contenteditable=''],[contenteditable=true],button[aria-haspopup],[role=button][aria-haspopup],[aria-haspopup=listbox],canvas";
  function widgetsIn(root, all) {
    const taken = all.flatMap((u) => u.els);
    const boxes = all.filter((u) => isCombo(u.first) || u.kind === "file").map((u) => fieldBox(u.first, root));
    const found = [
      ...new Set(
        Array.from(root.querySelectorAll(WIDGETS), (w) => (w.getAttribute("role") === "radio" && !w.closest("[role=radiogroup]") ? w.parentElement : w)),
      ),
    ].filter(
      (w) =>
        w && w !== root && root.contains(w) && visible(w) && !taken.some((e) => e === w || e.contains(w) || w.contains(e)) && !boxes.some((b) => b.contains(w)),
    );
    return found.filter((w) => !found.some((o) => o !== w && o.contains(w)));
  }
  function widgetLabel(w, root) {
    const by = (w.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
    const forLabels = w.id ? Array.from(document.querySelectorAll(`label[for="${CSS.escape(w.id)}"]`)) : [];
    const named = [...by.map((x) => textOf(x)), norm(w.getAttribute("aria-label")), ...forLabels.map((x) => textOf(x))].filter(Boolean);
    if (named.length) return named.join(" ");
    const g = groupLabelEl(w);
    if (g && !g.contains(w)) return textOf(g);
    const box = fieldBox(w.parentElement || w, root);
    let s = "";
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) if (!w.contains(n) && !n.parentElement?.closest("script,style,option")) s += " " + n.textContent;
    return norm(s).slice(0, 240);
  }
  const PICKED = "[aria-checked=true],[aria-selected=true],[aria-pressed=true]";
  const typedWidget = (w) => w.tagName === "CANVAS" || w.isContentEditable || w.getAttribute("role") === "textbox";
  function widgetShown(w) {
    if (w.tagName === "CANVAS") return [];
    if (typedWidget(w)) return [norm(w.innerText || w.textContent)].filter(Boolean);
    if (w.tagName === "BUTTON" || w.getAttribute("role") === "button") return [btnLabel(w)].filter((t) => t && !PLACEHOLDER.test(t));
    if (w.matches(PICKED)) return [textOf(w) || "1"];
    const c = w.querySelector(PICKED);
    return c ? [textOf(c) || "1"] : [];
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
    if (alreadyClicked()) add(clickedCode());

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
        u.kind === "pair"
          ? ATTEST_CONTROL.test(q)
          : u.kind === "radio"
            ? ATTEST_CONTROL.test(`${question(u.first)} ${textOf(groupLabelEl(u.first))}`)
            : u.kind === "check"
              ? u.els.some(attestationControl) || ATTEST_CONTROL.test(textOf(groupLabelEl(u.first)))
              : attestationControl(u.first);
      if (attest) {
        u.skip = true;
        // An unticked optional consent box is fine; a typed signature or name always goes to you.
        const typed = u.kind === "single" && TEXTLIKE.includes(typeOf(u.first)) && !isCombo(u.first);
        if (typed || req || !isEmpty) add("attestation", unitLabel(u), u.first);
      }
    }

    for (const w of widgetsIn(root, all)) {
      const label = widgetLabel(w, root);
      const name = label.replace(/[\s*:✱]+$/, "") || "Question";
      const req = w.getAttribute("aria-required") === "true" || STAR.test(label);
      const shownVals = widgetShown(w);
      const kind = DEMOGRAPHIC.test(label) ? "demographic" : SENSITIVE.test(label) ? "sensitive_question" : "";
      if (kind) {
        if (!allowOptional || req || shownVals.length) add(kind, name, w);
        else relax.add("optional_sensitive_blank");
        continue;
      }
      if (TYPED_NAME.test(label) || ATTEST_CONTROL.test(label)) {
        if (typedWidget(w) || req || shownVals.length) add("attestation", name, w);
        continue;
      }
      if (!req) continue;
      if (!shownVals.length) add("unanswered_required", name, w);
      else if (!equalsProfile(shownVals, job?.profile)) add("site_value_on_required", name, w);
    }

    // R5 every required question has an approved answer
    for (const u of all) {
      if (u.skip || u.outside) continue;
      const req = unitRequired(u);
      if (u.kind === "file") {
        if (u.first === resumeInput || resumeEls.includes(u.first) || !req) continue;
        if (coverFile(u.first)) add("cover_letter_file_required", null, u.first);
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
    parts.push(String(allFrames().length));
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
    noteClick();
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
    noteSuccessBefore();
    listenForClicks();
    btn.scrollIntoView({ block: "center" });
    return { armed: true, reason: "", submit: { path: cssPath(btn), label: btnLabel(btn) } };
  }

  // Your own Submit clicks, from the moment ApplyPilot finds the form: before it arms, while it waits, after the page
  // re-renders the form, and in a tab left open for you. Capture phase on the document, so the snapshot is taken
  // before the page reacts. Only a real click counts; ApplyPilot's own click() is never trusted.
  function listenForClicks() {
    if (state.clickListener) return;
    state.clickListener = true;
    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted || !(e.target instanceof Element)) return;
        const b = e.target.closest("button,input[type=submit],input[type=button],[role=button]");
        const armed = state.armed;
        if (!b || (b !== armed?.button && !SUBMIT.test(btnLabel(b)))) return;
        const at = new Date().toISOString();
        let now = "",
          matches = false;
        if (armed) {
          try {
            now = syncChecks(armed.job, armed.settings).fingerprint;
            matches = now === armed.fingerprint && !!currentRoot(adapterFor(armed.job?.ats))?.contains(b);
          } catch {}
        }
        state.peterClick = { at, fingerprintAtClick: now, matches };
        document.documentElement.dataset.applypilotPeterClicked = at;
        noteClick();
        post("peter_click", { fingerprint: now, at, matches });
      },
      true,
    );
  }
  // For a runner that wasn't listening when you clicked.
  function clickState() {
    const at = document.documentElement.dataset.applypilotPeterClicked || "";
    return { clicked: !!at, at, matches: !!at && state.peterClick?.at === at && state.peterClick.matches === true };
  }
  // The runner stopped waiting (Stop, Skip or the countdown ran out), so the green outline and banner no longer hold.
  function disarm(reasons = []) {
    const b = state.armed?.button;
    if (b?.style) {
      b.style.outline = "";
      b.style.outlineOffset = "";
    }
    state.armed = null;
    showBanner("warn", "ApplyPilot stopped waiting, so this is no longer an approved send. Check every answer before you submit it yourself.", bannerItems(reasons));
    return { disarmed: true };
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
  // Success wording already on the page before Submit (a job description's "once we have received your
  // application") is never read as the confirmation.
  const successLines = () =>
    new Set(
      pageText()
        .split(/[.!?\n]+/)
        .map(norm)
        .filter((x) => SUCCESS.test(x)),
    );
  const noteSuccessBefore = () => {
    state.successBefore = successLines();
    state.href = location.href;
  };
  const noteClick = () => {
    noteSuccessBefore();
    state.clickPath = location.pathname;
    document.documentElement.dataset.applypilotClickPath = location.pathname;
  };
  // Success shown in the page counts only on the page where Submit was clicked (or a step below it): a click that
  // didn't send and then Ashby's Overview tab, whose text may render after the route change, is not a confirmation.
  const onClickPath = () => {
    const at = state.clickPath || document.documentElement.dataset.applypilotClickPath || "";
    const here = location.pathname;
    return !!at && (here === at || here.startsWith(at.replace(/\/$/, "") + "/"));
  };
  function sawRoot() {
    if (!state.successBefore) noteSuccessBefore();
    state.rootSeen = true;
  }
  const newSuccess = () => {
    const before = state.successBefore;
    if (!before) return SUCCESS.test(pageText());
    for (const x of successLines()) if (!before.has(x)) return true;
    return false;
  };
  function classify(adapter) {
    // A route change inside the page (Ashby's Overview tab) shows text that was there all along, such as "every
    // application received is reviewed"; it is never new success wording.
    if (location.href !== state.href && state.successBefore) noteSuccessBefore();
    const text = pageText();
    if (captchaState().challenge || CODE_STEP.test(text))
      return { outcome: "check", code: "challenge", reason: "A CAPTCHA or verification step appeared after Submit" };
    if (ALREADY.test(text)) return { outcome: "check", code: "already_applied", reason: "The site says you already applied. Check this one." };
    const root = currentRoot(adapter);
    // "Gone" means a form this page showed was removed or hidden. A page where no form was ever found (a posting
    // page, a form ApplyPilot couldn't locate) confirms only on the site's confirmation URL.
    const gone = state.rootSeen && (!root || !visible(root));
    const urlHit = !!adapter?.confirmUrl?.test(location.pathname + location.search);
    const errs = errorsIn(root || document.body, adapter, SUCCESS).length > 0;
    if (((urlHit && SUCCESS.test(text)) || (gone && onClickPath() && newSuccess())) && !errs)
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
    currentRoot(adapter);
    listenForClicks();
    // Without the site's confirmation URL, success shown in the page counts only after a real Submit click in this
    // page, yours or ApplyPilot's: a needs-you tab where you open the job's Overview never reads as sent.
    observeOutcome(
      adapter,
      (r) => post("confirmed", { text: r.confirmationText, confirmationKind: r.confirmationKind }),
      0,
      (r) => r.outcome === "submitted" && (r.confirmationKind === "url" || alreadyClicked()),
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
  const bannerItems = (reasons) =>
    (Array.isArray(reasons) ? reasons : [])
      .map((r) => (typeof r === "string" ? r : r?.text || r?.code || ""))
      .map((t) => clip(t, 200))
      .filter(Boolean)
      .slice(0, 10);
  function bannerNeedsYou(reasons = []) {
    const items = bannerItems(reasons);
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
