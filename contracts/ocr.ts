/**
 * OCR output shapes shared by the Python service and its tests.
 * Boxes are [x, y, w, h] normalized (0..1) to the canonical render, same space as Region.bbox.
 * OCR output is a claim, not ground truth: ocrConfidence is carried everywhere.
 */

export interface OcrWord {
  text: string;
  bbox: [x: number, y: number, w: number, h: number];
  ocrConfidence: number; // 0..1
  lineIndex: number; // index into OcrPage.lines
}

export interface OcrLine {
  text: string;
  bbox: [x: number, y: number, w: number, h: number];
  ocrConfidence: number; // 0..1
  wordIndices: number[]; // indices into OcrPage.words
}

export interface OcrPage {
  docId: string;
  page: number; // 1-based
  widthPx: number; // canonical render size in pixels
  heightPx: number;
  renderDpi: number;
  engine: string; // "paddleocr" | "tesseract" | "fixture"
  engineVersion: string;
  words: OcrWord[];
  lines: OcrLine[];
}
