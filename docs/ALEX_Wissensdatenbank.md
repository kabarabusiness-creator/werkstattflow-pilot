# ALEX – Wissensdatenbank (Stand: 29.09.2026)

Automatisch generiert aus `AI_KB` in `index.html` – bitte nicht von Hand editieren, sondern `tools/generate_kb_doc.py` erneut ausführen.

**Gesamtzahl Einträge:** 73

---

## Diagnose-Workflow & Fehlercode-Grundlagen

**1. Systematischer Diagnose-Workflow bei unbekanntem Fehler**
*Trigger (Beispielmuster):* `/wie (gehe ich|gehen wir|sollte ich).*vor|systematisch.*(diagnostizieren|vorgehen|fehler)|diagnose.*(vorgehen|schritte|workflow)/i`

- 1. Fehlerspeicher komplett auslesen (alle Steuergeräte, nicht nur Motor) – auch gespeicherte/sporadische Codes mitnehmen
- 2. Freeze-Frame-Daten zum Code prüfen: unter welchen Bedingungen (Drehzahl, Temperatur, Last) trat der Fehler auf
- 3. Kundengespräch/Symptome abgleichen: passt das gemeldete Symptom zum gespeicherten Code, oder gibt es Zusatzsymptome ohne Code
- 4. Plausibilitätsprüfung vor Bauteiltausch: Sensor/Aktor gezielt mit Live-Daten oder Multimeter verifizieren statt auf Verdacht tauschen
- 5. Nach Reparatur: Fehler löschen, Probefahrt/Testzyklus, erneut auslesen zur Bestätigung

**2. Aufbau eines OBD-Fehlercodes (z.B. P0401)**
*Trigger (Beispielmuster):* `/aufbau.*fehlercode|fehlercode.*aufbau|was bedeutet.*p0|obd.*code.*aufbau|unterschied.*p-code.*b-code|unterschied.*p.?code.*c.?code/i`

- 1. Buchstabe – System: P=Antrieb (Powertrain), B=Karosserie (Body), C=Fahrwerk (Chassis), U=Netzwerk/Kommunikation (Network)
- 2. Ziffer – Norm: 0=generischer SAE-Code (herstellerübergreifend genormt), 1=herstellerspezifischer Code
- 3. Ziffer – Subsystem-Gruppe: z.B. 1er/2er=Kraftstoff/Luft-Gemisch, 3er=Zündung/Aussetzer, 4er=Zusatzemission (AGR/Sekundärluft), 5er=Fahrzeuggeschwindigkeit/Leerlauf, 6er=Steuergerät/Ausgänge, 7er/8er=Getriebe
- 4.–5. Ziffer – laufende Nummer innerhalb der Gruppe, identifiziert das konkrete Bauteil/die konkrete Störung

**3. Pending / Stored / Permanent – Fehlercode-Status verstehen**
*Trigger (Beispielmuster):* `/pending.*code|permanent.*code|unterschied.*fehlercode.*status|fehlercode.*(bestätigt|unbestätigt)/i`

- Pending (anstehend): Fehler ist einmal aufgetreten, aber noch nicht in zwei aufeinanderfolgenden Fahrzyklen bestätigt – MIL/Warnleuchte i.d.R. noch aus
- Stored/Confirmed (gespeichert/bestätigt): Fehler wurde in mehreren Zyklen bestätigt – MIL an, Freeze-Frame-Daten liegen vor
- Permanent: Code bleibt gespeichert, bis das Fahrzeug den Fehler selbst über mehrere saubere Fahrzyklen als behoben erkennt – lässt sich nicht per Diagnosegerät manuell löschen (Missbrauchsschutz für Abgasrelevanz)
- Praxisrelevanz: Ein "Permanent"-Code nach Reparatur ist normal und verschwindet erst nach erfolgreicher Selbstdiagnose des Fahrzeugs, nicht durch Löschen

**4. Freeze-Frame-Daten interpretieren**
*Trigger (Beispielmuster):* `/freeze.?frame|standbilddaten|momentaufnahme.*fehlerspeicher/i`

- Freeze-Frame = Schnappschuss der Betriebsparameter (Drehzahl, Last, Temperatur, Geschwindigkeit, Kraftstoff-Trimmwerte) im Moment der Fehlererkennung
- Hilft zu unterscheiden: last-/drehzahlabhängiger Fehler vs. Fehler im Leerlauf/Standgas
- Kühlmitteltemperatur im Freeze-Frame prüfen: Fehler nur im Kaltlauf aufgetreten? → andere Ursachenrichtung als bei warmem Motor
- Wichtig: Freeze-Frame zeigt die Bedingungen bei Fehler-erkennung, nicht zwingend die Grundursache selbst

**5. Sporadischen/intermittierenden Fehler diagnostizieren**
*Trigger (Beispielmuster):* `/sporadisch|intermittierend|fehler.*kommt.*geht|wackelkontakt.*diagnose/i`

- Fehlerspeicher-Historie nutzen: Häufigkeit und Zeitabstand der Fehlerauslösung geben Hinweis auf Auslöser (Vibration, Temperatur, Feuchtigkeit)
- Wackelkontakte gezielt provozieren: Kabelbaum/Steckverbinder im Verdachtsbereich unter Betrieb leicht bewegen/klopfen, dabei Live-Daten beobachten
- Datenlogger/Langzeitmessung sinnvoll, wenn Fehler im Werkstattbetrieb nicht reproduzierbar ist (z.B. nur bei Nässe oder nach langer Fahrt)
- Steckverbinder auf Korrosion/aufgeweitete Kontakte prüfen – häufigste Ursache für "kommt und geht"-Fehler bei Elektronik

**6. Fehlercode löschen ohne Ursachenbehebung – typischer Fallstrick**
*Trigger (Beispielmuster):* `/(fehlerspeicher|fehlercode).*löschen|löschen.*(fehlerspeicher|fehlercode)|nur.*löschen.*bringt/i`

- Löschen des Fehlerspeichers behebt nie die Ursache – der Code kommt nach dem nächsten passenden Fahrzyklus wieder, wenn der Defekt weiterbesteht
- Vor dem Löschen: Freeze-Frame-Daten und Auftretenshäufigkeit dokumentieren, sonst gehen Diagnoseinformationen verloren
- Sinnvoller Einsatz von "Löschen": gezielt nach abgeschlossener Reparatur, um die Selbstdiagnose des Fahrzeugs für Permanent-Codes neu zu starten
- Kundenkommunikation: "Lampe aus" durch reines Löschen ohne Reparatur ist keine Lösung und sollte klar so benannt werden

**7. Diagnose bei Symptom ohne gespeicherten Fehlercode**
*Trigger (Beispielmuster):* `/kein(en)? (fehlercode|dtc).*(gespeichert|vorhanden)|problem.*ohne.*fehlercode|fehler.*aber.*kein.*code|kein.*fehlercode.*aber/i`

- Nicht jeder wahrnehmbare Fehler erzeugt einen DTC – viele Systeme melden erst ab einer definierten Schwelle/Häufigkeit
- Vorgehen: Live-Daten im Grenzbereich beobachten (z.B. Lambdawerte, Raildruck-Ist/Soll, Sensorspannungen), statt auf einen Code zu warten
- Kundenbeschreibung strukturiert abfragen: wann genau, wie oft, unter welchen Bedingungen (kalt/warm, Last, Wetter)
- Vergleichsmessung an einem baugleichen, fehlerfreien Fahrzeug kann bei unklaren Grenzwerten helfen

---

## Schaltpläne & Elektrik – Grundlagen

**8. CAN-Bus – Grundlagen & Diagnoseansatz**
*Trigger (Beispielmuster):* `/can.?bus|canbus.*(diagnose|fehler|terminierung|abschlusswiderstand)/i`

- Zwei Leitungen (CAN-High/CAN-Low), differentielles Signal – dadurch robust gegen elektromagnetische Störungen
- Abschlusswiderstände (i.d.R. 2× 120Ω an den Bus-Enden, zusammen ca. 60Ω messbar zwischen den Leitungen) – fehlender/defekter Widerstand verursacht Kommunikationsausfälle
- Typischer Fehler "Steuergerät nicht erreichbar": zuerst Spannungsversorgung/Masse des Steuergeräts prüfen, dann Bus-Pegel mit Oszilloskop, erst danach Steuergerät selbst verdächtigen
- Mehrere Steuergeräte gleichzeitig nicht erreichbar deutet auf Bus-Problem (Kurzschluss/Unterbrechung/Abschlusswiderstand) statt Einzelbauteil hin

**9. LIN-Bus – Grundlagen**
*Trigger (Beispielmuster):* `/lin.?bus/i`

- Single-Wire-Bus (eine Datenleitung + Masse) für einfache Komponenten – günstiger als CAN, aber langsamer und weniger störsicher
- Typischer Einsatz: Fensterheber, Sitzverstellung, Klimabedienteile, Regensensor – Komfortelektronik statt sicherheitsrelevante Systeme
- Ein Master-Steuergerät steuert mehrere LIN-Slaves im Zeitschlitzverfahren – fällt der Master aus, sind alle angeschlossenen Slaves betroffen
- Diagnose ähnlich CAN: erst Spannungsversorgung/Masse der Teilnehmer prüfen, dann Signalpegel auf der einzelnen Datenleitung

**10. Spannungsabfalltest (Voltage Drop) – Vorgehen**
*Trigger (Beispielmuster):* `/spannungsabfall|voltage.?drop|leitungswiderstand.*prüfen/i`

- Prinzip: Multimeter parallel über den zu prüfenden Leitungs-/Kontaktabschnitt, Verbraucher dabei eingeschaltet (Strom muss fließen, sonst kein aussagekräftiges Ergebnis)
- Deutlich sinnvoller als reine Widerstandsmessung im spannungslosen Zustand – findet auch Übergangswiderstände, die erst unter Last auftreten
- Typische Prüfpunkte: Batterie-Pluspol bis Verbraucher, Verbraucher-Masse bis Batterie-Minuspol, einzelne Steckverbindungen im Verdachtsbereich
- Auffällig hoher Spannungsabfall an einem Abschnitt (deutlich höher als an vergleichbaren Abschnitten) markiert die Fehlerstelle – Korrosion, lockerer Kontakt oder Kabelbruch mit Teilkontakt

**11. Massefehler/Erdungsproblem finden**
*Trigger (Beispielmuster):* `/massefehler|erdungsfehler|schlechte masse|masseproblem|masseband/i`

- Typische Symptome: mehrere, scheinbar unzusammenhängende elektrische Probleme gleichzeitig, flackernde Beleuchtung, unplausible Sensorwerte
- Massebänder (Motor-Karosserie, Getriebe-Karosserie) auf Korrosion/lockeren Sitz prüfen – häufigste Fehlerquelle bei Masseproblemen
- Spannungsabfalltest zwischen Bauteil-Masseanschluss und Batterie-Minuspol durchführen, um die genaue Stelle mit erhöhtem Übergangswiderstand einzugrenzen
- Vorsicht bei Ersatz-/Behelfsmassen: unsachgemäß gesetzte Zusatzmassen können neue Ausgleichsströme und Folgefehler verursachen

**12. Multimeter vs. Oszilloskop – wann was einsetzen**
*Trigger (Beispielmuster):* `/wann.*oszilloskop|multimeter.*oszi|oszi.*multimeter|wann.*multimeter/i`

- Multimeter: statische/quasi-statische Werte – Spannung, Widerstand, Strom, Spannungsabfall – reicht für die meisten Standardprüfungen
- Oszilloskop: immer dann nötig, wenn sich ein Signal über die Zeit ändert – Sensorsignale (Kurbelwelle/Nockenwelle), PWM-Signale, Kommunikationsbusse (CAN/LIN), Zündsignale
- Faustregel: wackelt/schwankt ein Multimeter-Messwert unerklärlich, oder soll ein "sporadischer" Aussetzer im Signal selbst gefunden werden → zum Oszilloskop wechseln
- Bus-Diagnose (CAN/LIN) ist ohne Oszilloskop nur eingeschränkt möglich – reine Spannungsmessung zeigt keine Signalqualität/Störungen im Datenverkehr

**13. Schaltplan lesen – Grundlagen & Symbole**
*Trigger (Beispielmuster):* `/schaltplan.*les|les.*schaltplan|schaltplansymbole|schaltzeichen.*bedeutung/i`

- Leitungsfarben und Querschnittsangaben im Schaltplan mit der realen Verkabelung abgleichen – Farbcode ist herstellerspezifisch, immer die Legende des jeweiligen Plans nutzen
- Bauteile werden meist als vereinfachte Symbole dargestellt (Schalter, Relais, Steckverbinder, Massepunkte) – Legende/Symbolverzeichnis am Anfang des Dokuments klärt die genaue Bedeutung
- Steckverbinder-Nummerierung und Pin-Bezeichnung im Plan mit der Beschriftung am realen Stecker abgleichen, bevor gemessen wird
- Stromlaufrichtung meist von oben (Versorgung/Plus) nach unten (Masse) dargestellt – hilft beim schnellen Einordnen unbekannter Pläne

**14. Steckverbinder/Pins prüfen – Kontaktwiderstand**
*Trigger (Beispielmuster):* `/pin.*prüfen|steckverbinder.*prüfen|kontaktwiderstand|pinbelegung.*prüfen/i`

- Sichtprüfung zuerst: Korrosion, aufgeweitete/verbogene Kontakte, Feuchtigkeitsspuren im Steckergehäuse
- Kontaktwiderstand nie nur "gesteckt" prüfen – Spannungsabfalltest unter Last liefert das aussagekräftigere Ergebnis als eine Widerstandsmessung im spannungslosen Zustand
- Bei Verdacht auf Wackelkontakt: Steckverbinder unter Betrieb/Live-Daten-Beobachtung leicht bewegen, um den Fehler gezielt zu provozieren
- Passende Pin-Auszieh-/Prüfwerkzeuge verwenden statt mit Prüfspitzen direkt in die Kontaktkammer zu gehen – vermeidet dauerhaft aufgeweitete Kontakte durch die Prüfung selbst

---

## Symptom-/Phänomen-Diagnose ohne DTC

**15. Ruckeln beim Beschleunigen – Diagnoseansatz**
*Trigger (Beispielmuster):* `/ruckelt.*beschleunig|ruckeln.*(last|beschleunigen)|beschleunigen.*ruckel/i`

- Kalt vs. warm unterscheiden: nur im Kaltlauf → oft Gemischaufbereitung/Sensorik noch nicht in Regelbereich; auch warm → eher mechanisch/elektrisch dauerhaft
- Mögliche Ursachen: Zündaussetzer (Kerzen/Spulen), Kraftstoffdruck schwankt, verschmutzte Drosselklappe, Nebenluft, verstopfter Kraftstofffilter
- Vorgehen: zuerst Fehlerspeicher auslesen (auch Sporadische/History), dann Fuel-Trims im Livedaten-Modus unter Last beobachten, danach gezielt Zündung/Einspritzung eingrenzen
- Bei Automatik zusätzlich: Wandlerüberbrückungskupplung (Schlupf) als Ursache für last-abhängiges Ruckeln in Betracht ziehen

**16. Startprobleme bei Kälte – Diagnoseansatz**
*Trigger (Beispielmuster):* `/kaltstart.*(problem|schwer|schlecht)|startprobleme.*kälte|kälte.*startproblem/i`

- Diesel: Glühkerzen/Glühzeitsteuergerät prüfen (Vorglühzeit, Anzahl defekter Kerzen per Stromzangenmessung), Kompression bei Verdacht auf Motoralter
- Benziner: Batteriezustand/Kaltstartstrom, Zündkerzen-Zustand, Kraftstoffdruckhaltung über Nacht (Standdruck-Abfall = undichtes Rückschlagventil/Injektor)
- Bei beiden: Kühlmitteltemperatursensor-Plausibilität prüfen (falscher Wert → falsches Kaltstart-Kennfeld)
- Symptom "dreht durch, springt aber nicht an" bei Kälte spricht eher für Kraftstoff/Zündung als für den Anlasser selbst

**17. Quietschen/Pfeifen/Zischen – Geräusch eingrenzen**
*Trigger (Beispielmuster):* `/quietscht|pfeift(?!.*bremse)|zischt.*motor/i`

- Hochfrequentes Quietschen beim Start/Kaltlauf: meist Keilrippenriemen (Spannrolle/Riemenscheiben-Fluchtung prüfen)
- Pfeifen unter Last/bei Gas: Hinweis auf Unterdruck-/Ladeluftleck (Schläuche, Ladeluftkühler, Turboladerdichtungen)
- Zischen aus dem Motorraum bei laufendem Motor: Abgasleck (Krümmerdichtung) oder Vakuumleck am Bremskraftverstärker
- Vorgehen: Geräusch bei stehendem Fahrzeug mit Stethoskop/Hörrohr lokalisieren, danach gezielt Bauteil prüfen statt auf Verdacht tauschen

**18. Vibration bei bestimmter Geschwindigkeit – Diagnoseansatz**
*Trigger (Beispielmuster):* `/vibriert|vibration.*(fahrt|tempo|geschwindigkeit|km\/h)/i`

- Vibration tempoabhängig (nicht drehzahlabhängig) → meist Rad/Reifen: Unwucht, Reifenschaden, Felge verzogen
- Vibration beim Bremsen: Bremsscheibe verzogen (Scheibendickenschwankung)
- Vibration nur bei Beschleunigung/Last, unabhängig vom Tempo: Antriebswelle/Gelenkwelle (Gummilager, Gleichlaufgelenk) oder Motorlager
- Vorgehen: Probefahrt mit Zuordnung Lenkrad (Vorderachse) vs. Sitz/Karosserie (Hinterachse/Antriebsstrang), danach gezielt Rad tauschen/Unwucht prüfen zur Eingrenzung

**19. Automatikgetriebe ruckelt/schaltet hart – Diagnoseansatz**
*Trigger (Beispielmuster):* `/automatik.*(ruckelt|hart|schaltruck)|schaltruck|getriebe.*ruckelt/i`

- Getriebeöl-Zustand und -Stand prüfen (verbranntes/dunkles Öl, falscher Füllstand sehr häufige Ursache)
- Fehlerspeicher Getriebesteuergerät separat auslesen (oft eigenes Modul, nicht immer über Standard-OBD sichtbar)
- Adaptionswerte/Anlernung: nach Ölwechsel oder Batterietrennung ggf. Getriebeadaption zurückgesetzt – Anlernfahrt nach Herstellervorgabe nötig
- Hartes Schalten nur kalt, normal warm: meist unkritisch (Ölviskosität) – nur warm hart/ruckelnd: eher Kupplungspaket/Wandler-Thema

**20. Verkokung der Einlassventile bei Direkteinspritzern – bekanntes Serienthema**
*Trigger (Beispielmuster):* `/verkokung|einlassventile.*verkokt|carbon.*ventile|ventile.*(verkokt|verrußt)/i`

- Betrifft v.a. Benzin-Direkteinspritzer (FSI/TSI/TFSI, viele BMW-N-Motoren, u.a.): Kraftstoff spült bei Saugrohreinspritzung die Ventile, bei Direkteinspritzung fehlt dieser Reinigungseffekt
- Anzeichen: Leistungsverlust, unruhiger Leerlauf, erhöhter Kraftstoffverbrauch, teils Zündaussetzer bei starker Verkokung
- Diagnose: Endoskopie durch die Zündkerzenbohrung zur Sichtprüfung der Einlassventile
- Reparatur: Walnussschalen-Strahlen (Soda-/Walnuss-Reinigung) der Ventile bei ausgebautem Ansaugtrakt; vorbeugend: hochwertigen Kraftstoff, regelmäßige Additiv-Reinigung

**21. Steuerkettenlängung – allgemeines Diagnoseprinzip (motorunabhängig)**
*Trigger (Beispielmuster):* `/kettenlängung|steuerkette.*(gelängt|verschleiß)(?!.*n47)/i`

- Kette "längt" sich durch Verschleiß an Bolzen/Buchsen, nicht durch tatsächliche Materialdehnung – Kettenspanner gleicht das bis zu einem Grenzwert aus
- Typisches Symptom: Rasseln/Klappern im Kaltstart (kurz, dann leiser durch Öldruckaufbau am Spanner)
- Diagnose: Nockenwellen-/Kurbelwellen-Sensorkorrelation im Diagnosegerät prüfen (Phasenabweichung = Indiz für gelängte Kette)
- Wichtig: motorspezifische Ausfallmuster (z.B. bestimmte Baureihen) gesondert nachschlagen – Ausfallzeitpunkt/Kilometerlaufleistung variiert stark je Motor

---

## Komponentenwissen & Sensorik

**22. Hall- vs. Induktivgeber (Kurbel-/Nockenwellensensor)**
*Trigger (Beispielmuster):* `/hallgeber|induktivgeber|kurbelwellensensor.*(typ|unterschied)|nockenwellensensor.*(typ|unterschied)/i`

- Induktivgeber (passiv, 2-Draht): erzeugt Wechselspannung durch Zahnrad-Vorbeibewegung, Signalamplitude drehzahlabhängig, im Stillstand kein Signal messbar
- Hallgeber (aktiv, 3-Draht: Versorgung/Masse/Signal): liefert Rechtecksignal, auch bei sehr niedriger Drehzahl/Stillstand auswertbar (wichtig fürs Anlassen)
- Prüfung Induktivgeber: Widerstandsmessung an den beiden Signalleitungen (Sollwert laut Hersteller, üblich einige hundert Ohm bis ca. 1–2 kΩ) plus Oszilloskop-Signalform (sauberer Sinus)
- Prüfung Hallgeber: Versorgungsspannung am Stecker prüfen, dann Rechtecksignal am Oszilloskop bei Motor durchdrehen

**23. Breitband- vs. Sprung-Lambdasonde**
*Trigger (Beispielmuster):* `/lambdasonde|breitbandsonde|sprungsonde/i`

- Sprungsonde (Zirkondioxid): springt sprunghaft zwischen ca. 0,1 V (mager) und 0,9 V (fett) um Lambda=1 – nur Aussage "zu fett/zu mager", kein genauer Wert
- Breitbandsonde (Planarsonde, meist 5–6 Leitungen): liefert stufenlosen Strom-/Spannungswert proportional zum tatsächlichen Lambda-Wert, auch weit von Lambda=1 entfernt messbar (wichtig für Direkteinspritzer/Magerbetrieb)
- Position: Sprungsonde meist hinter Kat (Diagnosesonde), Breitbandsonde vor Kat (Regelsonde)
- Diagnosehinweis: träge reagierende Sonde (verzögerte Spannungswechsel) = klassisches Alterungssymptom, oft mit P0420/P0430 verwechselt

**24. Piezo- vs. Magnetventil-Injektoren**
*Trigger (Beispielmuster):* `/piezo.*injektor|magnetventil.*injektor|injektor.*(typ|unterschied)/i`

- Magnetventil-Injektor: klassische Bauart, Schaltzeiten im Bereich einiger hundert Mikrosekunden, robuster/günstiger, etwas trägere Ansteuerung
- Piezo-Injektor: Piezokristall dehnt sich unter Spannung, extrem schnelle Schaltzeiten (Mehrfacheinspritzung präziser möglich), typisch bei modernen Common-Rail-Dieseln und einigen Benzin-Direkteinspritzern
- Diagnose gemeinsam: Stromzangenmessung am Injektor-Steuersignal zeigt Ansteuerungsmuster; Mengenabgleich-Werte im Diagnosegerät je Zylinder vergleichen (Ausreißer = Injektor-Verdacht)
- Wichtig: Piezo-Injektoren reagieren empfindlicher auf Kraftstoffverunreinigung – bei Tausch grundsätzlich Kraftstoffsystem auf Verschmutzung prüfen

**25. AGR/EGR-System – Diagnose ohne konkreten Fehlercode**
*Trigger (Beispielmuster):* `/agr.*(diagnose|prüfen|klappe|system)|egr.*(diagnose|prüfen)/i`

- Funktion: führt Abgas zurück in den Ansaugtrakt, senkt Verbrennungstemperatur, reduziert Stickoxide (NOx)
- Typische mechanische Symptome: AGR-Ventil hängt (verkokt) → unruhiger Leerlauf, Leistungsverlust, oder hängt offen → mageres Gemisch/Startprobleme
- Prüfung: Ansteuerung im Diagnosegerät aktivieren (Stellgliedtest) und Klappenbewegung/Ansaugdruckänderung beobachten; bei elektrischem AGR-Ventil zusätzlich Potentiometer-Rückmeldung live prüfen
- Sichtprüfung: Ventil ausbauen, Verkokungsgrad beurteilen – bei Diesel meist deutlich stärker verkokt als bei Benziner

**26. DPF (Dieselpartikelfilter) – Regenerationsbedingungen**
*Trigger (Beispielmuster):* `/\bdpf\b|partikelfilter|russpartikelfilter/i`

- Aktive Regeneration wird vom Steuergerät eingeleitet, wenn Beladung (Differenzdrucksensor + Ruß-Modell) einen Schwellwert erreicht – meist alle paar hundert km
- Voraussetzungen für erfolgreiche Regeneration: Motor auf Betriebstemperatur, längere Fahrt mit gleichmäßiger Last (Autobahn/Landstraße), ausreichend Kraftstoff im Tank
- Häufige Ursache für DPF-Probleme: reine Kurzstreckenfahrten verhindern Regeneration → Filter läuft voll, Warnleuchte, im Extremfall Leistungsreduzierung
- Diagnose: Beladungswert und Anzahl fehlgeschlagener Regenerationen im Diagnosegerät auslesen, vor Filtertausch immer Ursache (z.B. Injektor, AGR, Ölverdünnung) mitprüfen

**27. ADAS-Kalibrierung (Kamera/Radar) & Lenkwinkelsensor – Grundprinzip**
*Trigger (Beispielmuster):* `/adas|kamera.*kalibrier|radar.*kalibrier|lenkwinkelsensor/i`

- Nach Arbeiten mit Bezug zu Achsgeometrie, Windschutzscheibentausch, Stoßfängerarbeiten oder Batterietrennung ist eine Neukalibrierung der Fahrerassistenzsysteme oft zwingend vorgeschrieben
- Statische Kalibrierung: Kalibriertafeln in exakt definiertem Abstand/Winkel vor dem Fahrzeug, Fahrzeug muss eben und exakt ausgerichtet stehen
- Dynamische Kalibrierung: Kalibrierfahrt unter definierten Bedingungen (Geschwindigkeit, Fahrbahnmarkierungen, Diagnosegerät verbunden)
- Lenkwinkelsensor-Anlernen: nach Reparaturen an Lenkung/Achsgeometrie zwingend, sonst fehlerhafte ESP-/Spurhalteassistent-Funktion – Ablauf grundsätzlich: Lenkung auf Geradeausstellung, Anlernvorgang über Diagnosegerät starten, danach Prüffahrt

---

## Anlernprozeduren & Codierungen

**28. Drosselklappen-Anlernen – Grundprinzip**
*Trigger (Beispielmuster):* `/drosselklappe.*anlernen|drosselklappenanpassung/i`

- Nötig nach: Drosselklappentausch, Reinigung, Batterietrennung oder Fehlercode-Löschung bei elektronischer Drosselklappe (E-Gas)
- Ablauf grundsätzlich: Zündung ein (Motor aus), Anlernvorgang über Diagnosegerät starten, Steuergerät fährt die Klappe selbstständig an Anschläge und lernt Grundstellung/Endanschläge
- Nach dem Anlernen: Leerlaufverhalten und Gasannahme im Livedaten-Modus prüfen, Probefahrt zur Kontrolle
- Ohne korrektes Anlernen drohen: unruhiger Leerlauf, Notlaufprogramm, ruckartige Gasannahme

**29. Batterie-Anlernen/Registrierung (Batteriemanagement)**
*Trigger (Beispielmuster):* `/batterie.*(anlernen|registrierung|registrieren|codieren)|neue batterie.*(agm|efb)|agm.*batterie|efb.*batterie/i`

- Grundprinzip: viele Fahrzeuge mit intelligentem Batteriemanagement (Batteriesensor/BMS) müssen nach Batterietausch über das Diagnosegerät die neue Batterie "anmelden" – sonst rechnet das System weiter mit dem alten Alterungszustand
- Folgen bei fehlender Registrierung: falsches Lademanagement, ggf. verkürzte Batterielebensdauer, Start-Stopp-Funktion kann deaktiviert bleiben
- AGM- vs. EFB-Batterie: AGM (meist bei Start-Stopp mit Rekuperation) hat höhere Zyklenfestigkeit als EFB – beim Tausch grundsätzlich denselben Batterietyp wie Original verwenden, sonst Ladestrategie/BMS-Fehlanpassung möglich
- Ablauf grundsätzlich: Batteriekapazität (Ah) und -typ im Diagnosegerät hinterlegen, Anlernvorgang bestätigen

**30. DPF-Rückstellung nach Filtertausch – Grundprinzip**
*Trigger (Beispielmuster):* `/dpf.*rückstellung|russfilter.*(getauscht|zurücksetzen)|servicereset.*dpf/i`

- Nach mechanischem DPF-Tausch muss der Beladungswert/Servicezähler im Steuergerät zurückgesetzt werden, sonst rechnet das System mit dem alten (vollen) Beladungsstand weiter
- Ablauf grundsätzlich: über Diagnosegerät "Bauteil ersetzt"-Funktion oder gezielten Servicereset für den Partikelfilter auswählen und bestätigen
- Wichtig: unterscheiden zwischen reinem Reset (nach Tausch) und aktiver Zwangsregeneration (bei zugesetztem, aber noch verbautem Filter) – unterschiedliche Menüpunkte im Diagnosegerät

**31. EPB (Elektrische Parkbremse) in Servicestellung / Diagnose-Bremsenentlüftung**
*Trigger (Beispielmuster):* `/epb.*(service|wartung)|elektrische parkbremse.*(service|wartung|zurückfahren)|bremsenentlüftung.*diagnose/i`

- Vor Arbeiten an Bremsbelägen/Bremssattel bei elektrischer Parkbremse: Kolben müssen über Diagnosegerät in Service-/Wartungsposition zurückgefahren werden (nicht mechanisch gewaltsam zurückdrücken)
- Nach Arbeiten: Anlernvorgang/Grundeinstellung über Diagnosegerät, danach Funktionstest (Anziehen/Lösen) vor der ersten Fahrt
- Bremsenentlüftung per Diagnosegerät: bei modernen Systemen (v.a. mit ESP-Pumpe im Kreislauf) ist eine softwaregestützte Entlüftungsroutine oft vorgeschrieben, rein manuelles Pedal-Pumpen reicht nicht sicher aus
- Sicherheitshinweis: Fahrzeug bei EPB-Arbeiten gegen Wegrollen zusätzlich mechanisch sichern (Unterlegkeile), da die elektrische Bremse während der Arbeit ausgehängt ist

---

## Fehlercodes – spezifische DTCs

**32. P0401 – AGR-System, unzureichender Durchfluss**
*Trigger (Beispielmuster):* `/p0401/i`

- Mögliche Ursache: AGR-Ventil verkokt oder klemmt
- Reparatur: AGR-Ventil ausbauen, reinigen oder ersetzen
- Benötigte Teile: AGR-Ventil, Dichtsatz
- Arbeitszeit: ca. 1,5 Std.
- Hinweis: nach Reparatur Fehlerspeicher löschen & Probefahrt

**33. P0300 – Zündaussetzer (mehrere Zylinder)**
*Trigger (Beispielmuster):* `/p0300|zündaussetzer|verbrennungsaussetzer/i`

- Mögliche Ursachen: Zündkerzen verschlissen, Zündspule defekt, Kraftstoffzufuhr mangelhaft
- Prüfung: Zylinderindividuelle Aussetzererkennung im Diagnosegerät auslesen
- Reparatur: Zündkerzen/-spulen tauschen, Kompression prüfen wenn Ursache unklar
- Hinweis: bei Ruckeln unter Last zusätzlich Kraftstoffdruck prüfen

**34. P0420 – Katalysator-Wirkungsgrad unter Schwelle**
*Trigger (Beispielmuster):* `/p0420|katalysator|kat\b/i`

- Mögliche Ursachen: Katalysator gealtert/beschädigt, vorgelagerte Lambdasonde defekt, Abgasleck vor Sonde
- Prüfung: beide Lambdasonden-Signale vergleichen, Abgasanlage auf Undichtigkeiten prüfen
- Reparatur: erst Sonden/Dichtigkeit prüfen, Katalysator nur bei bestätigtem Defekt tauschen

**35. P0171/P0174 – Gemisch zu mager**
*Trigger (Beispielmuster):* `/p0171|p0174|gemisch.*mager|mager.*gemisch/i`

- Mögliche Ursachen: Nebenluft (undichter Ansaugtrakt), verschmutzter Luftmassenmesser, schwache Kraftstoffpumpe
- Prüfung: Rauchtest Ansaugtrakt, Luftmassenmesser reinigen/prüfen, Kraftstoffdruck messen
- Hinweis: Bank 1 = Zylinder mit Zylinder 1, Bank 2 = gegenüberliegende Bank bei V-Motoren

**36. P0128 – Kühlmitteltemperatur unterhalb Regelwert**
*Trigger (Beispielmuster):* `/p0128|thermostat|kühlmitteltemperatur/i`

- Mögliche Ursache: Thermostat klemmt offen
- Prüfung: Warmlaufverhalten beobachten, Motor erreicht Betriebstemperatur nicht in erwarteter Zeit
- Reparatur: Thermostat ersetzen, danach Kühlsystem entlüften

---

## Allgemeine Wartung & Service

**37. Klackern im Fahrwerksbereich – typische Ursachen**
*Trigger (Beispielmuster):* `/klackert|klacker|geräusch/i`

- Koppelstange Stabilisator ausgeschlagen
- Federbeinlager defekt
- Achsmanschette gerissen
- Prüfung: Sichtprüfung + Abklopfen bei angehobener Achse
- Arbeitszeit Koppelstange: ca. 0,5 Std. je Seite

**38. Bremsenprüfung – Richtwerte**
*Trigger (Beispielmuster):* `/bremse|bremsen/i`

- Mindestbelagstärke: 2 mm
- Anzugsdrehmoment Radschrauben: meist 100–140 Nm (Herstellerangabe beachten)
- Nach Belagwechsel: Bremse mehrfach betätigen, Probefahrt mit Bremstest

**39. Ölwechsel – Standardablauf**
*Trigger (Beispielmuster):* `/öl|oel/i`

- Motor auf Betriebstemperatur bringen
- Altöl ablassen, Ölfilter wechseln
- Neues Öl nach Herstellerfreigabe einfüllen
- Ölstand nach 5 Minuten Wartezeit kontrollieren

**40. Batterie & Starthilfe**
*Trigger (Beispielmuster):* `/batterie|starthilfe/i`

- Ruhestrom prüfen (Sollwert meist &lt; 50 mA, Herstellerangabe beachten)
- Batterietest: Ladezustand + Kaltstartstrom (CCA) mit Batterietester prüfen
- Starthilfe: Plus zuerst an leere Batterie, Minus an Massepunkt (nicht direkt an leere Batterie), Reihenfolge beim Abklemmen umgekehrt
- Nach Batterietausch: Anlernvorgang/Registrierung bei vielen Fahrzeugen nötig (Batteriemanagement)

**41. Zahnriemen/Steuerriemen – Wechsel**
*Trigger (Beispielmuster):* `/zahnriemen|steuerriemen|zahnriemenwechsel/i`

- Wechselintervall herstellerspezifisch, üblich 60.000–160.000 km oder 5–10 Jahre
- Bei Wechsel: Wasserpumpe, Spannrolle & Umlenkrolle mittauschen (Satz)
- Bei Riss/Sprung: Zylinderkopfschaden möglich (Ventilschäden bei Interferenzmotor prüfen)
- Nach Einbau: Steuerzeiten mit Werkzeugsatz exakt nach Herstellervorgabe fixieren

**42. Kupplung – Verschleißanzeichen**
*Trigger (Beispielmuster):* `/kupplung/i`

- Rutschen: Motordrehzahl steigt ohne entsprechenden Vortrieb, v.a. bei Last/Steigung
- Rupfen beim Anfahren: Mitnehmerscheibe verölt oder verschlissen
- Kupplungspedal-Spiel/Geräusche: Ausrücklager prüfen
- Arbeitszeit Kupplungssatz: stark modellabhängig (oft 3–6 Std., Getriebeausbau nötig)

**43. Klimaanlage/Klimaservice**
*Trigger (Beispielmuster):* `/klima|klimaanlage|klimaservice/i`

- Klimaservice: Kältemittel absaugen, Anlage auf Dichtigkeit prüfen, evakuieren, neu befüllen (Menge nach Herstellerangabe)
- Kältemitteltyp beachten: R134a oder R1234yf – nicht verwechseln
- Schwacher Kühleffekt: meist Kältemittelverlust durch Leckage, UV-Kontrastmittel zur Lecksuche nutzen
- Unangenehmer Geruch: Verdampfer-/Innenraumfilter prüfen, ggf. Klimaanlagen-Desinfektion

**44. Zündkerzenwechsel**
*Trigger (Beispielmuster):* `/zündkerze/i`

- Wechselintervall: meist 30.000–60.000 km (Iridium/Platin-Kerzen auch deutlich länger), Herstellerangabe beachten
- Elektrodenabstand vor Einbau prüfen (falls nicht vorjustiert)
- Anzugsdrehmoment beachten – nicht überdrehen (Gewindeschaden im Zylinderkopf möglich)
- Zündspule bei Wechsel auf Risse/Ölspuren im Kerzenschacht prüfen

**45. Kühlmittel wechseln**
*Trigger (Beispielmuster):* `/kühlmittel|kühlwasser|kühlsystem/i`

- Kühlsystem drucklos machen, Altkühlmittel vollständig ablassen (auch Motorblock-Ablassschraube falls vorhanden)
- Nur freigegebenes Kühlmittel-Konzentrat mischen (Frostschutz i.d.R. bis -25°C bis -35°C je nach Klima)
- Nach Befüllung: System entlüften (Entlüftungsschraube/-ventil), Motor mit offenem Deckel/Ventil warmlaufen lassen
- Kühlmittelstand nach Abkühlen erneut kontrollieren

**46. Bremsflüssigkeit wechseln**
*Trigger (Beispielmuster):* `/bremsflüssigkeit|dot\s?4|dot\s?3/i`

- Wechselintervall: meist alle 2 Jahre unabhängig vom Kilometerstand (Wasseraufnahme durch Hygroskopie)
- Nur freigegebene Spezifikation verwenden (meist DOT 4, Herstellerangabe beachten)
- Reihenfolge beim Entlüften: vom Rad mit dem längsten Bremsleitungsweg zum kürzesten (meist hinten rechts → vorne links)
- Nach Wechsel: Bremspedalgefühl und Dichtigkeit prüfen

**47. Stoßdämpfer/Fahrwerk prüfen**
*Trigger (Beispielmuster):* `/stoßdämpfer|fahrwerk/i`

- Sichtprüfung: Ölaustritt am Dämpfer = Defekt, immer achsweise (paarweise) tauschen
- Funktionstest: Fahrzeugecke eindrücken – schwingt sie mehr als 1–1,5x nach, Dämpfer verschlissen
- Begleitend prüfen: Domlager, Federn auf Setzung/Bruch, Koppelstangen

**48. Achsvermessung/Spureinstellung**
*Trigger (Beispielmuster):* `/achsvermessung|spur\b|spureinstellung/i`

- Vorher prüfen: Reifendruck korrekt, Fahrwerk unbeschädigt, Fahrzeug auf Nennlast/-beladung
- Typische Ursache für einseitigen Verschleiß: Spur oder Sturz außerhalb Toleranz
- Nach Fahrwerksarbeiten (Federn, Querlenker, Spurstangen) immer Achsvermessung empfehlen

**49. HU/AU-Vorbereitung (TÜV)**
*Trigger (Beispielmuster):* `/hu\b|au\b|tüv|hauptuntersuchung/i`

- Prüfpunkte vorab checken: Beleuchtung, Bremsen, Reifenprofil (min. 1,6 mm, empfohlen mehr), Abgaswerte
- Fälligkeitsplakette am Kennzeichen kontrollieren, mit next_service_date im Auftrag abgleichen
- Häufige Mängel: Bremsscheiben korrodiert, Ölundichtigkeiten, defekte Beleuchtung, Achsspiel
- Bei Mängeln: Frist zur Nachbesserung beachten (i.d.R. 1 Monat für Nachprüfung)

**50. AdBlue/SCR-System**
*Trigger (Beispielmuster):* `/adblue/i`

- Warnmeldung "Restreichweite" ernst nehmen – bei leerem Tank verweigert der Motor nach Fahrtende den Neustart
- Nur AdBlue nach ISO 22241 verwenden (32,5% Harnstofflösung), Verunreinigung vermeiden
- Fehlercodes im SCR-System: oft Dosierventil, NOx-Sensor oder Tankheizung betroffen

**51. Anlasser/Startprobleme**
*Trigger (Beispielmuster):* `/anlasser|springt nicht an|startet nicht/i`

- Kein Geräusch beim Startversuch: Batterie, Massepunkte, Zündschloss/Starterrelais prüfen
- Klacken ohne Durchdrehen: Anlasser-Magnetschalter oder Ritzel defekt, oder Batterie zu schwach
- Motor dreht durch, springt aber nicht an: Kraftstoffversorgung, Zündung, Wegfahrsperre prüfen

**52. Lichtmaschine/Ladeproblem**
*Trigger (Beispielmuster):* `/lichtmaschine|generator|ladekontrolle/i`

- Ladekontrollleuchte an bei laufendem Motor: Ladespannung messen (Sollwert meist 13,5–14,8 V)
- Mögliche Ursachen: Keilrippenriemen gerissen/rutscht, Lichtmaschine oder Regler defekt
- Batterie entlädt sich trotz Fahrbetrieb: auf jeden Fall vor Batterietausch die Ladeleistung prüfen

**53. Scheibenwischer/Scheibenwaschanlage**
*Trigger (Beispielmuster):* `/scheibenwischer|scheibenwaschanlage/i`

- Schlierenbildung: Wischerblätter tauschen, Scheibe vorher fettfrei reinigen
- Waschanlage fördert nicht: Pumpe, Düsen (verstopft) und Sicherung prüfen
- Bei Frost: nur frostsicheres Scheibenreinigungsmittel verwenden (Frostschutzgrad prüfen)

**54. Auspuff/Abgasanlage – Rauchfarben-Diagnose**
*Trigger (Beispielmuster):* `/auspuff|abgasanlage|rauch\b/i`

- Blauer Rauch: Motor verbrennt Öl (Kolbenringe/Ventilschaftdichtungen)
- Weißer Rauch (dauerhaft, nicht nur Kondenswasser): Kühlmittel gelangt in Brennraum (Zylinderkopfdichtung)
- Schwarzer Rauch: Gemisch zu fett, oft Einspritzung oder Luftfilter betroffen
- Zusätzlich: Anlage auf Durchrostung/Undichtigkeiten und Aufhängung prüfen

---

## BMW – markenübergreifend

**55. BMW N47 (Diesel) – Steuerkettenverschleiß**
*Trigger (Beispielmuster):* `/n47.*(steuerkette|kette)|steuerkette.*n47|bmw.*(diesel).*kette/i`

- Betrifft v.a. BMW N47 (2007–2014, 118d/120d/318d/320d u.a.) – Steuerkette liegt motorseitig hinten, sehr aufwendiger Wechsel
- Anzeichen: Rasseln/Klappern beim Kaltstart, Fehlercode Nockenwellen-/Kurbelwellensensor-Korrelation
- Bei Kettenriss: Motortotalschaden (Interferenzmotor) möglich – bei Verdacht keine Probefahrt mehr
- Reparatur: Steuerkettensatz (Kette, Spanner, Führungsschienen) – Motor/Getriebe muss meist abgesenkt werden
- Arbeitszeit: ca. 8–12 Std. je nach Modell

**56. BMW N52/N54/N55 – Ventildeckeldichtung/Ölundichtigkeit**
*Trigger (Beispielmuster):* `/bmw.*(ventildeckel|öllecl|undicht)|ventildeckeldichtung.*bmw|n52|n54|n55/i`

- Klassische Ölleckage-Stelle bei vielen BMW-Reihenmotoren: Ventildeckeldichtung wird mit den Jahren spröde
- Kontrolle: Motor sauber machen, Probefahrt, danach auf frische Ölspuren am Ventildeckel/Zündspulenschächten prüfen
- Reparatur: Ventildeckeldichtung inkl. Zündspulendichtringe ersetzen
- Hinweis: Öl in Zündspulenschächten kann Zündaussetzer (P0300er-Codes) verursachen

**57. BMW VANOS – Nockenwellenverstellung**
*Trigger (Beispielmuster):* `/vanos/i`

- Anzeichen für Defekt: Rasseln im Kaltstart (Rasselgeräusch von vorne am Motor), Leistungsloch im mittleren Drehzahlbereich
- Häufige Ursache: Magnetventil verschlammt/verklebt (Ölverkokung), Dichtringe am VANOS-Kolben porös
- Prüfung: VANOS-Solltest per Diagnosegerät, Ölzustand/Ölwechselintervall prüfen
- Reparatur: VANOS-Magnetventile reinigen/tauschen, bei Verschleiß VANOS-Einheit überholen

**58. BMW – Elektrische Wasserpumpe**
*Trigger (Beispielmuster):* `/bmw.*(wasserpumpe|kühlmittelverlust)|elektrische wasserpumpe/i`

- Viele BMW-Reihenmotoren (u.a. N20, N51, N52, N54, N55) nutzen eine elektrische Wasserpumpe – typisches Verschleißteil
- Anzeichen: Temperaturschwankungen, Kühlmittelverlust ohne sichtbares Leck, Fehlercode Kühlmittelpumpe/Regelung
- Reparatur: Wasserpumpe komplett ersetzen (nicht reparierbar), gleichzeitig Thermostat prüfen
- Hinweis: nach Tausch Kühlsystem sorgfältig entlüften (BMW-spezifisches Befüllverfahren beachten)

**59. BMW N63/N63TU (V8) – bekannte Schwachstellen**
*Trigger (Beispielmuster):* `/n63|bmw.*v8.*(ölverbrauch|ölverlust)/i`

- Erhöhter Ölverbrauch: Ventilschaftdichtungen/Kolbenringe – bei manchen Baujahren Kulanz-/Rückrufaktionen möglich, VIN prüfen
- Abgaskrümmerdichtungen (innenliegend, zwischen den Zylinderbänken) undicht – Ansaugung von Abgas, Klopfgeräusch
- Hochdruckpumpe und Ladeluftkühler-Kondensat ebenfalls bekannte Ausfallpunkte
- Empfehlung: Ölstand bei jedem Service besonders im Blick behalten, kurze Ölwechselintervalle einhalten

**60. BMW N54/N55 – Hochdruckpumpe (HPFP)**
*Trigger (Beispielmuster):* `/n54|n55|hochdruckpumpe|hpfp/i`

- Bekannte Schwachstelle bei Direkteinspritzer-Motoren N54/N55 – Ausfall meist ohne Vorwarnung
- Anzeichen: Motor startet nicht/stirbt ab, Leistungsverlust, Fehlercode Kraftstoffdruck-Regelabweichung
- Reparatur: Hochdruckpumpe komplett ersetzen, Kraftstoffdrucksensor mitprüfen
- Hinweis: bei manchen Modelljahren gab es Werksgarantie-Verlängerung – VIN/Servicehistorie prüfen

---

## BMW E30 – Schaltplan/Verkabelung

**61. BMW E30 – Schaltplan-Übersicht (Verkabelungsschema)**
*Trigger (Beispielmuster):* `/e30.*(schaltplan|kabelbaum)|schaltplan.*e30|kabelbaum.*e30|e30.*farbcode|farbcode.*e30/i`

- Deckt ab: 3er E30 (316–325i, auch Touring/Cabrio), 5er E28 & E34 als Referenz
- Farbcodes im Schaltplan: BK=Schwarz, BL=Blau, BR/TN=Braun, GE/Y=Gelb, GN=Grün, GR/GY=Grau, OR=Orange, PK/RS=Rosa, R/RT=Rot, V/VI=Violett, W/WS=Weiß
- Enthaltene Schaltpläne: Starten/Laden/Hupe/Blinker (S.2) · Scheinwerfer/Nebelscheinwerfer/Innenlicht (S.3) · Check Control/Spiegel/Brems-Parklicht (S.4) · Motronic-Motorsteuerung (S.5–7) · Tempomat (S.8–9) · Zentralverriegelung/Alarm/Bordcomputer/Zusatzheizung/Uhr (S.10–12) · Scheinwerferwaschanlage (S.13–14) · elektrische Fenster (S.15–16) · Klimaanlage/Heizung (S.17–18) · Sitzheizung (S.19–20) · Memory-Sitze (S.21–23) · Sitze ohne Memory (S.24–25) · Radio (S.26–27) · L-Jetronic (S.28)
- Hinweis: Details (genaue Pinbelegung/Stecker) im hinterlegten PDF-Dokument nachschlagen
- &#128196; Komplettes Schaltplan-PDF öffnen

**62. BMW E30 – Motronic-Kabelbaum (Schaltplan S.5–7)**
*Trigger (Beispielmuster):* `/e30.*motronic|motronic.*e30/i`

- Zentrale Steuergeräte-Kennung: 1 = Elektronisches Steuergerät (ESG)
- Sensoren/Aktoren im Diagramm: Drosselklappenschalter (6), Luftstromsensor (7), Referenzmarkensensor (9), Kraftstoffeinspritzdüsen (25), Kühlmitteltemperatursensor (24), Öldruckschalter (12), elektrische Kraftstoffpumpe (30)
- Zündung/Start: Zündspule (19), Verteiler (18), Starter (20), Lichtmaschine (21)
- Diagnose: Diagnoseschaltung (14) am Motorstecker (15)

**63. BMW E30 – Zentralverriegelung/Alarmanlage/Bordcomputer (Schaltplan S.10–12)**
*Trigger (Beispielmuster):* `/e30.*(zentralverriegelung|zzv|alarm|bordcomputer)|zentralverriegelung.*e30/i`

- Steuereinheit: zentrale Schlosssteuereinheit (4), Steuergerät Einbruchmeldeanlage (27)
- Verriegelungsmotoren pro Tür einzeln verkabelt: Fahrertür (11), Beifahrertür (15), hintere Türen (21/25), Tankklappe (19), Kofferraum (17)
- Türkontaktschalter (35–38) und Haubenkontakt (39) laufen zentral auf das Alarmsteuergerät
- Bordcomputer-Anschluss an Instrumentencluster (61/63), Außentemperatursensor (53) und Digitaluhr (85)

**64. BMW E30 – Elektrische Fensterheber (Schaltplan S.15–16)**
*Trigger (Beispielmuster):* `/e30.*fensterheber|fensterheber.*e30/i`

- Relais (Pos. 20) versorgt die Fensterheber-Sammelschiene (31I/31II)
- Motoren einzeln je Tür: vorne links (16), vorne rechts (17), hinten links/rechts über separate Stecker (8/9)
- Sicherheitsschalter (14) und Kindersicherung (15) unterbrechen bei Bedarf die Steuerleitung
- Häufige Praxis-Ursache bei Ausfall: Kontaktprobleme an den Fensterheberschaltern oder der Steckverbindung in der Tür (Kabelbruch durch Türbewegung)

**65. BMW E30 – Klimaanlage/Heizung (Schaltplan S.17–18)**
*Trigger (Beispielmuster):* `/e30.*(klimaanlage|klima\b)|klimaanlage.*e30/i`

- Steuergerät Klimaanlage (16), Schalter Klimaanlage (13)
- Temperaturschalter zweistufig: 91°C Stufe I (11), 99°C Stufe II (12)
- Elektromagnetische Kupplung Kompressor (28) wird über Hochdruck-Pressostat (20) abgesichert
- Zusatzlüfter-Relais Stufe I/II (18/19) je nach Kühlmitteltemperatur

**66. BMW E30 – Sitzheizung & Memory-Sitze (Schaltplan S.19–23)**
*Trigger (Beispielmuster):* `/e30.*(sitzheizung|memory.*sitz|sitz.*memory)|sitzheizung.*e30/i`

- Sitzheizung: separate Schalter/Relais je Fahrer-/Beifahrerseite (Pos. 3/8), einfacher Stromkreis ohne Steuergerät
- Memory-Sitze: elektronisches Steuergerät unter dem Sitz (Pos. 14), Speicherschalter (Pos. 25) sichert Rückenlehnen-, Höhen- und Kopfstützenposition
- Motoren bei Memory-Sitzen: Rückenlehne, Höhe vorne/hinten, Kopfstütze – je eigener Kanal am Steuergerät

**67. BMW E30 – Radio-Verkabelung (Schaltplan S.26–27, frühe Modelle)**
*Trigger (Beispielmuster):* `/e30.*radio|radio.*e30/i`

- Lautsprecher: vorne links/rechts (Pos. 1/2), hinten links/rechts (Pos. 3/13), Türlautsprecher links/rechts (Pos. 7/8)
- Verstärker (Pos. 6) sitzt zwischen Radio und Lautsprechern bei entsprechender Ausstattung
- Stromantenne über eigene Steuerleitung (Pos. 10), Sondergeräte-Stecker RA12 für Nachrüstungen

**68. BMW E30 – L-Jetronic-Kabelbaum (Schaltplan S.28)**
*Trigger (Beispielmuster):* `/e30.*(l-jetronic|ljetronic)|l-jetronic.*e30/i`

- Einspritzsteuergerät (Pos. 11) verarbeitet Signale von Luftstromsensor (14), Drosselklappenschalter (13), Kühlmittelsensor (10)
- Kraftstoffpumpenrelais (Pos. 16) schaltet die Kraftstoffpumpe über Motorstecker-Pin C3/C13
- Zündung: Zündspule (3), Verteiler (2) mit Impulsgeber, Zündmodul (17)
- Diagnosestecker vorhanden für Fehlerauslesung am Steuergerät

---

## BMW E92

**69. BMW E92 – Hinterachse/Differential-Aufhängung**
*Trigger (Beispielmuster):* `/e92.*(hinterachse|differential|subframe)|hinterachse.*e92|subframe.*e92/i`

- Bekannte Schwachstelle bei E90/E92/E93: die Differential-Aufnahme kann aus dem Blech der Karosserie ausreißen (v.a. bei sportlicher Fahrweise/Leistungssteigerung)
- Anzeichen: dumpfes Klonken beim Gasgeben/-wegnehmen aus dem Heckbereich, sichtbare Risse am Blech bei Anhebung
- Prüfung: Fahrzeug anheben, Differential-Aufnahme und Hinterachsträger-Lagerung auf Risse/Verformung sichtprüfen
- Reparatur: bei bestätigtem Riss Verstärkungsblech/-kit einschweißen (kein reiner Teiletausch ausreichend)

**70. BMW E92 M3 (S65 V8) – Pleuellager-Verschleiß**
*Trigger (Beispielmuster):* `/s65|e92.*m3|m3.*e92|pleuellager/i`

- Bekanntes Thema beim S65-V8: erhöhter Verschleiß der Pleuellager, v.a. bei frühen Baujahren (2007–2008)
- Anzeichen: metallisches Klopfen/Rasseln aus dem Motorblock, oft last-/drehzahlabhängig, Warnleuchte Öldruck möglich
- Prüfung: unbedingt vor Kauf/nach Auffälligkeit Ölanalyse (Spektralanalyse auf Metallabrieb) und Motor-Abhörtest im Kaltstart
- Reparatur: bei bestätigtem Verschleiß Pleuellager satzweise tauschen (Motor muss dafür ausgebaut werden) – frühzeitige Diagnose spart Folgeschäden

**71. BMW N52 (u.a. E92 325i/328i/330i) – DISA-Ventil**
*Trigger (Beispielmuster):* `/disa|saugrohrklappe|ansaugbrücke.*rasseln/i`

- DISA-Ventil (variable Saugrohrgeometrie) klappert im Leerlauf/unteren Drehzahlbereich, wenn die interne Feder bricht oder Lager verschleißen
- Anzeichen: rasselndes/klackerndes Geräusch aus dem Ansaugbereich, meist bei ca. 2000–4000 U/min am deutlichsten
- Reparatur: DISA-Ventil-Reparatursatz (Feder+Lager) oder komplettes Ventil tauschen – kein Sicherheitsrisiko, aber Dauerbetrieb kann Kleinteile ins Saugrohr fallen lassen

**72. BMW E90/E92 – Fensterheber „One-Touch“-Ausfall**
*Trigger (Beispielmuster):* `/e92.*fensterheber|one.?touch.*fenster|fensterheber.*(reset|anlernen)/i`

- Typisches Symptom: Fenster lässt sich nur noch manuell (gehalten) auf/zu fahren, One-Touch-Automatik und Einklemmschutz reagieren nicht mehr
- Ursache meist: Fensterheber-Steuerung hat die Referenzposition verloren (z.B. nach Batterietrennung oder mechanischem Widerstand)
- Reparatur: Fensterheber neu anlernen – Fenster von Hand ganz hochfahren, Taste 3× über Anschlag halten (Anlernvorgang), je Tür einzeln wiederholen
- Bleibt der Fehler bestehen: Fensterheberschalter oder Steuergerät in der Tür prüfen

**73. BMW E92 335i (N54) – Ladeluftrohr/Chargepipe-Riss**
*Trigger (Beispielmuster):* `/e92.*(335i|n54).*(ladeluft|y-?rohr|chargepipe)|chargepipe|ladeluftrohr.*riss/i`

- Das werksseitige Kunststoff-Ladeluftrohr (Y-Pipe) zwischen den Turboladern neigt bei höherer Ladedrücken/Alterung zum Reißen
- Anzeichen: spürbarer Leistungsverlust, Fehlercode Ladedruck-Regelabweichung, teils hörbares Zischen unter Last
- Reparatur: Ladeluftrohr ersetzen – im Nachrüstmarkt sind verstärkte Aluminium-Chargepipes üblich (haltbarer als Original-Kunststoffteil)
- Zusätzlich prüfen: Wastegate-Rasseln im Leerlauf (separates, bekanntes N54-Thema, meist unkritisch aber hörbar störend)

---
