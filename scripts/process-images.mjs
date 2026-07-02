/***********************
 * process-images.mjs
 *
 * Runs inside GitHub Actions. For every Models record that needs syncing:
 *   1. Downloads the first attachment (Airtable's temp URL is fresh at run time)
 *   2. Validates it's a real image in an accepted format
 *   3. Normalises it: auto-rotate, resize to MAX_EDGE (no upscaling),
 *      strip metadata, convert to PNG (if transparent) or JPEG (otherwise)
 *   4. Writes it to images/ with a Markdown-safe filename:
 *        {model-name-slug}-{recordId}.{png|jpg}
 *      (lowercase letters, digits, hyphens only in the slug — no underscores
 *       or parentheses, which the Outlook block's Markdown pass mangles)
 *   5. Records the outcome in sync-results.json for the write-back step
 *
 * Which records count as "needing syncing":
 *   MODE=sync    -> Status field is "Pending"  (set by the Airtable watcher)
 *   MODE=backlog -> has an attachment and isn't yet "Published" (or URL empty)
 *
 * Rejected records (wrong format, too large, download failed) are marked
 * "Rejected" with a reason — never silently skipped.
 ************************/

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

/* -------------------- config from environment -------------------- */
function env(key, required = true) {
  const v = process.env[key];
  if (required && !v) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return v ?? "";
}

const AIRTABLE_PAT = env("AIRTABLE_PAT");
const BASE_ID      = env("BASE_ID");
const TABLE_ID     = env("TABLE_ID");
const FLD_ATTACH   = env("FLD_ATTACH");
const FLD_NAME     = env("FLD_NAME");
const FLD_URL      = env("FLD_URL");
const FLD_STATUS   = env("FLD_STATUS");
const FLD_NOTE     = process.env.FLD_NOTE || "";          // optional
const MODE         = process.env.MODE || "sync";           // sync | backlog
const REPO         = env("GITHUB_REPOSITORY");             // owner/repo, set by Actions
const BRANCH       = process.env.BRANCH || "main";
const MAX_EDGE     = parseInt(process.env.MAX_EDGE || "600", 10);
const JPEG_QUALITY = parseInt(process.env.JPEG_QUALITY || "82", 10);

const IMAGES_DIR = "images";
const RESULTS_FILE = "sync-results.json";

// Formats sharp can read that we'll accept as INPUT.
// Output is always png or jpg — the only formats Outlook renders reliably.
const ACCEPTED_INPUT = new Set(["jpeg", "png", "webp", "gif", "tiff"]);
const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // reject absurdly large sources

/* -------------------- helpers -------------------- */

/** Lowercase letters, digits, hyphens only — safe through the Markdown pass. */
function slugify(s) {
  const slug = (s ?? "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")       // everything else -> hyphen
    .replace(/^-+|-+$/g, "")           // trim edge hyphens
    .slice(0, 60);
  return slug || "model";
}

/** List all records in the table, paginated, fields keyed by field ID. */
async function listRecords() {
  const records = [];
  let offset = null;
  do {
    const params = new URLSearchParams({
      returnFieldsByFieldId: "true",
      pageSize: "100",
    });
    for (const fld of [FLD_ATTACH, FLD_NAME, FLD_URL, FLD_STATUS]) {
      params.append("fields[]", fld);
    }
    if (offset) params.set("offset", offset);

    const resp = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?${params}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
    );
    if (!resp.ok) {
      throw new Error(`Airtable list failed: HTTP ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    records.push(...data.records);
    offset = data.offset ?? null;
  } while (offset);
  return records;
}

/* -------------------- main -------------------- */

fs.mkdirSync(IMAGES_DIR, { recursive: true });

const all = await listRecords();
console.log(`Fetched ${all.length} records from Airtable (mode: ${MODE})`);

const needsSync = all.filter((rec) => {
  const atts = rec.fields[FLD_ATTACH];
  if (!Array.isArray(atts) || atts.length === 0) return false;
  const status = rec.fields[FLD_STATUS] || "";
  const url = rec.fields[FLD_URL] || "";
  if (MODE === "backlog") return status !== "Published" || !url;
  return status === "Pending";
});
console.log(`${needsSync.length} record(s) need processing`);

const results = [];

for (const rec of needsSync) {
  const att = rec.fields[FLD_ATTACH][0]; // first attachment is the model image
  const label = rec.fields[FLD_NAME] || att.filename || rec.id;

  try {
    // 1. Download while the temp URL is fresh
    const resp = await fetch(att.url);
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
    const input = Buffer.from(await resp.arrayBuffer());
    if (input.length > MAX_SOURCE_BYTES) {
      throw new Error(`source too large (${(input.length / 1048576).toFixed(1)} MB)`);
    }

    // 2. Validate it's a real image in an accepted format
    const meta = await sharp(input).metadata();
    if (!meta.format || !ACCEPTED_INPUT.has(meta.format)) {
      throw new Error(`unsupported format: ${meta.format || "unrecognised"}`);
    }

    // 3. Normalise: rotate per EXIF, cap longest edge, strip metadata.
    //    Transparency -> PNG; everything else -> JPEG on white.
    const useAlpha = meta.hasAlpha === true && meta.format !== "jpeg";
    const ext = useAlpha ? "png" : "jpg";
    const pipeline = sharp(input)
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
    const outBuf = useAlpha
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
          .toBuffer();

    // 4. Markdown-safe filename, unique + deterministic per record
    const filename = `${slugify(rec.fields[FLD_NAME] ?? att.filename)}-${rec.id}.${ext}`;
    const filePath = path.join(IMAGES_DIR, filename);

    // Remove stale variants for this record (renamed model, or png<->jpg switch)
    for (const existing of fs.readdirSync(IMAGES_DIR)) {
      if (existing.includes(rec.id) && existing !== filename) {
        fs.unlinkSync(path.join(IMAGES_DIR, existing));
        console.log(`  removed stale file ${existing}`);
      }
    }

    // Only write if the bytes actually changed (keeps commits meaningful)
    const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    if (!prev || !prev.equals(outBuf)) {
      fs.writeFileSync(filePath, outBuf);
      console.log(`  wrote ${filePath} (${(outBuf.length / 1024).toFixed(0)} KB)`);
    } else {
      console.log(`  ${filePath} unchanged`);
    }

    // 5. Permanent public URL (raw.githubusercontent serves the latest on BRANCH)
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${IMAGES_DIR}/${filename}`;

    const fields = { [FLD_URL]: url, [FLD_STATUS]: "Published" };
    if (FLD_NOTE) {
      fields[FLD_NOTE] =
        `Published ${new Date().toISOString()} — ` +
        `${meta.width}x${meta.height} ${meta.format} -> ${ext}, ` +
        `${(outBuf.length / 1024).toFixed(0)} KB`;
    }
    results.push({ id: rec.id, fields });
    console.log(`OK  ${label}`);
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    const fields = { [FLD_STATUS]: "Rejected" };
    if (FLD_NOTE) fields[FLD_NOTE] = `Rejected ${new Date().toISOString()} — ${reason}`;
    results.push({ id: rec.id, fields });
    console.log(`REJECTED  ${label}: ${reason}`);
  }
}

fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`\nDone. ${results.length} result(s) written to ${RESULTS_FILE}`);
