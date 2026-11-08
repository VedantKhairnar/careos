// Renames the product-facing name everywhere people can see it.   Usage: node scripts/rename-brand.mjs "<Old>" "<New>"
// Internal identifiers (package name, repository, server user, paths) are NOT touched on purpose: renaming those breaks deployment.
// After renaming, re-record the README media:  pnpm media
import fs from "node:fs";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('Usage: node scripts/rename-brand.mjs "<Old name>" "<New name>"');
  process.exit(1);
}
const files = ["src/lib/brand.ts", "README.md", "DEVPOST.md", "infra/vultr/README.md", "assets/readme/banner.svg"];
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const before = fs.readFileSync(f, "utf8");
  const after = before.split(from).join(to);
  if (after !== before) fs.writeFileSync(f, after);
  console.log(`${f}: ${before.split(from).length - 1} replacement(s)`);
}
console.log(`\nDone. Review with git diff, run the tests, then re-record the media (pnpm media).`);
