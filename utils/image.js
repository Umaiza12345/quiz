// utils/image.js
// OCR temporarily disabled (no node-tesseract-ocr installed)

async function ocrBuffer(buf) {
  throw new Error("OCR not enabled: node-tesseract-ocr not installed.");
}

module.exports = { ocrBuffer };
