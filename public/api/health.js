'use strict';

module.exports = (_req, res) => {
  res.status(200).json({
    ok: true,
    runtime: process.version,
    hasAgnesKey: Boolean((process.env.AGNES_API_KEY || '').trim()),
    hasAgnesBaseUrl: Boolean((process.env.AGNES_BASE_URL || '').trim()),
    model: (process.env.AGNES_MODEL || 'agnes-2.5-flash').trim()
  });
};
