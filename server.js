#!/usr/bin/env node
/**
 * Multilingual Support / Content Translation Demo — DigitalOcean App Platform
 *
 * Pitch: paste an inbound support email or a product description written in
 * English (or any language), pick target languages, and get instant
 * side-by-side translations powered by DigitalOcean Serverless Inference.
 * An obvious win for any SMB or SaaS expanding internationally.
 *
 * No external dependencies — Node.js 18+ standard library + built-in fetch
 * only. Listens on process.env.PORT (App Platform sets this).
 *
 * Env vars:
 *   MODEL_ACCESS_KEY   DigitalOcean Serverless Inference model access key.
 *                      Required unless DRY_RUN=true.
 *   MODEL_ID           Model used for translation (default: openai-gpt-oss-120b).
 *                      Swap in a stronger model (e.g. anthropic-claude-5-sonnet)
 *                      for higher translation quality at a higher per-token cost.
 *   DRY_RUN            Set to "true" to use canned mock translations instead
 *                      of calling the live API — good for a first deploy
 *                      before you've added a real key or balance.
 *   PORT               HTTP port to listen on (App Platform sets this).
 */

'use strict';

const http = require('http');

const BASE_URL = 'https://inference.do-ai.run';
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 25000;

const MAX_TEXT_LEN = 3000;
const MAX_TARGET_LANGS = 6;
const MAX_BODY_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// Supported target languages. Codes are only used client-side / as mock keys;
// the actual translation request just sends the human-readable label to the
// model ("Translate into Japanese"), so adding a language here is enough.
// ---------------------------------------------------------------------------
const LANGUAGES = [
  { code: 'es', label: 'Spanish' },
  { code: 'ja', label: 'Japanese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'it', label: 'Italian' },
];
const LANGUAGE_BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));
const DEFAULT_TARGET_CODES = ['es', 'ja'];

const PRESET_EXAMPLES = {
  support_email: {
    label: 'Inbound support email',
    text:
      'Subject: Unable to access my account after password reset\n\n' +
      "Hi team,\n\nI reset my password yesterday but I still can't log in — it keeps " +
      'saying "invalid credentials" even though I just reset it twice. I have an ' +
      'important client demo in two hours and need access to my dashboard. Can ' +
      'someone please help urgently?\n\nThanks,\nJordan',
  },
  product_description: {
    label: 'Product description',
    text:
      'CloudSync Pro automatically backs up your files across every device in ' +
      'real time, with bank-level encryption and one-click restore. Built for ' +
      "small teams who can't afford downtime, it syncs in seconds and works " +
      'seamlessly with the tools you already use — no IT department required.',
  },
};

// ---------------------------------------------------------------------------
// Translation call
// ---------------------------------------------------------------------------
async function translateOne({ modelAccessKey, baseUrl, modelId, text, targetLabel }) {
  const url = baseUrl.replace(/\/$/, '') + CHAT_COMPLETIONS_PATH;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelAccessKey}` },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              `You are a professional translator. Translate the user's message into ${targetLabel}. ` +
              'Preserve the original tone, meaning, formatting, and line breaks. Respond with only ' +
              'the translated text — no notes, no quotation marks, no explanations. If the text is ' +
              `already in ${targetLabel}, return it unchanged.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    const reason = err.name === 'AbortError' ? 'Request timed out.' : `Request failed: ${err.message}`;
    return { translation: null, input_tokens: 0, output_tokens: 0, latency_s: (Date.now() - start) / 1000, error: reason };
  }
  clearTimeout(timeout);

  const latency_s = (Date.now() - start) / 1000;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { translation: null, input_tokens: 0, output_tokens: 0, latency_s, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
  }

  const data = await res.json();
  const usage = data.usage || {};
  const translation = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return {
    translation: translation != null ? String(translation).trim() : null,
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    latency_s,
    error: translation ? null : 'Model returned an empty response.',
  };
}

function mockTranslation(text, code, label) {
  // Deterministic, clearly-labeled placeholder so the UI and plumbing can be
  // demoed end-to-end with no API key and no cost.
  const snippet = text.length > 60 ? text.slice(0, 60) + '…' : text;
  return `[DRY RUN — mock ${label} translation, not a real translation]\n${snippet}`;
}

async function translateAll({ text, targetCodes, modelAccessKey, modelId, baseUrl, dryRun }) {
  const jobs = targetCodes.map(async (code) => {
    const lang = LANGUAGE_BY_CODE[code];
    if (dryRun) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400)); // feel "live"
      return {
        code,
        label: lang.label,
        translation: mockTranslation(text, code, lang.label),
        input_tokens: Math.round(text.length / 4),
        output_tokens: Math.round(text.length / 4),
        latency_s: 0.3 + Math.random() * 0.3,
        error: null,
      };
    }
    const r = await translateOne({ modelAccessKey, baseUrl, modelId, text, targetLabel: lang.label });
    return { code, label: lang.label, ...r };
  });
  return Promise.all(jobs);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeJs(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const PAGE_STYLE = `
  :root {
    --do-blue: #0069ff; --do-blue-dark: #0050c4; --ink: #111827; --muted: #6b7280;
    --border: #e5e7eb; --bg: #f7f8fa; --card: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }
  header { background: #03244d; color: #fff; padding: 24px 28px; }
  header h1 { margin: 0 0 4px 0; font-size: 19px; }
  header p { margin: 0; font-size: 13px; color: #9fb4d6; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  textarea { width: 100%; min-height: 150px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; font-family: inherit; font-size: 14px; resize: vertical; }
  .presets { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 18px 0; }
  .chip-btn { background: #eef4ff; color: #0050c4; border: 1px solid #cfe0ff; border-radius: 999px; padding: 6px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .chip-btn:hover { background: #dde9ff; }
  .chip-btn.ghost { background: #fff; color: var(--muted); border-color: var(--border); }
  .langs { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 20px 0; }
  .lang-check { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; font-size: 13.5px; cursor: pointer; }
  .lang-check input { margin: 0; }
  .char-count { font-size: 12px; color: var(--muted); text-align: right; margin-top: 4px; }
  .btn { display: inline-block; background: var(--do-blue); color: #fff; border: none; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: var(--do-blue-dark); }
  .btn:disabled { background: #9fb4d6; cursor: default; }
  .note { font-size: 13px; color: var(--muted); margin-top: 14px; line-height: 1.6; }
  .mode-flag { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: #fff1e6; color: #b45309; margin-left: 8px; }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
  .result-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
  .result-card .lang-name { font-weight: 700; font-size: 14px; margin-bottom: 8px; color: #03244d; }
  .result-card .translation { font-size: 14px; white-space: pre-wrap; line-height: 1.5; }
  .result-card .meta { font-size: 11.5px; color: var(--muted); margin-top: 10px; }
  .result-card .err { color: #b91c1c; font-size: 13px; }
  .status-line { font-size: 13.5px; color: var(--muted); margin: 4px 0 14px 0; min-height: 18px; }
  footer { text-align: center; font-size: 11px; color: var(--muted); padding: 24px; }
`;

const CLIENT_SCRIPT = `
const PRESETS = ${JSON.stringify(PRESET_EXAMPLES)};

function loadPreset(key) {
  document.getElementById('text').value = PRESETS[key].text;
  updateCharCount();
}
function clearText() {
  document.getElementById('text').value = '';
  updateCharCount();
}
function updateCharCount() {
  const el = document.getElementById('text');
  document.getElementById('charCount').textContent = el.value.length + ' / ' + ${MAX_TEXT_LEN} + ' characters';
}

function selectedLangs() {
  return Array.from(document.querySelectorAll('.lang-check input:checked')).map((c) => c.value);
}

function renderResults(data) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';
  for (const r of data.results) {
    const card = document.createElement('div');
    card.className = 'result-card';
    if (r.error) {
      card.innerHTML = '<div class="lang-name">' + r.label + '</div><div class="err">Error: ' + r.error.replace(/</g, '&lt;') + '</div>';
    } else {
      const meta = r.input_tokens + ' in / ' + r.output_tokens + ' out &middot; ' + r.latency_s.toFixed(2) + 's';
      const safeTranslation = (r.translation || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      card.innerHTML = '<div class="lang-name">' + r.label + '</div><div class="translation">' + safeTranslation + '</div><div class="meta">' + meta + '</div>';
    }
    grid.appendChild(card);
  }
}

async function runTranslate() {
  const text = document.getElementById('text').value.trim();
  const langs = selectedLangs();
  const statusEl = document.getElementById('statusLine');
  const btn = document.getElementById('translateBtn');
  const grid = document.getElementById('resultsGrid');

  if (!text) { statusEl.textContent = 'Enter some text first.'; return; }
  if (langs.length === 0) { statusEl.textContent = 'Pick at least one target language.'; return; }

  btn.disabled = true;
  grid.innerHTML = '';
  statusEl.textContent = 'Translating into ' + langs.length + ' language' + (langs.length > 1 ? 's' : '') + '...';

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, targetLangs: langs }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.error || ('Request failed with status ' + res.status);
    } else {
      statusEl.textContent = data.dryRun ? 'Done (dry-run / mock translations).' : 'Done.';
      renderResults(data);
    }
  } catch (err) {
    statusEl.textContent = 'Request failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('text').addEventListener('input', updateCharCount);
  document.getElementById('translateBtn').addEventListener('click', runTranslate);
  updateCharCount();
});
`;

function landingPage({ dryRun, hasKey, modelId }) {
  const langChecks = LANGUAGES.map((l) => {
    const checked = DEFAULT_TARGET_CODES.includes(l.code) ? 'checked' : '';
    return `<label class="lang-check"><input type="checkbox" value="${l.code}" ${checked}> ${escapeHtml(l.label)}</label>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Multilingual Support / Content Translation Demo</title><style>${PAGE_STYLE}</style></head><body>
<header>
  <h1>Multilingual Support &amp; Content Demo${dryRun ? '<span class="mode-flag">dry run</span>' : ''}</h1>
  <p>DigitalOcean Serverless Inference — real-time translation of support emails and product copy</p>
</header>
<div class="wrap">
  <div class="panel">
    <p style="margin-top:0;">Paste an inbound support email, a product description, or anything else — pick the
    languages you want it in, and get instant side-by-side translations.</p>

    <div class="presets">
      <button type="button" class="chip-btn" onclick="loadPreset('support_email')">Load example: support email</button>
      <button type="button" class="chip-btn" onclick="loadPreset('product_description')">Load example: product description</button>
      <button type="button" class="chip-btn ghost" onclick="clearText()">Clear</button>
    </div>

    <textarea id="text" maxlength="${MAX_TEXT_LEN}" placeholder="Type or paste text in any language..."></textarea>
    <div class="char-count" id="charCount"></div>

    <div class="langs">${langChecks}</div>

    <button class="btn" id="translateBtn" type="button">Translate &rarr;</button>
    <div class="status-line" id="statusLine"></div>

    <div class="note">
      ${dryRun
        ? `Running in <strong>dry-run mode</strong> (mock translations, no API calls, no cost). Set <code>DRY_RUN=false</code> and a valid <code>MODEL_ACCESS_KEY</code> to go live.`
        : hasKey
          ? `Running live against your DigitalOcean account using model <code>${escapeHtml(modelId)}</code>. Each translation is a small real usage charge.`
          : `<strong>No MODEL_ACCESS_KEY is configured</strong> — live requests will fail. Set it as an app-level secret, or set DRY_RUN=true to demo with mock data.`}
    </div>
  </div>

  <div class="results-grid" id="resultsGrid"></div>
</div>
<footer>Unofficial internal demo. Translations are generated by a DigitalOcean Serverless Inference model and may not be perfect — review before sending to real customers.</footer>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const MODEL_ACCESS_KEY = process.env.MODEL_ACCESS_KEY || null;
const MODEL_ID = process.env.MODEL_ID || 'openai-gpt-oss-120b';

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingPage({ dryRun: DRY_RUN, hasKey: !!MODEL_ACCESS_KEY, modelId: MODEL_ID }));
      return;
    }

    if (req.url === '/api/translate' && req.method === 'POST') {
      if (!DRY_RUN && !MODEL_ACCESS_KEY) {
        sendJson(res, 500, { error: "MODEL_ACCESS_KEY is not configured and DRY_RUN is not true. Set one of them in the app's environment variables." });
        return;
      }

      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }

      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      const requestedCodes = Array.isArray(payload.targetLangs) ? payload.targetLangs : [];
      const targetCodes = [...new Set(requestedCodes)].filter((c) => LANGUAGE_BY_CODE[c]);

      if (!text) {
        sendJson(res, 400, { error: 'Field "text" is required.' });
        return;
      }
      if (text.length > MAX_TEXT_LEN) {
        sendJson(res, 400, { error: `Text is too long (max ${MAX_TEXT_LEN} characters).` });
        return;
      }
      if (targetCodes.length === 0) {
        sendJson(res, 400, { error: 'Pick at least one supported target language.' });
        return;
      }
      if (targetCodes.length > MAX_TARGET_LANGS) {
        sendJson(res, 400, { error: `Pick at most ${MAX_TARGET_LANGS} target languages at a time.` });
        return;
      }

      const results = await translateAll({
        text,
        targetCodes,
        modelAccessKey: MODEL_ACCESS_KEY,
        modelId: MODEL_ID,
        baseUrl: BASE_URL,
        dryRun: DRY_RUN,
      });

      sendJson(res, 200, { dryRun: DRY_RUN, model: DRY_RUN ? null : MODEL_ID, results });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error — check app logs.');
  }
});

server.listen(PORT, () => {
  console.log(`Multilingual translation demo listening on :${PORT} (DRY_RUN=${DRY_RUN}, key configured=${!!MODEL_ACCESS_KEY}, model=${MODEL_ID})`);
});
