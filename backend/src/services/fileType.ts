export type DetectedType = { ext: "pdf" | "png" | "jpg" | "tiff"; mimeType: string };

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/**
 * Identifies a supported upload from its content only. The client's extension and
 * Content-Type are never trusted. Returns null for anything unsupported.
 */
export function detectFileType(buf: Buffer): DetectedType | null {
  // PDF: "%PDF-" at the start (some producers prepend junk, the spec allows it within 1024 bytes)
  if (buf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    return { ext: "pdf", mimeType: "application/pdf" };
  }
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { ext: "tiff", mimeType: "image/tiff" };
  }
  return null;
}
