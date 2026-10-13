// Images in requests
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './common.js';
import { ImageInput } from '../types/index.js';

export const IMAGE_AGENTS = new Set(['claude', 'codex', 'opencode']);
const MAX_IMAGES = 8,
  MAX_BYTES = 10 * 1024 * 1024,
  TYPES = /^image\/(png|jpe?g|gif|webp)$/i,
  DOWNLOAD_BUDGET_MS = 15000; // wall-clock budget for one pinned request (headers + body)

const bad = (m: string, code = 'invalid_image') => new HttpError(400, m, 'invalid_request_error', code);

function parseIpv4Bytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (nums.some((n) => n === -1)) return null;
  return nums;
}

function isPrivateIpv4Bytes(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return (
    a === 0 || // 'this' network
    a === 10 || // private 10.0.0.0/8
    a === 127 || // loopback 127.0.0.0/8
    a >= 224 || // multicast / reserved
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private 172.16.0.0/12
    (a === 192 && b === 168) || // private 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF / TEST-NET-1
    (a === 198 && (b === 18 || b === 19 || b === 51)) || // benchmark / TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
}

function parseIpv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Bytes(s.slice(lastColon + 1));
    if (!v4) return null;
    const hex = ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hex;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').map((h) => (h ? parseInt(h, 16) : -1)) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').map((h) => (h ? parseInt(h, 16) : -1)) : [];
  if (left.some((n) => isNaN(n) || n < 0 || n > 0xffff) || right.some((n) => isNaN(n) || n < 0 || n > 0xffff)) {
    return null;
  }
  const missing = 8 - (left.length + right.length);
  if (parts.length === 2 && missing < 0) return null;
  const words = parts.length === 2 ? [...left, ...Array(missing).fill(0), ...right] : left;
  if (words.length !== 8) return null;
  const bytes: number[] = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and IPv4-mapped equivalents. */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIpv4Bytes(clean);
  if (v4) return isPrivateIpv4Bytes(v4);

  const v6 = parseIpv6Bytes(clean);
  if (v6) {
    // Unspecified ::
    if (v6.every((b) => b === 0)) return true;
    // Loopback ::1
    if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) return true;
    // Unique local fc00::/7
    if ((v6[0] & 0xfe) === 0xfc) return true;
    // Link local fe80::/10
    if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return true;
    // Multicast ff00::/8
    if (v6[0] === 0xff) return true;
    // IPv4-mapped ::ffff:0:0/96
    if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
      return isPrivateIpv4Bytes(v6.slice(12));
    }
    // IPv4-compatible ::/96 (deprecated)
    if (v6.slice(0, 12).every((b) => b === 0) && (v6[12] !== 0 || v6[13] !== 0 || v6[14] !== 0 || v6[15] > 1)) {
      return isPrivateIpv4Bytes(v6.slice(12));
    }
    // NAT64 64:ff9b::/96
    if (v6[0] === 0 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6.slice(4, 12).every((b) => b === 0)) {
      return isPrivateIpv4Bytes(v6.slice(12));
    }
    // 6to4 2002::/16
    if (v6[0] === 0x20 && v6[1] === 0x02) {
      return isPrivateIpv4Bytes(v6.slice(2, 6));
    }
    return false;
  }

  return true; // Malformed IP defaults to blocked
}

/**
 * Picks the address a fetch may connect to out of already-resolved DNS results, refusing
 * whenever ANY result is private. Exported so the pinning decision stays unit-testable.
 */
export function pickAddress(addrs: { address: string }[], host = '?'): string {
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))
    throw bad(`image URL points to a private or local address (${host})`, 'image_url_blocked');
  return addrs[0].address;
}

async function assertPublic(url: URL): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw bad(`image host "${host}" could not be resolved`);
      });
  return pickAddress(addrs, host);
}

function parseDataUrl(u: string): ImageInput {
  const m = u.match(/^data:([^;,]+)((?:;[^;,]+)*?)(;base64)?,(.*)$/s);
  if (!m) throw bad('malformed data: URL');
  const mediaType = m[1].toLowerCase();
  if (!TYPES.test(mediaType)) throw bad(`unsupported image type "${mediaType}"`);
  let data: string;
  if (m[3]) data = m[4];
  else {
    try {
      data = Buffer.from(decodeURIComponent(m[4]), 'binary').toString('base64');
    } catch {
      throw bad('malformed data: URL'); // malformed percent-encoding bubbles as URIError otherwise
    }
  }
  if (Buffer.byteLength(data, 'base64') > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
  return { mediaType, data };
}

/** Host header for the original URL, with brackets restored around IPv6 literals. */
function hostHeaderOf(url: URL): string {
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  return url.port ? `${host}:${url.port}` : host;
}

interface FetchedImage {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Buffer>;
  /** Releases the download timer (pinned transport only; a no-op for an injected fetchImpl). */
  done: () => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

function cancelBody(body: any): void {
  try {
    if (typeof body?.destroy === 'function') body.destroy();
    else if (typeof body?.cancel === 'function') void Promise.resolve(body.cancel()).catch(() => {});
  } catch {
    // Cancellation is best effort; preserve the original fetch/validation result.
  }
}

/**
 * Single-shot http/https GET that connects to the address `assertPublic` validated, while SNI
 * (`servername`) and the Host header still carry the original hostname. This pins the socket to
 * the validated IP so no second, unpinned DNS resolution can redirect the connection into
 * private infrastructure (TOCTOU / DNS-rebinding fix). The whole request is bounded by a
 * wall-clock timer that destroys the socket on expiry.
 */
function pinnedRequest(url: URL, ip: string, signal?: AbortSignal): Promise<FetchedImage> {
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const options: https.RequestOptions = {
    host: ip,
    agent: false, // one-shot connection; never reuse a pooled socket resolved elsewhere
    path: `${url.pathname}${url.search}`,
    headers: { host: hostHeaderOf(url), accept: '*/*' },
    ...(isHttps ? { servername: host } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      if (signal?.aborted) {
        req.destroy(new Error('image download aborted'));
        res.destroy();
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortRequest);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      const status = res.statusCode || 0;
      const abortResponse = () => {
        const error = new Error('image download aborted');
        req.destroy(error);
        res.destroy(error);
      };
      signal?.removeEventListener('abort', abortRequest);
      signal?.addEventListener('abort', abortResponse, { once: true });
      resolve({
        status,
        ok: status >= 200 && status <= 299,
        headers: {
          get: (name: string) => {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
          },
        },
        body: res,
        done: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abortResponse);
        },
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('image download timed out')), DOWNLOAD_BUDGET_MS);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortRequest);
    };
    const abortRequest = () => req.destroy(new Error('image download aborted'));
    signal?.addEventListener('abort', abortRequest, { once: true });
    req.on('error', () => {
      cleanup();
      reject(bad('image URL could not be fetched', signal?.aborted ? 'aborted' : 'image_fetch_failed'));
    });
    if (signal?.aborted) abortRequest();
    req.end();
  });
}

/**
 * Fetches an image URL, following at most 4 hops and re-resolving/re-validating each hop.
 *
 * Transport contract: when the caller injects an explicit `fetchImpl` (tests), it is used the
 * historical fetch-shaped way (redirect: 'manual', 10s AbortSignal). Production always goes
 * through `pinnedRequest`, whose socket connects to the very IP `assertPublic` validated, so
 * a DNS server flipping answers between validation and connection cannot bypass the filter.
 */
async function fetchImage(raw: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<ImageInput> {
  let url!: URL;
  for (let hop = 0; hop < 4; hop++) {
    throwIfAborted(signal);
    try {
      url = new URL(hop ? url.href : raw);
    } catch {
      throw bad('malformed image URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('image URLs must be http(s) or data:');
    const ip = await assertPublic(url);
    throwIfAborted(signal);
    const r: FetchedImage = fetchImpl
      ? await fetchImpl(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
          .then(
            (res): FetchedImage => ({
              status: res.status,
              ok: res.ok,
              headers: res.headers,
              body: res.body as unknown as AsyncIterable<Buffer>,
              done: () => {},
            })
          )
          .catch(() => {
            throw bad('image URL could not be fetched', 'image_fetch_failed');
          })
      : await pinnedRequest(url, ip, signal);
    const dispose = () => {
      r.done();
      cancelBody(r.body); // 204/304 responses carry a null body
    };
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      dispose();
      let next: URL;
      try {
        next = new URL(r.headers.get('location')!, url);
      } catch {
        throw bad('malformed redirect location');
      }
      url = next;
      continue;
    }
    if (!r.ok) {
      dispose();
      throw bad(`image URL answered ${r.status}`, 'image_fetch_failed');
    }
    const mediaType = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.test(mediaType)) {
      dispose();
      throw bad(`image URL is not a supported image (${mediaType || 'no content-type'})`);
    }
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for await (const c of r.body) {
        n += c.length;
        if (n > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
        chunks.push(c);
      }
    } catch (e) {
      dispose();
      if (e instanceof HttpError) throw e; // the size cap, or other deliberate rejections
      throw bad('image URL could not be fetched', 'image_fetch_failed');
    }
    r.done();
    return { mediaType, data: Buffer.concat(chunks).toString('base64') };
  }
  throw bad('too many redirects fetching the image', 'image_fetch_failed');
}

export interface ImageRef {
  url?: string;
  mediaType?: string;
  data?: string;
}

/** Image references in request order: [{url} | {mediaType, data}] */
export function findImages(body: any): ImageRef[] {
  const out: ImageRef[] = [];
  const visit = (c: any) => {
    if (!Array.isArray(c)) return;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'image_url') out.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url });
      else if (p.type === 'input_image') out.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url });
      else if (p.type === 'image' && p.source) {
        out.push(
          p.source.type === 'base64'
            ? { mediaType: p.source.media_type, data: p.source.data }
            : { url: p.source.url }
        );
      } else if (Array.isArray(p.content)) {
        visit(p.content);
      }
    }
  };
  for (const m of body.messages || []) visit(m?.content);
  if (Array.isArray(body.input)) {
    for (const it of body.input) visit(it?.content);
  }
  return out;
}

export async function resolveImages(body: any, { fetchImpl, signal }: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<ImageInput[]> {
  const found = findImages(body);
  if (found.length > MAX_IMAGES) throw bad(`at most ${MAX_IMAGES} images per request`, 'too_many_images');
  const out: ImageInput[] = [];
  for (const f of found) {
    throwIfAborted(signal);
    if (f.data) {
      if (!TYPES.test(f.mediaType || '')) throw bad(`unsupported image type "${f.mediaType}"`);
      if (Buffer.byteLength(f.data, 'base64') > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
      out.push({ mediaType: f.mediaType!.toLowerCase(), data: f.data });
    } else if (typeof f.url === 'string') {
      out.push(f.url.startsWith('data:') ? parseDataUrl(f.url) : await fetchImage(f.url, fetchImpl, signal));
    } else {
      throw bad('image part has no url or data');
    }
  }
  return out;
}

/**
 * Attach request images to a prepared run `p`.
 */
export async function attachImages(p: any, body: any, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<any> {
  const found = findImages(body);
  if (!found.length) return p;
  const agent = typeof p.target.agent === 'string' ? p.target.agent : p.target.agent?.name;
  if (!IMAGE_AGENTS.has(agent) && p.target.agent?.images !== true) {
    p.warning = 'images_not_supported: this agent receives a text placeholder instead of the image';
    return p;
  }
  p.images = await resolveImages(body, opts);
  return p;
}
