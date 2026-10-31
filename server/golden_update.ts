/**
 * Writes server/golden/* from the renderer as it is RIGHT NOW.
 *
 *   deno task golden            # rewrite the goldens in place
 *   deno run --allow-write=/tmp/x server/golden_update.ts /tmp/x   # elsewhere
 *
 * Run it only when a person-to-person page is MEANT to change, and read the
 * diff: that diff is the review. A change to shop mode must leave it empty,
 * which is exactly what golden_test.ts enforces.
 */
import { GOLDEN_CASES } from './golden_cases.ts';

const dir = Deno.args[0] ?? new URL('./golden/', import.meta.url).pathname;
await Deno.mkdir(dir, { recursive: true });
for (const [name, render] of Object.entries(GOLDEN_CASES)) {
  await Deno.writeTextFile(`${dir.replace(/\/$/, '')}/${name}`, render());
}
console.log(`wrote ${Object.keys(GOLDEN_CASES).length} files to ${dir}`);
