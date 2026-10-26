import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { TailoredResume } from "./ai";

// A plain one-column PDF that applicant-tracking systems read reliably: real text, no tables or images.

const PAGE = { width: 612, height: 792 }; // US Letter
const MARGIN = 54;
const WIDTH = PAGE.width - MARGIN * 2;

// The built-in PDF fonts only cover Windows-1252, so anything else is swapped for a close match.
const extra = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function pdfSafe(text: string) {
  return text
    .normalize("NFC")
    .replace(/[‐-‒]/g, "-")
    .replace(/[•●▪◦⁃]/g, "•")
    .replace(/\s+/g, " ")
    .split("")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || extra.has(ch) ? ch : "?";
    })
    .join("")
    .trim();
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of pdfSafe(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Fixed metadata and a caller-chosen date make the bytes reproducible: one tailored revision, one file hash.
export async function buildResumePdf(resume: TailoredResume["resume"], opts: { date?: Date } = {}) {
  const date = opts.date ?? new Date();
  if (Number.isNaN(date.getTime())) throw new Error("The resume date is not valid.");
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`${pdfSafe(resume.name)} Resume`);
  pdf.setAuthor(pdfSafe(resume.name));
  pdf.setCreator("ApplyPilot");
  pdf.setProducer("ApplyPilot");
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  const ensure = (height: number) => {
    if (y - height < MARGIN) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - MARGIN;
    }
  };
  const text = (value: string, opts: { font?: PDFFont; size?: number; indent?: number; gap?: number; bullet?: boolean } = {}) => {
    const font = opts.font ?? regular, size = opts.size ?? 10, indent = opts.indent ?? 0;
    const lead = size * 1.3;
    const lines = wrap(value, font, size, WIDTH - indent - (opts.bullet ? 10 : 0));
    lines.forEach((line, index) => {
      ensure(lead);
      y -= lead;
      if (opts.bullet && index === 0) page.drawText("•", { x: MARGIN + indent, y, size, font: regular });
      page.drawText(line, { x: MARGIN + indent + (opts.bullet ? 10 : 0), y, size, font, color: rgb(0.1, 0.1, 0.1) });
    });
    y -= opts.gap ?? 0;
  };
  const heading = (value: string) => {
    ensure(34);
    y -= 12;
    text(value.toUpperCase(), { font: bold, size: 10.5 });
    y -= 3;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
    y -= 3;
  };

  text(resume.name, { font: bold, size: 18, gap: 2 });
  if (resume.contactLine) text(resume.contactLine, { size: 9.5 });
  if (resume.headline) text(resume.headline, { font: bold, size: 11, gap: 2 });
  if (resume.summary) {
    heading("Summary");
    text(resume.summary);
  }
  if (resume.skills.length) {
    heading("Skills");
    text(resume.skills.join(" • "));
  }
  if (resume.experience.length) {
    heading("Experience");
    for (const job of resume.experience) {
      ensure(40);
      y -= 4;
      text([job.title, job.company].filter(Boolean).join(", "), { font: bold });
      const meta = [job.location, job.dates].filter(Boolean).join(" | ");
      if (meta) text(meta, { font: italic, size: 9.5 });
      for (const bullet of job.bullets) text(bullet, { bullet: true, indent: 4 });
    }
  }
  if (resume.education.length) {
    heading("Education");
    for (const item of resume.education) text([item.credential, item.school, item.dates].filter(Boolean).join(", "));
  }
  if (resume.certifications.length) {
    heading("Certifications");
    text(resume.certifications.join(" • "));
  }
  return pdf.save();
}
