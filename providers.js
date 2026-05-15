const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const Groq = require('groq-sdk');

const {
  GROQ_API_KEY,
  OPENAI_API_KEY,
  GEMINI_API_KEY,
  GROQ_MODEL,
  OPENAI_MODEL,
  GEMINI_MODEL,
  AI_MODEL,
  AI_PROVIDER_ORDER,
  HTTPS_PROXY,
  AI_TIMEOUT_MS,
} = process.env;

const TIMEOUT_MS = Number(AI_TIMEOUT_MS) || 60000;

function buildProxyAgent() {
  return HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : null;
}

function postJson({ url, headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(headers || {}),
        },
        agent: agent || undefined,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(Object.assign(new Error('Request timeout'), { code: 'ETIMEDOUT' })); });
    req.write(data);
    req.end();
  });
}

async function callGroq({ systemPrompt, userText, agent }) {
  const groq = new Groq({
    apiKey: GROQ_API_KEY,
    httpAgent: agent || undefined,
    timeout: TIMEOUT_MS,
  });
  const r = await groq.chat.completions.create({
    model: GROQ_MODEL || AI_MODEL || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
  });
  return r.choices[0].message.content;
}

async function callOpenAI({ systemPrompt, userText, agent }) {
  const r = await postJson({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    agent,
    body: {
      model: OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    },
  });
  return r.choices?.[0]?.message?.content || '';
}

async function callGemini({ systemPrompt, userText, agent }) {
  const model = GEMINI_MODEL || 'gemini-2.0-flash';
  const r = await postJson({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    agent,
    body: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    },
  });
  const parts = r.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

const PROVIDER_DEFS = {
  groq:   { name: 'groq',   hasKey: () => !!GROQ_API_KEY,   call: callGroq   },
  openai: { name: 'openai', hasKey: () => !!OPENAI_API_KEY, call: callOpenAI },
  gemini: { name: 'gemini', hasKey: () => !!GEMINI_API_KEY, call: callGemini },
};

function getOrderedProviders() {
  const order = (AI_PROVIDER_ORDER || 'groq,openai,gemini')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return order
    .map((name) => PROVIDER_DEFS[name])
    .filter((p) => p && p.hasKey());
}

function isNetworkError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  const msg = String(err.message || '');
  if (['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','ENOTFOUND','EPIPE','EPROTO'].includes(code)) return true;
  if (/timeout|socket hang up|network|proxy|tunneling|tls|getaddrinfo/i.test(msg)) return true;
  return false;
}

async function tryProviderWithProxyFallback(provider, { systemPrompt, userText }) {
  const proxyAgent = buildProxyAgent();
  if (proxyAgent) {
    try {
      const out = await provider.call({ systemPrompt, userText, agent: proxyAgent });
      console.log(`[AI] ${provider.name} OK via proxy`);
      return { provider: provider.name, route: 'proxy', text: out };
    } catch (err) {
      if (isNetworkError(err)) {
        console.warn(`[AI] ${provider.name} via proxy failed (${err.message.slice(0,120)}), retrying direct`);
      } else {
        throw err;
      }
    }
  }
  const out = await provider.call({ systemPrompt, userText, agent: null });
  console.log(`[AI] ${provider.name} OK direct`);
  return { provider: provider.name, route: 'direct', text: out };
}

async function analyze({ systemPrompt, userText }) {
  const providers = getOrderedProviders();
  if (!providers.length) {
    throw new Error('No AI provider configured: set GROQ_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY');
  }
  const errors = [];
  for (const p of providers) {
    try {
      return await tryProviderWithProxyFallback(p, { systemPrompt, userText });
    } catch (err) {
      const short = String(err.message || err).slice(0, 200);
      console.error(`[AI] ${p.name} failed: ${short}`);
      errors.push(`${p.name}: ${short.slice(0,120)}`);
    }
  }
  const e = new Error(`All AI providers failed. ${errors.join(' | ')}`);
  e.allFailed = true;
  throw e;
}

function describeConfig() {
  const active = getOrderedProviders().map((p) => p.name);
  return {
    active,
    proxy: HTTPS_PROXY ? `enabled (${HTTPS_PROXY.replace(/\/\/[^@]+@/, '//***@')})` : 'disabled',
  };
}

module.exports = { analyze, getOrderedProviders, isNetworkError, describeConfig };