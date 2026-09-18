// Render a repo markdown document to a PDF, diagrams and all.
//
// The document lives in docs/ as markdown, because that is where it is read,
// reviewed and diffed. This makes the shareable copy: it inlines each
// referenced SVG so the PDF stands alone, lays the text out for reading rather
// than for a terminal, and prints through the Chrome already on the machine.
//
// The markdown subset is deliberately small — headings, paragraphs, lists,
// tables, code spans, links, images, rules, bold and italic — because the
// input is ours. Anything outside it renders as plain text rather than
// silently disappearing, and the converter says so.
//
//   node scripts/doc-to-pdf.mjs docs/architecture.md --out output/docs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, wait } from './lib/chrome.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const source = path.resolve(args.find((a) => !a.startsWith('--') && a.endsWith('.md')) || path.join(ROOT, 'docs', 'architecture.md'));
const outDir = path.resolve(flag('out', path.join(ROOT, 'output', 'docs')));
const sourceDir = path.dirname(source);

// ---- markdown ----

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline spans, in an order that keeps code literal. */
function inline(text) {
  const code = [];
  let out = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  out = escape(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${escape(href)}">${label}</a>`);
  // Non-greedy, and NOT [^*]: a bold span may contain an italic one, and
  // `[^*]+` silently failed to match those — leaving literal asterisks on the
  // page, which is exactly the kind of miss the check at the end now catches.
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escape(code[Number(i)])}</code>`);
}

/** An image whose target is an SVG in the repo becomes the SVG itself. */
function figure(alt, src) {
  const file = path.resolve(sourceDir, src);
  if (!fs.existsSync(file)) throw new Error(`${source} references ${src}, which does not exist`);
  if (!file.endsWith('.svg')) throw new Error(`${src} is not an SVG; this converter inlines SVG only`);
  const svg = fs.readFileSync(file, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '');
  return `<figure aria-label="${escape(alt)}">${svg}</figure>`;
}

function render(markdown) {
  const lines = markdown.split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  const unknown = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) { flush(); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) { flush(); html.push('<hr>'); continue; }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (image) { flush(); html.push(figure(image[1], image[2])); continue; }

    // A table: a header row, a separator, then rows until a blank line.
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      flush();
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) { body.push(cells(lines[i])); i++; }
      i--;
      html.push(
        '<table><thead><tr>'
        + head.map((c) => `<th>${inline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>',
      );
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { flushParagraph(); (list ||= []).push(bullet[1]); continue; }

    // A continuation of the bullet above, or of the paragraph above.
    if (list && /^\s{2,}\S/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; continue; }

    if (/^\s{4,}\S/.test(line) || line.startsWith('```') || line.startsWith('>')) {
      unknown.push(`line ${i + 1}: ${line.slice(0, 60)}`);
    }
    flushList();
    paragraph.push(line.trim());
  }
  flush();
  const body = html.join('\n');
  // Markup that survived conversion is markup that did not convert. Cheap,
  // and it catches the inline cases the line-level check above cannot see.
  for (const [pattern, what] of [[/\*\*/, 'bold'], [/\]\(/, 'a link'], [/^\s*\|/m, 'a table row']]) {
    if (pattern.test(body)) unknown.push(`${what} markup reached the output unconverted`);
  }
  return { html: body, unknown };
}

// ---- the page ----

const markdown = fs.readFileSync(source, 'utf8');
const { html, unknown } = render(markdown);
const title = (/^#\s+(.*)$/m.exec(markdown)?.[1] || path.basename(source, '.md')).trim();

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  @page { size: 1100px 1500px; margin: 64px 70px; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #14161a; background: #fff; font-size: 14.5px; line-height: 1.62;
         font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1 { font-size: 34px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 22px; }
  /* Sections flow rather than each starting a page: a forced break left half
     of most pages empty, which is worse than a heading near a page foot. */
  h2 { font-size: 22px; letter-spacing: -0.01em; margin: 38px 0 14px; break-after: avoid; }
  h3 { font-size: 16.5px; margin: 28px 0 10px; break-after: avoid; }
  p { margin: 0 0 14px; max-width: 78ch; }
  strong { font-weight: 640; }
  a { color: #1f5fa8; text-decoration: none; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.88em;
         background: #f2f4f7; padding: 1px 5px; border-radius: 4px; }
  ul { margin: 0 0 14px; padding-left: 22px; max-width: 78ch; }
  li { margin: 0 0 7px; }
  hr { border: none; border-top: 1px solid #e3e7ee; margin: 30px 0; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 20px; font-size: 13px;
          break-inside: avoid; }
  th { text-align: left; font-weight: 640; border-bottom: 1.5px solid #c3cad6; padding: 8px 12px 8px 0;
       vertical-align: top; }
  td { border-bottom: 1px solid #eceff4; padding: 8px 12px 8px 0; vertical-align: top; }
  th:last-child, td:last-child { padding-right: 0; }
  figure { margin: 22px 0 26px; break-inside: avoid; }
  figure svg { width: 100%; height: auto; display: block; }
  em { color: #454c59; }
</style></head>
<body>
${html}
</body></html>`;

fs.mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `${path.basename(source, '.md')}.html`);
fs.writeFileSync(htmlPath, page);

const browser = await openPage({ chrome: flag('chrome', undefined), width: 1100, height: 1500 });
await browser.send('Page.navigate', { url: `file://${htmlPath}` });
await browser.once('Page.loadEventFired');
await wait(900);
const { data } = await browser.send('Page.printToPDF', {
  printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
});
const pdfPath = path.join(outDir, `${path.basename(source, '.md')}.pdf`);
fs.writeFileSync(pdfPath, Buffer.from(data, 'base64'));
await browser.close();

if (unknown.length) {
  console.log(`\n⚠️  ${unknown.length} line(s) outside the supported markdown subset, rendered as text:`);
  for (const line of unknown.slice(0, 8)) console.log(`   ${line}`);
}
console.log(`
${path.relative(ROOT, source)} → PDF
  html  ${htmlPath}
  pdf   ${pdfPath}  (${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB)
`);
