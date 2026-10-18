/**
 * The spellings of a path, and the rules that have to survive them.
 *
 * On 2026-10-18 the live host answered /server/app.ts with 404 and
 * /server%2fapp.ts with 200 and 7192 bytes of TypeScript, because the guard
 * read the escapes as sent while the file server decoded them first. These
 * tests hold the two readings together: every rule in app.ts and main.ts now
 * compares against canonicalPath, and the cases below are the ones that were
 * actually served.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { canonicalPath, type Deps, handle, isSourcePath } from './app.ts';

const ID = '550e8400-e29b-41d4-a716-446655440000';

function deps(): Deps & { staticHits: string[] } {
  const staticHits: string[] = [];
  return {
    env: { url: 'https://db.example.co', anon: 'anon-key' },
    staticHits,
    serveStatic: (req) => {
      staticHits.push(new URL(req.url).pathname);
      return Promise.resolve(new Response('static', { status: 200 }));
    },
  } as Deps & { staticHits: string[] };
}

Deno.test('the four spellings the live host served are all one path', () => {
  assertEquals(canonicalPath('/server/app.ts'), '/server/app.ts');
  assertEquals(canonicalPath('/server%2fapp.ts'), '/server/app.ts');
  assertEquals(canonicalPath('/server%2Fapp.ts'), '/server/app.ts');
  assertEquals(canonicalPath('/%73erver/app.ts'), '/server/app.ts');
  assertEquals(canonicalPath('/s.html%2f'), '/s.html');
});

Deno.test('spelling is settled: empty segments and the trailing slash go', () => {
  assertEquals(canonicalPath('/'), '/');
  assertEquals(canonicalPath('//s.html'), '/s.html');
  assertEquals(canonicalPath('/s.html/'), '/s.html');
  assertEquals(canonicalPath('/listing//' + ID + '/'), '/listing/' + ID);
});

Deno.test('a path that cannot name a file is null, not a cleaned-up guess', () => {
  assertEquals(canonicalPath('/%zz'), null, 'a malformed escape must not throw');
  assertEquals(canonicalPath('/%2573erver/app.ts'), null, 'encoded twice');
  assertEquals(canonicalPath('/server/../s.html'), null, 'a dot segment');
  assertEquals(canonicalPath('/..%2fserver/app.ts'), null, 'a dot segment, escaped');
});

Deno.test('the well-known paths keep their leading dot', () => {
  assertEquals(canonicalPath('/.well-known/assetlinks.json'), '/.well-known/assetlinks.json');
});

Deno.test('source is refused in every spelling, and only source', () => {
  for (const raw of ['/server', '/server/app.ts', '/server%2fapp.ts', '/%73erver/app.ts']) {
    const path = canonicalPath(raw);
    assert(path !== null, raw + ' should canonicalise');
    assert(isSourcePath(path), raw + ' must be refused');
  }
  // The prefix is a segment, not a string: these are content and must be served.
  for (const ok of ['/server.html', '/servers-guide.html', '/s.html', '/']) {
    assertEquals(isSourcePath(canonicalPath(ok)!), false, ok + ' must not be refused');
  }
});

Deno.test('an escaped slash no longer smuggles s.html past the redirect', async () => {
  const d = deps();
  const res = await handle(
    new Request('https://logosell.app/s.html%2f?t=listing&id=' + ID),
    d,
  );
  assertEquals(res.status, 302, 'it used to be served as a file, price and all');
  assertEquals(res.headers.get('Location'), '/listing/' + ID);
  assertEquals(d.staticHits.length, 0, 's.html must never reach the file server here');
});

Deno.test('a malformed escape is a 404, not a crash', async () => {
  const d = deps();
  const res = await handle(new Request('https://logosell.app/%zz'), d);
  assertEquals(res.status, 200, 'handed to the static handler');
  assertEquals(d.staticHits.length, 1, 'decodeURIComponent used to throw here');
});
