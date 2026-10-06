// Node-side bridge: turn a PDF into the page-model that statement-parser.js
// consumes. This mirrors EXACTLY what index.html does in the browser with the
// same pdf.js API (page.getTextContent -> items with transform/width/height),
// so a green test here means the browser path parses the same bytes identically.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfToPages(data) {
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => 'str' in it)
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width,
        height: it.height || Math.hypot(it.transform[2], it.transform[3])
      }));
    pages.push({ width: viewport.width, height: viewport.height, items });
  }
  await pdf.destroy();
  return pages;
}
