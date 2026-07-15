/* Strips a spurious trailing 0x0A (LF) byte from Mixamo .fbx downloads.
 *
 * Some of the clips in public/animations/ arrived with one extra newline byte
 * appended after the FBX binary footer — a text-mode write somewhere in the
 * download/extract path. The FBX payload itself is intact, but the extra byte
 * pushes the trailing footer to 177 bytes, and three.js' FBXLoader gives the
 * footer a hard-coded 176-byte budget (BinaryParser.endOfContent: 160 + 16).
 * When the footer overshoots that budget the parser doesn't recognise the end
 * of content, tries to read one more node out of the footer, hits the footer's
 * zero-padding and throws "THREE.FBXLoader: Unknown property type ".
 *
 * Only clips whose footer padding already sat at the 176-byte limit actually
 * break; the rest carry the same stray byte harmlessly. This strips it from
 * all of them.
 *
 * Safe + idempotent: a byte is only removed when the file is a Kaydara binary
 * FBX, ends in 0x0A, and dropping that byte restores the 16-byte size
 * alignment every valid FBX binary has. A legitimate FBX ending in 0x0A is
 * already aligned, so it fails that check and is left alone.
 *
 * Usage: node scripts/repair-fbx.mjs [dir]   (default: public/animations)
 */
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = 'Kaydara FBX Binary';
const dir = process.argv[2] || 'public/animations';

if (!fs.existsSync(dir)) {
  console.error(`repair-fbx: no such directory: ${dir}`);
  process.exit(1);
}

let repaired = 0, clean = 0, skipped = 0;

for (const name of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.fbx')).sort()) {
  const file = path.join(dir, name);
  const buf = fs.readFileSync(file);

  if (buf.subarray(0, MAGIC.length).toString('binary') !== MAGIC) {
    console.log(`skip     ${name} (not a binary FBX)`);
    skipped++;
    continue;
  }

  if (buf[buf.length - 1] !== 0x0a) { clean++; continue; }

  /* Valid FBX binaries are 16-byte aligned. If dropping the trailing 0x0A is
     what restores that alignment, the byte was never part of the file. */
  if ((buf.length - 1) % 16 !== 0) {
    console.log(`skip     ${name} (trailing 0x0A looks intentional — alignment unchanged)`);
    skipped++;
    continue;
  }

  fs.writeFileSync(file, buf.subarray(0, buf.length - 1));
  console.log(`repaired ${name} (${buf.length} -> ${buf.length - 1} bytes)`);
  repaired++;
}

console.log(`\nrepair-fbx: ${repaired} repaired, ${clean} already clean, ${skipped} skipped`);
