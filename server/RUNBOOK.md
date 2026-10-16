# Suprafața web randată: ce face, cum se pune în funcțiune

Scris 2026-10-16. Codul e în `server/`, testele trec local, **nimic nu e
desfășurat** — pașii de desfășurare de mai jos sunt ai proprietarului, pentru că
cer un cont nou și o schimbare de DNS.

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
| `/listing/<uuid>` | pagina anunțului: `og:title` cu titlul și prețul, `og:image` pe poza reală, `canonical`, date structurate Product/Offer |
| `/seller/<uuid>` | pagina vânzătorului cu anunțurile lui |
| `/sitemap.xml` | paginile legale **plus fiecare anunț public**, cu `lastmod` |
| orice altceva | fișierele statice din acest repo, exact ca înainte, inclusiv `404.html` la 404 |

Ultima linie e importantă: `404.html` face rutarea în JS pentru `/m/<token>`
(link de siguranță trimis unui prieten) și `/p/<cod>` (tipărit pe cardurile
Founder care sunt deja în mâinile oamenilor), iar
`/.well-known/assetlinks.json` trebuie să rămână accesibil sau App Links nu mai
deschide linkurile partajate în aplicație pe Android.

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

## Desfășurare

Nimic din ce urmează nu l-am rulat eu.

1. **Deno Deploy** — cont, apoi un proiect legat de repo-ul `X1Ray-F/logosell-legal`,
   ramura pe care o alegi, entry point `server/main.ts`.
2. **Variabile de mediu** în proiect: `SUPABASE_URL` și `SUPABASE_ANON_KEY` —
   aceleași valori `EXPO_PUBLIC_*` din `marketplace.env` din seif. Cheia anon e
   publică prin natura ei (o conține și APK-ul), deci nu adaugă nicio expunere.
   Fără ele, site-ul static servește normal, iar paginile de anunț răspund
   „indisponibil" — direcția sigură.
3. **Verifică pe subdomeniul `*.deno.dev`** înainte de DNS:
   `curl -A "WhatsApp/2.23.20.0" https://<proiect>.deno.dev/listing/<uuid real>`
4. **DNS la Namecheap.** Acum: `logosell.app` A → `185.199.108–111.153`
   (GitHub Pages), `www` CNAME → `x1ray-f.github.io`. Le înlocuiești cu ce indică
   Deno Deploy pentru domeniu propriu. Pages poate rămâne pornit — nu mai primește
   trafic.
5. **După tăiere:** retrimite `sitemap.xml` în Google Search Console și verifică
   un anunț în Facebook Sharing Debugger (`developers.facebook.com/tools/debug/`),
   care forțează recitirea og tags.

**Întoarcere:** pui înapoi la Namecheap cele patru A-uri către GitHub Pages.
Nimic din acest repo nu se schimbă, deci revenirea e doar DNS.

### Costul

Planul gratuit Deno Deploy e dat de surse terțe ca ~1M cereri/lună, 20 GiB
trafic și 5 domenii proprii, cu o reducere raportată (neconfirmată) în august
2026. **Verifică `deno.com/deploy/pricing`** — n-am putut deschide pagina
oficială. La traficul de azi orice plan gratuit e cu mult peste nevoie.

Alternativa, dacă vrei o singură poveste de hosting cu Casepack: Fly.io Londra,
~£4/lună, aceeași structură de cod (e doar un `fetch` handler).

## Local

```bash
deno task test    # 27 de teste, fără rețea
deno task dev     # necesită SUPABASE_URL și SUPABASE_ANON_KEY în mediu
```

## Ce NU e aici

- **Paginile de zonă** (`/<zona>/<categoria>`) din
  `logosell-app/docs/FEED-PE-APROPIERE-2026-10-16.md`: cer `zone_label` pe anunț,
  care încă nu există. Sitemap-ul și randorul sunt construite ca să le primească.
- **Formular de listă de așteptare** pe pagina partajată. `join_waitlist(email,
  city, referred_by)` există deja în bază, și pagina asta e singurul loc unde
  ajunge un străin — dar un formular public care colectează e-mailuri e PII, cere
  captcha și o mențiune în privacy. Decizie separată.
- `supabase/functions/listing-page` rămâne desfășurată și neatinsă. După tăierea
  DNS nu mai e folosită de nimeni; dacă o ștergi, șterge și redirectarea către
  `/s.html` din `404.html`.
