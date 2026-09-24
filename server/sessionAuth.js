import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE_NAME = 'pulsefeedback_session';
export const noStoreHeaders = Object.freeze({
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', pragma: 'no-cache', expires: '0'
});
let jwksCache = null;

function decode(segment) { return Buffer.from(segment, 'base64url'); }
function sign(value) { return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url'); }
function cookieValue(request, name) {
  const prefix = `${name}=`;
  return String(request.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(prefix))?.slice(prefix.length);
}
function cookie(maxAge, value) {
  return [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
    ...(config.publicUrl.startsWith('https://') ? ['Secure'] : [])].join('; ');
}

export async function verifyGatewayToken(token, expectedUse) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(decode(headerB64).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error(`Unexpected algorithm "${header.alg}".`);
  if (!jwksCache) {
    const response = await fetch(`${config.gatewayUrl}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
    jwksCache = await response.json();
  }
  const jwk = jwksCache.keys?.find(key => key.kid === header.kid);
  if (!jwk) throw new Error(`No key "${header.kid}" in the gateway JWKS.`);
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), decode(signatureB64));
  if (!valid) throw new Error('Signature does not verify.');
  const claims = JSON.parse(decode(payloadB64).toString('utf8'));
  if (claims.token_use !== expectedUse) throw new Error(`Expected a "${expectedUse}" token.`);
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('Token has expired.');
  if (claims.iss !== config.gatewayUrl) throw new Error('Unexpected token issuer.');
  if (claims.aud !== config.serviceId) throw new Error('Token was not minted for this service.');
  return claims;
}

export function readSession(request) {
  const raw = cookieValue(request, COOKIE_NAME);
  if (!raw) return null;
  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature) return null;
  const expected = Buffer.from(sign(encoded)); const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const session = JSON.parse(decode(encoded).toString('utf8'));
    return typeof session?.exp === 'number' && session.exp * 1000 > Date.now() ? session : null;
  } catch { return null; }
}

export function setSession(response, claims) {
  const session = { sid: claims.sid, sub: claims.sub, email: claims.email, name: claims.name,
    role: claims.role || null,
    exp: Math.floor(Date.now() / 1000) + config.sessionTtlSeconds };
  const encoded = Buffer.from(JSON.stringify(session)).toString('base64url');
  response.setHeader('set-cookie', cookie(config.sessionTtlSeconds, `${encoded}.${sign(encoded)}`));
}
export function clearSession(response) { response.setHeader('set-cookie', cookie(0, '')); }

export async function gatewaySessionIsLive(session) {
  if (!session?.sid || !session?.sub) return false;
  try {
    const response = await fetch(`${config.gatewayUrl}/oauth/introspect`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: session.sid, sub: session.sub }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return true;
    return Boolean((await response.json()).active);
  } catch { return true; }
}

export async function exchangeAuthorizationCode(code) {
  const response = await fetch(`${config.gatewayUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: `${config.publicUrl}/` }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Gateway authorization-code exchange failed.');
  const payload = await response.json();
  if (!payload.token) throw new Error('Gateway identity response did not include a token.');
  return verifyGatewayToken(payload.token, 'identity');
}
export function gatewayAuthorizeUrl() {
  return `${config.gatewayUrl}/oauth/authorize?${new URLSearchParams({ redirect_uri: `${config.publicUrl}/` })}`;
}
