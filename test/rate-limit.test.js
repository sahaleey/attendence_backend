import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rateLimit } from '../src/middleware/rate-limit.js';

const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const hit = (limiter, req) => {
  const res = fakeRes();
  let passed = false;
  limiter(req, res, () => { passed = true; });
  return { passed, res };
};

test('rateLimit: allows max requests per key, then 429 with Retry-After', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 2 });
  const req = { ip: '1.1.1.1' };
  assert.equal(hit(limiter, req).passed, true);
  assert.equal(hit(limiter, req).passed, true);
  const blocked = hit(limiter, req);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.ok(Number(blocked.res.headers['Retry-After']) > 0);
  assert.equal(typeof blocked.res.body.message, 'string');
  assert.equal(hit(limiter, { ip: '2.2.2.2' }).passed, true, 'other keys are unaffected');
});

test('rateLimit: window resets', async () => {
  const limiter = rateLimit({ windowMs: 30, max: 1 });
  const req = { ip: '3.3.3.3' };
  assert.equal(hit(limiter, req).passed, true);
  assert.equal(hit(limiter, req).passed, false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(hit(limiter, req).passed, true);
});

test('rateLimit: custom key separates accounts behind one IP', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 1, key: (req) => `${req.ip}|${req.body.email}` });
  assert.equal(hit(limiter, { ip: '4.4.4.4', body: { email: 'a@x.test' } }).passed, true);
  assert.equal(hit(limiter, { ip: '4.4.4.4', body: { email: 'a@x.test' } }).passed, false);
  assert.equal(hit(limiter, { ip: '4.4.4.4', body: { email: 'b@x.test' } }).passed, true);
});
