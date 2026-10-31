#!/usr/bin/env bash
# Cele patru ortografii care scurgeau sursa de pe host, plus redirectarea care
# ascunde preturile. Se ruleaza DUPA `deno deploy`. Asteptat: 404 404 404 302 404.
#
# Ele au fost masurate pe viu pe 2026-10-17: /server%2fapp.ts si /%73erver/app.ts
# intorceau 7192 de octeti de TypeScript, /s.html%2f?t=... ocolea redirectarea
# care scoate preturile, iar /%zz arunca inauntrul lui decodeURIComponent.
# Reparatia e canonicalPath() din server/app.ts; asta e proba ei pe host.
set -u
HOST="${1:-https://logosell-web.x1ray-f.deno.net}"
fail=0
check() { # cale, cod-asteptat, ce-dovedeste
  got=$(curl -s -o /dev/null -w '%{http_code}' "$HOST$1")
  if [ "$got" = "$2" ]; then printf 'ok    %-28s %s  %s\n' "$1" "$got" "$3"
  else printf 'EROARE %-27s %s (asteptat %s)  %s\n' "$1" "$got" "$2" "$3"; fail=1; fi
}
echo "host: $HOST"
check '/server/app.ts'        404 'sursa, ortografia simpla'
check '/server%2fapp.ts'      404 'bara procentata'
check '/%73erver/app.ts'      404 's-ul procentat'
# Redirectarea de la /s.html porneste numai cand cererea e una pe care s.html ar fi
# INTELES-O: si t=listing|seller, si un id de 36 de caractere (server/app.ts:223-235).
# Prima versiune a acestui script cerea 302 pentru `?t=x` si raporta o gaura care nu
# exista: fara id, nici ortografia canonica nu redirecteaza. Un test care cade pe un
# caz pe care codul nu l-a promis niciodata nu dovedeste nimic.
U=11111111-2222-3333-4444-555555555555
check "/s.html?t=listing&id=$U"   302 'ortografia canonica redirecteaza spre pagina randata'
check "/s.html%2f?t=listing&id=$U" 302 'si bara procentata, deci nu ocoleste ascunderea preturilor'
check "/s.html%2f?t=x"            200 'o cerere neparsabila cade pe fisier, la fel ca cea canonica'
check '/%zz'                  404 'procentaj invalid, nu arunca'
check '/.well-known/assetlinks.json' 200 'App Links raspunde (fara el, linkurile deschid browserul)'
exit $fail
