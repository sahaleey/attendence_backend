// Pure, deterministic attendance analytics (no database access) so every
// number and flag can be explained and unit-tested.

export const emptyCounts = () => ({ PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 });

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * EXCUSED sessions are left out of the denominator; LATE counts as attended.
 * Adjustment points are percentage points added on top (clamped to 0..100).
 */
export const computeStats = (counts, { adjustmentPoints = 0, minPercent = 75 } = {}) => {
  const c = { ...emptyCounts(), ...counts };
  const total = c.PRESENT + c.ABSENT + c.LATE + c.EXCUSED;
  const counted = total - c.EXCUSED;
  const attended = c.PRESENT + c.LATE;
  const percentage = counted > 0 ? round1((attended / counted) * 100) : null;
  const adjustedPercentage =
    percentage === null ? null : round1(Math.min(100, Math.max(0, percentage + Number(adjustmentPoints || 0))));

  return {
    counts: c,
    totalSessions: total,
    countedSessions: counted,
    attendedSessions: attended,
    percentage,
    adjustmentPoints: Number(adjustmentPoints || 0),
    adjustedPercentage,
    eligible: adjustedPercentage === null ? null : adjustedPercentage >= minPercent,
    presentsNeeded: presentsNeeded({ attended, counted, minPercent }),
  };
};

/**
 * Consecutive sessions a student must attend from now on to reach minPercent:
 * smallest k with (attended + k) / (counted + k) >= min / 100.
 */
export const presentsNeeded = ({ attended, counted, minPercent }) => {
  if (counted <= 0) return 0;
  if (attended * 100 >= minPercent * counted) return 0;
  if (minPercent >= 100) return null; // unreachable once any session was missed
  return Math.ceil((minPercent * counted - 100 * attended) / (100 - minPercent));
};

/**
 * A day counts as absent only when every record that day is ABSENT, so one
 * missed period does not look like a missed day.
 * `days` = [{ date: 'YYYY-MM-DD', statuses: [...] }]. Returns the current streak.
 */
export const trailingAbsentDays = (days) => {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? 1 : -1));
  let streak = 0;
  for (const d of sorted) {
    if (d.statuses.length && d.statuses.every((s) => s === 'ABSENT')) streak += 1;
    else break;
  }
  return streak;
};

export const SEVERITY = { BELOW_MINIMUM: 3, CONSECUTIVE_ABSENCES: 2, AT_RISK: 1, RECENT_DECLINE: 1 };

/**
 * Explainable early-warning flags. Each flag carries a human-readable reason.
 * `recent` = stats for the recent window, used to detect a decline.
 */
export const buildFlags = ({ stats, recent, absentStreak, settings }) => {
  const flags = [];
  const pct = stats.adjustedPercentage;
  const { minAttendancePercent: min, atRiskAttendancePercent: atRisk, consecutiveAbsenceAlert } = settings;

  if (pct !== null && pct < min) {
    flags.push({
      code: 'BELOW_MINIMUM',
      severity: SEVERITY.BELOW_MINIMUM,
      reason: `Attendance is ${pct}%, below the required ${min}%.`,
    });
  } else if (pct !== null && pct < atRisk) {
    flags.push({
      code: 'AT_RISK',
      severity: SEVERITY.AT_RISK,
      reason: `Attendance is ${pct}%, within ${round1(pct - min)} points of the ${min}% minimum.`,
    });
  }

  if (consecutiveAbsenceAlert > 0 && absentStreak >= consecutiveAbsenceAlert) {
    flags.push({
      code: 'CONSECUTIVE_ABSENCES',
      severity: SEVERITY.CONSECUTIVE_ABSENCES,
      reason: `Absent for the last ${absentStreak} school day(s) in a row.`,
    });
  }

  // Needs enough recent sessions to be meaningful, and a real drop.
  if (
    recent &&
    recent.percentage !== null &&
    stats.percentage !== null &&
    recent.countedSessions >= 5 &&
    stats.percentage - recent.percentage >= 10
  ) {
    flags.push({
      code: 'RECENT_DECLINE',
      severity: SEVERITY.RECENT_DECLINE,
      reason: `Recent attendance is ${recent.percentage}%, down from ${stats.percentage}% overall.`,
    });
  }

  return flags.sort((a, b) => b.severity - a.severity);
};

export const maxSeverity = (flags) => flags.reduce((m, f) => Math.max(m, f.severity), 0);

/** Template summary (no external AI): stable, factual, and explainable. */
export const summarize = ({ name, stats, flags, minPercent }) => {
  if (stats.percentage === null) return `${name} has no marked attendance yet.`;
  const parts = [
    `${name} attended ${stats.attendedSessions} of ${stats.countedSessions} counted sessions (${stats.adjustedPercentage}%).`,
  ];
  if (stats.counts.EXCUSED) parts.push(`${stats.counts.EXCUSED} excused session(s) were not counted.`);
  if (stats.adjustmentPoints) parts.push(`Includes ${stats.adjustmentPoints > 0 ? '+' : ''}${stats.adjustmentPoints} adjustment point(s).`);
  if (stats.eligible === false) {
    parts.push(
      stats.presentsNeeded === null
        ? `The ${minPercent}% requirement can no longer be met.`
        : `Needs ${stats.presentsNeeded} consecutive present session(s) to reach ${minPercent}%.`
    );
  } else {
    parts.push(`Meets the ${minPercent}% requirement.`);
  }
  for (const f of flags) if (f.code !== 'BELOW_MINIMUM' && f.code !== 'AT_RISK') parts.push(f.reason);
  return parts.join(' ');
};

/**
 * Live status of one session at `nowMinutes` on `relativeDay`
 * ('PAST' | 'TODAY' | 'FUTURE').
 */
export const liveStatusOf = ({ sessionStatus, startMin, endMin, nowMinutes, relativeDay, graceMinutes }) => {
  if (sessionStatus === 'MARKED') return 'MARKED';
  if (sessionStatus === 'STAFF_LEAVE') return 'STAFF_LEAVE';
  if (relativeDay === 'PAST') return 'OVERDUE';
  if (relativeDay === 'FUTURE') return 'UPCOMING';
  if (startMin === null || endMin === null) return 'PENDING';
  if (nowMinutes < startMin) return 'UPCOMING';
  if (nowMinutes < endMin) return 'IN_PROGRESS';
  if (nowMinutes < endMin + graceMinutes) return 'AWAITING';
  return 'OVERDUE';
};
