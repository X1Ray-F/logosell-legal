/**
 * /.well-known/*: Android App Links.
 *
 * Android fetches https://logosell.app/.well-known/assetlinks.json to decide
 * whether a logosell.app link opens in the app. GitHub Pages served it; this
 * server's static handler (serveDir) refuses every path with a dot segment, so
 * on Deno it was a 404 and every shared link would have gone back to being a
 * browser tab. app.ts now answers these paths itself from a table compiled into
 * wellknown.ts, and these tests hold the table to the files byte for byte.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { type Deps, handle } from './app.ts';
import { WELL_KNOWN } from './wellknown.ts';

const dir = new URL('../.well-known/', import.meta.url);

/** Every dependency throws: a /.well-known request must not need any of them. */
function boom(): never {
  throw new Error('a /.well-known request reached something that is not the table');
}

function deps(over: Partial<Deps> = {}): Deps & { staticHits: string[] } {
  const staticHits: string[] = [];
  return {
    // No database configured at all, which is also what the first deploy looks like.
    env: { url: '', anon: '' },
    staticHits,
    serveStatic: (req: Request) => {
      staticHits.push(new URL(req.url).pathname);
      return Promise.resolve(new Response('static', { status: 200 }));
    },
    fetchListing: boom,
    fetchSeller: boom,
    fetchPublicListings: boom,
    fetchZone: boom,
    fetchZoneListings: boom,
    fetchZoneCategories: boom,
    fetchTraders: boom,
    fetchShop: boom,
    ...over,
  } as unknown as Deps & { staticHits: string[] };
}

const get = (path: string, init?: RequestInit) => new Request(`https://logosell.app${path}`, init);

/** Where two byte arrays first differ, or null: a failure message that says more than
 *  "not equal" for a 320 byte file. */
function firstDifference(a: Uint8Array, b: Uint8Array): string | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `byte ${i}: served 0x${a[i].toString(16)}, file 0x${b[i].toString(16)}`;
    }
  }
  return a.length === b.length ? null : `length: served ${a.length}, file ${b.length}`;
}

Deno.test('assetlinks.json is served by the server, byte for byte as the file on disk', async () => {
  const onDisk = await Deno.readFile(new URL('assetlinks.json', dir));
  const d = deps();
  const res = await handle(get('/.well-known/assetlinks.json'), d);
  assertEquals(res.status, 200);
  const served = new Uint8Array(await res.arrayBuffer());
  assertEquals(firstDifference(served, onDisk), null);
  assertEquals(served.length, onDisk.length);
  assertEquals(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  // Answered by the server, ahead of the static handler that cannot serve it.
  assertEquals(d.staticHits, []);
});

Deno.test('what is served as assetlinks.json is the statement Android looks for', async () => {
  const res = await handle(get('/.well-known/assetlinks.json'), deps());
  const json = JSON.parse(await res.text());
  assert(Array.isArray(json) && json.length > 0, 'not a non-empty array');
  const handlesUrls = json.filter((s: { relation?: string[] }) =>
    s.relation?.includes('delegate_permission/common.handle_all_urls')
  );
  assert(handlesUrls.length > 0, 'no handle_all_urls statement');
  for (const s of handlesUrls) {
    assertEquals(s.target?.namespace, 'android_app');
    assert(typeof s.target?.package_name === 'string' && s.target.package_name.length > 0);
    assert(
      Array.isArray(s.target?.sha256_cert_fingerprints) &&
        s.target.sha256_cert_fingerprints.length > 0,
      'no certificate fingerprint',
    );
  }
});

Deno.test('the table in wellknown.ts is every file in .well-known/ and nothing else', async () => {
  const onDisk: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    assert(e.isFile, `${e.name} is not a plain file`);
    onDisk.push(`/.well-known/${e.name}`);
  }
  assertEquals(
    Object.keys(WELL_KNOWN).sort(),
    onDisk.sort(),
    'the files and the table differ: run `deno task wellknown`',
  );
  for (const [path, { body }] of Object.entries(WELL_KNOWN)) {
    const file = await Deno.readFile(new URL(path.replace('/.well-known/', ''), dir));
    const served = new TextEncoder().encode(body);
    assertEquals(
      firstDifference(served, file),
      null,
      `${path} differs from the file: run \`deno task wellknown\``,
    );
  }
});

Deno.test('every file in the table is answered with its own bytes and a content type', async () => {
  for (const [path, { type }] of Object.entries(WELL_KNOWN)) {
    const file = await Deno.readFile(new URL(path.replace('/.well-known/', ''), dir));
    const res = await handle(get(path), deps());
    assertEquals(res.status, 200, path);
    assertEquals(firstDifference(new Uint8Array(await res.arrayBuffer()), file), null, path);
    assertEquals(res.headers.get('Content-Type'), type, path);
    assertEquals(res.headers.get('Cache-Control'), 'public, max-age=600', path);
    assertEquals(res.headers.get('X-Content-Type-Options'), 'nosniff', path);
  }
});

Deno.test('HEAD is answered and writes are refused', async () => {
  const head = await handle(get('/.well-known/assetlinks.json', { method: 'HEAD' }), deps());
  assertEquals(head.status, 200);
  await head.body?.cancel();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await handle(get('/.well-known/assetlinks.json', { method }), deps());
    assertEquals(res.status, 405, method);
    assertEquals(res.headers.get('Allow'), 'GET, HEAD', method);
    await res.body?.cancel();
  }
});

Deno.test('only the listed files are answered here: the route is an allowlist, not a directory', async () => {
  // A name like /constructor looks like a zone, so the zone lookup is asked and finds nothing.
  const d = deps({ fetchZone: () => Promise.resolve(null) });
  const paths = [
    '/.well-known/',
    '/.well-known',
    '/.well-known/secret',
    '/.well-known/assetlinks.json.bak',
    '/.well-known/ASSETLINKS.JSON',
    '/.WELL-KNOWN/assetlinks.json',
    '/.well-known/__proto__',
    '/.well-known/constructor',
    '/__proto__',
    '/constructor',
    '/.git/config',
    '/.env',
    '/assetlinks.json',
  ];
  for (const p of paths) {
    const res = await handle(get(p), d);
    assertEquals(await res.text(), 'static', `${p} was answered by the table`);
  }
  // Every one of them went to the static handler, which is the one that decides.
  assertEquals(d.staticHits.length, paths.length);
});

/*
  '/.well-known/assetlinks.json/' used to be in the list above, as a path the
  table refused. It is answered now, and the change is deliberate: since the
  path-smuggling fix (app.ts, canonicalPath) a trailing slash is spelling, not
  identity — the live host was serving /s.html%2f, which is /s.html/, as the
  file s.html, so a rule that read the two as different paths was guarding only
  one of them. The allowlist still admits nothing new: the only extra spelling
  that answers is the one for a file already in the table, with the same bytes.
*/
Deno.test('a trailing slash is spelling, so it answers the same listed file', async () => {
  const canonical = await handle(get('/.well-known/assetlinks.json'), deps());
  const slashed = await handle(get('/.well-known/assetlinks.json/'), deps());
  assertEquals(slashed.status, canonical.status);
  assertEquals(await slashed.text(), await canonical.text());
  // And still nothing beside it: a sibling that is not in the table is a 404.
  const d = deps({ fetchZone: () => Promise.resolve(null) });
  assertEquals(await (await handle(get('/.well-known/secret/'), d)).text(), 'static');
});

Deno.test('a dot-dot cannot step out of, or into, the table', async () => {
  const d = deps();
  // The URL parser resolves these before the router sees them.
  for (const p of ['/.well-known/../server/app.ts', '/.well-known/../.well-known/../.git/config']) {
    const res = await handle(get(p), d);
    assertEquals(await res.text(), 'static', p);
  }
  assert(d.staticHits.every((p) => !p.startsWith('/.well-known/')), d.staticHits.join(', '));
});

Deno.test('percent-encoding reaches the same file, not another one', async () => {
  const onDisk = await Deno.readFile(new URL('assetlinks.json', dir));
  for (
    const p of [
      '/.well-known/assetlinks%2Ejson',
      '/%2Ewell-known/assetlinks.json',
      '/.well-known/assetlinks.json?x=1',
      '/.well-known/assetlinks.json?',
    ]
  ) {
    const res = await handle(get(p), deps());
    assertEquals(res.status, 200, p);
    assertEquals(firstDifference(new Uint8Array(await res.arrayBuffer()), onDisk), null, p);
  }
});
