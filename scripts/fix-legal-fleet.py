#!/usr/bin/env python3
"""v39: privacy policy + terms for Kørselstid for vognmænd.

Run from ~/taxa-app       → updates lib/legal-text.ts
Run from the website repo → updates privatlivspolitik/ and vilkaar/
(the same script, it detects where it is). Idempotent; writes nothing if a
pattern is missing.
"""
import sys, pathlib

NEW_DATE = '3. oktober 2026'

VOGN_1 = ('Vognmænd: Hvis du er vognmand og forbinder jeres GPS-konto i appen, gemmer vi firmanavn, '
          'CVR-nummer og API-nøglen til GPS-kontoen. Nøglen gemmes krypteret og kan ikke ses i appen bagefter. '
          'Vi gemmer også bilerne på kontoen og de nummerplader, du giver dem.')
VOGN_2 = ('Når en fører indløser en bilkode fra vognmanden, gemmer vi, hvilke biler føreren har adgang til, og '
          'hvem der gav adgangen. Vognmanden kan se Kørselstid-rapporterne for vagter, der køres i hans biler: '
          'førerens navn, tidspunkter, stop, pauser og adresser. Vognmanden kan ikke se førerens vagtregnskab. '
          'Føreren får det at vide, før koden indløses.')
SEC_OLD = 'Adgangsnøglen til GPS-udbyderen ligger kun på serveren, aldrig i appen.'
SEC_NEW = 'API-nøgler til GPS-udbydere gemmes krypteret på serveren (Supabase Vault) og sendes aldrig til appen.'
RET = [('GPS-forbindelse og API-nøgle', 'Indtil vognmanden fjerner forbindelsen eller sletter sin konto'),
       ('Førernes adgang til biler', 'Indtil vognmanden fjerner adgangen eller forbindelsen')]
TERMS_OLD = ('Når du bruger Kørselstid, bekræfter du, at du har lov til at bruge GPS-data fra bilen, og at du '
             'overholder aftalen med vognmanden og med GPS-udbyderen. EgyDan ApS er ikke part i din aftale med '
             'GPS-udbyderen.')
TERMS_ADD = ('Forbinder du som vognmand en GPS-konto, bekræfter du, at du har ret til at give TaxaBog adgang til '
             'kontoen, at du kun giver førere adgang til biler, de kører i for dig, og at dine førere er '
             'informeret om, at du kan se Kørselstid-rapporterne for vagter i dine biler.')
GPS_END = 'Dine egne svar (pause, venter på arbejde, slut vagt) gemmes sammen med vagten.'

jobs = []  # (path, [(old, new, label)])

if pathlib.Path('lib/legal-text.ts').exists():
    jobs.append(('lib/legal-text.ts', [
        (GPS_END + '\\n\\n2.4 Deling', GPS_END + '\\n\\n' + VOGN_1 + '\\n\\n' + VOGN_2 + '\\n\\n2.4 Deling', 'vognmand data'),
        (SEC_OLD, SEC_NEW, 'vault'),
        ('• Delinger: Indtil de udløber eller tilbagekaldes',
         '• Delinger: Indtil de udløber eller tilbagekaldes\\n' + '\\n'.join(f'• {a}: {b}' for a, b in RET).replace('\n', '\\n'),
         'retention'),
        (TERMS_OLD, TERMS_OLD + '\\n\\n' + TERMS_ADD, 'terms vognmand'),
    ]))
    date_job = ('lib/legal-text.ts', "export const LAST_UPDATED = '", "';")
elif pathlib.Path('privatlivspolitik/index.html').exists():
    rows = ''.join(f'<tr>\n<td>{a}</td>\n<td>{b}</td>\n</tr>\n' for a, b in RET)
    jobs.append(('privatlivspolitik/index.html', [
        (GPS_END + '</p>\n<h3>2.4 Deling</h3>',
         GPS_END + f'</p>\n<p>{VOGN_1}</p>\n<p>{VOGN_2}</p>\n<h3>2.4 Deling</h3>', 'vognmand data'),
        (SEC_OLD, SEC_NEW, 'vault'),
        ('<td>Indtil de udløber eller tilbagekaldes</td>\n</tr>\n',
         '<td>Indtil de udløber eller tilbagekaldes</td>\n</tr>\n' + rows, 'retention'),
    ]))
    jobs.append(('vilkaar/index.html', [
        (TERMS_OLD + '</p>', TERMS_OLD + f'</p>\n<p>{TERMS_ADD}</p>', 'terms vognmand'),
    ]))
    date_job = None
else:
    sys.exit('ABORT: run from ~/taxa-app or from the website repo')

out = {}
for path, edits in jobs:
    s = pathlib.Path(path).read_text()
    for old, new, label in edits:
        if new in s:
            print(f'  already done: {path}: {label}')
            continue
        n = s.count(old)
        if n != 1:
            sys.exit(f'ABORT: {path}: pattern for "{label}" found {n} times - nothing written')
        s = s.replace(old, new)
        print(f'  patched: {path}: {label}')
    out[path] = s

# dates
import re
if date_job:
    p, pre, post = date_job
    out[p] = re.sub(re.escape(pre) + r"[^']*" + re.escape(post), pre + NEW_DATE + post, out[p], count=1)
else:
    for p in ['privatlivspolitik/index.html', 'vilkaar/index.html']:
        out[p] = re.sub(r'(<strong>Senest opdateret:</strong> )[^<]*', r'\g<1>' + NEW_DATE, out[p], count=1)

for p, s in out.items():
    if pathlib.Path(p).read_text() != s:
        pathlib.Path(p).write_text(s)
        print(f'  wrote {p}')
print('done')
