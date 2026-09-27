/**
 * "Save to Google Drive" without any server: hand files to the OS share sheet
 * (Web Share API level 2). On Android the user picks Drive and the folder.
 * Nothing is uploaded to the website. If file sharing isn't available, the
 * files are downloaded instead so they can be uploaded to Drive by hand.
 */

/** Chrome's share allowlist has no .json, so the backup can be re-labelled as .txt. */
export function asShareableText(file) {
  return new File([file], `${file.name}.txt`, { type: "text/plain", lastModified: file.lastModified });
}

function canShareFiles(nav, files) {
  try {
    return Boolean(nav && typeof nav.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files }));
  } catch {
    return false;
  }
}

/** Pick the set of files the browser will share, or null if file sharing is unsupported. */
export function pickShareableFiles(files, nav = globalThis.navigator) {
  if (canShareFiles(nav, files)) return files;
  const relabelled = files.map((f) => (/\.json$/i.test(f.name) ? asShareableText(f) : f));
  if (canShareFiles(nav, relabelled)) return relabelled;
  return null;
}

export function downloadFile(file, doc = globalThis.document) {
  const url = URL.createObjectURL(file);
  const a = doc.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  a.style.display = "none";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Share `files`, falling back to downloads.
 * Returns { method: "share" | "download" | "cancelled" | "retry", files }.
 * "retry" means the browser refused because the tap was too long ago; the
 * caller shows a button so the next tap can share straight away.
 */
export async function shareOrDownload(files, { nav = globalThis.navigator, download = downloadFile, title = "Pay Ledger backup", text = "" } = {}) {
  const shareable = pickShareableFiles(files, nav);
  if (shareable) {
    try {
      await nav.share({ files: shareable, title, text });
      return { method: "share", files: shareable };
    } catch (err) {
      if (err && err.name === "AbortError") return { method: "cancelled", files: shareable };
      if (err && err.name === "NotAllowedError") return { method: "retry", files: shareable, error: err };
      // Any other failure: fall through to downloads so the user still gets the files.
    }
  }
  for (const file of files) download(file);
  return { method: "download", files };
}
