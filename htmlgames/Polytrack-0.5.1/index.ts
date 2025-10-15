import { queryAll, queryFirst, execute } from './db';
import {
  emptyResponse,
  errorResponse,
  jsonError,
  jsonResponse as json,
  parseFormBody,
  parseInteger,
  preflightResponse,
  HttpError,
} from './http';

export interface Env {
  DB: D1Database;
  DEV_MODE?: string;
  DEV_ALLOWED_ORIGINS?: string;
}

const MAX_FRAMES = 5_999_999;
const LEADERBOARD_LIMIT = 10;
const MAX_RECORDING_BATCH = 25;
const TRUE_VALUES = new Set(['true', '1', 'yes']);
const FALSE_VALUES = new Set(['false', '0', 'no']);

const OFFICIAL_TRACK_IDS = [
  'desert1',
  'desert2',
  'desert3',
  'desert4',
  'summer1',
  'summer2',
  'summer3',
  'summer4',
  'summer5',
  'summer6',
  'summer7',
  'winter1',
  'winter2',
  'winter3',
  'winter4',
];

const COMMUNITY_TRACK_IDS = [
  '90_reset',
  'alpine_descent',
  'anubis',
  'arabica',
  'asguardia',
  'clay_temples',
  'concrete_jungle',
  'desert_stallion',
  'flying_dreams',
  'ghost_city',
  'hyperions_sanctuary',
  'japan',
  'joenail_jones',
  'las_calles',
  'last_remnant',
  'lu_muvimento',
  'malformations',
  'mos_espa',
  'natsujo',
  'natures_sanctuary',
  'opal_place_ii',
  'oxygen_not_included',
  'pavlova_dip',
  're_akina',
  'sandline_ultimatum',
  'snow_park',
  'winter_hollow',
  'winterfell',
];

const CANONICAL_TRACK_IDS = new Set<string>([...OFFICIAL_TRACK_IDS, ...COMMUNITY_TRACK_IDS]);

const ALLOWED_SITE_PATHS: Record<string, string[]> = {
  'sites.google.com': ['/view/poly-track', '/view/poly-track/poly-track'],
  'htmlunblockedgames.github.io': ['/polytrack-0.5.1'],
  'polytrack-0-5-1.pages.dev': ['/'],
};

const DB = {
  upsertUser: `
    INSERT INTO users (token, token_hash, name, car_colors, is_verifier, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, unixepoch(), unixepoch())
    ON CONFLICT(token) DO UPDATE SET
      token_hash = excluded.token_hash,
      name = excluded.name,
      car_colors = excluded.car_colors,
      updated_at = unixepoch()
  `,
  selectUserByToken: 'SELECT id FROM users WHERE token = ?',
  selectUserProfile: 'SELECT name, car_colors, is_verifier FROM users WHERE token = ?',
  selectTrackByHash: 'SELECT hash, track_id, version, enabled FROM tracks WHERE hash = ? LIMIT 1',
  selectTrackByIdVersion: `
    SELECT hash, track_id, version, enabled
    FROM tracks
    WHERE track_id = ?
      AND version = ?
    LIMIT 1
  `,
  selectExistingEntry: 'SELECT id, frames, recording_id FROM leaderboard_entries WHERE track_id = ? AND user_id = ?',
  insertRecording: 'INSERT INTO recordings (track_id, user_id, frames, recording, verified_state, created_at) VALUES (?, ?, ?, ?, 1, unixepoch())',
  updateLeaderboardEntry: 'UPDATE leaderboard_entries SET recording_id = ?, frames = ?, verified_state = 1, updated_at = unixepoch() WHERE id = ?',
  deleteRecordingById: 'DELETE FROM recordings WHERE id = ?',
  insertLeaderboardEntry: 'INSERT INTO leaderboard_entries (track_id, user_id, recording_id, frames, verified_state, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NULL, unixepoch(), unixepoch())',
  deleteOverflowLeaderboardEntries: `
    WITH retained AS (
      SELECT le.id
      FROM leaderboard_entries le
      WHERE le.track_id = ?
      ORDER BY le.frames ASC, le.updated_at ASC, le.id ASC
      LIMIT ?
    )
    DELETE FROM leaderboard_entries
    WHERE track_id = ?
      AND id NOT IN (SELECT id FROM retained)
    RETURNING recording_id
  `,
  selectLeaderboardTotals: (filterClause: string) => `
    SELECT COUNT(*) AS total FROM leaderboard_entries le WHERE le.track_id = ? ${filterClause}
  `,
  selectLeaderboardEntries: (filterClause: string) => `
    SELECT
      le.recording_id AS recordingId,
      le.frames AS frames,
      le.verified_state AS verifiedState,
      u.token_hash AS tokenHash,
      u.name AS name,
      u.car_colors AS carColors
    FROM leaderboard_entries le
    JOIN users u ON u.id = le.user_id
    WHERE le.track_id = ? ${filterClause}
    ORDER BY le.frames ASC, le.updated_at ASC, le.id ASC
    LIMIT ? OFFSET ?
  `,
  selectUserLeaderboardEntry: (filterClause: string, peerFilterClause: string) => `
    SELECT
      le.recording_id AS recordingId,
      le.frames AS frames,
      1 + (
        SELECT COUNT(*)
        FROM leaderboard_entries le2
        WHERE le2.track_id = le.track_id
          ${peerFilterClause}
          AND (
            le2.frames < le.frames
            OR (le2.frames = le.frames AND (
              le2.updated_at < le.updated_at
              OR (le2.updated_at = le.updated_at AND le2.id < le.id)
            ))
          )
      ) AS position
    FROM leaderboard_entries le
    JOIN users u ON u.id = le.user_id
    WHERE le.track_id = ? ${filterClause}
      AND u.token_hash = ?
    LIMIT 1
  `,
  selectRecordingsByIds: (placeholders: string) => `
    SELECT r.id, r.recording, r.frames, r.verified_state, u.car_colors
    FROM recordings r
    JOIN users u ON u.id = r.user_id
    WHERE r.id IN (${placeholders})
  `,
  selectTopLeaderboard: `
    SELECT le.recording_id, le.frames, u.name
    FROM leaderboard_entries le
    JOIN users u ON u.id = le.user_id
    WHERE le.track_id = ?
    ORDER BY le.frames ASC, le.updated_at ASC, le.id ASC
    LIMIT ?
  `,
};

type Primitive = string | number | boolean | null;

type JsonObject = Record<string, unknown>;

type DevAllowlist = {
  origins: Set<string>;
  hosts: Set<string>;
};

type TrackRow = {
  hash: string;
  track_id: string;
  version: string | null;
  enabled: number;
};

interface ResolvedTrack {
  trackId: string;
  trackHash: string;
  version: string;
}

function parseBoolean(value: string | null | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function isDevMode(env: Env): boolean {
  return parseBoolean(env.DEV_MODE, false);
}

function normalizeTrackId(trackId: string): string {
  return trackId.trim().toLowerCase();
}

function normalizeTrackHash(hash: string): string {
  return hash.trim().toLowerCase();
}

function normalizeVersion(version: string): string {
  return version.trim();
}

function parseJsonObjectFromText(value: Primitive | JsonObject): JsonObject {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
    } catch {
      return {};
    }
    return {};
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function normalizeCarColorsInput(value: unknown): JsonObject | null {
  if (value === undefined || value === null) {
    return null;
  }

  let input: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      input = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as JsonObject;
  }

  return null;
}

function normalizePathname(urlValue: string | null | undefined): string | null {
  if (!urlValue) {
    return null;
  }

  try {
    const url = new URL(urlValue);
    return url.pathname || '/';
  } catch {
    return null;
  }
}

function matchesAllowedPathForHost(host: string, urlValue: string | null | undefined): boolean {
  if (!urlValue) {
    return false;
  }

  const allowedPaths = ALLOWED_SITE_PATHS[host];
  if (!allowedPaths || allowedPaths.length === 0) {
    return false;
  }

  const pathname = normalizePathname(urlValue);
  if (!pathname) {
    return false;
  }

  try {
    const url = new URL(urlValue);
    if (url.host !== host) {
      return false;
    }
  } catch {
    return false;
  }

  for (const allowedPath of allowedPaths) {
    if (allowedPath === '/') {
      return true;
    }
    if (pathname === allowedPath || pathname.startsWith(`${allowedPath}/`)) {
      return true;
    }
  }

  return false;
}

function contextAllowed(host: string, contextUrls: Array<string | null | undefined>): boolean {
  for (const urlValue of contextUrls) {
    if (matchesAllowedPathForHost(host, urlValue)) {
      return true;
    }
  }
  return false;
}

function allowedContextForHost(host: string | null, contextUrls: Array<string | null | undefined>): boolean {
  if (!host) {
    return false;
  }
  return contextAllowed(host, contextUrls);
}

function buildDevAllowlist(env: Env): DevAllowlist {
  const origins = new Set<string>();
  const hosts = new Set<string>();

  const raw = env.DEV_ALLOWED_ORIGINS;
  if (!raw) {
    return { origins, hosts };
  }

  for (const entry of raw.split(',')) {
    const value = entry.trim().toLowerCase();
    if (!value) {
      continue;
    }
    if (value.includes('://')) {
      try {
        const url = new URL(value);
        origins.add(url.origin.toLowerCase());
        if (url.host) {
          hosts.add(url.host.toLowerCase());
        }
      } catch {
        // Ignore invalid
      }
      continue;
    }

    hosts.add(value);
  }

  return { origins, hosts };
}

function devMatches(value: string | null | undefined, allowlist: DevAllowlist): boolean {
  if (!value) {
    return false;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  if (allowlist.origins.has(trimmed)) {
    return true;
  }

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (allowlist.origins.has(url.origin.toLowerCase())) {
      return true;
    }
    if (allowlist.hosts.has(url.host.toLowerCase())) {
      return true;
    }
  } catch {
    if (allowlist.hosts.has(trimmed)) {
      return true;
    }
  }

  return allowlist.hosts.has(trimmed);
}

function getHostFromOrigin(origin: string | null | undefined): string | null {
  if (!origin) {
    return null;
  }

  try {
    const url = new URL(origin);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function allowedOriginForRequest(env: Env, request: Request): string | null {
  const originHeader = request.headers.get('Origin');
  const devMode = isDevMode(env);
  const devAllowlist = buildDevAllowlist(env);

  if (devMode) {
    return originHeader ?? '*';
  }

  const referer = request.headers.get('Referer');
  const embedParent = request.headers.get('x-embed-parent');
  const embedAncestor = request.headers.get('x-embed-ancestor');
  const embedHint = request.headers.get('x-embed-hint');

  if (
    devMatches(originHeader, devAllowlist) ||
    devMatches(referer, devAllowlist) ||
    devMatches(embedParent, devAllowlist) ||
    devMatches(embedAncestor, devAllowlist) ||
    devMatches(embedHint, devAllowlist)
  ) {
    return originHeader ?? '*';
  }

  const host = getHostFromOrigin(originHeader);
  if (!host || !ALLOWED_SITE_PATHS[host]) {
    return null;
  }

  if (!allowedContextForHost(host, [referer, embedParent, embedAncestor, embedHint])) {
    return null;
  }

  return originHeader ?? '*';
}

function allowedOriginForPreflight(env: Env, request: Request): string | null {
  const originHeader = request.headers.get('Origin');
  const devMode = isDevMode(env);
  const devAllowlist = buildDevAllowlist(env);

  if (devMode) {
    return originHeader ?? '*';
  }

  const referer = request.headers.get('Referer');
  const embedParent = request.headers.get('x-embed-parent');
  const embedAncestor = request.headers.get('x-embed-ancestor');
  const embedHint = request.headers.get('x-embed-hint');

  if (
    devMatches(originHeader, devAllowlist) ||
    devMatches(referer, devAllowlist) ||
    devMatches(embedParent, devAllowlist) ||
    devMatches(embedAncestor, devAllowlist) ||
    devMatches(embedHint, devAllowlist)
  ) {
    return originHeader ?? '*';
  }

  const host = getHostFromOrigin(originHeader);
  if (!host || !ALLOWED_SITE_PATHS[host]) {
    return null;
  }

  if (!allowedContextForHost(host, [referer, embedParent, embedAncestor, embedHint])) {
    return null;
  }

  return originHeader ?? '*';
}

function resolveAllowedOrigin(env: Env, request: Request): string | null {
  return allowedOriginForRequest(env, request);
}

function nameIsValid(value: string): boolean {
  return value.length > 0 && value.length <= 50;
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveTrack(env: Env, input: {
  trackId?: string | null;
  trackHash?: string | null;
  version?: string | null;
}): Promise<ResolvedTrack> {
  const devMode = isDevMode(env);
  const trackIdInput = input.trackId ? normalizeTrackId(input.trackId) : null;
  const trackHashInput = input.trackHash ? normalizeTrackHash(input.trackHash) : null;
  const versionInput = input.version ? normalizeVersion(input.version) : null;

  if (!trackIdInput && !trackHashInput) {
    throw new HttpError(400, 'TRACK_ID_REQUIRED', 'trackId or trackHash is required');
  }

  if (trackHashInput) {
    const row = await queryFirst<TrackRow | null>(env.DB, DB.selectTrackByHash, [trackHashInput]);
    if (!row) {
      throw new HttpError(400, 'TRACK_HASH_UNKNOWN', 'Unknown track hash');
    }

    if (!devMode && row.enabled !== 1) {
      throw new HttpError(403, 'TRACK_DISABLED', 'Track is disabled');
    }

    const resolvedTrackId = normalizeTrackId(row.track_id);
    if (trackIdInput && trackIdInput !== resolvedTrackId) {
      throw new HttpError(400, 'TRACK_MISMATCH', 'trackId does not match trackHash');
    }

    if (versionInput && row.version && row.version !== versionInput) {
      throw new HttpError(400, 'TRACK_VERSION_MISMATCH', 'Version mismatch for track');
    }

    return {
      trackId: resolvedTrackId,
      trackHash: trackHashInput,
      version: row.version ? normalizeVersion(row.version) : versionInput ?? '',
    };
  }

  if (!versionInput) {
    throw new HttpError(400, 'VERSION_REQUIRED', 'version is required');
  }

  if (!trackIdInput) {
    throw new HttpError(400, 'TRACK_ID_REQUIRED', 'trackId is required');
  }

  const row = await queryFirst<TrackRow | null>(env.DB, DB.selectTrackByIdVersion, [trackIdInput, versionInput]);
  if (!row) {
    throw new HttpError(404, 'TRACK_NOT_FOUND', 'Track not found');
  }

  if (!devMode && row.enabled !== 1) {
    throw new HttpError(403, 'TRACK_DISABLED', 'Track is disabled');
  }

  const hash = row.hash ? normalizeTrackHash(row.hash) : trackHashInput;
  if (trackHashInput && hash && trackHashInput !== hash) {
    throw new HttpError(400, 'TRACK_HASH_MISMATCH', 'Provided trackHash does not match record');
  }

  return {
    trackId: normalizeTrackId(row.track_id),
    trackHash: hash ?? trackIdInput,
    version: row.version ? normalizeVersion(row.version) : versionInput,
  };
}

async function resolveTrackWithDevFallback(env: Env, input: {
  trackId?: string | null;
  trackHash?: string | null;
  version?: string | null;
}): Promise<ResolvedTrack> {
  try {
    return await resolveTrack(env, input);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === 'TRACK_NOT_FOUND' &&
      isDevMode(env)
    ) {
      const trackIdInput = input.trackId ? normalizeTrackId(input.trackId) : null;
      const versionInput = input.version ? normalizeVersion(input.version) : '';
      if (trackIdInput && CANONICAL_TRACK_IDS.has(trackIdInput)) {
        return {
          trackId: trackIdInput,
          trackHash: trackIdInput,
          version: versionInput,
        };
      }
    }
    throw error;
  }
}

async function parseRequestBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await request.text();
    if (!text) {
      return {};
    }
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
      return {};
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'Invalid JSON body');
    }
  }

  const form = await parseFormBody(request);
  const result: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (result[key] === undefined) {
      result[key] = value;
      continue;
    }
    const existing = result[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

function pickFirst<T>(...values: Array<T | null | undefined | T[]>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        if (value.length > 0) {
          return value[0] as T;
        }
        continue;
      }
      return value as T;
    }
  }
  return undefined;
}

function methodNotAllowed(method: string, allowed: string[], corsOrigin: string | null): Response {
  const response = jsonError(405, 'METHOD_NOT_ALLOWED', { method, allowed }, { corsOrigin: corsOrigin ?? 'null' });
  response.headers.set('Allow', allowed.join(', '));
  return response;
}

function notImplemented(message: string, corsOrigin: string | null): Response {
  return jsonError(501, 'NOT_IMPLEMENTED', { message }, { corsOrigin: corsOrigin ?? 'null' });
}

function readIntegerParam(params: URLSearchParams, key: string, defaultValue: number, {
  min,
  max,
  code,
  message,
}: {
  min?: number;
  max?: number;
  code: string;
  message: string;
}): number {
  const raw = params.get(key);
  if (raw === null || raw === '') {
    return defaultValue;
  }

  let parsed: number;
  try {
    parsed = parseInteger(raw, key);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(400, code, message);
    }
    throw error;
  }

  if (min !== undefined && parsed < min) {
    throw new HttpError(400, code, message);
  }

  if (max !== undefined && parsed > max) {
    throw new HttpError(400, code, message);
  }

  return parsed;
}

function parseBooleanParam(params: URLSearchParams, key: string, defaultValue: boolean): boolean {
  const raw = params.get(key);
  return parseBoolean(raw, defaultValue);
}

function getRequiredParam(
  params: URLSearchParams,
  key: string,
  code: string,
  message: string,
): string {
  const value = params.get(key);
  if (value === null) {
    throw new HttpError(400, code, message);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, code, message);
  }
  return trimmed;
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(env, request) ?? '*';
  const row = await queryFirst<{ now: string } | null>(env.DB, 'SELECT datetime("now") AS now');
  return json({ status: 'ok', now: row?.now ?? null }, { corsOrigin });
}

async function handleGetLeaderboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const corsOrigin = resolveAllowedOrigin(env, request);
  if (!corsOrigin) {
    return jsonError(
      403,
      'ORIGIN_NOT_ALLOWED',
      { message: 'Leaderboard access is restricted to approved sites.' },
      { corsOrigin: 'null' },
    );
  }

  const version = getRequiredParam(url.searchParams, 'version', 'VERSION_REQUIRED', 'version is required');
  const trackId = url.searchParams.get('trackId') ?? url.searchParams.get('track_id');
  const trackHash = url.searchParams.get('trackHash') ?? url.searchParams.get('track_hash');

  const skip = readIntegerParam(url.searchParams, 'skip', 0, {
    min: 0,
    code: 'INVALID_SKIP',
    message: 'skip must be a non-negative integer',
  });

  const requestedAmount = readIntegerParam(url.searchParams, 'amount', 20, {
    min: 1,
    code: 'INVALID_AMOUNT',
    message: 'amount must be at least 1',
  });

  const amount = Math.min(requestedAmount, LEADERBOARD_LIMIT);
  const onlyVerified = parseBooleanParam(url.searchParams, 'onlyVerified', false);
  const userTokenHash = url.searchParams.get('userTokenHash');

  const resolvedTrack = await resolveTrackWithDevFallback(env, {
    trackId,
    trackHash,
    version,
  });

  const filterClause = onlyVerified ? 'AND le.verified_state > 0' : '';
  const peerFilterClause = onlyVerified ? 'AND le2.verified_state > 0' : '';

  const totalRow = await queryFirst<{ total: number } | null>(
    env.DB,
    DB.selectLeaderboardTotals(filterClause),
    [resolvedTrack.trackId],
  );
  const total = totalRow ? Number(totalRow.total ?? 0) : 0;

  const entries = await queryAll<{
    recordingId: number;
    frames: number;
    verifiedState: number;
    tokenHash: string;
    name: string;
    carColors: Primitive | JsonObject;
  }>(
    env.DB,
    DB.selectLeaderboardEntries(filterClause),
    [resolvedTrack.trackId, amount, skip],
  );

  const formattedEntries = entries.map((entry) => ({
    recordingId: entry.recordingId,
    frames: entry.frames,
    verifiedState: entry.verifiedState,
    tokenHash: entry.tokenHash,
    name: entry.name,
    carColors: parseJsonObjectFromText(entry.carColors),
  }));

  let userEntry: { recordingId: number; frames: number; position: number } | null = null;
  if (userTokenHash) {
    const row = await queryFirst<{
      recordingId: number;
      frames: number;
      position: number;
    } | null>(
      env.DB,
      DB.selectUserLeaderboardEntry(filterClause, peerFilterClause),
      [resolvedTrack.trackId, userTokenHash],
    );
    if (row) {
      userEntry = {
        recordingId: row.recordingId,
        frames: row.frames,
        position: row.position,
      };
    }
  }

  return json(
    {
      total,
      entries: formattedEntries,
      userEntry,
      trackHash: resolvedTrack.trackHash,
    },
    { corsOrigin },
  );
}

async function handlePostLeaderboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const corsOrigin = resolveAllowedOrigin(env, request);
  if (!corsOrigin) {
    return jsonError(
      403,
      'ORIGIN_NOT_ALLOWED',
      { message: 'Leaderboard access is restricted to approved sites.' },
      { corsOrigin: 'null' },
    );
  }

  const body = await parseRequestBody(request);

  const version = pickFirst(
    url.searchParams.get('version'),
    body.version,
    body['version'] as string | undefined,
  );
  if (!version) {
    throw new HttpError(400, 'VERSION_REQUIRED', 'version is required');
  }

  const trackId = pickFirst(
    url.searchParams.get('trackId'),
    url.searchParams.get('track_id'),
    body.trackId as string | undefined,
    body.track_id as string | undefined,
  );

  const trackHash = pickFirst(
    url.searchParams.get('trackHash'),
    url.searchParams.get('track_hash'),
    body.trackHash as string | undefined,
    body.track_hash as string | undefined,
  );

  const userToken = pickFirst(
    body.userToken as string | undefined,
    body.user_token as string | undefined,
  );
  if (!userToken) {
    throw new HttpError(400, 'USER_TOKEN_REQUIRED', 'userToken is required');
  }

  const rawName = pickFirst(
    body.name as string | undefined,
  );
  if (!rawName) {
    throw new HttpError(400, 'NAME_REQUIRED', 'name is required');
  }
  const name = rawName.trim();
  if (!nameIsValid(name)) {
    throw new HttpError(400, 'INVALID_NAME_LENGTH', 'name must be between 1 and 50 characters');
  }

  const carColorsInput = pickFirst(
    body.carColors,
    body.car_colors,
  );
  const carColors = normalizeCarColorsInput(carColorsInput);
  if (!carColors) {
    throw new HttpError(400, 'CAR_COLORS_REQUIRED', 'carColors must be provided');
  }

  const framesInput = pickFirst(
    body.frames,
  );
  if (framesInput === undefined || framesInput === null) {
    throw new HttpError(400, 'FRAMES_REQUIRED', 'frames is required');
  }
  const framesNumber = typeof framesInput === 'number' ? framesInput : Number(framesInput);
  if (!Number.isInteger(framesNumber) || framesNumber < 1 || framesNumber > MAX_FRAMES) {
    throw new HttpError(400, 'INVALID_FRAMES', `frames must be between 1 and ${MAX_FRAMES}`);
  }

  const recordingInput = pickFirst(
    body.recording as string | undefined,
  );
  if (typeof recordingInput !== 'string') {
    throw new HttpError(400, 'RECORDING_REQUIRED', 'recording is required');
  }
  const recording = recordingInput.trim();
  if (!recording) {
    throw new HttpError(400, 'RECORDING_EMPTY', 'recording must be a non-empty string');
  }

  const resolvedTrack = await resolveTrackWithDevFallback(env, {
    trackId,
    trackHash,
    version,
  });

  const tokenHash = await sha256Hex(userToken);
  const carColorsJson = JSON.stringify(carColors);

  await execute(env.DB, DB.upsertUser, [userToken, tokenHash, name, carColorsJson]);

  const userRow = await queryFirst<{ id: number } | null>(env.DB, DB.selectUserByToken, [userToken]);
  if (!userRow) {
    throw new HttpError(500, 'USER_RESOLUTION_FAILED', 'Unable to resolve user');
  }

  const userId = Number(userRow.id);
  const existingEntry = await queryFirst<{
    id: number;
    frames: number;
    recording_id: number | null;
  } | null>(
    env.DB,
    DB.selectExistingEntry,
    [resolvedTrack.trackId, userId],
  );

  if (existingEntry && existingEntry.frames <= framesNumber) {
    return json(
      {
        ok: true,
        entryId: existingEntry.id != null ? String(existingEntry.id) : null,
        recordingId: existingEntry.recording_id != null ? String(existingEntry.recording_id) : null,
        trackHash: resolvedTrack.trackHash,
      },
      { corsOrigin },
    );
  }

  const recordingResult = await execute(env.DB, DB.insertRecording, [
    resolvedTrack.trackId,
    userId,
    framesNumber,
    recording,
  ]);
  const newRecordingId = Number(recordingResult.meta?.last_row_id ?? 0);
  if (!newRecordingId) {
    throw new HttpError(500, 'RECORDING_CREATION_FAILED', 'Unable to create recording');
  }

  let entryId: number | null = null;
  if (existingEntry) {
    await execute(env.DB, DB.updateLeaderboardEntry, [
      newRecordingId,
      framesNumber,
      existingEntry.id,
    ]);
    if (existingEntry.recording_id) {
      await execute(env.DB, DB.deleteRecordingById, [existingEntry.recording_id]);
    }
    entryId = existingEntry.id;
  } else {
    const entryResult = await execute(env.DB, DB.insertLeaderboardEntry, [
      resolvedTrack.trackId,
      userId,
      newRecordingId,
      framesNumber,
    ]);
    const newEntryId = Number(entryResult.meta?.last_row_id ?? 0);
    if (!newEntryId) {
      throw new HttpError(500, 'LEADERBOARD_INSERT_FAILED', 'Unable to insert leaderboard entry');
    }
    entryId = newEntryId;
  }

  const overflowRows = await queryAll<{ recording_id: number | null }>(
    env.DB,
    DB.deleteOverflowLeaderboardEntries,
    [resolvedTrack.trackId, LEADERBOARD_LIMIT, resolvedTrack.trackId],
  );

  const evictedRecordingIds = overflowRows
    .map((row) => (row.recording_id ? Number(row.recording_id) : null))
    .filter((id): id is number => id !== null);

  if (evictedRecordingIds.length) {
    const placeholders = evictedRecordingIds.map(() => '?').join(', ');
    await execute(env.DB, `DELETE FROM recordings WHERE id IN (${placeholders})`, evictedRecordingIds);
  }

  const recordingEvicted = evictedRecordingIds.includes(newRecordingId);
  if (recordingEvicted) {
    entryId = null;
  }

  return json(
    {
      ok: true,
      entryId: entryId !== null ? String(entryId) : null,
      recordingId: recordingEvicted ? null : String(newRecordingId),
      trackHash: resolvedTrack.trackHash,
    },
    { corsOrigin },
  );
}

async function handleGetRecordings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const corsOrigin = resolveAllowedOrigin(env, request);
  if (!corsOrigin) {
    return jsonError(
      403,
      'ORIGIN_NOT_ALLOWED',
      { message: 'Leaderboard access is restricted to approved sites.' },
      { corsOrigin: 'null' },
    );
  }

  getRequiredParam(url.searchParams, 'version', 'VERSION_REQUIRED', 'version is required');

  const recordingIdParams = url.searchParams.getAll('recordingIds');
  const idSegments: string[] = [];
  for (const param of recordingIdParams) {
    for (const part of param.split(',')) {
      const trimmed = part.trim();
      if (trimmed) {
        idSegments.push(trimmed);
      }
    }
  }

  if (idSegments.length > MAX_RECORDING_BATCH) {
    throw new HttpError(400, 'RECORDING_BATCH_TOO_LARGE', `A maximum of ${MAX_RECORDING_BATCH} recordingIds are allowed`);
  }

  const ids = idSegments.map((segment) => parseInteger(segment, 'recordingIds'));
  const uniqueIds: number[] = [];
  const seenIds = new Set<number>();
  for (const id of ids) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      uniqueIds.push(id);
    }
  }

  let rows: Array<{ id: number; recording: string; frames: number; verified_state: number; car_colors: Primitive | JsonObject }> = [];
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => '?').join(', ');
    rows = await queryAll<{
      id: number;
      recording: string;
      frames: number;
      verified_state: number;
      car_colors: Primitive | JsonObject;
    }>(
      env.DB,
      DB.selectRecordingsByIds(placeholders),
      uniqueIds,
    );
  }

  const rowMap = new Map<number, { id: number; recording: string; frames: number; verified_state: number; car_colors: Primitive | JsonObject }>();
  for (const row of rows) {
    rowMap.set(Number(row.id), row);
  }

  const entries = ids
    .map((id) => {
      const record = rowMap.get(id);
      if (!record) {
        return null;
      }
      return {
        id: String(id),
        recording: record.recording,
        frames: record.frames,
        verifiedState: record.verified_state,
        carColors: parseJsonObjectFromText(record.car_colors),
      };
    })
    .filter((entry): entry is {
      id: string;
      recording: string;
      frames: number;
      verifiedState: number;
      carColors: JsonObject;
    } => entry !== null);

  return json(
    {
      total: entries.length,
      entries,
      userEntry: null,
    },
    { corsOrigin },
  );
}

async function handleGetUser(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const corsOrigin = resolveAllowedOrigin(env, request);
  if (!corsOrigin) {
    return jsonError(
      403,
      'ORIGIN_NOT_ALLOWED',
      { message: 'Leaderboard access is restricted to approved sites.' },
      { corsOrigin: 'null' },
    );
  }

  getRequiredParam(url.searchParams, 'version', 'VERSION_REQUIRED', 'version is required');
  const userToken = getRequiredParam(url.searchParams, 'userToken', 'USER_TOKEN_REQUIRED', 'userToken is required');

  const profile = await queryFirst<{
    name: string;
    car_colors: Primitive | JsonObject;
    is_verifier: number;
  } | null>(
    env.DB,
    DB.selectUserProfile,
    [userToken],
  );

  if (!profile) {
    return json(null, { corsOrigin });
  }

  return json(
    {
      name: profile.name,
      carColors: parseJsonObjectFromText(profile.car_colors),
      isVerifier: profile.is_verifier === 1,
    },
    { corsOrigin },
  );
}

async function handlePostUser(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const corsOrigin = resolveAllowedOrigin(env, request);
  if (!corsOrigin) {
    return jsonError(
      403,
      'ORIGIN_NOT_ALLOWED',
      { message: 'Leaderboard access is restricted to approved sites.' },
      { corsOrigin: 'null' },
    );
  }

  const formParams = await parseFormBody(request);
  const formData: Record<string, string | string[]> = {};
  for (const [key, value] of formParams.entries()) {
    if (formData[key] === undefined) {
      formData[key] = value;
      continue;
    }
    const existing = formData[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      formData[key] = [existing, value];
    }
  }

  const formValue = (key: string): string | undefined => {
    const value = formData[key];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  };

  const version = pickFirst(
    url.searchParams.get('version'),
    formValue('version'),
  );
  if (!version) {
    throw new HttpError(400, 'VERSION_REQUIRED', 'version is required');
  }

  const userToken = pickFirst(
    url.searchParams.get('userToken'),
    formValue('userToken'),
    formValue('user_token'),
  );
  if (!userToken) {
    throw new HttpError(400, 'USER_TOKEN_REQUIRED', 'userToken is required');
  }

  const rawName = pickFirst(
    formValue('name'),
  );
  if (!rawName) {
    throw new HttpError(400, 'NAME_REQUIRED', 'name is required');
  }
  const name = rawName.trim();
  if (!nameIsValid(name)) {
    throw new HttpError(400, 'INVALID_NAME_LENGTH', 'name must be between 1 and 50 characters');
  }

  const carColorsInput = pickFirst(
    formValue('carColors'),
    formValue('car_colors'),
  );
  const carColors = normalizeCarColorsInput(carColorsInput);
  if (!carColors) {
    throw new HttpError(400, 'CAR_COLORS_REQUIRED', 'carColors must be provided');
  }

  const tokenHash = await sha256Hex(userToken);
  await execute(env.DB, DB.upsertUser, [userToken, tokenHash, name, JSON.stringify(carColors)]);

  return emptyResponse({ status: 200, corsOrigin });
}

async function handleVerifyRecordings(request: Request, env: Env): Promise<Response> {
  const corsOrigin = resolveAllowedOrigin(env, request);
  if (!corsOrigin) {
    return jsonError(
      403,
      'ORIGIN_NOT_ALLOWED',
      { message: 'Leaderboard access is restricted to approved sites.' },
      { corsOrigin: 'null' },
    );
  }

  return json(
    {
      unverifiedRecordings: [],
      exhaustive: true,
      estimatedRemaining: 0,
    },
    { corsOrigin },
  );
}

function getRequestedHeaders(request: Request): string | null {
  return request.headers.get('Access-Control-Request-Headers');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      const origin = isDevMode(env) ? request.headers.get('Origin') ?? '*' : allowedOriginForPreflight(env, request);
      if (!origin) {
        return jsonError(
          403,
          'ORIGIN_NOT_ALLOWED',
          { message: 'Leaderboard access is restricted to approved sites.' },
          { corsOrigin: 'null' },
        );
      }
      const allowHeaders = getRequestedHeaders(request) ?? '';
      return preflightResponse({
        corsOrigin: origin,
        allowHeaders,
      });
    }

    try {
      const url = new URL(request.url);
      switch (url.pathname) {
        case '/health':
          if (method !== 'GET') {
            return methodNotAllowed(method, ['GET'], resolveAllowedOrigin(env, request));
          }
          return await handleHealth(request, env);
        case '/leaderboard':
          if (method === 'GET') {
            return await handleGetLeaderboard(request, env);
          }
          if (method === 'POST') {
            return await handlePostLeaderboard(request, env);
          }
          return methodNotAllowed(method, ['GET', 'POST'], resolveAllowedOrigin(env, request));
        case '/recordings':
          if (method !== 'GET') {
            return methodNotAllowed(method, ['GET'], resolveAllowedOrigin(env, request));
          }
          return await handleGetRecordings(request, env);
        case '/user':
          if (method === 'GET') {
            return await handleGetUser(request, env);
          }
          if (method === 'POST') {
            return await handlePostUser(request, env);
          }
          return methodNotAllowed(method, ['GET', 'POST'], resolveAllowedOrigin(env, request));
        case '/verifyRecordings':
          if (method !== 'POST') {
            return methodNotAllowed(method, ['POST'], resolveAllowedOrigin(env, request));
          }
          return await handleVerifyRecordings(request, env);
        default:
          return notImplemented(`No handler for ${url.pathname}`, resolveAllowedOrigin(env, request));
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
};
