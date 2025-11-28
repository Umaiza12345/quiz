// analyzeQuiz.js
const fs = require('fs').promises;
const path = require('path');
// NOTE: downloadToBuffer in utils/fetcher.js MAY accept an optional third 'opts' argument
const { downloadToBuffer } = require('./utils/fetcher'); 
const pdfUtil = require('./utils/pdf');
const csvUtil = require('./utils/csv');
const imageUtil = require('./utils/image');
const charts = require('./utils/charts');

/**
 * Very small engine that receives parsed quiz JSON (or page text),
 * inspects instructions and routes to the appropriate utility.
 *
 * Input:
 * { parsed, pageText, baseUrl }
 * ...
 */
async function analyzeQuiz({ parsed, pageText, baseUrl }) {
  // If parsed contains an explicit "task" or "type", use it
  const task = parsed?.task || parsed?.type || inferTaskFromText(pageText);

  // 1) PDF table sum task (common)
  if (looksLikePdfTask(parsed, pageText) || task === 'pdf-sum') {
    const fileUrl = parsed?.url || extractFirstFileUrl(pageText, baseUrl);
    if (!fileUrl) throw new Error('No file URL for PDF task');
    const buf = await downloadToBuffer(fileUrl);
    const sum = await pdfUtil.sumColumn(buf, { page: parsed?.page || 2, column: parsed?.column || 'value' });
    return { answer: sum };
  }

  // 2) CSV numeric aggregation
  if (looksLikeCsvTask(parsed, pageText) || task === 'csv-sum') {
    const fileUrl = parsed?.url || extractFirstFileUrl(pageText, baseUrl);
    if (!fileUrl) throw new Error('No file URL for CSV task');
    const buf = await downloadToBuffer(fileUrl);
    const rows = await csvUtil.parseBufferToObjects(buf);
    const col = parsed?.column || parsed?.field || 'value';
    const sum = rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
    return { answer: sum };
  }
  
  // 3) Audio Transcription Task (robust handling)
  if (looksLikeAudioTask(parsed, pageText) || task === 'audio-transcribe') {
    // pageOrFileUrl: can be either direct asset or demo-audio page
    const pageOrFileUrl = parsed?.url || extractFirstFileUrl(pageText, baseUrl);
    if (!pageOrFileUrl) throw new Error('No file URL for Audio task');

    // compute base origin if baseUrl provided
    let baseOrigin = null;
    try { baseOrigin = new URL(baseUrl).origin; } catch (e) { baseOrigin = null; }

    // Fast-path: many demos expose a static asset at /demo-audio.opus on the same host
    let triedFastPath = false;
    if (baseOrigin) {
      try {
        triedFastPath = true;
        const fastUrl = `${baseOrigin}/demo-audio.opus`;
        const bufFast = await downloadToBuffer(fastUrl, 'GET', {
          headers: { 'Referer': pageOrFileUrl, 'User-Agent': 'Mozilla/5.0' },
          retries: 2,
          timeoutMs: 12000,
          debug: false,
        });
        // success — we have the buffer
        // Placeholder transcription; replace with actual audio transcription later
        const text = 'TRANSCRIPTION_PLACEHOLDER';
        return { answer: text };
      } catch (e) {
        // fast-path failed — continue to robust flow
      }
    }

    // Robust flow:
    // 1) Try direct GET on pageOrFileUrl (many endpoints accept GET)
    // 2) If it fails (405 or HTML template), fetch the page, extract real asset URL and download it
    // 3) If extraction fails, try alternative methods (HEAD, OPTIONS, direct file extensions)
    let buf;
    try {
      buf = await downloadToBuffer(pageOrFileUrl, 'GET', {
        headers: { 'Referer': baseOrigin || 'https://tds-llm-analysis.s-anand.net/' },
        retries: 2,
        timeoutMs: 15000,
        debug: false,
      });
    } catch (err) {
      // direct GET failed — try extracting asset URL from the page HTML
      const extractionResult = await tryExtractAssetUrlFromPage(pageOrFileUrl, baseOrigin);
      if (extractionResult && extractionResult.url) {
        const assetUrl = extractionResult.url;
        // Final check: avoid pointing at the demo page itself
        if (!assetUrl.includes('/demo-audio')) {
          // Download extracted asset
          buf = await downloadToBuffer(assetUrl, 'GET', {
            headers: { 'Referer': pageOrFileUrl, 'User-Agent': 'Mozilla/5.0' },
            retries: 3,
            timeoutMs: 20000,
            debug: true,
          });
        } else {
          // Asset URL is the demo page itself — try alternative paths
          buf = await tryAlternativeAudioPaths(pageOrFileUrl, baseOrigin);
        }
      } else {
        // No asset URL found in extraction — try alternative paths
        buf = await tryAlternativeAudioPaths(pageOrFileUrl, baseOrigin);
      }
    }

    // Placeholder for actual transcription logic
    // const text = await audioUtil.transcribeBuffer(buf); 
    const text = 'TRANSCRIPTION_PLACEHOLDER'; // Placeholder answer
    
    return { answer: text.trim() }; 
  }

  // 4) Image OCR task (read numbers on image)
  if (looksLikeImageTask(parsed, pageText) || task === 'image-ocr') {
    const fileUrl = parsed?.url || extractFirstFileUrl(pageText, baseUrl);
    if (!fileUrl) throw new Error('No file URL for Image task');
    const buf = await downloadToBuffer(fileUrl); 
    const text = await imageUtil.ocrBuffer(buf);
    const num = (text.match(/-?\d+(\.\d+)?/) || [null])[0];
    return { answer: num ?? text.trim() };
  }

  // 5) Charting / visualization: when parsed requests a plot of given data
  if (parsed?.makeChart || task === 'chart') {
    const data = parsed?.data; 
    if (!data) throw new Error('No data for chart task');
    const pngB64 = await charts.makeBarChartBase64(data, { width: 800, height: 600, title: parsed?.title });
    return { answer: pngB64, attachments: [{ name: 'chart.png', mime: 'image/png', b64: pngB64 }] };
  }

  // 6) Generic: if parsed.answer is already present, return it
  if (typeof parsed?.answer !== 'undefined') {
    return { answer: parsed.answer };
  }

  // Fallback: try to extract numbers and return first
  const maybe = (pageText.match(/-?\d+(\.\d+)?/) || [null])[0];
  return { answer: maybe ?? 'unable to determine' };
}

/* Helper detection heuristics */
function inferTaskFromText(text = '') {
  text = (text || '').toLowerCase();
  if (text.includes('pdf') && text.includes('page')) return 'pdf-sum';
  if (text.includes('csv') || text.includes('column')) return 'csv-sum';
  if (text.includes('image') || text.includes('ocr')) return 'image-ocr';
  if (text.includes('plot') || text.includes('chart')) return 'chart';
  if (text.includes('audio') || text.includes('transcribe')) return 'audio-transcribe'; 
  return null;
}

function looksLikePdfTask(parsed, text) {
  // Explicitly exclude audio URLs
  if (parsed?.url && /\baudio\b|demo-audio/i.test(parsed.url)) return false;
  if (!parsed) return /pdf/i.test(text) && !/audio|audio-demo/i.test(text);
  return (parsed.url && parsed.url.toLowerCase().endsWith('.pdf')) || /pdf/i.test(text);
}
function looksLikeCsvTask(parsed, text) {
  // Explicitly exclude audio URLs
  if (parsed?.url && /\baudio\b|demo-audio/i.test(parsed.url)) return false;
  if (!parsed) return /csv|comma separated/i.test(text);
  return (parsed.url && parsed.url.toLowerCase().endsWith('.csv')) || /csv|comma separated/i.test(text);
}
function looksLikeImageTask(parsed, text) {
  if (!parsed) return /image|photo|scan/i.test(text);
  return (parsed.url && /\.(png|jpe?g|bmp|tiff)$/i.test(parsed.url)) || /image|photo|scan/i.test(text);
}

function looksLikeAudioTask(parsed, text) {
  if (!parsed) return /audio|mp3|wav|transcribe|opus/i.test(text);
  // Check for audio file extensions OR audio-related path keywords
  const hasAudioExtension = parsed.url && /\.(mp3|wav|m4a|ogg|opus|m4b|flac)$/i.test(parsed.url);
  const hasAudioKeyword = parsed.url && /\baudio\b|demo-audio/i.test(parsed.url);
  const hasAudioInText = /audio|mp3|wav|transcribe|opus/i.test(text);
  return hasAudioExtension || hasAudioKeyword || hasAudioInText;
}

function extractFirstFileUrl(text, baseUrl) {
  const m = (text || '').match(/https?:\/\/[^\s'"]+/);
  if (m) return m[0];
  return null;
}

/* ---------------------
   Small helper functions used by audio block
   --------------------- */

/**
 * Try alternative audio paths when direct extraction fails.
 * Attempts various common audio file patterns and locations.
 */
async function tryAlternativeAudioPaths(pageUrl, baseOrigin) {
  const candidates = [];
  
  // Extract base path from URL
  try {
    const urlObj = new URL(pageUrl);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    
    // Try common audio file paths relative to the page
    candidates.push(`${baseOrigin}/audio.opus`);
    candidates.push(`${baseOrigin}/demo-audio.opus`);
    candidates.push(`${baseOrigin}/audio.mp3`);
    candidates.push(`${baseOrigin}/demo.mp3`);
    candidates.push(`${baseOrigin}/demo-audio.mp3`);
    
    // Try with /api prefix
    candidates.push(`${baseOrigin}/api/audio.opus`);
    candidates.push(`${baseOrigin}/api/audio.mp3`);
    
    // Try static/assets directories
    candidates.push(`${baseOrigin}/static/audio.opus`);
    candidates.push(`${baseOrigin}/static/demo-audio.opus`);
    candidates.push(`${baseOrigin}/assets/audio.opus`);
    candidates.push(`${baseOrigin}/assets/demo-audio.opus`);
  } catch (e) {
    // baseOrigin might be invalid, continue anyway
  }
  
  // Try each candidate
  for (const candidate of candidates) {
    try {
      const buf = await downloadToBuffer(candidate, 'GET', {
        headers: { 'Referer': pageUrl, 'User-Agent': 'Mozilla/5.0' },
        retries: 1,
        timeoutMs: 8000,
        debug: false,
      });
      // Success!
      return buf;
    } catch (e) {
      // Continue to next candidate
    }
  }
  
  // All alternatives failed
  throw new Error(`Could not find audio file. Tried ${candidates.length} alternative paths.`);
}

/**
 * Try to fetch pageUrl and extract a direct asset URL from its HTML.
 * Returns { url: string|null, snippet: string } to aid debugging.
 */
async function tryExtractAssetUrlFromPage(pageUrl, baseUrl) {
  // dynamic import fetch to avoid ESM issues
  const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
  let res;
  try {
    res = await fetch(pageUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': baseUrl || 'https://tds-llm-analysis.s-anand.net/',
      },
    });
  } catch (err) {
    return { url: null, snippet: `<network error fetching page: ${err.message}>` };
  }

  let html;
  try {
    html = await res.text();
  } catch (e) {
    return { url: null, snippet: '<could not read page text>' };
  }

  // quick detect: placeholder/demo template present?
  // If we get the template, it means the page didn't find the actual asset either
  const isTemplate = html.includes('"email": "your email"') || html.includes('"secret": "your secret"');
  
  // 1) <audio> / <source> tags
  const audioRe = /<(?:audio|source)[^>]+src=(?:'|")([^'"]+)(?:'|")/ig;
  let m;
  while ((m = audioRe.exec(html)) !== null) {
    if (m[1]) {
      try { return { url: new URL(m[1], pageUrl).toString(), snippet: html.slice(0, 3000) }; } catch (e) { return { url: m[1], snippet: html.slice(0, 3000) }; }
    }
  }

  // 2) meta og:audio / og:video tags
  const metaRe = /<meta[^>]+(?:property|name)=(?:'|")?(og:audio|og:audio:secure_url|og:video:secure_url|og:video)[^>]+content=(?:'|")([^'"]+)(?:'|")/i;
  const metaMatch = html.match(metaRe);
  if (metaMatch && metaMatch[2]) {
    try { return { url: new URL(metaMatch[2], pageUrl).toString(), snippet: html.slice(0, 3000) }; } catch (e) { return { url: metaMatch[2], snippet: html.slice(0, 3000) }; }
  }

  // 3) inline JSON-like blob (look for common fields)
  const jsonUrlMatch = html.match(/"((?:audio_)?url|file|src|source|download)"\s*:\s*"([^"]*http[^"]+)"/i);
  if (jsonUrlMatch && jsonUrlMatch[2]) {
    try { return { url: new URL(jsonUrlMatch[2], pageUrl).toString(), snippet: html.slice(0, 3000) }; } catch (e) { return { url: jsonUrlMatch[2], snippet: html.slice(0, 3000) }; }
  }

  // 4) direct link fallback (common audio extensions including opus)
  const directMatch = html.match(/https?:\/\/[^\s"'<>]+?\.(?:mp3|wav|m4a|ogg|opus|m4b|flac)/i);
  if (directMatch) return { url: directMatch[0], snippet: html.slice(0, 3000) };

  // If template is present, indicate that we got the template page rather than the asset
  if (isTemplate) {
    return { url: null, snippet: `[TEMPLATE PAGE DETECTED - Audio asset not embedded in HTML. Will try alternative paths.] ${html.slice(0, 2000)}` };
  }

  // nothing found
  return { url: null, snippet: html.slice(0, 3000) };
}

module.exports = { analyzeQuiz };
