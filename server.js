'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');
const cors = require('cors');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.AGNES_API_KEY || '').trim();
const BASE_URL = (process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/chat\/completions$/, '');
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;
const DEFAULT_MODEL = (process.env.AGNES_MODEL || 'agnes-2.5-flash').trim();
const UPSTREAM_TIMEOUT_MS = 90_000;
const ALLOWED_ROLES = new Set(['user', 'assistant']);

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m === 'object' && ALLOWED_ROLES.has(m.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
}

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'AGNES_API_KEY chưa được cấu hình trên server' });
  }

  const messages = sanitizeMessages(req.body && req.body.messages);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'messages không hợp lệ hoặc rỗng' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        stream: false
      }),
      signal: controller.signal
    });

    const rawText = await upstream.text();
    if (/^\s*</.test(rawText) || /<!doctype/i.test(rawText)) {
      console.error(`[upstream] HTML thay vì JSON (HTTP ${upstream.status}) tại ${CHAT_ENDPOINT}`);
      return res.status(502).json({
        error: 'Upstream trả HTML thay vì JSON',
        hint: 'Kiểm tra AGNES_BASE_URL / AGNES_MODEL / AGNES_API_KEY'
      });
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      console.error('[upstream] JSON parse fail:', rawText.slice(0, 300));
      return res.status(502).json({ error: 'Upstream trả dữ liệu không phải JSON' });
    }

    if (!upstream.ok) {
      const message = typeof payload.error === 'string'
        ? payload.error
        : (payload.error && payload.error.message) || 'Upstream error';
      return res.status(upstream.status).json({ error: message });
    }

    delete payload.model;
    delete payload.provider;
    delete payload.system_fingerprint;

    const reasoningFields = ['reasoning_content', 'reasoning', 'thinking', 'internal', 'chain_of_thought'];
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (choice && choice.message && typeof choice.message === 'object') {
          for (const field of reasoningFields) delete choice.message[field];
        }
        if (choice && typeof choice === 'object') {
          for (const field of reasoningFields) delete choice[field];
          delete choice.provider_specific_fields;
        }
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json(payload);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    console.error('[proxy]', error.message);
    return res.status(502).json({ error: 'Không kết nối được upstream' });
  } finally {
    clearTimeout(timeoutId);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Body quá lớn' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON không hợp lệ' });
  }
  console.error('[server]', err && err.message);
  return res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Liber AI gateway chạy tại cổng ${PORT}`);
  console.log(`  upstream: ${CHAT_ENDPOINT}`);
  console.log(`  model:    ${DEFAULT_MODEL}`);
});
