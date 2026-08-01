/**
 * Getting text out of whatever the reader dropped on the page.
 *
 * Two paths, and which one a file takes decides both its privacy story and its
 * price:
 *
 *   text layer   A PDF exported from a journal carries its own text. pdf.js
 *                reads it in the browser, nothing leaves the machine, and it
 *                costs nothing — so it is free.
 *   vision       A photograph or a flatbed scan has no text layer. Only a
 *                vision model reads a rotated, two-column, slightly skewed
 *                journal page reliably, so the page image goes to the backend,
 *                which forwards it to Anthropic and stores nothing. That costs
 *                real money per page, so it costs one credit.
 *
 * Client-side OCR was considered for the second path and rejected. On the
 * material that actually matters — a phone photo of a genetics paper — it
 * produces confident garbage, and a wrong character in `c.507G>A` silently
 * makes it a different variant. No transcription is better than a plausible
 * wrong one, because nothing downstream can tell the difference.
 *
 * Both heavy dependencies are imported dynamically, so a reader who never
 * uploads anything never downloads either.
 */

const MAX_IMAGE_DIMENSION = 2200;   // enough for 9pt journal body text
const JPEG_QUALITY = 0.85;
const MIN_TEXT_LAYER_CHARS = 200;   // below this, treat the PDF as scanned

/** What kind of file this is, and therefore how it will be read. */
function classifyFile(file) {
  const name = (file?.name || "").toLowerCase();
  const type = (file?.type || "").toLowerCase();

  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  // Safari reports HEIC correctly; Chrome and Firefox often report "" for it,
  // so the extension is the reliable signal.
  if (type === "image/heic" || type === "image/heif" ||
      name.endsWith(".heic") || name.endsWith(".heif")) return "heic";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || name.endsWith(".txt") || name.endsWith(".md")) return "text";
  return "unsupported";
}

/** Whether reading this file will need the paid vision path. */
function needsVision(kind) {
  return kind === "image" || kind === "heic";
}

/** Human-readable note about what will happen, shown before the upload runs. */
function costNote(kind) {
  if (kind === "pdf") return "Read in your browser — free, and nothing leaves your device.";
  if (needsVision(kind)) return "Scanned page: read by Claude — uses one query credit per page.";
  if (kind === "text") return "Read in your browser — free, and nothing leaves your device.";
  return "";
}

/**
 * Pull the text layer out of a PDF, entirely in the browser.
 *
 * Returns `{ text, pageCount, hasTextLayer }`. A PDF that is really a bundle of
 * page scans has no usable text layer, and reports `hasTextLayer: false` so the
 * caller can offer the vision path rather than silently importing an empty
 * document.
 */
async function extractPdfText(file, { onProgress } = {}) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    // Join on the item level and let paragraph detection happen in
    // documents.js — pdf.js hands back positioned runs, not sentences.
    pages.push(content.items.map(i => i.str).join(" ").replace(/\s+/g, " ").trim());
    onProgress?.({ page: n, of: pdf.numPages });
  }

  const text = pages.filter(Boolean).join("\n\n");
  return { text, pageCount: pdf.numPages, hasTextLayer: text.length >= MIN_TEXT_LAYER_CHARS };
}

/**
 * Decode HEIC to a JPEG blob.
 *
 * iPhone photos are HEIC and no browser will paint one to a canvas, so without
 * this the most natural way to capture a page — photograph it — silently fails.
 * The decoder is ~500KB of wasm and loads only when a HEIC actually arrives.
 */
async function heicToJpeg(file) {
  const { heicTo } = await import("heic-to");
  return heicTo({ blob: file, type: "image/jpeg", quality: JPEG_QUALITY });
}

/**
 * Downscale an image and return bare base64 JPEG, ready for the vision call.
 *
 * Downscaling is not only a bandwidth question: an 8MP phone photo costs
 * meaningfully more to process than a 2200px one and reads no better, because
 * the limit is the model's resolution handling rather than the sensor's.
 */
async function imageToBase64(blob, maxDim = MAX_IMAGE_DIMENSION) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Read one file into plain text.
 *
 * `transcribe(base64Images)` is injected rather than called directly so this
 * module stays free of API and auth concerns — and so a caller can decline the
 * paid path. When it is absent and the file needs vision, this throws rather
 * than quietly returning nothing.
 */
async function extractText(file, { transcribe, onProgress } = {}) {
  const kind = classifyFile(file);

  if (kind === "text") {
    return { text: await file.text(), source: "text", pages: 1 };
  }

  if (kind === "pdf") {
    const { text, pageCount, hasTextLayer } = await extractPdfText(file, { onProgress });
    if (hasTextLayer) return { text, source: "pdf", pages: pageCount };
    // A PDF of page scans. Falls through to vision if the caller allows it,
    // rather than importing a document with no content in it.
    if (!transcribe) {
      throw new Error("This PDF has no selectable text — it looks like a scan.");
    }
    throw new Error(
      "This PDF appears to be scanned images rather than text. " +
      "Export the pages as images and upload those to have them read."
    );
  }

  if (needsVision(kind)) {
    if (!transcribe) throw new Error("Reading a scanned page requires signing in.");
    onProgress?.({ stage: "decoding" });
    const blob = kind === "heic" ? await heicToJpeg(file) : file;
    onProgress?.({ stage: "reading" });
    const base64 = await imageToBase64(blob);
    const text = await transcribe([base64]);
    return { text, source: "image", pages: 1 };
  }

  throw new Error("Upload a PDF, an image of a page, or a text file.");
}

export {
  classifyFile, needsVision, costNote, extractText, extractPdfText,
  heicToJpeg, imageToBase64, MAX_IMAGE_DIMENSION, MIN_TEXT_LAYER_CHARS,
};
