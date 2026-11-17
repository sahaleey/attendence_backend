import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFlags,
  computeStats,
  emptyCounts,
  liveStatusOf,
  maxSeverity,
  presentsNeeded,
  summarize,
  trailingAbsentDays,
} from '../src/services/attendance-insights.logic.js';

const settings = { minAttendancePercent: 75, atRiskAttendancePercent: 80, consecutiveAbsenceAlert: 3 };

test('computeStats: LATE counts as attended, EXCUSED leaves the denominator', () => {
  const s = computeStats({ PRESENT: 6, LATE: 1, ABSENT: 3, EXCUSED: 2 });
  assert.equal(s.totalSessions, 12);
  assert.equal(s.countedSessions, 10);
  assert.equal(s.attendedSessions, 7);
  assert.equal(s.percentage, 70);
  assert.equal(s.eligible, false);
  assert.equal(s.presentsNeeded, 2);
});

test('computeStats: no marked sessions gives null percentage and eligibility', () => {
  const s = computeStats(emptyCounts());
  assert.equal(s.percentage, null);
  assert.equal(s.adjustedPercentage, null);
  assert.equal(s.eligible, null);
  assert.equal(s.presentsNeeded, 0);
});

test('computeStats: only EXCUSED sessions is not a 0% student', () => {
  const s = computeStats({ EXCUSED: 4 });
  assert.equal(s.countedSessions, 0);
  assert.equal(s.percentage, null);
});

test('computeStats: adjustment points are added and clamped to 0..100', () => {
  assert.equal(computeStats({ PRESENT: 73, ABSENT: 27 }, { adjustmentPoints: 2 }).adjustedPercentage, 75);
  assert.equal(computeStats({ PRESENT: 73, ABSENT: 27 }, { adjustmentPoints: 2 }).eligible, true);
  assert.equal(computeStats({ PRESENT: 99, ABSENT: 1 }, { adjustmentPoints: 5 }).adjustedPercentage, 100);
  assert.equal(computeStats({ PRESENT: 1, ABSENT: 99 }, { adjustmentPoints: -5 }).adjustedPercentage, 0);
  assert.equal(computeStats({ PRESENT: 1 }, { adjustmentPoints: '1.5' }).adjustmentPoints, 1.5);
});

test('computeStats: rounds to one decimal', () => {
  assert.equal(computeStats({ PRESENT: 2, ABSENT: 1 }).percentage, 66.7);
});

test('presentsNeeded: smallest k that reaches the minimum', () => {
  assert.equal(presentsNeeded({ attended: 7, counted: 10, minPercent: 75 }), 2); // 9/12 = 75%
  assert.equal(presentsNeeded({ attended: 0, counted: 4, minPercent: 75 }), 12); // 12/16
  assert.equal(presentsNeeded({ attended: 3, counted: 4, minPercent: 75 }), 0);
  assert.equal(presentsNeeded({ attended: 0, counted: 0, minPercent: 75 }), 0);
  assert.equal(presentsNeeded({ attended: 9, counted: 10, minPercent: 100 }), null);
  for (const [attended, counted] of [[5, 13], [1, 9], [60, 100]]) {
    const k = presentsNeeded({ attended, counted, minPercent: 75 });
    assert.ok((attended + k) / (counted + k) >= 0.75);
    assert.ok(k === 0 || (attended + k - 1) / (counted + k - 1) < 0.75);
  }
});

test('trailingAbsentDays: counts whole absent days from the latest date', () => {
  const days = [
    { date: '2026-11-10', statuses: ['ABSENT'] },
    { date: '2026-11-13', statuses: ['ABSENT', 'ABSENT'] },
    { date: '2026-11-12', statuses: ['ABSENT'] },
    { date: '2026-11-11', statuses: ['ABSENT', 'PRESENT'] },
    { date: '2026-11-14', statuses: ['ABSENT'] },
  ];
  assert.equal(trailingAbsentDays(days), 3);
  assert.equal(trailingAbsentDays([{ date: '2026-11-14', statuses: ['LATE'] }]), 0);
  assert.equal(trailingAbsentDays([{ date: '2026-11-14', statuses: [] }]), 0);
  assert.equal(trailingAbsentDays([]), 0);
});

test('buildFlags: below minimum outranks at-risk and is sorted by severity', () => {
  const stats = computeStats({ PRESENT: 70, ABSENT: 30 });
  const flags = buildFlags({ stats, recent: null, absentStreak: 3, settings });
  assert.deepEqual(flags.map((f) => f.code), ['BELOW_MINIMUM', 'CONSECUTIVE_ABSENCES']);
  assert.equal(maxSeverity(flags), 3);
});

test('buildFlags: at-risk band uses the adjusted percentage', () => {
  const stats = computeStats({ PRESENT: 78, ABSENT: 22 });
  assert.deepEqual(buildFlags({ stats, recent: null, absentStreak: 0, settings }).map((f) => f.code), ['AT_RISK']);
  const boosted = computeStats({ PRESENT: 78, ABSENT: 22 }, { adjustmentPoints: 2 });
  assert.deepEqual(buildFlags({ stats: boosted, recent: null, absentStreak: 0, settings }), []);
});

test('buildFlags: recent decline needs 5+ recent sessions and a 10-point drop', () => {
  const stats = computeStats({ PRESENT: 90, ABSENT: 10 });
  const drop = computeStats({ PRESENT: 4, ABSENT: 2 }); // 66.7%
  assert.deepEqual(buildFlags({ stats, recent: drop, absentStreak: 0, settings }).map((f) => f.code), ['RECENT_DECLINE']);
  const tooFew = computeStats({ PRESENT: 2, ABSENT: 2 });
  assert.deepEqual(buildFlags({ stats, recent: tooFew, absentStreak: 0, settings }), []);
  const small = computeStats({ PRESENT: 17, ABSENT: 3 }); // 85%, drop of 5
  assert.deepEqual(buildFlags({ stats, recent: small, absentStreak: 0, settings }), []);
});

test('buildFlags: streak alert can be disabled with 0', () => {
  const stats = computeStats({ PRESENT: 95, ABSENT: 5 });
  assert.deepEqual(buildFlags({ stats, recent: null, absentStreak: 9, settings: { ...settings, consecutiveAbsenceAlert: 0 } }), []);
});

test('summarize: explains ineligibility and extra flags', () => {
  const stats = computeStats({ PRESENT: 6, LATE: 1, ABSENT: 3, EXCUSED: 2 });
  const flags = buildFlags({ stats, recent: null, absentStreak: 3, settings });
  const text = summarize({ name: 'Demo Student', stats, flags, minPercent: 75 });
  assert.match(text, /attended 7 of 10 counted sessions \(70%\)/);
  assert.match(text, /2 excused session\(s\) were not counted/);
  assert.match(text, /Needs 2 consecutive present session\(s\) to reach 75%/);
  assert.match(text, /Absent for the last 3 school day\(s\)/);
  assert.equal(summarize({ name: 'X', stats: computeStats({}), flags: [], minPercent: 75 }), 'X has no marked attendance yet.');
  assert.match(summarize({ name: 'Y', stats: computeStats({ PRESENT: 9, ABSENT: 1 }), flags: [], minPercent: 75 }), /Meets the 75% requirement/);
});

test('liveStatusOf: covers every state', () => {
  const base = { startMin: 540, endMin: 590, graceMinutes: 15, relativeDay: 'TODAY' };
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'MARKED', nowMinutes: 0 }), 'MARKED');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'STAFF_LEAVE', nowMinutes: 0 }), 'STAFF_LEAVE');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', relativeDay: 'PAST', nowMinutes: 0 }), 'OVERDUE');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', relativeDay: 'FUTURE', nowMinutes: 999 }), 'UPCOMING');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', nowMinutes: 539 }), 'UPCOMING');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', nowMinutes: 540 }), 'IN_PROGRESS');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', nowMinutes: 590 }), 'AWAITING');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', nowMinutes: 604 }), 'AWAITING');
  assert.equal(liveStatusOf({ ...base, sessionStatus: 'PENDING', nowMinutes: 605 }), 'OVERDUE');
  assert.equal(liveStatusOf({ ...base, startMin: null, sessionStatus: 'PENDING', nowMinutes: 600 }), 'PENDING');
});
