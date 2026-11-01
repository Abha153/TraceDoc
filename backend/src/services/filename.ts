/**
 * Makes a display-safe filename for the manifest and UI. The result is NEVER used to build
 * a filesystem path: stored files are named from the server-generated docId.
 */
export function sanitizeFilename(input: string): string {
  // keep only the last path segment, for both / and \
  let name = input.split(/[\\/]/).pop() ?? "";
  // strip control characters and characters that are troublesome in shells, URLs and HTML
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*`$;&]/g, "_");
  name = name.replace(/\s+/g, " ").trim();
  // no leading dots (hidden files, "..")
  name = name.replace(/^\.+/, "");
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name === "" ? "unnamed" : name;
}
