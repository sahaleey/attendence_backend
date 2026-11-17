// Minimal in-memory fixed-window limiter. Per-process only: behind several
// instances each one keeps its own counters.
export const rateLimit = ({ windowMs, max, key = (req) => req.ip, message = 'Too many requests, please try again later' }) => {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ message });
    }
    next();
  };
};

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Keyed by IP + email so one targeted account cannot lock out a shared NAT/proxy.
export const loginLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: Number(process.env.LOGIN_RATE_LIMIT || 10),
  key: (req) => `${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`,
  message: 'Too many login attempts, please try again later',
});

export const refreshLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: Number(process.env.REFRESH_RATE_LIMIT || 300),
});
