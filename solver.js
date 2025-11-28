// solver.js (engine orchestrator)
// solver.js (fixed, end-to-end solver)
const { chromium } = require('playwright');
const { URL } = require('url');
const { analyzeQuiz } = require('./analyzeQuiz');

// dynamic import shim for node-fetch v3 (works in CommonJS)
const fetchFunc = (...args) => import('node-fetch').then(m => m.default(...args));

/**
 * Attempts to extract a balanced JSON object starting from the first '{'.
 */
function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let i = start, depth = 0, inString = false, escape = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

async function solveQuiz({ email, secret, url }) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  try {
    console.log("Visiting:", url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    // --- FIX IMPLEMENTATION START ---
    // Extract the base origin (e.g., https://tds-llm-analysis.s-anand.net)
    const originUrl = new URL(url).origin;
    // --- FIX IMPLEMENTATION END ---

    const html = await page.content();
    const base64Match = html.match(/atob\(`([\s\S]*?)`\)/);
    let inner = null;
    if (base64Match) inner = Buffer.from(base64Match[1].replace(/\s+/g,''), 'base64').toString('utf-8');
    else inner = await page.textContent('body');

    const jsonStr = extractBalancedJson(inner);
    let parsed = null;
    if (jsonStr) {
      try { parsed = JSON.parse(jsonStr); } catch (e) {
        console.error('JSON parse error (parsed snippet):', jsonStr.slice(0,500));
      }
    }

    // Use analyze engine
    let result;
    try {
      result = await analyzeQuiz({ parsed, pageText: inner, baseUrl: url });
    } catch (e) {
      console.error('analyzeQuiz error:', e);
      throw e;
    }

    // prepare payload
    const payload = { email, secret, url, answer: result.answer };
    if (result.attachments) payload.attachments = result.attachments;

    // find submit URL: prefer parsed.url else fallback to original URL (Note: this is only used for fallbacks now)
    const submitUrl = parsed?.url || url;

    console.log("Submitting to:", submitUrl);
    const attemptTimeoutMs = 15000; // per-attempt timeout

    // helper to attempt fetch with timeout
    const doFetch = async (u, opts, label) => {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), attemptTimeoutMs);
        const resp = await fetchFunc(u, { ...opts, signal: controller.signal });
        clearTimeout(id);
        const status = resp.status;
        const rawText = await resp.text();
        let parsedResp;
        try { parsedResp = JSON.parse(rawText); } catch { parsedResp = rawText; }
        console.log(`Attempt ${label} -> ${status}`);
        if (rawText && rawText.length > 0) {
          console.log(`Response snippet: ${String(parsedResp).toString().slice(0,500)}`);
        }
        return { ok: resp.ok, status, rawText, parsedResp };
      } catch (err) {
        console.log(`Attempt ${label} failed:`, err.message || err);
        return { ok: false, error: String(err) };
      }
    };

    // payloads to try
    const payloadJson = JSON.stringify({ email, secret, url, answer: result.answer });
    const payloadForm = `email=${encodeURIComponent(email)}&secret=${encodeURIComponent(secret)}&url=${encodeURIComponent(url)}&answer=${encodeURIComponent(result.answer)}`;
    const payloadPlain = String(result.answer);

    const attempts = [
      // 🥇 1. Server-Instructed Method (FIXED URL): POST JSON to the correct /submit endpoint
      { 
        label: 'POST JSON /submit', 
        url: originUrl + '/submit', // <--- CORRECTED URL
        opts: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadJson } 
      },
      
      // 🥈 2. Secondary POST Method (FIXED URL): Try form submission to the correct /submit endpoint
      { 
        label: 'POST Form /submit', 
        url: originUrl + '/submit', // <--- CORRECTED URL
        opts: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payloadForm } 
      },

      // 🥉 3. Fallbacks to the Base URL (using submitUrl which might be '.../demo')
      { label: 'POST JSON', url: submitUrl, opts: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadJson } },
      { label: 'POST Form', url: submitUrl, opts: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payloadForm } },
      { label: 'POST Plain', url: submitUrl, opts: { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: payloadPlain } },
      
      // 4. Last Resort: GET Query (Just to retrieve instructions, if needed)
      { label: 'GET Query', url: submitUrl + (submitUrl.includes('?') ? '&' : '?') + 'answer=' + encodeURIComponent(result.answer) + '&email=' + encodeURIComponent(email) + '&secret=' + encodeURIComponent(secret), opts: { method: 'GET' } },
    ];


    let finalReply = null;
    for (const at of attempts) {
      const r = await doFetch(at.url, at.opts, at.label);
      if (r.ok) {
        finalReply = r.parsedResp ?? r.rawText;
        console.log(`Submission succeeded with attempt "${at.label}" (status ${r.status})`);
        break;
      } else {
        if (r.status) {
          console.log(`Attempt ${at.label} returned status ${r.status}`);
        }
      }
    }

    if (!finalReply) {
      console.log('All submission attempts failed. Last attempt response (if any) logged above.');
      // return last attempt info if you want; here return an object summarizing attempts
      return { correct: false, reason: 'submission failed' };
    } else {
      console.log('Final reply:', finalReply);
      return finalReply;
    }

  } finally {
    await browser.close();
  }
}

module.exports = { solveQuiz };