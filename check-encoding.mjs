// Fails if any shipped text file has a BOM or double-encoded UTF-8 (mojibake: a middle dot shown as "A-circumflex + dot").
// Root cause of the Sep 2026 bug: js/app.js was read as Windows-1252 and re-saved as UTF-8 (with BOM), turning "·" into two characters..
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const skip = new Set([".git", "node_modules", "test-results"]);
const exts = new Set([".html", ".js", ".mjs", ".css", ".json", ".md", ".svg", ".ps1"]);
const bad = /\u00C2|\u00E2\u20AC|\u00E2\u02C6|\u00C3\u2014|\u00C3\u00A9|\uFFFD/;
const problems = [];
let checked = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (exts.has(path.extname(name))) {
      const buf = readFileSync(full);
      checked += 1;
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push(`${full}: UTF-8 BOM`);
      const text = buf.toString("utf8");
      text.split("\n").forEach((line, i) => {
        if (bad.test(line)) problems.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
  }
})(root);
if (problems.length) {
  console.error("Encoding problems:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`encoding ok · ${checked} files, no BOM, no mojibake`);
