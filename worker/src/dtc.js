/* Fehlercodes (OBD-II, SAE J2012 / ISO 15031-6) – feste Bedeutung, damit ALEX sie nicht rät.
 * Nur generische Codes (P0xxx, P2xxx, U0xxx). P1xxx/P3xxx und die meisten B/C-Codes sind herstellerspezifisch:
 * dafür gibt es hier bewusst keine Bedeutung – ALEX verweist dann auf den Diagnosetester/Herstellerdaten.
 * Je Code: Bedeutung + Gruppe (für typische Prüfschritte). */

const G = {
  ladedruck: 'Ladedruck: Soll-/Ist-Ladedruck in den Livedaten unter Last vergleichen; Ladeluftstrecke abdrücken (Schläuche, Schellen, Ladeluftkühler); Unterdruckleitungen und Ladedrucksteller bzw. VTG-Verstellung/Wastegate auf Gängigkeit; Ladedrucksensor auf Plausibilität (Zündung an, Motor aus ≈ Umgebungsdruck); Turbolader auf Spiel und Ölverlust; Luftfilter, Luftmassenmesser und AGR-Ventil (klemmt offen) prüfen.',
  zuendaussetzer: 'Zündaussetzer: betroffenen Zylinder bestimmen (Aussetzerzähler in den Livedaten); Zündspule/Zündkerze mit Nachbarzylinder quertauschen und prüfen, ob der Fehler mitwandert; Injektor, Kompression bzw. Druckverlust und Falschluft prüfen. Blinkende Motorkontrollleuchte = starke Aussetzer, Gefahr für den Katalysator – Fahrzeug nicht unter Last weiterfahren.',
  gemisch: 'Gemisch: Kraftstofftrimm (kurz-/langfristig) im Leerlauf und bei 2.500/min vergleichen; Falschluft (Unterdruckschläuche, Kurbelgehäuseentlüftung, Saugrohrdichtung), Luftmassenmesser, Kraftstoffdruck, Injektoren und Lambdasonde vor Kat prüfen; Abgasleck vor der Sonde ausschließen.',
  lambda: 'Lambdasonde: Stecker/Leitungen, Heizungswiderstand und Versorgung prüfen; Sondensignal in den Livedaten (Sprungsonde pendelt, Breitbandsonde ≈ Lambda 1,0); Abgasleck vor der Sonde ausschließen; erst dann Sonde tauschen.',
  kat: 'Katalysator: Signale der Sonden vor und nach Kat vergleichen (nach Kat ruhiges Signal = Kat arbeitet); Abgasleck vor/hinter Kat, defekte Sonde und Zündaussetzer als Ursache ausschließen; Kat nur bei bestätigtem Defekt tauschen.',
  sensor: 'Sensor/Stromkreis: Stecker, Pins und Leitungen prüfen (Sichtprüfung, Kontaktwiderstand, Spannungsabfall); Versorgung, Masse und Signal am Sensor messen; Sensorwert in den Livedaten auf Plausibilität prüfen; erst dann Sensor tauschen.',
  steuerzeit: 'Steuerzeiten/Nockenwelle: Ölstand und richtige Ölspezifikation prüfen (Versteller arbeiten mit Öldruck); Magnetventil der Nockenwellenverstellung (Widerstand, Sieb, Ansteuerung) prüfen; Kurbel-/Nockenwellen-Korrelation in den Livedaten; bei Abweichung Steuerkette/-riemen (Längung, Spanner, Übersprung) prüfen.',
  agr: 'AGR: AGR-Ventil auf Verkokung und Gängigkeit prüfen (Stellgliedtest); AGR-Kühler, Leitungen und Unterdrucksteuerung prüfen; Luftmassenmesser-Werte mit offenem/geschlossenem AGR vergleichen.',
  evap: 'Tankentlüftung: Tankdeckel und Dichtung prüfen; Leitungen, Aktivkohlefilter und Spülventil (Ansteuerung, Dichtheit) prüfen; Rauchtest der Tankentlüftung.',
  einspritzung: 'Einspritzung/Kraftstoffdruck: Soll-/Ist-Raildruck in den Livedaten; Vorförderdruck und Kraftstofffilter; Mengenregel-/Druckregelventil und Hochdruckpumpe; Rücklaufmengen der Injektoren (Diesel); Leitungen auf Undichtigkeit.',
  dpf: 'Partikelfilter: Differenzdrucksensor und Schläuche prüfen (Zündung an ≈ 0 mbar); Beladung/Asche in den Livedaten; Fahrprofil (Kurzstrecke) erfragen; Ursache für hohe Rußbildung (AGR, Injektoren, Ladedruck) vor einer Regeneration klären; Regeneration nur nach Herstellervorgabe.',
  scr: 'SCR/AdBlue: Füllstand und AdBlue-Qualität (Harnstoffgehalt ca. 32,5 %) prüfen; Kristallbildung am Dosierventil; Pumpe, Heizung und Leitungen; NOx-Sensoren vor/nach SCR-Kat vergleichen.',
  getriebe: 'Getriebe: Fehlerspeicher des Getriebesteuergeräts auslesen; Ölstand und Ölzustand nach Herstellervorgabe prüfen; Drehzahlsignale und Magnetventile in den Livedaten prüfen; Steckverbindung am Getriebe (Mechatronik) auf Öl/Korrosion prüfen.',
  kuehlung: 'Kühlung: Kühlmittelstand und Thermostat (Öffnungsverhalten), Kühlmitteltemperatursensor (Plausibilität kalt ≈ Umgebungstemperatur), Kühlerlüfter und Wasserpumpe prüfen.',
  spannung: 'Bordnetz: Batterie (Ruhespannung, Belastungstest), Ladespannung der Lichtmaschine (ca. 13,5–14,8 V je nach Ladestrategie), Masseverbindungen und Spannungsabfall prüfen.',
  steuergeraet: 'Steuergerät: Versorgung und Masse des Steuergeräts prüfen, Softwarestand/Updates nach Herstellerinfo; Steuergerät erst nach Ausschluss von Bordnetzfehlern tauschen (Tausch meist mit Codierung/Anlernen).',
  bus: 'Kommunikation (CAN): Steuergerät erreichbar? Versorgung/Masse des betroffenen Steuergeräts, CAN-High/Low (Widerstand ≈ 60 Ω zwischen High und Low bei ausgeschalteter Zündung), Stecker und Feuchtigkeit prüfen; Unterspannung als Ursache ausschließen.',
  leerlauf: 'Leerlauf: Drosselklappe reinigen und ggf. anlernen; Falschluft; Leerlaufregelung in den Livedaten; Kurbelgehäuseentlüftung prüfen.',
  gluehen: 'Vorglühen: Glühkerzen einzeln auf Widerstand/Stromaufnahme prüfen; Glühzeitsteuergerät, Versorgung und Leitungen prüfen.',
};

const C = {};
const add = (code, text, group) => { C[code] = { text, group }; };
const range = (from, to, fn) => { for (let i = from; i <= to; i++) fn(i); };
const p = n => 'P' + String(n).padStart(4, '0');

add('P0010', 'Nockenwellenversteller A (Einlass/links/vorne) Bank 1 – Stromkreis', 'steuerzeit');
add('P0011', 'Nockenwellenposition A (Einlass) Bank 1 – Zeitpunkt zu früh / Systemleistung', 'steuerzeit');
add('P0012', 'Nockenwellenposition A (Einlass) Bank 1 – Zeitpunkt zu spät', 'steuerzeit');
add('P0013', 'Nockenwellenversteller B (Auslass) Bank 1 – Stromkreis', 'steuerzeit');
add('P0014', 'Nockenwellenposition B (Auslass) Bank 1 – Zeitpunkt zu früh / Systemleistung', 'steuerzeit');
add('P0015', 'Nockenwellenposition B (Auslass) Bank 1 – Zeitpunkt zu spät', 'steuerzeit');
add('P0016', 'Kurbelwellen-/Nockenwellenposition – Korrelation Bank 1 Sensor A', 'steuerzeit');
add('P0017', 'Kurbelwellen-/Nockenwellenposition – Korrelation Bank 1 Sensor B', 'steuerzeit');
add('P0018', 'Kurbelwellen-/Nockenwellenposition – Korrelation Bank 2 Sensor A', 'steuerzeit');
add('P0019', 'Kurbelwellen-/Nockenwellenposition – Korrelation Bank 2 Sensor B', 'steuerzeit');
add('P0030', 'Lambdasonde Heizung Steuerkreis Bank 1 Sensor 1', 'lambda');
add('P0036', 'Lambdasonde Heizung Steuerkreis Bank 1 Sensor 2', 'lambda');
add('P0045', 'Turbolader/Kompressor Ladedruckregelung Magnetventil A – Stromkreis offen', 'ladedruck');
add('P0068', 'Saugrohrdruck/Luftmasse – Drosselklappenposition Korrelation', 'sensor');
add('P0069', 'Saugrohrdruck – Luftdruck (Umgebung) Korrelation', 'sensor');
add('P0087', 'Kraftstoffverteilerrohr/Systemdruck zu niedrig', 'einspritzung');
add('P0088', 'Kraftstoffverteilerrohr/Systemdruck zu hoch', 'einspritzung');
add('P0089', 'Kraftstoffdruckregler 1 – Leistung', 'einspritzung');
add('P0093', 'Kraftstoffsystem – große Leckage erkannt', 'einspritzung');
add('P0100', 'Luftmassen- oder Luftmengenmesser A – Stromkreis', 'sensor');
add('P0101', 'Luftmassen- oder Luftmengenmesser A – Bereich/Leistung', 'gemisch');
add('P0102', 'Luftmassen- oder Luftmengenmesser A – Signal zu niedrig', 'sensor');
add('P0103', 'Luftmassen- oder Luftmengenmesser A – Signal zu hoch', 'sensor');
add('P0105', 'Saugrohrdruck-/Luftdrucksensor – Stromkreis', 'sensor');
add('P0106', 'Saugrohrdruck-/Luftdrucksensor – Bereich/Leistung', 'sensor');
add('P0107', 'Saugrohrdruck-/Luftdrucksensor – Signal zu niedrig', 'sensor');
add('P0108', 'Saugrohrdruck-/Luftdrucksensor – Signal zu hoch', 'sensor');
add('P0110', 'Ansauglufttemperatursensor 1 – Stromkreis', 'sensor');
add('P0111', 'Ansauglufttemperatursensor 1 – Bereich/Leistung', 'sensor');
add('P0112', 'Ansauglufttemperatursensor 1 – Signal zu niedrig', 'sensor');
add('P0113', 'Ansauglufttemperatursensor 1 – Signal zu hoch', 'sensor');
add('P0115', 'Kühlmitteltemperatursensor 1 – Stromkreis', 'kuehlung');
add('P0116', 'Kühlmitteltemperatursensor 1 – Bereich/Leistung', 'kuehlung');
add('P0117', 'Kühlmitteltemperatursensor 1 – Signal zu niedrig', 'kuehlung');
add('P0118', 'Kühlmitteltemperatursensor 1 – Signal zu hoch', 'kuehlung');
add('P0120', 'Drosselklappen-/Pedalwertgeber A – Stromkreis', 'sensor');
add('P0121', 'Drosselklappen-/Pedalwertgeber A – Bereich/Leistung', 'sensor');
add('P0122', 'Drosselklappen-/Pedalwertgeber A – Signal zu niedrig', 'sensor');
add('P0123', 'Drosselklappen-/Pedalwertgeber A – Signal zu hoch', 'sensor');
add('P0125', 'Kühlmitteltemperatur zu niedrig für geregelten Kraftstoffbetrieb', 'kuehlung');
add('P0128', 'Kühlmitteltemperatur unter Regeltemperatur des Thermostats', 'kuehlung');
// Lambdasonden Bank 1 Sensor 1/2, Bank 2 Sensor 1/2
const O2 = [['Stromkreis', 'lambda'], ['Spannung zu niedrig', 'lambda'], ['Spannung zu hoch', 'lambda'], ['langsame Reaktion', 'lambda'], ['keine Aktivität', 'lambda'], ['Heizung Stromkreis', 'lambda']];
[[130, 'Bank 1 Sensor 1'], [136, 'Bank 1 Sensor 2'], [150, 'Bank 2 Sensor 1'], [156, 'Bank 2 Sensor 2']].forEach(([base, where]) =>
  O2.forEach(([t, g], i) => add(p(base + i), `Lambdasonde ${where} – ${t}`, g)));
add('P0171', 'Gemisch zu mager Bank 1', 'gemisch');
add('P0172', 'Gemisch zu fett Bank 1', 'gemisch');
add('P0174', 'Gemisch zu mager Bank 2', 'gemisch');
add('P0175', 'Gemisch zu fett Bank 2', 'gemisch');
add('P0190', 'Kraftstoffdrucksensor A (Rail) – Stromkreis', 'einspritzung');
add('P0191', 'Kraftstoffdrucksensor A (Rail) – Bereich/Leistung', 'einspritzung');
add('P0192', 'Kraftstoffdrucksensor A (Rail) – Signal zu niedrig', 'einspritzung');
add('P0193', 'Kraftstoffdrucksensor A (Rail) – Signal zu hoch', 'einspritzung');
add('P0200', 'Einspritzventil – Stromkreis', 'einspritzung');
range(1, 8, i => add(p(200 + i), `Einspritzventil Zylinder ${i} – Stromkreis`, 'einspritzung'));
add('P0217', 'Motorübertemperatur', 'kuehlung');
add('P0219', 'Motordrehzahl – Überdrehzahl', 'sensor');
add('P0220', 'Drosselklappen-/Pedalwertgeber B – Stromkreis', 'sensor');
add('P0221', 'Drosselklappen-/Pedalwertgeber B – Bereich/Leistung', 'sensor');
add('P0222', 'Drosselklappen-/Pedalwertgeber B – Signal zu niedrig', 'sensor');
add('P0223', 'Drosselklappen-/Pedalwertgeber B – Signal zu hoch', 'sensor');
add('P0230', 'Kraftstoffpumpe – Primärstromkreis', 'einspritzung');
add('P0234', 'Turbolader/Kompressor – Überladung (Ladedruck zu hoch)', 'ladedruck');
add('P0235', 'Ladedrucksensor A – Stromkreis', 'ladedruck');
add('P0236', 'Ladedrucksensor A – Bereich/Leistung', 'ladedruck');
add('P0237', 'Ladedrucksensor A – Signal zu niedrig', 'ladedruck');
add('P0238', 'Ladedrucksensor A – Signal zu hoch', 'ladedruck');
add('P0243', 'Wastegate-Magnetventil A – Stromkreis', 'ladedruck');
add('P0299', 'Turbolader/Kompressor – Unterladung (Ladedruck zu niedrig)', 'ladedruck');
add('P0300', 'Zündaussetzer – zufällig/mehrere Zylinder erkannt', 'zuendaussetzer');
range(1, 12, i => add(p(300 + i), `Zündaussetzer Zylinder ${i} erkannt`, 'zuendaussetzer'));
add('P0320', 'Zünd-/Drehzahlgeber – Eingangskreis', 'sensor');
add('P0325', 'Klopfsensor 1 (Bank 1) – Stromkreis', 'sensor');
add('P0326', 'Klopfsensor 1 (Bank 1) – Bereich/Leistung', 'sensor');
add('P0327', 'Klopfsensor 1 (Bank 1) – Signal zu niedrig', 'sensor');
add('P0328', 'Klopfsensor 1 (Bank 1) – Signal zu hoch', 'sensor');
add('P0330', 'Klopfsensor 2 (Bank 2) – Stromkreis', 'sensor');
add('P0335', 'Kurbelwellenpositionssensor A – Stromkreis', 'sensor');
add('P0336', 'Kurbelwellenpositionssensor A – Bereich/Leistung', 'sensor');
add('P0340', 'Nockenwellenpositionssensor A (Bank 1) – Stromkreis', 'sensor');
add('P0341', 'Nockenwellenpositionssensor A (Bank 1) – Bereich/Leistung', 'steuerzeit');
add('P0345', 'Nockenwellenpositionssensor A (Bank 2) – Stromkreis', 'sensor');
range(1, 8, i => add(p(350 + i), `Zündspule ${'ABCDEFGH'[i - 1]} (meist Zylinder ${i}) – Primär-/Sekundärstromkreis`, 'zuendaussetzer'));
add('P0380', 'Glühkerzen/Heizung Stromkreis A', 'gluehen');
add('P0381', 'Glühkerzen-Kontrollleuchte – Stromkreis', 'gluehen');
add('P0400', 'Abgasrückführung (AGR) – Durchfluss', 'agr');
add('P0401', 'Abgasrückführung (AGR) – Durchfluss unzureichend', 'agr');
add('P0402', 'Abgasrückführung (AGR) – Durchfluss zu hoch', 'agr');
add('P0403', 'Abgasrückführung (AGR) – Steuerkreis', 'agr');
add('P0404', 'Abgasrückführung (AGR) – Steuerkreis Bereich/Leistung', 'agr');
add('P0405', 'AGR-Sensor A – Signal zu niedrig', 'agr');
add('P0406', 'AGR-Sensor A – Signal zu hoch', 'agr');
add('P0410', 'Sekundärluftsystem', 'sensor');
add('P0411', 'Sekundärluftsystem – falscher Durchfluss', 'sensor');
add('P0420', 'Katalysator – Wirkungsgrad unter Schwellwert (Bank 1)', 'kat');
add('P0430', 'Katalysator – Wirkungsgrad unter Schwellwert (Bank 2)', 'kat');
add('P0440', 'Tankentlüftungssystem (EVAP)', 'evap');
add('P0441', 'Tankentlüftungssystem – falscher Spüldurchfluss', 'evap');
add('P0442', 'Tankentlüftungssystem – kleines Leck erkannt', 'evap');
add('P0443', 'Tankentlüftungssystem – Spülventil Stromkreis', 'evap');
add('P0455', 'Tankentlüftungssystem – großes Leck erkannt', 'evap');
add('P0456', 'Tankentlüftungssystem – sehr kleines Leck erkannt', 'evap');
add('P0480', 'Kühlerlüfter 1 – Steuerkreis', 'kuehlung');
add('P0500', 'Fahrzeuggeschwindigkeitssensor A', 'sensor');
add('P0505', 'Leerlaufregelsystem', 'leerlauf');
add('P0506', 'Leerlaufregelsystem – Drehzahl niedriger als erwartet', 'leerlauf');
add('P0507', 'Leerlaufregelsystem – Drehzahl höher als erwartet', 'leerlauf');
add('P0520', 'Öldrucksensor/-schalter – Stromkreis', 'sensor');
add('P0530', 'Klimaanlage Kältemitteldrucksensor A – Stromkreis', 'sensor');
add('P0560', 'Systemspannung', 'spannung');
add('P0562', 'Systemspannung zu niedrig', 'spannung');
add('P0563', 'Systemspannung zu hoch', 'spannung');
add('P0600', 'Serielle Kommunikationsverbindung', 'bus');
add('P0601', 'Steuergerät – interner Speicher-Prüfsummenfehler', 'steuergeraet');
add('P0602', 'Steuergerät – Programmierfehler', 'steuergeraet');
add('P0603', 'Steuergerät – interner Dauerspeicher (KAM) fehlerhaft', 'steuergeraet');
add('P0604', 'Steuergerät – interner RAM-Fehler', 'steuergeraet');
add('P0605', 'Steuergerät – interner ROM-Fehler', 'steuergeraet');
add('P0606', 'Steuergerät – Prozessor', 'steuergeraet');
add('P0627', 'Kraftstoffpumpe A – Steuerkreis offen', 'einspritzung');
add('P0670', 'Glühzeitsteuergerät – Stromkreis', 'gluehen');
range(1, 8, i => add(p(670 + i), `Glühkerze Zylinder ${i} – Stromkreis`, 'gluehen'));
add('P0700', 'Getriebesteuerung – Fehler gespeichert (Getriebesteuergerät auslesen)', 'getriebe');
add('P0705', 'Getriebe-Wählhebelsensor – Stromkreis', 'getriebe');
add('P0715', 'Turbinen-/Eingangsdrehzahlsensor A (Getriebe) – Stromkreis', 'getriebe');
add('P0720', 'Ausgangsdrehzahlsensor (Getriebe) – Stromkreis', 'getriebe');
add('P0730', 'Falsches Übersetzungsverhältnis', 'getriebe');
add('P0740', 'Wandlerüberbrückungskupplung – Stromkreis', 'getriebe');
add('P0741', 'Wandlerüberbrückungskupplung – Leistung oder hängt offen', 'getriebe');
add('P2002', 'Partikelfilter – Wirkungsgrad unter Schwellwert (Bank 1)', 'dpf');
add('P2015', 'Saugrohrklappen-Positionssensor (Bank 1) – Bereich/Leistung', 'sensor');
add('P2096', 'Gemischregelung nach Kat – System zu mager (Bank 1)', 'gemisch');
add('P2097', 'Gemischregelung nach Kat – System zu fett (Bank 1)', 'gemisch');
add('P2135', 'Drosselklappen-/Pedalwertgeber A/B – Spannungskorrelation', 'sensor');
add('P2138', 'Pedalwertgeber D/E – Spannungskorrelation', 'sensor');
add('P2187', 'Gemisch im Leerlauf zu mager (Bank 1)', 'gemisch');
add('P2188', 'Gemisch im Leerlauf zu fett (Bank 1)', 'gemisch');
add('P2195', 'Lambdasonde Bank 1 Sensor 1 – Signal bleibt mager', 'lambda');
add('P2196', 'Lambdasonde Bank 1 Sensor 1 – Signal bleibt fett', 'lambda');
add('P2263', 'Turbolader/Kompressor Ladesystem – Leistung', 'ladedruck');
add('P2279', 'Ansaugluftsystem – Undichtigkeit', 'gemisch');
add('P2452', 'Partikelfilter-Differenzdrucksensor A – Stromkreis', 'dpf');
add('P2453', 'Partikelfilter-Differenzdrucksensor A – Bereich/Leistung', 'dpf');
add('P2463', 'Partikelfilter – Rußansammlung (Bank 1)', 'dpf');
add('P244A', 'Partikelfilter Differenzdruck zu niedrig (Bank 1)', 'dpf');
add('P244B', 'Partikelfilter Differenzdruck zu hoch (Bank 1)', 'dpf');
add('P20EE', 'SCR-NOx-Katalysator – Wirkungsgrad unter Schwellwert (Bank 1)', 'scr');
add('U0001', 'CAN-Bus (High-Speed) – Kommunikation', 'bus');
add('U0100', 'Kommunikation mit Motorsteuergerät verloren', 'bus');
add('U0101', 'Kommunikation mit Getriebesteuergerät verloren', 'bus');
add('U0121', 'Kommunikation mit ABS-Steuergerät verloren', 'bus');
add('U0140', 'Kommunikation mit Bordnetzsteuergerät (BCM) verloren', 'bus');
add('U0155', 'Kommunikation mit Kombiinstrument verloren', 'bus');

export const DTC = C;
export const DTC_GROUPS = G;

const CODE_RE = /\b([PCBU])[\s-]?([0-3][0-9A-F]{3})\b/gi;
export function findCodes(text) {
  const out = [];
  String(text || '').replace(CODE_RE, (m, a, b) => { const c = (a + b).toUpperCase(); if (!out.includes(c)) out.push(c); return m; });
  return out.slice(0, 5);
}

// Faktentext für den Prompt bzw. die Antwort ohne KI
export function describeCode(code) {
  const c = String(code).toUpperCase();
  const hit = C[c];
  if (hit) return { code: c, known: true, text: hit.text, hint: G[hit.group] || '' };
  const sys = { P: 'Antrieb', C: 'Fahrwerk', B: 'Karosserie', U: 'Netzwerk/Kommunikation' }[c[0]];
  const maker = /^P[13]/.test(c) || /^[BCU][13]/.test(c) || /^[BC]0/.test(c) || /^[BC]2/.test(c);
  return { code: c, known: false, text: maker
    ? `${sys} – herstellerspezifischer Code, Bedeutung je nach Marke unterschiedlich`
    : `${sys} – generischer Code, Bedeutung hier nicht hinterlegt` };
}
