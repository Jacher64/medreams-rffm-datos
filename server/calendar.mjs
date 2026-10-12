import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SOURCE_URL = 'https://www.rffm.es/competicion/calendario?temporada=22&tipojuego=1&competicion=26737811&grupo=26737812';
export const TEAM_ID = '2277258';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function dateFromFederation(value) {
  if (!value) return null;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) throw new Error('La Federación ha devuelto una fecha no reconocida.');
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso) {
    throw new Error('La Federación ha devuelto una fecha inválida.');
  }
  return iso;
}

function score(value) {
  if (value === '' || value == null) return null;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0) throw new Error('Marcador no reconocido.');
  return result;
}

export function parseCalendarHtml(html, refreshedAt = new Date().toISOString()) {
  const script = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!script) throw new Error('La página ya no contiene el calendario en el formato esperado.');
  let calendar;
  try {
    calendar = JSON.parse(script[1]).props?.pageProps?.calendar;
  } catch {
    throw new Error('No se ha podido leer el calendario de la Federación.');
  }
  if (!calendar || !Array.isArray(calendar.rounds) || !calendar.competicion || !calendar.temporada || !calendar.grupo) {
    throw new Error('La Federación no ha devuelto un calendario válido.');
  }
  const matches = [];
  const names = new Set();
  const ids = new Set();
  for (const round of calendar.rounds) {
    if (!Array.isArray(round.equipos)) throw new Error('Jornada sin encuentros válidos.');
    for (const item of round.equipos) {
      const home = String(item.codigo_equipo_local) === TEAM_ID;
      const away = String(item.codigo_equipo_visitante) === TEAM_ID;
      if (!home && !away) continue;
      if (home && away) throw new Error('Un encuentro tiene el mismo equipo en ambos lados.');
      const homeTeam = { id: String(item.codigo_equipo_local), name: item.equipo_local };
      const awayTeam = { id: String(item.codigo_equipo_visitante), name: item.equipo_visitante };
      if (!homeTeam.name || !awayTeam.name || !item.codacta) throw new Error('Un encuentro está incompleto.');
      const id = String(item.codacta);
      if (ids.has(id)) throw new Error('El calendario contiene partidos duplicados.');
      ids.add(id);
      names.add(home ? homeTeam.name : awayTeam.name);
      const roundNumber = Number(round.codjornada);
      if (!Number.isInteger(roundNumber) || roundNumber < 1) throw new Error('Número de jornada no reconocido.');
      const kickoff = item.hora || null;
      if (kickoff && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(kickoff)) throw new Error('Hora no reconocida.');
      matches.push({
        id, round: roundNumber, date: dateFromFederation(item.fecha), kickoff,
        venue: item.campo || null, homeTeam, awayTeam,
        homeScore: score(item.goles_casa), awayScore: score(item.goles_visitante),
        side: home ? 'home' : 'away', opponent: home ? awayTeam : homeTeam,
      });
    }
  }
  if (!matches.length || names.size !== 1) throw new Error('No se ha encontrado el equipo de prueba en este calendario.');
  return {
    source: { name: 'Real Federación de Fútbol de Madrid', url: SOURCE_URL },
    competition: calendar.competicion, group: calendar.grupo, season: calendar.temporada,
    team: { id: TEAM_ID, name: [...names][0] }, refreshedAt,
    matches: matches.sort((a, b) => a.round - b.round),
  };
}

function validSavedCalendar(value) {
  return value?.team?.id === TEAM_ID && value?.source?.url === SOURCE_URL &&
    value?.season === '2026-2027' && Array.isArray(value?.matches) && value.matches.length > 0 &&
    Number.isFinite(Date.parse(value.refreshedAt)) &&
    new Set(value.matches.map(match => match.id)).size === value.matches.length &&
    new Set(value.matches.map(match => match.round)).size === value.matches.length &&
    value.matches.every(match => match.id && Number.isInteger(match.round) && match.opponent?.name &&
      match.homeTeam?.name && match.awayTeam?.name && ['home', 'away'].includes(match.side));
}

export async function createCalendarService({ cachePath, seedPath, fetchImpl = fetch, now = Date.now, maxAgeMs = MAX_AGE_MS }) {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  if (!validSavedCalendar(seed)) throw new Error('El calendario inicial no es válido.');
  let current = seed;
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    if (validSavedCalendar(cached) && cached.matches.length === seed.matches.length &&
        cached.competition === seed.competition && cached.group === seed.group && Date.parse(cached.refreshedAt) >= Date.parse(seed.refreshedAt)) current = cached;
  } catch { /* La semilla permite arrancar aunque falte la caché local. */ }
  let inFlight = null;
  let warning = null;
  let lastFailedAt = 0;
  const envelope = () => ({ calendar: current, stale: Boolean(warning) || now() - Date.parse(current.refreshedAt) >= maxAgeMs, warning });
  async function refresh() {
    try {
      const response = await fetchImpl(SOURCE_URL, {
        headers: { 'User-Agent': 'FutbolMister/0.1 (calendar reader)', Accept: 'text/html' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`Respuesta HTTP ${response.status}.`);
      const next = parseCalendarHtml(await response.text(), new Date(now()).toISOString());
      // Una respuesta de otro calendario nunca sustituye el del equipo elegido.
      if (next.season !== current.season || next.competition !== current.competition || next.group !== current.group) {
        throw new Error('La fuente ha devuelto una competición diferente.');
      }
      if (next.matches.length !== seed.matches.length ||
          new Set(next.matches.map(match => match.round)).size !== seed.matches.length) {
        throw new Error('La fuente ha devuelto un calendario incompleto.');
      }
      await mkdir(dirname(cachePath), { recursive: true });
      const tempPath = `${cachePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tempPath, cachePath);
      current = next;
      warning = null;
      lastFailedAt = 0;
      return { ...envelope(), refreshed: true };
    } catch {
      lastFailedAt = now();
      warning = 'No se ha podido actualizar desde la Federación. Conservamos el último calendario disponible; puedes volver a intentarlo.';
      return { ...envelope(), refreshed: false };
    }
  }
  return {
    async get({ force = false } = {}) {
      if (!force && now() - Date.parse(current.refreshedAt) < maxAgeMs) return envelope();
      if (!force && lastFailedAt && now() - lastFailedAt < 60000) return envelope();
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      return inFlight;
    },
    peek: envelope,
  };
}
