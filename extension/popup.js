const $ = (s) => document.querySelector(s);
let profile = null,
  resume = null;
chrome.storage.local.get(["applypilotProfile", "applypilotResume"], (s) => {
  profile = s.applypilotProfile || null;
  resume = s.applypilotResume || null;
  refresh();
});
chrome.tabs.query(
  { active: true, currentWindow: true },
  ([t]) => ($("#platform").textContent = platform(t?.url || "")),
);
$("#profile-file").onchange = async (e) => {
  try {
    const p = JSON.parse(await e.target.files[0].text());
    if (!p.firstName || !p.lastName || !p.email)
      throw Error("Profile needs first name, last name, and email.");
    profile = p;
    await chrome.storage.local.set({ applypilotProfile: p });
    $("#result").textContent = "Profile imported.";
    refresh();
  } catch (x) {
    $("#result").textContent = x.message || "Could not import profile.";
  }
};
$("#resume-file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) {
    $("#result").textContent = "Use a resume smaller than 5 MB.";
    return;
  }
  resume = { name: f.name, type: f.type || "application/octet-stream", dataUrl: await dataUrl(f) };
  await chrome.storage.local.set({ applypilotResume: resume });
  $("#result").textContent = "Resume saved for applications.";
  refresh();
};
$("#run").onclick = () => run(false);
$("#next").onclick = () => run(true);
function refresh() {
  if (profile) {
    $("#dot").classList.add("ready");
    $("#profile-status").textContent = "Profile ready";
    $("#profile-detail").textContent = `${profile.firstName} ${profile.lastName} · ${profile.email}`;
    $("#run").disabled = false;
  }
  $("#resume-label").textContent = resume ? resume.name : "Add resume";
}
async function run(advance) {
  $("#run").disabled = true;
  $("#next").disabled = true;
  $("#result").textContent = advance
    ? "Checking for a safe Next button…"
    : "Scanning and filling approved fields…";
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t?.id || !/^https?:/.test(t.url || "")) throw Error("Open an employer application first.");
    $("#platform").textContent = platform(t.url);
    const out = await chrome.scripting.executeScript({
      target: { tabId: t.id },
      func: assistant,
      args: [profile, resume, advance],
    });
    const s = out[0]?.result;
    if (!s) throw Error("This page could not be read.");
    show(s);
    $("#result").textContent = s.advanced
      ? "Moved to the next step. Open ApplyPilot again after it loads."
      : s.blockers.length
        ? `Filled ${s.filled} fields. Answer the highlighted questions.`
        : `Filled ${s.filled} fields. Review, then continue safely.`;
    $("#next").disabled = !!s.blockers.length || s.final;
  } catch (e) {
    $("#result").textContent = e.message || "This page could not be processed.";
  } finally {
    $("#run").disabled = !profile;
  }
}
function show(s) {
  $("#report").hidden = false;
  $("#filled").textContent = s.filled;
  $("#blocked").textContent = s.blockers.length;
  $("#uploaded").textContent = s.resumeAttached ? "Yes" : resume ? "Waiting" : "None";
  $("#blockers").hidden = !s.blockers.length;
  $("#blocker-list").replaceChildren(
    ...s.blockers.slice(0, 8).map((x) => {
      const li = document.createElement("li");
      li.textContent = x;
      return li;
    }),
  );
}
function dataUrl(f) {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = no;
    r.readAsDataURL(f);
  });
}
function platform(u) {
  let h = "";
  try {
    h = new URL(u).hostname.toLowerCase();
  } catch {}
  if (/myworkdayjobs|workday/.test(h)) return "Workday";
  if (/greenhouse/.test(h)) return "Greenhouse";
  if (/lever\.co/.test(h)) return "Lever";
  if (/icims/.test(h)) return "iCIMS";
  if (/smartrecruiters/.test(h)) return "SmartRecruiters";
  if (/jobvite/.test(h)) return "Jobvite";
  if (/taleo/.test(h)) return "Taleo";
  return h ? "Employer site" : "Open a job";
}
async function assistant(data, savedResume, advance) {
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
  let filled = 0,
    resumeAttached = false;
  const blockers = [];
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
    if (/^(yes|y|true)$/.test(t)) return true;
    if (/^(no|n|false)$/.test(t)) return false;
    const n = no.test(t),
      y = yes.test(t.replace(new RegExp(no.source, "g"), ""));
    return y && !n ? true : n && !y ? false : null;
  };
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
  const alias = {
    us: "united states",
    usa: "united states",
    "u.s.": "united states",
    "u.s.a.": "united states",
    uk: "united kingdom",
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
  const fillRecord = (root, r) => {
    let n = 0;
    for (const f of root.querySelectorAll("input,select,textarea")) {
      if (!empty(f) || f.disabled || f.readOnly) continue;
      const m = match(f, recordFields);
      const v = !m || (r.current && /^end/.test(m[0])) ? "" : String(r[m[0]] ?? "").trim();
      if (v && set(f, v)) n++;
    }
    const c = Array.from(root.querySelectorAll("input[type=checkbox]")).find((f) =>
      /current|present|still work/i.test(desc(f)),
    );
    if (r.current && c && !c.checked) {
      c.click();
      mark(c, "#2f7df6");
      n++;
    }
    return n;
  };
  const fillSections = (kind, records) => {
    const roots = sectionRoots(kind);
    let n = 0;
    for (let i = 0; i < Math.min(roots.length, records.length); i++) n += fillRecord(roots[i], records[i]);
    return n;
  };
  filled += fillSections("work experience|employment|work history", data.workHistory || []);
  filled += fillSections("education|school", data.education || []);
  for (const f of document.querySelectorAll("input,select,textarea")) {
    const t = (f.type || "").toLowerCase();
    if (f.disabled || f.readOnly || ["hidden", "password", "submit", "button", "reset"].includes(t)) continue;
    const d = desc(f);
    if (sensitive.test(d)) {
      if (empty(f) && required(f)) blockers.push(d.slice(0, 90) || "Sensitive question");
      continue;
    }
    if (t === "file" && savedResume && /resume|cv|curriculum/i.test(d) && empty(f)) {
      try {
        const b = await (await fetch(savedResume.dataUrl)).blob();
        const file = new File([b], savedResume.name, { type: savedResume.type });
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
    if (/authori[sz]ed|legally.*work|work.*authori[sz]ation/i.test(d)) {
      if (authorized === null) blockers.push("Work authorization: answer this yourself");
      else if (choice(f, authorized ? "yes" : "no")) filled++;
    } else if (/sponsor|visa/i.test(d)) {
      if (needsSponsor === null) blockers.push("Visa sponsorship: answer this yourself");
      else if (choice(f, needsSponsor ? "yes" : "no")) filled++;
    }
  }
  for (const f of document.querySelectorAll("input,select,textarea"))
    if (!f.disabled && required(f) && empty(f)) {
      const label = (desc(f) || "Required question").slice(0, 90);
      if (!blockers.includes(label)) blockers.push(label);
      mark(f, "#f5b84b");
    }
  const buttons = Array.from(
    document.querySelectorAll("button,input[type=submit],input[type=button],a[role=button]"),
  );
  const final = buttons.find((b) =>
    /submit application|^submit$|apply now/i.test((b.textContent || b.value || "").trim()),
  );
  const next = buttons.find((b) =>
    /^(next|continue|save and continue|review)$/i.test((b.textContent || b.value || "").trim()),
  );
  let advanced = false;
  if (advance && !blockers.length && next && !final) {
    next.click();
    advanced = true;
  }
  if (final) mark(final, "#f5b84b");
  return { filled, blockers: [...new Set(blockers)], resumeAttached, advanced, final: !!final };
}
