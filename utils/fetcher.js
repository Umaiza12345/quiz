// utils/fetcher.js
const fs = require('fs').promises;
const path = require('path');

/**
 * Downloads the content from a URL into a Buffer.
 *
 * Signature kept backward-compatible:
 *   downloadToBuffer(url, method = 'GET', opts = {})
 *
 * opts:
 *  - headers: object of headers to send (merged with sensible defaults)
 *  - body: string|Buffer|null (only sent for non-GET methods when provided)
 *  - timeoutMs: number (request timeout; default 15000)
 *  - retries: number (how many total attempts; default 2)
 *  - retryDelayMs: number (initial delay for backoff; default 500)
 *  - allowRedirects: boolean (node-fetch follows redirects by default)
 *  - debug: boolean (if true, attaches snippets to errors)
 *
 * Behavior:
 *  - Will not add an automatic empty JSON body on POST (caller must provide body).
 *  - If a non-GET request returns 405, will retry once as GET.
 *  - If response is HTML, will attempt to extract a direct file/audio URL from inline JSON or audio/source tags and follow it.
 */
async function downloadToBuffer(url, method = 'GET', opts = {}) {
  // dynamic import of node-fetch to avoid ESM issues
  const _importFetch = async () => {
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    const mod = await import('node-fetch');
    // node-fetch v3 exports default; older environments may differ
    return mod.default || mod;
  };

  const fetchFn = await _importFetch();

  const m = (method || 'GET').toUpperCase();
  const {
    headers: providedHeaders = {},
    body = undefined,
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 500,
    debug = false,
  } = opts;

  const defaultHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };

  // Merge headers (caller overrides defaults)
  const headers = Object.assign({}, defaultHeaders, providedHeaders);

  // Abortable fetch helper
  const fetchWithTimeout = async (fetchUrl, fetchOptions, timeout = timeoutMs) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchFn(fetchUrl, Object.assign({}, fetchOptions, { signal: controller.signal }));
      return res;
    } finally {
      clearTimeout(id);
    }
  };

  // Helper to get small snippet of text safely (capped)
  const readSnippet = async (res, cap = 1500) => {
    try {
      const txt = await res.text();
      return txt.slice(0, cap);
    } catch (e) {
      return '<could not read response body>';
    }
  };

  // try loop with retries and exponential backoff
  let attempt = 0;
  let lastErr = null;
  let currentUrl = url;

  while (attempt < retries) {
    attempt += 1;
    try {
      const options = { method: m, headers: headers };
      if (m !== 'GET' && body !== undefined) options.body = body;

      let res;
      try {
        res = await fetchWithTimeout(currentUrl, options);
      } catch (err) {
        // If fetch was aborted, make a specific message
        throw new Error(`Network error fetching ${currentUrl}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      }

      // If non-GET got 405, retry as GET once (this is very common for file endpoints)
      if (res.status === 405 && m !== 'GET') {
        // consume small body to free resources
        try { await res.text().catch(() => {}); } catch (e) {}
        const retryRes = await fetchWithTimeout(currentUrl, { method: 'GET', headers }, timeoutMs);
        res = retryRes;
      }

      // If not OK, but might be HTML explaining what's wrong, include snippet
      if (!res.ok) {
        // Helpful hint for private cases (401/403)
        if (res.status === 401 || res.status === 403) {
          const snippet = debug ? await readSnippet(res, 1000) : '';
          throw new Error(
            `Download failed: ${res.status} ${res.statusText}. The resource may be protected (requires cookies/headers/auth). ${snippet}`
          );
        }
        const snippet = debug ? await readSnippet(res, 1000) : '';
        throw new Error(`Download failed: ${res.status} ${res.statusText}. ${snippet}`);
      }

      // If content-type is HTML, try to extract a direct file link and follow it
      const ctype = res.headers && (res.headers.get ? res.headers.get('content-type') : res.headers['content-type']);
      if (ctype && String(ctype).toLowerCase().includes('text/html')) {
        const html = await res.text();

        // Try 1: extract JSON blob (first valid JSON-looking substring) and parse for url fields
        const tryExtractUrlFromJsonBlob = () => {
          // find first "{" and last "}" and attempt to parse progressively smaller substrings
          let start = html.indexOf('{');
          while (start !== -1) {
            const end = html.lastIndexOf('}');
            if (end <= start) break;
            const candidate = html.slice(start, end + 1);
            try {
              const parsed = JSON.parse(candidate);
              // look for common url fields
              const keys = ['url', 'audio_url', 'file', 'src', 'source', 'download'];
              for (const k of keys) {
                if (parsed && typeof parsed[k] === 'string' && parsed[k].startsWith('http')) return parsed[k];
              }
              // sometimes nested
              const flat = JSON.stringify(parsed);
              for (const k of keys) {
                const re = new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`, 'i');
                const m = flat.match(re);
                if (m) return m[1];
              }
            } catch (e) {
              // fallthrough - try moving start forward to locate next JSON-like object
            }
            start = html.indexOf('{', start + 1);
          }
          return null;
        };

        // Try 2: look for <audio src="..."> or <source src="...">
        const tryExtractFromAudioTags = () => {
          const audioRe = /<(?:audio|source)[^>]+src=(?:'|")([^'"]+)(?:'|")/ig;
          let m;
          while ((m = audioRe.exec(html)) !== null) {
            if (m[1] && m[1].startsWith('http')) return m[1];
            // relative URLs could exist; resolve against original URL
            if (m[1]) {
              try {
                const resolved = new URL(m[1], currentUrl).toString();
                return resolved;
              } catch (e) {}
            }
          }
          return null;
        };

        // Try 3: open graph or meta tags
        const tryExtractFromMeta = () => {
          const metaRe = /<meta[^>]+property=(?:'|")(og:audio|og:video:secure_url|og:audio:secure_url|og:video)['"]\s+content=(?:'|")([^'"]+)(?:'|")/i;
          const m = html.match(metaRe);
          if (m && m[2]) {
            try { return new URL(m[2], currentUrl).toString(); } catch (e) { return m[2]; }
          }
          return null;
        };

        let extracted = tryExtractUrlFromJsonBlob() || tryExtractFromAudioTags() || tryExtractFromMeta();

        if (extracted) {
          // If the extracted URL is relative, resolve it
          try { extracted = new URL(extracted, currentUrl).toString(); } catch (e) {}
          // follow the extracted URL (simple GET)
          const followRes = await fetchWithTimeout(extracted, { method: 'GET', headers }, timeoutMs);
          if (!followRes.ok) {
            const snippet = debug ? await readSnippet(followRes, 1000) : '';
            throw new Error(`Failed to fetch extracted asset URL (${followRes.status} ${followRes.statusText}). ${snippet}`);
          }
          const arrBuf = await followRes.arrayBuffer();
          return Buffer.from(arrBuf);
        } else {
          // No obvious asset found in HTML — return helpful error including snippet to debug scraping
          const snippet = debug ? html.slice(0, 1600) : '';
          throw new Error(
            `Downloaded HTML but could not find a direct asset URL. This usually means your scraper extracted a page rather than a file. HTML snippet: ${snippet}`
          );
        }
      }

      // If not HTML and OK, assume binary or JSON file — return buffer
      const arrBuf = await res.arrayBuffer();
      return Buffer.from(arrBuf);
    } catch (err) {
      lastErr = err;
      // exponential backoff before next attempt if we have attempts left
      if (attempt < retries) {
        const delay = retryDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        // continue to next attempt (same URL)
        continue;
      }
      // no retries left — rethrow with last error
      throw lastErr;
    }
  } // end attempts loop

  // fallback: if somehow loop exited, throw last error
  throw lastErr || new Error('Unknown error in downloadToBuffer');
}

module.exports = { downloadToBuffer };
