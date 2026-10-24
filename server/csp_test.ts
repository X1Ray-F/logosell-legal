/**
 * Every static page pins its inline <script> and <style> blocks by sha256 in a
 * CSP <meta>. Editing the block without updating the hash does not fail
 * anywhere visible: the browser just refuses to run or apply it. That is how
 * s.html went dark in 71a2c2e, so this compares the two for every page.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createHash } from 'node:crypto';

const sha = (s: string) => 'sha256-' + createHash('sha256').update(s, 'utf8').digest('base64');

Deno.test('every inline script and style in a static page is allowed by its CSP meta', async () => {
  const problems: string[] = [];
  let blocks = 0;
  for await (const e of Deno.readDir('.')) {
    if (!e.isFile || !e.name.endsWith('.html')) continue;
    const html = await Deno.readTextFile(e.name);
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
    const policy = meta?.[1] ?? '';
    for (const m of html.matchAll(/<(script|style)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/gi)) {
      const [, tag, attrs, body] = m;
      // An external script is governed by its origin, not by a hash.
      if (tag.toLowerCase() === 'script' && /\ssrc\s*=/i.test(attrs)) continue;
      // Data blocks such as application/ld+json are never executed.
      if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs)) continue;
      blocks++;
      if (!policy.includes(`'${sha(body)}'`)) {
        problems.push(`${e.name}: inline <${tag}> hashes to ${sha(body)}, which its CSP meta does not list`);
      }
    }
  }
  assert(blocks > 0, 'found no inline blocks at all: the scan is broken');
  assertEquals(problems, []);
});
