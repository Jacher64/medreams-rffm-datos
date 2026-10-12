import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCalendarHtml, SOURCE_URL as calendarUrl } from '../server/calendar.mjs';
import { parseStandingsHtml, SOURCE_URL as standingsUrl } from '../server/standings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Publish one complete pair. A failed/partial read leaves the last publication intact. */
export async function syncFederation({ fetchImpl = fetch, destination = resolve(root, 'public/federation/latest.json'), now = Date.now } = {}) {
  const seed = JSON.parse(await readFile(resolve(root, 'data/calendar-seed.json'), 'utf8'));
  const updatedAt = new Date(now()).toISOString();
  const read = async (url, parser) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error(`RFFM: HTTP ${response.status}`);
    return parser(await response.text(), updatedAt);
  };
  const [calendar, standings] = await Promise.all([read(calendarUrl, parseCalendarHtml), read(standingsUrl, parseStandingsHtml)]);
  const matches = new Map(seed.matches.map(match => [match.id, match]));
  const teamIds = new Set([seed.team.id, ...seed.matches.map(match => match.opponent.id)]);
  if (calendar.matches.length !== matches.size || calendar.season !== seed.season || calendar.competition !== seed.competition || calendar.group !== seed.group
    || !calendar.matches.every(match => { const expected = matches.get(match.id); return expected && expected.round === match.round && expected.opponent.id === match.opponent.id && expected.side === match.side; })
    || standings.season !== calendar.season || standings.competition !== calendar.competition || standings.group !== calendar.group
    || standings.teams.length !== teamIds.size || !standings.teams.every(team => teamIds.has(team.teamId))) {
    throw new Error('La publicación no contiene el calendario y la clasificación completos del mismo grupo.');
  }
  let previous;
  try { previous = JSON.parse(await readFile(destination, 'utf8')); } catch { /* First publication. */ }
  if (previous?.standings?.round > standings.round) throw new Error('La fuente devuelve una jornada anterior a la ya publicada.');
  const payload = { version: 1, updatedAt, calendar, standings };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(`${destination}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(`${destination}.tmp`, destination);
  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = await syncFederation();
  console.log(`RFFM publicada: jornada ${payload.standings.round}, ${payload.calendar.matches.length} encuentros, consulta ${payload.updatedAt}`);
}
