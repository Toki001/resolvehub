import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

async function parse() {
  if (!(workerData instanceof Uint8Array)) throw new Error('Invalid PDF input');
  const task = getDocument({
    data: new Uint8Array(workerData),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages > 200) throw new Error('Too many pages');
    let text = '';
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
      if (text.length > 200000) throw new Error('Too much text');
    }
    parentPort?.postMessage({ text });
  } finally {
    await task.destroy();
  }
}
parse().catch(() => parentPort?.postMessage({ error: 'INVALID_CONTENT' }));
