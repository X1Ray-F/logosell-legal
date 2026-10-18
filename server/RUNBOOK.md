# Suprafața web randată: ce face, cum se pune în funcțiune

Scris 2026-10-16, actualizat 2026-10-18 (modul vitrină, `/.well-known/`, lista de
gazde). Codul e în `server/`, testele trec local. Ce rulează pe
`logosell-web.x1ray-f.deno.net` este ce s-a desfășurat pe 16 oct (vezi
„Desfășurare"); **nimic din actualizarea de pe 18 oct nu e desfășurat** — pașii de
desfășurare și schimbarea de DNS sunt ai proprietarului.

## Problema, măsurată

```
$ curl -s -o /dev/null -w "%{http_code}" -A "WhatsApp/2.23.20.0" \
    https://logosell.app/listing/550e8400-e29b-41d4-a716-446655440000
404
$ curl -s -A "WhatsApp/2.23.20.0" https://logosell.app/listing/<uuid> | grep og:title
<meta property="og:title" content="Logosell — buy and sell nearby">
```

Orice anunț partajat pe WhatsApp, Facebook sau iMessage arăta identic — fără
titlu, fără preț, fără poză — și răspundea 404 către roboți, deci Google nu avea
ce indexa. `sitemap.xml` avea trei URL-uri, toate pagini legale.

**Cauza nu era cod lipsă.** `supabase/functions/listing-page` din repo-ul
aplicației randează pagina corect, dar Supabase rescrie `text/html` servit din
`functions/v1` în `text/plain` cu CSP sandbox (anti-phishing pe domeniul lor
partajat — măsurat cu o probă pe patru content-types, comentariul e în
`404.html`). Iar GitHub Pages nu poate randa nimic pe server. Ambele jumătăți
existau și nu se puteau uni.

## Ce face codul din `server/`

| cale | ce răspunde |
|---|---|
| `/listing/<uuid>` | vânzător privat: `og:title` cu titlul și prețul, `og:image` pe poza reală, `canonical`, date structurate Product/Offer. Comerciant verificat: pagină de vitrină, **fără preț nicăieri** (vezi „Modul vitrină") |
| `/seller/<uuid>` | pagina vânzătorului cu anunțurile lui; pentru un comerciant verificat, pagina de vitrină |
| `/<zonă>`, `/<zonă>/<categorie>` | pagini de zonă; rândurile unui comerciant au „Ask in store" în loc de preț |
| `/sitemap.xml` | paginile legale **plus fiecare anunț public**, cu `lastmod` |
| `/.well-known/assetlinks.json`, `/.well-known/security.txt` | răspunse de server dintr-un tabel compilat (`wellknown.ts`), înaintea fișierelor statice |
| `/s.html?t=listing\|seller&id=<uuid>` | redirecționat 302 către `/listing/<uuid>` sau `/seller/<uuid>`; `s.html` citește prețul direct din bază în browser, deci nu se mai servește pentru o cerere pe care ar fi înțeles-o |
| orice altceva | fișierele statice din acest repo, exact ca înainte, inclusiv `404.html` la 404 |

Ultima linie a tabelului (`orice altceva`) e importantă: `404.html` face
rutarea în JS pentru `/m/<token>` (link de siguranță trimis unui prieten) și
`/p/<cod>` (tipărit pe cardurile Founder care sunt deja în mâinile oamenilor).

**`/.well-known/assetlinks.json` trebuie să rămână accesibil**, altfel App Links
nu mai deschide linkurile partajate în aplicație pe Android. Biblioteca de fișiere
statice (`serveDir`) refuză orice cale cu segment-punct, deci pe serverul Deno
fișierul răspundea 404 deși pe GitHub Pages răspundea 200. Acum e răspuns de
server, dintr-un tabel de căi exacte (nu `showDotfiles: true`, care ar fi servit
și `.git/`). Tabelul `server/wellknown.ts` e **generat**: după orice schimbare în
`.well-known/` rulezi `deno task wellknown`; `wellknown_test.ts` pică dacă
tabelul și fișierele nu mai coincid octet cu octet.

### Lista de gazde (`ALLOWED_HOSTS`)

`canonical`, `og:url`, linkurile și sitemap-ul poartă numele gazdei cererii, dar
doar pentru gazde cunoscute (un antet `Host` falsificat nu are voie să-și planteze
domeniul). Lista avea `deno.dev` (vechiul Deploy Classic), nu `deno.net`, deci pe
adresa reală de producție totul cădea înapoi pe `https://logosell.app` — care era
încă GitHub Pages și dădea 404 pe `/hounslow`. Acum conține `x1ray-f.deno.net`, iar
`app_test.ts` **citește gazda de producție din acest fișier** (rândul „producție"
din blocul de la «Desfășurare», cel cu organizația și aplicația) și pică dacă lista
nu o mai acoperă; nu pune gazda în test de mână, ar putea să rămână în urmă față de
runbook. Același test pică, tare, dacă rândul acela dispare sau e rescris în alt fel.

### Ce s-a reparat pe drum

- **Un anunț vândut sau ascuns de moderare nu mai are pagină publică.** Randorul
  vechi selecta `circle_id` dar nu `status` și nu `hidden`, deci randa cu og tags
  corecte un obiect vândut sau luat jos de un moderator.
- **Textul nu mai minte.** Spunea „Get an invite to Logosell" și „invite-only",
  dar înregistrarea e deschisă, iar `/join` redirecționează către pagina
  „coming soon". Acum spune ce e și unde începe.
- **Poza trece printr-un filtru**: doar `https://…`, altfel se folosește imaginea
  site-ului. Un `javascript:` strecurat în `images[]` ar fi ajuns în `og:image`
  și în `<img src>`.
- **Pagina „indisponibil" nu spune de ce.** „Nu există" și „e într-un cerc
  privat" arată identic, altfel pagina devine un oracol pentru existența
  anunțurilor private.

## Modul vitrină (comercianți verificați)

Un vânzător cu `markety.trader_accounts.status = 'verified'` are pagini **fără niciun
preț**: nici în `<title>`, `<h1>`, `og:title`, `product:price:*`, nici în date
structurate, nici într-un rând de listă. În loc: „Ask in store". Motivul îl dă
proprietarul: o pagină fără preț probabil nu e o „invitație la cumpărare" (DMCC Act
2024 s.230(10), CMA207 4.11), una cu preț probabil e. **Premisa juridică nu e
verificată de nimeni aici** — codul face ce s-a cerut, iar absența prețului e
tratată ca obligație (testele scanează fiecare pagină de vitrină).

**Cine e comerciant** se decide din `trader_accounts`, citit ca **listă** de
`profile_id` verificate (`select=profile_id&status=eq.verified`, paginat cu cursor,
cheia anon, aceeași ca la restul citirilor), nu cu `shop_front(id)` pe fiecare
vânzător: o pagină de zonă are mulți vânzători, deci o singură citire cache-uită bate
un apel pe vânzător. Anon vede doar rândurile verificate și doar coloanele publice,
fără adresă (migrațiile 0143 și 0149), deci lista nu adaugă acces. `shop_front` se
folosește doar pentru antet (nume, program, număr de piese): dacă pică, antetul e mai
scurt, regula nu se schimbă.

| situație | răspuns |
|---|---|
| vânzătorul e în listă | pagină de vitrină, `cache-control: public, max-age=60` |
| vânzătorul nu e în listă | pagina de vânzător privat, ca înainte, `max-age=300` |
| lista nu se poate citi și nu există copie recentă | **404 `no-store`** (pagina „indisponibil") pentru orice pagină care ar fi tipărit un preț |
| anunț fără `seller_id` | 404, nu pagină cu preț |
| pagină de zonă fără anunțuri, lista necitibilă | se randează (nu tipărește niciun preț) |
| pagină de zonă cu anunțuri, lista necitibilă | 404 |

Niciodată o pagină cu preț pentru un vânzător a cărui stare nu se știe. Lista e
proaspătă 60 s; dacă o reîmprospătare eșuează, copia veche ține până la 15 minute,
apoi paginile cu preț dau 404 (mai bine 404 decât o copie tot mai veche). În log
apare, cel mult o dată pe minut, `verified-trader list unreadable and no recent copy`
— dacă îl vezi, nu e „site-ul pică", e lista (vezi verificarea de mai jos).

**Ce arată pagina de vitrină:** numele magazinului, „Open now"/„Closed now" cu
programul de azi (doar dacă magazinul și-a setat programul; altfel nimic, fiindcă
`open_now` e fals și pentru un magazin care nu l-a completat), numărul de piese,
„Sold in store only. Logosell does not take payment." **Nu arată:** adresa
(anon n-o poate citi), rating, „N sold".

**Textul scris de magazin** (titlu, descriere, oraș, nume) trece prin
`withoutPrices`: scoate un semn de monedă urmat de sumă, o sumă urmată de
GBP/pounds/quid, entități HTML (`&pound;`, și dublu-codate), variantele fullwidth și
cu caractere de lățime zero. E o **plasă, nu un zid**: nu prinde „twenty pounds", un
„1 2 0" deghizat, un număr gol („Table 4871"), nici un preț din poză; textul peste
4000 de caractere e tăiat. De aceea aplicația ar trebui să valideze prețul și la
publicarea de către un comerciant (în afara acestui repo).

**Cu `s.html` nu se joacă:** pagina aceea randează în browser și citește prețul
direct din bază, fără să știe de comercianți. `404.html` trimite către ea orice cale
`/listing/<uuid>…` sau `/seller/<uuid>…` care a ajuns la 404 (de pildă
`/listing/<uuid>/ceva`). Serverul nu o mai servește pentru o cerere pe care ar fi
înțeles-o: răspunde 302 către `/listing/<uuid>` sau `/seller/<uuid>`, unde se aplică
modul vitrină. O cerere pe care `s.html` n-ar fi putut-o interpreta cade pe fișier,
care arată „not available" fără să citească nimic. `shop_test.ts` fixează cele două
expresii din `s.html` pe care se sprijină redirectul: dacă schimbi `s.html`, testul
pică și îți spune de ce. Nu modifica `s.html`, `404.html` sau `.well-known/` fără să
rulezi testele.

### Ordinea la un comerciant nou

1. Rândul din `trader_accounts` cu `status = 'verified'`.
2. Deschizi `/seller/<uuid>`: trebuie să fie pagină de vitrină (fără preț).
3. **Abia apoi** publici stocul.

După pasul 1 așteaptă **aproximativ 6 minute** înainte de pasul 3: lista are 60 s,
pagina de vitrină 60 s, iar o pagină privată deja cache-uită de un browser sau de un
proxy mai ține până la 300 s. Un comerciant cu status `pending`, `rejected` sau
`withdrawn` este tratat ca **vânzător privat** (are preț) — așa cere specificația;
merită decis cu avocatul dacă un comerciant în curs de verificare are voie să apară
cu preț.

## Desfășurare

Pasul 1 e **făcut** (16 oct, de mine, cu tokenul pus de proprietar într-o
fereastră). Pasul cu DNS-ul rămâne al lui. Textul de mai jos e ce a funcționat,
nu ce ar trebui să funcționeze.

1. **Deno Deploy — FĂCUT pe 2026-10-16.**

   ```
   organizație : x1ray-f
   aplicație   : logosell-web
   regiune     : eu
   producție   : https://logosell-web.x1ray-f.deno.net
   consolă     : https://console.deno.com/x1ray-f/logosell-web
   ```

   **Capcana 1: `deployctl` nu mai merge.** Țintește Deno Deploy *Classic*, care
   respinge un token din dashboard-ul nou cu
   `APIError: The authorization token is not valid: The bearer token is invalid`.
   Tokenul era bun; unealta era greșită. Platforma nouă se folosește prin
   subcomanda din CLI-ul Deno: `deno deploy` (0.0.9908 în Deno 2.9.7). Vechiul
   API `api.deno.com/v1` dă 401 pentru tokenul nou — tot aceeași despărțire.

   **Capcana 2: detectarea automată alege `static`.** Rădăcina repo-ului e plină
   de `.html`, deci `deno deploy create` detectează un site static
   (`"mode":"static","staticDir":"."`) și **nu rulează niciodată `server/main.ts`**
   — adică exact bug-ul pentru care există randorul. `--runtime-mode dynamic`
   singur NU e de ajuns: configurația detectată câștigă. Trebuie
   **`--do-not-use-detected-build-config`**. Verifică cu `--dry-run`: trebuie să
   vezi `"mode":"dynamic","entrypoint":"server/main.ts"`.

   Comanda care a funcționat, din `~/logosell/logosell-legal`:

   ```bash
   export DENO_DEPLOY_TOKEN=$(cat ~/.config/deno-deploy-token)   # mod 600
   deno deploy --json --non-interactive --org x1ray-f --app logosell-web --prod \
     --ignore '.git' --ignore 'server/*_test.ts'
   ```

   Variabilele de mediu sunt setate pe aplicație, nu la fiecare desfășurare:

   ```bash
   deno deploy env add SUPABASE_URL "$EXPO_PUBLIC_SUPABASE_URL" --org x1ray-f --app logosell-web
   deno deploy env add SUPABASE_ANON_KEY "$EXPO_PUBLIC_SUPABASE_ANON_KEY" --secret --org x1ray-f --app logosell-web
   ```

   Tokenul **nu** se pune pe linia de comandă într-o sesiune Claude — ajunge în
   contextul lui. Stă în `~/.config/deno-deploy-token` (mod 600); scriptul
   `scratchpad/deno-deploy.sh` îl cere printr-o fereastră zenity dacă lipsește,
   fiindcă prin `!` nu există TTY.

2. **Verificat pe 2026-10-16** pe URL-ul de producție, cu User-Agent de Googlebot:

   | cerere | rezultat |
   |---|---|
   | `/privacy.html` | 200 — fișierul static, neschimbat |
   | `/sitemap.xml` | 200 `application/xml`, 4 URL-uri |
   | `/hounslow`, `/camden` | 200, titluri randate din baza **live** |
   | anunț inexistent | 404 |
   | cale care nu e zonă | 404 prin `404.html` |

   Antete pe o pagină randată: `content-security-policy` cu hash-ul de stil,
   `referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
   `cache-control: public, max-age=300`.

3. **Ce NU arată încă, și nu e vina codului:** live are zero anunțuri vizibile
   public (2 active, ambele ascunse, niciunul cu coordonate), deci sitemap-ul are
   doar cele 4 URL-uri statice și fiecare pagină de zonă e corect `noindex`.
   Câștigul SEO începe de la primul anunț public.

4. **Înainte de DNS (după ce desfășori versiunea de pe 18 oct)** — în ordinea asta,
   toate pe URL-ul `.deno.net`, nu pe `logosell.app`:

   ```bash
   H=https://logosell-web.x1ray-f.deno.net
   curl -sI "$H/.well-known/assetlinks.json" | head -3    # trebuie 200, application/json
   curl -s  "$H/sitemap.xml" | grep -c "$H"               # trebuie > 0: gazda de producție se numește singură
   ```

   `assetlinks.json` cu 404 pe noua gazdă, după tăiere, strică App Links pe Android
   fără nicio eroare vizibilă. Verifică și că lista comercianților se poate citi cu
   cheia anon (cheia o ai deja în mediu; nu o tipări):

   ```bash
   curl -s -H "apikey: $EXPO_PUBLIC_SUPABASE_ANON_KEY" \
        -H "Authorization: Bearer $EXPO_PUBLIC_SUPABASE_ANON_KEY" \
        -H "Accept-Profile: markety" \
        "$EXPO_PUBLIC_SUPABASE_URL/rest/v1/trader_accounts?select=profile_id&status=eq.verified&limit=5"
   ```

   Trebuie `[]` sau o listă de `{"profile_id": …}`. Un obiect de eroare (migrația
   0143 neaplicată pe live, tabel necitibil pentru anon) înseamnă că **orice pagină
   care ar tipări un preț dă 404** — corect ca siguranță, dar site-ul ar arăta gol.
   Codul nu poate verifica asta singur: testele rulează fără rețea.

5. **DNS la Namecheap — RĂMAS DE FĂCUT.** Acum: `logosell.app` A → `185.199.108–111.153`
   (GitHub Pages), `www` CNAME → `x1ray-f.github.io`. Le înlocuiești cu ce indică
   Deno Deploy pentru domeniu propriu. Pages poate rămâne pornit — nu mai primește
   trafic.
6. **După tăiere:** retrimite `sitemap.xml` în Google Search Console și verifică
   un anunț în Facebook Sharing Debugger (`developers.facebook.com/tools/debug/`),
   care forțează recitirea og tags.

**Întoarcere:** pui înapoi la Namecheap cele patru A-uri către GitHub Pages.
Nimic din acest repo nu se schimbă, deci revenirea e doar DNS.

**Nu verifica niciun comerciant cât timp `logosell.app` e încă pe GitHub Pages.**
Pages servește `s.html` vechi, care citește prețul direct din bază și nu știe de
comercianți: un comerciant verificat înainte de tăiere ar avea preț pe
`logosell.app/s.html?t=listing&id=…`, oricât de curată ar fi pagina de pe `.deno.net`.
Tot așa, după o întoarcere la GitHub Pages modul vitrină nu mai există.

Fișierele adăugate de modul vitrină și de `.well-known/` care nu sunt necesare la
rulare: `fixtures.ts`, `golden_cases.ts`, `golden_update.ts`, `wellknown_update.ts`,
directorul `golden/` (testele `*_test.ts` sunt deja excluse cu `--ignore`).
Sunt inerte; dacă vrei să nu urce, adaugă `--ignore` pentru ele — **netestat**, nu
l-am rulat (nu desfășor nimic de aici).

### Costul

Planul gratuit Deno Deploy e dat de surse terțe ca ~1M cereri/lună, 20 GiB
trafic și 5 domenii proprii, cu o reducere raportată (neconfirmată) în august
2026. **Verifică `deno.com/deploy/pricing`** — n-am putut deschide pagina
oficială. La traficul de azi orice plan gratuit e cu mult peste nevoie.

Alternativa, dacă vrei o singură poveste de hosting cu Casepack: Fly.io Londra,
~£4/lună, aceeași structură de cod (e doar un `fetch` handler).

## Local

```bash
deno task test      # 113 de teste, fără rețea (și fără --allow-net: nu pot atinge o bază de date)
deno task dev       # necesită SUPABASE_URL și SUPABASE_ANON_KEY în mediu
deno task golden    # rescrie server/golden/ din randor; diff-ul fișierelor e review-ul
deno task wellknown # rescrie server/wellknown.ts din .well-known/
```

`deno task test` a fost stricat din commitul în care a apărut (`6132c92`): task-ul vechi trecea
`--allow-none`, un steag care nu există, și Deno răspundea `unexpected argument
'--allow-none' found` fără să ruleze niciun test. Acum rulează cu `--no-prompt` și
cu citire doar din `.well-known`, `server` și `s.html`.

**Paginile de referință (`server/golden/`).** Zece fișiere fără prefix sunt pagina
unui vânzător privat exact așa cum o randa codul **înainte** de modul vitrină;
`golden_test.ts` pică dacă un singur octet din ele se schimbă, atât în randor cât și
prin router. Cele cu prefixul `shop-` sunt instantanee ale paginilor de vitrină.
Dacă o pagină privată trebuie într-adevăr să se schimbe: `deno task golden`, citești
diff-ul și îl pui în același commit cu schimbarea. O schimbare în modul vitrină nu
are voie să atingă un fișier fără prefix.
`deno fmt` nu atinge directorul (`fmt.exclude` în `deno.json`): fișierele sunt octeți
exacți, iar un formatator le-ar rescrie și testul ar pica.

## Ce NU e aici

- **Validarea prețului la publicare, în aplicație.** Modul vitrină scoate prețul din
  *pagini*, nu din baza de date: un comerciant care tastează „£120" în titlu are
  prețul șters din pagina publică (plasa `withoutPrices`, cu limitele de mai sus),
  dar el rămâne în bază și în aplicație. Un câmp de preț obligatoriu și o regulă
  „fără sume în titlu/descriere" la publicarea de către un comerciant ar închide
  problema la sursă.
- **Textul paginilor de zonă.** „N items for sale in …" și „Buy and sell in …" nu s-au
  schimbat și apar acum și pe pagini care conțin rânduri de vitrină („Ask in store").
  Dacă „for sale" contează juridic, e de revizuit odată cu premisa din „Modul vitrină".
- **Un timeout pe citirile din bază.** `rest()` din `data.ts` nu are timeout (la fel
  ca înainte de modul vitrină): o bază care nu răspunde ține cererea, iar citirea
  listei comercianților e partajată între cereri.
- **Formular de listă de așteptare** pe pagina partajată. `join_waitlist(email,
  city, referred_by)` există deja în bază, și pagina asta e singurul loc unde
  ajunge un străin — dar un formular public care colectează e-mailuri e PII, cere
  captcha și o mențiune în privacy. Decizie separată.
- `supabase/functions/listing-page` rămâne desfășurată și neatinsă. După tăierea
  DNS nu mai e folosită de nimeni; dacă o ștergi, șterge și redirectarea către
  `/s.html` din `404.html`.

  **Și scoate-o din `PUBLIC_PAGES`** în `scripts/verify-edge-auth.py:79` (repo-ul
  aplicației), unde stă alături de `passport-page`. Verificatorul cere ca funcția
  să răspundă unui străin fără credențiale; dacă funcția nu mai există, pasul
  `! listing-page: reachable` devine **roșu permanent** în jobul `live backend`,
  iar cine îl vede o va citi, pe bună dreptate, ca intermitența cunoscută a
  aceluiași pas (două rulări concurente care sondează funcții care pornesc la
  rece — dovedit pe `59c14e1`: push verde, pull_request roșu, la trei secunde
  distanță, același commit). Scoaterea din `PUBLIC_PAGES` trebuie să fie în
  aceeași schimbare care retrage funcția, nu după.
