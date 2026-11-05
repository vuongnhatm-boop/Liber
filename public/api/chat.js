'use strict';

// Vercel function: POST /api/chat — same contract as the Express gateway.

const API_KEY = (process.env.AGNES_API_KEY || '').trim();
const BASE_URL = (process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/chat\/completions$/, '');
const CHAT_ENDPOINT = `${BASE_URL}/chat/completions`;
const DEFAULT_MODEL = (process.env.AGNES_MODEL || 'agnes-2.5-flash').trim();
const UPSTREAM_TIMEOUT_MS = 55_000;
const ALLOWED_ROLES = new Set(['user', 'assistant']);
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking', 'internal', 'chain_of_thought'];

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m === 'object' && ALLOWED_ROLES.has(m.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!API_KEY) {
    res.status(500).json({ error: 'AGNES_API_KEY chưa được cấu hình trên Vercel' });
    return;
  }

  const body = readBody(req);
  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    res.status(400).json({ error: 'messages không hợp lệ hoặc rỗng' });
    return;
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
      body: JSON.stringify({ model: DEFAULT_MODEL, messages, stream: false }),
      signal: controller.signal
    });

    const rawText = await upstream.text();
    if (/^\s*</.test(rawText) || /<!doctype/i.test(rawText)) {
      res.status(502).json({ error: 'Upstream trả HTML thay vì JSON' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      res.status(502).json({ error: 'Upstream trả dữ liệu không phải JSON' });
      return;
    }

    if (!upstream.ok) {
      const message = typeof payload.error === 'string'
        ? payload.error
        : (payload.error && payload.error.message) || 'Upstream error';
      res.status(upstream.status).json({ error: message });
      return;
    }

    delete payload.model;
    delete payload.provider;
    delete payload.system_fingerprint;
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (choice && choice.message && typeof choice.message === 'object') {
          for (const field of REASONING_FIELDS) delete choice.message[field];
        }
        if (choice && typeof choice === 'object') {
          for (const field of REASONING_FIELDS) delete choice[field];
          delete choice.provider_specific_fields;
        }
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      res.status(504).json({ error: 'Upstream timeout' });
      return;
    }
    res.status(502).json({ error: 'Không kết nối được upstream' });
  } finally {
    clearTimeout(timeoutId);
  }
};
