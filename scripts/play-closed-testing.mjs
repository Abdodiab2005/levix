import { sign } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'net.leviro.levix';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const PROTECTED_TRACKS = ['production', 'beta', 'internal'];
const FORBIDDEN_TRACKS = [...PROTECTED_TRACKS, 'qa'];

class SafeError extends Error {}

function requireRule(condition, message) {
  if (!condition) throw new SafeError(message);
}

export function checkConfiguration({ packageName, closedTrack, versionCode }) {
  requireRule(packageName === PACKAGE, 'PACKAGE_NAME must be net.leviro.levix.');
  requireRule(
    typeof closedTrack === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(closedTrack)
      && !FORBIDDEN_TRACKS.includes(closedTrack.toLowerCase()),
    'CLOSED_TRACK must name a Closed testing track; production, beta, internal and qa are forbidden.',
  );
  requireRule(
    /^[1-9][0-9]{1,9}$/.test(String(versionCode))
      && Number(versionCode) >= 70 && Number(versionCode) <= 2100000000,
    'VERSION_CODE must be an integer from 70 through 2100000000.',
  );
  return { packageName, closedTrack, versionCode: Number(versionCode) };
}

export function buildJwtClaims({ clientEmail, tokenUri = TOKEN_URI, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  return { iss: clientEmail, scope: SCOPE, aud: tokenUri, iat, exp: iat + 600 };
}

function googleError(response, body, redact) {
  // Only Google's documented error message/status fields; never a body, URL,
  // request, assertion, stack, or Authorization header.
  const fields = typeof body?.error === 'object' && body.error !== null
    ? [body.error.message, body.error.status]
    : [body?.error, body?.error_description];
  const detail = fields.filter((field) => typeof field === 'string')
    .map((field) => redact(field).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 500)).join(' / ');
  return new SafeError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

export async function authenticate(serviceAccountJson, fetchImpl = fetch) {
  let account;
  try {
    account = JSON.parse(serviceAccountJson);
  } catch {
    throw new SafeError('PLAY_SERVICE_ACCOUNT_JSON is missing or invalid JSON.');
  }
  requireRule(
    typeof account?.client_email === 'string' && account.client_email.length > 0
      && typeof account?.private_key === 'string' && account.private_key.length > 0,
    'The service account must contain client_email and private_key.',
  );
  const tokenUri = account.token_uri ?? TOKEN_URI;
  requireRule(tokenUri === TOKEN_URI, 'The service account token_uri must be the Google OAuth endpoint.');
  const sensitive = [serviceAccountJson, account.private_key, account.client_email,
    ...account.private_key.split(/\s+/).filter((part) => part.length > 16)];
  const redact = (value) => {
    let result = value;
    for (const secret of sensitive) {
      if (secret) result = result.split(secret).join('[redacted]');
    }
    return result.replace(/\beyJ[A-Za-z0-9_.-]+/g, '[redacted]')
      .replace(/\bya29\.[A-Za-z0-9_.-]+/g, '[redacted]');
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(buildJwtClaims({
    clientEmail: account.client_email, tokenUri,
  }))}`;
  let assertion;
  try {
    assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`;
  } catch {
    throw new SafeError('Unable to sign the service account assertion.');
  }
  sensitive.push(assertion, unsigned, ...assertion.split('.'));
  let response;
  try {
    response = await fetchImpl(tokenUri, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
  } catch {
    throw new SafeError('OAuth request failed; request details withheld.');
  }
  let body;
  try { body = await response.json(); } catch { throw new SafeError(`HTTP ${response.status}`); }
  if (!response.ok) throw googleError(response, body, redact);
  requireRule(typeof body.access_token === 'string' && body.access_token.length > 0,
    'OAuth response contained no access token.');
  sensitive.push(body.access_token);
  return { accessToken: body.access_token, redact };
}

function normaliseVersionCode(value) {
  const code = String(value);
  requireRule(/^[1-9][0-9]*$/.test(code) && Number.isSafeInteger(Number(code))
    && Number(code) <= 2100000000, 'Google Play returned an invalid versionCode.');
  return String(Number(code));
}

export function normaliseSnapshot({ tracks = [], bundles = [], testers = null }, closedTrack,
  takenAt = new Date().toISOString()) {
  requireRule(Array.isArray(tracks) && Array.isArray(bundles), 'Invalid Play snapshot lists.');
  const normalisedTracks = tracks.map(({ track, releases = [] }) => {
    requireRule(typeof track === 'string' && Array.isArray(releases), 'Invalid Play track.');
    return {
      track,
      releases: releases.map((release) => {
        requireRule(Array.isArray(release.versionCodes ?? []), 'Invalid release versionCodes.');
        return {
          name: release.name ?? null,
          status: release.status ?? null,
          versionCodes: (release.versionCodes ?? []).map(normaliseVersionCode)
            .sort((a, b) => Number(a) - Number(b)),
          userFraction: release.userFraction ?? null,
        };
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }).sort((a, b) => a.track.localeCompare(b.track));
  requireRule(new Set(normalisedTracks.map(({ track }) => track)).size === normalisedTracks.length,
    'Google Play returned duplicate tracks.');
  const bundleVersionCodes = bundles.map(({ versionCode }) => normaliseVersionCode(versionCode))
    .sort((a, b) => Number(a) - Number(b));
  const allCodes = [...bundleVersionCodes,
    ...normalisedTracks.flatMap(({ releases }) => releases.flatMap(({ versionCodes }) => versionCodes))];
  requireRule(testers === null || Array.isArray(testers.googleGroups ?? []), 'Invalid Play testers object.');
  return {
    takenAt, tracks: normalisedTracks, bundleVersionCodes,
    maxVersionCode: allCodes.reduce((max, code) => Math.max(max, Number(code)), 0),
    closedTrack,
    testerGoogleGroupCount: testers === null ? 0 : (testers.googleGroups ?? []).length,
    testerCountNote: 'Google group count only. The API does not report individual tester or group member counts.',
  };
}

export async function readSnapshot(config, auth, fetchImpl = fetch) {
  checkConfiguration(config);
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.packageName}`;
  const request = async (method, path, allow404 = false) => {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
    } catch {
      throw new SafeError('Play API request failed; request details withheld.');
    }
    if (allow404 && response.status === 404) return null;
    if (response.ok && method === 'DELETE') return null;
    let body;
    try { body = await response.json(); } catch { throw new SafeError(`HTTP ${response.status}`); }
    if (!response.ok) throw googleError(response, body, auth.redact);
    return body;
  };
  const edit = await request('POST', '/edits');
  requireRule(typeof edit?.id === 'string' && /^[A-Za-z0-9_-]+$/.test(edit.id),
    'Google Play returned an invalid edit id.');
  try {
    const tracks = await request('GET', `/edits/${edit.id}/tracks`);
    const bundles = await request('GET', `/edits/${edit.id}/bundles`);
    const testers = await request('GET', `/edits/${edit.id}/testers/${encodeURIComponent(config.closedTrack)}`, true);
    return normaliseSnapshot({ tracks: tracks.tracks, bundles: bundles.bundles, testers }, config.closedTrack);
  } finally {
    // An uncommitted edit must be deleted even when a read or a rule fails.
    await request('DELETE', `/edits/${edit.id}`);
  }
}

export function checkPreflight(snapshot, config) {
  checkConfiguration(config);
  requireRule(snapshot.closedTrack === config.closedTrack
    && snapshot.tracks.some(({ track }) => track === config.closedTrack),
  'CLOSED_TRACK does not exist in Google Play.');
  requireRule(Number(config.versionCode) > snapshot.maxVersionCode,
    `VERSION_CODE must exceed the Play maximum (${snapshot.maxVersionCode}).`);
}

export function diffSnapshots(before, after) {
  return PROTECTED_TRACKS.filter((name) => {
    const releases = (snapshot) => snapshot.tracks.find(({ track }) => track === name)?.releases ?? null;
    return JSON.stringify(releases(before)) !== JSON.stringify(releases(after));
  });
}

export function checkPostflight(before, after, config) {
  checkConfiguration(config);
  requireRule(before.closedTrack === config.closedTrack && after.closedTrack === config.closedTrack,
    'Snapshot CLOSED_TRACK does not match this run.');
  const changed = diffSnapshots(before, after);
  requireRule(changed.length === 0, `Protected tracks changed: ${changed.join(', ')}.`);
  const release = after.tracks.find(({ track }) => track === config.closedTrack)?.releases
    .find(({ versionCodes }) => versionCodes.includes(String(config.versionCode)));
  requireRule(Boolean(release), 'CLOSED_TRACK has no release containing VERSION_CODE.');
  return release;
}

function summary(text, env) {
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function formatTrackSummary(tracks) {
  return tracks.map(({ track, releases }) => {
    const descriptions = releases.map(({ name, status, versionCodes }) => {
      const safeName = String(name).replace(/[^A-Za-z0-9 ._()-]/g, '?');
      const safeStatus = String(status).replace(/[^A-Za-z0-9_-]/g, '?');
      return `${safeName} [${safeStatus}] codes ${versionCodes.join(',')}`;
    });
    return `- ${track}: ${descriptions.join('; ') || 'no releases'}`;
  }).join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  requireRule(argv.length === 1 && ['preflight', 'postflight'].includes(argv[0]),
    'Usage: play-closed-testing.mjs preflight|postflight');
  const config = checkConfiguration({
    packageName: env.PACKAGE_NAME, closedTrack: env.CLOSED_TRACK, versionCode: env.VERSION_CODE,
  });
  requireRule(argv[0] !== 'preflight' || Boolean(env.OUT), 'OUT is required for preflight.');
  requireRule(argv[0] !== 'postflight' || Boolean(env.BEFORE), 'BEFORE is required for postflight.');
  const before = argv[0] === 'postflight' ? JSON.parse(readFileSync(env.BEFORE, 'utf8')) : null;
  const auth = await authenticate(env.PLAY_SERVICE_ACCOUNT_JSON, fetchImpl);
  const snapshot = await readSnapshot(config, auth, fetchImpl);
  if (argv[0] === 'preflight') {
    checkPreflight(snapshot, config);
    writeFileSync(env.OUT, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    summary(`### Play preflight\n- Closed track: ${config.closedTrack}\n- Requested versionCode: ${config.versionCode}\n- Maximum existing versionCode: ${snapshot.maxVersionCode}\n- Tester Google groups: ${snapshot.testerGoogleGroupCount}\n- ${snapshot.testerCountNote}\n- Read-only snapshot; edit deleted.\n${formatTrackSummary(snapshot.tracks)}`, env);
  } else {
    const release = checkPostflight(before, snapshot, config);
    // A status is data from Google, not a workflow command or Markdown fragment.
    const status = String(release.status).replace(/[^A-Za-z0-9_-]/g, '?');
    const tracks = snapshot.tracks.filter(({ track }) => track === config.closedTrack || track === 'production');
    summary(`### Play postflight\n- Closed track: ${config.closedTrack}\n- VersionCode: ${config.versionCode}\n- Release status: ${status}\n- Production unchanged; beta and internal unchanged (including presence).\n- availability to testers depends on Google Play review and managed publishing.\n${formatTrackSummary(tracks)}`, env);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof SafeError ? error.message : 'Closed testing check failed; details withheld.');
    process.exitCode = 1;
  });
}
