/* Aufgaben eines Auftrags sinnvoll zusammenführen.
 *
 * Jede Dienstleistung bringt ihre eigene Aufgabenvorlage mit. Werden mehrere Dienstleistungen auf einen Auftrag gelegt
 * (z. B. „Bremsen vorne“ + „Bremsen hinten“), stünden Rüstarbeiten wie „Fahrzeug aufbocken“ oder „Räder montieren,
 * Probefahrt“ sonst doppelt in der Liste. Hier wird erkannt, was zusammengehört:
 *   - gleiche Arbeit (auch anders formuliert) → eine Aufgabe
 *   - Räder vorne + hinten demontieren → „Räder demontieren (vorne + hinten)“
 *   - Probefahrt nach der Montage deckt eine separate Probefahrt mit ab
 *   - sinnvolle Reihenfolge: vorbereiten → aufbocken → Räder ab → Arbeiten → Räder dran/Probefahrt → Service zurücksetzen → Abschlusskontrolle
 *
 * groupTasks()  – für bestehende OrderTask-Datensätze (Tablet-Ansicht, Status für alle Datensätze einer Gruppe)
 * planTasks()   – für neue Aufträge: legt pro Gruppe nur noch EINE Aufgabe an
 */

export function normTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Phase bestimmt die Position im Ablauf; Arbeiten (Phase 50) behalten die Reihenfolge der Dienstleistungen.
const RULES = [
  { key: 'prep', phase: 5, re: /^fahrzeug vorbereiten\b/, title: 'Fahrzeug vorbereiten' },
  { key: 'lift', phase: 10, re: /aufbock|auf (die )?hebebuehne|fahrzeug anheben|hebebuehne (auffahren|anheben)/, title: 'Fahrzeug aufbocken' },
  { key: 'wheels_off', phase: 20, re: /\b(vorder|hinter)?(raeder|rad|reifen) (demontieren|abnehmen|abbauen|abmontieren)\b/ },
  { key: 'wheels_on', phase: 80, re: /\b(raeder|rad) (montieren|anbauen|anschrauben)\b/ },
  { key: 'tire_pressure', phase: 78, re: /reifendruck/, title: 'Reifendruck prüfen' },
  { key: 'test_drive', phase: 85, re: /^(fahrwerk bremsen |abschluss )?probefahrt\b|probefahrt (durchfuehren|machen)$/, title: 'Probefahrt' },
  { key: 'service_reset', phase: 90, re: /service (intervall )?zuruecksetzen|serviceanzeige zuruecksetzen/, title: 'Service zurücksetzen' },
  { key: 'final_check', phase: 95, re: /^(abschlusskontrolle|endkontrolle)( durchfuehren)?$/, title: 'Abschlusskontrolle' },
];

function classify(title) {
  const n = normTitle(title);
  for (const r of RULES) if (r.re.test(n)) return { key: r.key, phase: r.phase, title: r.title || null, n };
  return { key: 't:' + n, phase: 50, title: null, n };
}

const axleOf = n => /\bvorder|\bvorne\b/.test(n) ? 'vorne' : (/\bhinter|\bhinten\b/.test(n) ? 'hinten' : null);

function groupTitle(key, members) {
  const ns = members.map(m => m.cls.n);
  if (key === 'wheels_off') {
    const axles = new Set(ns.map(axleOf));
    return axles.has('vorne') && axles.has('hinten') ? 'Räder demontieren (vorne + hinten)' : members[0].title;
  }
  if (key === 'wheels_on') return ns.some(n => /probefahrt/.test(n)) ? 'Räder montieren, Probefahrt' : 'Räder montieren';
  const rule = RULES.find(r => r.key === key);
  if (rule && rule.title && members.length > 1) return rule.title;
  return members[0].title;
}

/* Kern: Liste von { id?, title, service_id, service_pos, order_index, ... } → Gruppen in Arbeitsreihenfolge */
function buildGroups(items) {
  const groups = new Map();
  items.forEach((it, i) => {
    const cls = classify(it.title);
    const m = { ...it, cls, _i: i };
    if (!groups.has(cls.key)) groups.set(cls.key, { key: cls.key, phase: cls.phase, members: [] });
    groups.get(cls.key).members.push(m);
  });
  // Probefahrt nach dem Räder-Montieren deckt eine separate Probefahrt mit ab
  const on = groups.get('wheels_on'), td = groups.get('test_drive');
  if (on && td && on.members.some(m => /probefahrt/.test(m.cls.n))) { on.members.push(...td.members); groups.delete('test_drive'); }
  const pos = m => [m.service_pos ?? 0, Number(m.order_index) || 0, m._i];
  const cmp = (a, b) => { const x = pos(a), y = pos(b); for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; };
  const list = [...groups.values()];
  list.forEach(g => { g.members.sort(cmp); g.title = groupTitle(g.key, g.members); });
  list.sort((a, b) => a.phase - b.phase || cmp(a.members[0], b.members[0]));
  return list;
}

function aggregateStatus(key, members) {
  const st = members.map(m => m.status || 'offen');
  if (st.every(s => s === 'erledigt')) return 'erledigt';
  // Gleiche Arbeit, die nur doppelt angelegt war (z. B. aufbocken): einmal erledigt = erledigt.
  // Räder vorne/hinten sind echte Teilschritte → erst fertig, wenn alle fertig sind.
  if (key !== 'wheels_off' && st.some(s => s === 'erledigt')) return 'erledigt';
  if (st.some(s => s !== 'offen')) return 'in_arbeit';
  return 'offen';
}

/* Bestehende Aufgaben EINES Auftrags → zusammengeführte Ansicht.
 * Gibt pro Gruppe einen Datensatz mit der ID der ersten Aufgabe zurück, plus merged_ids für den Statusabgleich.
 * serviceName(id) liefert optional den Namen der Dienstleistung für den Hinweis „Gilt für …“. */
export function groupTasks(tasks, serviceName) {
  // Herkunft einer Aufgabe: Dienstleistung, bei älteren Datensätzen ohne service_id der gemeinsame Anlage-Zeitpunkt der Vorlage
  const src = t => t.service_id || (t.created_date ? 'c:' + String(t.created_date).slice(0, 19) : '');
  const srcOrder = [];
  for (const t of [...tasks].sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')) || (a.order_index || 0) - (b.order_index || 0)))
    if (!srcOrder.includes(src(t))) srcOrder.push(src(t));
  const items = tasks.map(t => ({ ...t, service_pos: srcOrder.indexOf(src(t)) }));
  return buildGroups(items).map((g, i) => {
    const [first] = g.members;
    const { cls, _i, service_pos, ...base } = first;
    const out = { ...base, order_index: i + 1 };
    if (g.members.length > 1) {
      const svcIds = [...new Set(g.members.map(m => m.service_id).filter(Boolean))];
      out.title = g.title;
      out.status = aggregateStatus(g.key, g.members);
      out.estimated_minutes = Math.max(...g.members.map(m => Number(m.estimated_minutes) || 0));
      out.merged_ids = g.members.map(m => m.id);
      if (out.status === 'erledigt') {
        const last = g.members.filter(m => m.status === 'erledigt').reduce((a, b) => String(b.completed_date || '') > String(a.completed_date || '') ? b : a);
        out.completed_by = last.completed_by || out.completed_by; out.completed_date = last.completed_date || out.completed_date;
      }
      const names = serviceName ? svcIds.map(serviceName).filter(Boolean) : [];
      const descs = [...new Set(g.members.map(m => String(m.description || '').trim()).filter(Boolean))];
      if (names.length > 1) descs.push(`Einmal für alle: ${names.join(' + ')}`);
      out.description = descs.join('\n') || null;
      // Gemeinsame Rüstarbeit über verschiedene Leistungen → Kategorie aus dem Titel ableiten, nicht „Bremse“ o. ä.
      if (svcIds.length > 1) delete out.category;
    }
    return out;
  });
}

/* IDs, deren Status beim Ändern von taskId mitgezogen werden muss (inkl. taskId selbst). */
export function siblingIds(tasks, taskId) {
  const g = groupTasks(tasks).find(t => (t.merged_ids || [t.id]).includes(taskId));
  return g ? (g.merged_ids || [g.id]) : [taskId];
}

/* Neue Aufträge: Vorlagen mehrerer Dienstleistungen → bereinigte Aufgabenliste (ohne IDs).
 * templatesByService: [{ service_id, templates: [ServiceTaskTemplate…] }] in der gewählten Reihenfolge. */
export function planTasks(templatesByService) {
  const items = [];
  templatesByService.forEach(({ service_id, templates }, sp) =>
    (templates || []).forEach(t => items.push({ title: t.title, description: t.description || '', estimated_minutes: Number(t.estimated_minutes) || 0, order_index: Number(t.order_index) || 0, service_id, service_pos: sp })));
  let groups = buildGroups(items);
  // Grobe Sammelaufgabe weglassen, wenn die Einzelschritte schon drin sind (Inspektion + Ölwechsel)
  const has = re => groups.some(g => re.test(g.members[0].cls.n));
  if (has(/^oel ablassen$/) && has(/oelfilter/)) groups = groups.filter(g => g.members[0].cls.n !== 'oel und filter wechseln');
  return groups.map((g, i) => {
    const svcIds = [...new Set(g.members.map(m => m.service_id).filter(Boolean))];
    const descs = [...new Set(g.members.map(m => String(m.description || '').trim()).filter(Boolean))];
    return {
      title: g.title, description: descs.join('\n'), order_index: i + 1,
      estimated_minutes: Math.max(...g.members.map(m => m.estimated_minutes || 0)),
      // gemeinsame Rüstarbeit gehört keiner einzelnen Leistung
      service_id: svcIds.length === 1 ? svcIds[0] : null,
    };
  });
}
