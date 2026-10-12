import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SOURCE_URL = 'https://www.rffm.es/competicion/clasificaciones?temporada=22&tipojuego=1&competicion=26737811&grupo=26737812';
export const TEAM_ID = '2277258';
const SEASON_ID = '22';
const SEASON = '2026-2027';
const COMPETITION_ID = '26737811';
const COMPETITION = 'DIVISIÓN DE HONOR INFANTIL';
const GROUP_ID = '26737812';
const GROUP = 'Grupo 1';
const TEAM_COUNT = 16;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function integerFromFederation(value, label, minimum = 0) {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && !/^-?\d+$/.test(value.trim()))) {
    throw new Error(`La Federación ha devuelto ${label} no reconocidos.`);
  }
  const result = Number(value);
  if (!validInteger(result, minimum)) throw new Error(`La Federación ha devuelto ${label} no válidos.`);
  return result;
}

function validTeams(teams) {
  return Array.isArray(teams) && teams.length === TEAM_COUNT
    && new Set(teams.map(team => team?.teamId)).size === TEAM_COUNT
    && new Set(teams.map(team => team?.position)).size === TEAM_COUNT
    && teams.some(team => team?.teamId === TEAM_ID)
    && teams.every(team => isObject(team) && typeof team.teamId === 'string' && /^[1-9]\d*$/.test(team.teamId)
      && typeof team.name === 'string' && team.name.trim().length > 0 && team.name.length <= 200
      && validInteger(team.position, 1) && team.position <= TEAM_COUNT
      && validInteger(team.played) && validInteger(team.points, Number.MIN_SAFE_INTEGER)
      && ['wins', 'draws', 'losses', 'goalsFor', 'goalsAgainst'].every(field => team[field] === undefined || validInteger(team[field])));
}

function validSavedStandings(value) {
  return isObject(value) && value.source?.url === SOURCE_URL
    && value.source?.name === 'Real Federación de Fútbol de Madrid'
    && value.season === SEASON && value.competition === COMPETITION && value.group === GROUP
    && validInteger(value.round) && value.round <= 30 && validDate(value.refreshedAt)
    && validTeams(value.teams);
}

/** Preserves official positions/points; no local tie-break or sanction calculations. */
export function parseStandingsHtml(html, refreshedAt = new Date().toISOString()) {
  const script = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!script) throw new Error('La página ya no contiene la clasificación en el formato esperado.');
  let data;
  try {
    data = JSON.parse(script[1]);
  } catch {
    throw new Error('No se ha podido leer la clasificación de la Federación.');
  }
  const page = data?.props?.pageProps;
  const table = page?.standings;
  // RFFM returns some 404 pages with HTTP 200: the route and all identity fields matter.
  if (!isObject(data) || data.page !== '/competicion/clasificaciones' || !isObject(table)
    || String(table.estado) !== '1' || String(table.sesion_ok) !== '1'
    || String(table.codigo_competicion) !== COMPETITION_ID || String(table.codigo_grupo) !== GROUP_ID
    || String(page?.season?.cod_temporada) !== SEASON_ID || page?.season?.nombre !== SEASON
    || String(page?.idGameType) !== '1' || typeof table.competicion !== 'string' || table.competicion.trim() !== COMPETITION
    || typeof table.grupo !== 'string' || table.grupo.trim() !== GROUP
    || String(data.query?.temporada) !== SEASON_ID || String(data.query?.tipojuego) !== '1'
    || String(data.query?.competicion) !== COMPETITION_ID || String(data.query?.grupo) !== GROUP_ID) {
    throw new Error('La Federación no ha devuelto la clasificación del grupo y temporada elegidos.');
  }
  if (!Array.isArray(table.clasificacion)) throw new Error('La clasificación de la Federación está incompleta.');
  const teams = table.clasificacion.map(team => {
    if (!isObject(team) || (typeof team.codequipo !== 'string' && typeof team.codequipo !== 'number')
      || typeof team.nombre !== 'string') throw new Error('La clasificación contiene un equipo incompleto.');
    return {
      teamId: String(team.codequipo), name: team.nombre.trim(),
      position: integerFromFederation(team.posicion, 'puestos', 1),
      played: integerFromFederation(team.jugados, 'partidos jugados'),
      points: integerFromFederation(team.puntos, 'puntos', Number.MIN_SAFE_INTEGER),
      wins: integerFromFederation(team.ganados, 'ganados'),
      draws: integerFromFederation(team.empatados, 'empatados'),
      losses: integerFromFederation(team.perdidos, 'perdidos'),
      goalsFor: integerFromFederation(team.goles_a_favor, 'goles a favor'),
      goalsAgainst: integerFromFederation(team.goles_en_contra, 'goles en contra'),

    };
  });
  if (!validTeams(teams)) throw new Error('La clasificación está incompleta, tiene duplicados o no contiene al equipo de prueba.');
  const round = integerFromFederation(table.jornada, 'datos de la jornada');
  if (round > 30 || !validDate(refreshedAt)) throw new Error('La jornada o fecha de lectura de la clasificación no es válida.');
  return {
    teams: teams.sort((left, right) => left.position - right.position), refreshedAt,
    source: { name: 'Real Federación de Fútbol de Madrid', url: SOURCE_URL },
    round, season: SEASON, competition: COMPETITION, group: GROUP,
  };
}

export async function createStandingsService({ cachePath, seedPath, fetchImpl = fetch, now = Date.now, maxAgeMs = MAX_AGE_MS }) {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  if (!validSavedStandings(seed)) throw new Error('La clasificación inicial no es válida.');
  const expectedTeamIds = new Set(seed.teams.map(team => team.teamId));
  let current = seed;
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    if (validSavedStandings(cached) && cached.teams.every(team => expectedTeamIds.has(team.teamId))
      && Date.parse(cached.refreshedAt) >= Date.parse(seed.refreshedAt)) current = cached;
  } catch { /* The verified source snapshot supports startup without a local cache. */ }
  let inFlight = null;
  let warning = null;
  let lastAttemptAt = null;
  const envelope = () => ({
    standings: current,
    stale: warning !== null || now() - Date.parse(current.refreshedAt) >= maxAgeMs,
    warning,
  });
  async function refresh() {
    try {
      const response = await fetchImpl(SOURCE_URL, {
        headers: { 'User-Agent': 'FutbolMister/0.1 (standings reader)', Accept: 'text/html' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`Respuesta HTTP ${response.status}.`);
      const next = parseStandingsHtml(await response.text(), new Date(now()).toISOString());
      if (!next.teams.every(team => expectedTeamIds.has(team.teamId))) {
        throw new Error('La fuente ha devuelto equipos de otro grupo.');
      }
      await mkdir(dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(temporary, cachePath);
      current = next;
      warning = null;
      return { ...envelope(), refreshed: true };
    } catch {
      warning = 'No se ha podido actualizar desde la Federación. Conservamos la última clasificación disponible; puedes volver a intentarlo.';
      return { ...envelope(), refreshed: false };
    }
  }
  return {
    async get({ force = false } = {}) {
      if (inFlight) return inFlight;
      if (!force && warning === null && now() - Date.parse(current.refreshedAt) < maxAgeMs) return envelope();
      if (lastAttemptAt !== null && now() - lastAttemptAt < RETRY_INTERVAL_MS) return { ...envelope(), refreshed: false };
      lastAttemptAt = now();
      inFlight = refresh().finally(() => { inFlight = null; });
      return inFlight;
    },
    peek: envelope,
  };
}
