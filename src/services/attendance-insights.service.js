import prisma from '../lib/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { startOfDay, endOfDay, businessNow, todayKey, addDays, parseSchoolDateStrict } from '../utils/date.js';
import { activeEnrollmentFilter } from '../utils/enrollment-status.js';
import { getAttendanceSettings } from '../utils/attendance-settings.js';
import { getStaffForUser, getStaffStandardIds, isAttendanceManager } from '../utils/attendance-access.js';
import { resolveAcademicYear } from './attendance-report.service.js';
import { getLiveBoard } from './attendance-live.service.js';
import { findMissingSessions } from './attendance-session.service.js';
import {
  buildFlags,
  computeStats,
  emptyCounts,
  maxSeverity,
  summarize,
  trailingAbsentDays,
} from './attendance-insights.logic.js';

const RECENT_DAYS = 14;
const STREAK_LOOKBACK_DAYS = 21;
const MISSING_LOOKBACK_DAYS = 7;

const toInt = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** null = every class; otherwise the set of standards a teacher may see. */
const visibleStandardIds = async (user, academicYearId) => {
  if (isAttendanceManager(user)) return null;
  const staff = await getStaffForUser(user.id);
  if (!staff) return null; // non-staff with report permission (e.g. office role)
  return getStaffStandardIds(staff.id, academicYearId);
};

const scopedStandardFilter = (scope, standardId) => {
  if (standardId) {
    if (scope && !scope.has(standardId)) throw new ApiError(403, 'You are not assigned to this class');
    return standardId;
  }
  return scope ? { in: [...scope] } : undefined;
};

const parseRange = ({ from, to }) => {
  const range = {};
  if (from) range.gte = startOfDay(parseSchoolDateStrict(from, 'from'));
  if (to) range.lte = endOfDay(parseSchoolDateStrict(to, 'to'));
  if (range.gte && range.lte && range.lte < range.gte) throw new ApiError(400, '"to" must be on or after "from"');
  return Object.keys(range).length ? range : undefined;
};

const countsByEnrollment = async (enrollmentIds, academicYearId, dateRange) => {
  const map = new Map();
  if (!enrollmentIds.length) return map;
  const rows = await prisma.studentAttendance.groupBy({
    by: ['enrollmentId', 'status'],
    where: {
      enrollmentId: { in: enrollmentIds },
      session: { is: { academicYearId, ...(dateRange ? { attendanceDate: dateRange } : {}) } },
    },
    _count: { _all: true },
  });
  for (const r of rows) {
    if (!map.has(r.enrollmentId)) map.set(r.enrollmentId, emptyCounts());
    const c = map.get(r.enrollmentId);
    if (r.status in c) c[r.status] += r._count._all;
  }
  return map;
};

const adjustmentsByStudent = async (studentIds, academicYearId) => {
  if (!studentIds.length) return new Map();
  const rows = await prisma.attendanceAdjustment.groupBy({
    by: ['studentId'],
    where: { academicYearId, studentId: { in: studentIds } },
    _sum: { points: true },
  });
  return new Map(rows.map((r) => [r.studentId, Number(r._sum.points || 0)]));
};

const absentStreaks = async (enrollmentIds, academicYearId, now) => {
  const map = new Map();
  if (!enrollmentIds.length) return map;
  const records = await prisma.studentAttendance.findMany({
    where: {
      enrollmentId: { in: enrollmentIds },
      session: {
        is: {
          academicYearId,
          attendanceDate: { gte: startOfDay(addDays(now, -STREAK_LOOKBACK_DAYS)), lte: endOfDay(now) },
        },
      },
    },
    select: { enrollmentId: true, status: true, session: { select: { attendanceDate: true } } },
  });
  const days = new Map();
  for (const r of records) {
    const key = todayKey(r.session.attendanceDate);
    if (!days.has(r.enrollmentId)) days.set(r.enrollmentId, new Map());
    const byDay = days.get(r.enrollmentId);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r.status);
  }
  for (const [enrollmentId, byDay] of days) {
    map.set(enrollmentId, trailingAbsentDays([...byDay].map(([date, statuses]) => ({ date, statuses }))));
  }
  return map;
};

/** Stats + flags for every active enrollment in scope. */
const analyseEnrollments = async ({ year, settings, where, dateRange }) => {
  const now = businessNow();
  const enrollments = await prisma.studentEnrollment.findMany({
    where: { academicYearId: year.id, status: activeEnrollmentFilter(), ...where },
    include: {
      student: { select: { id: true, name: true, admissionNo: true } },
      standard: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ standard: { code: 'asc' } }, { rollNo: 'asc' }],
  });
  const ids = enrollments.map((e) => e.id);
  const recentRange = { gte: startOfDay(addDays(now, -(RECENT_DAYS - 1))), lte: endOfDay(now) };

  const [overall, recent, adjustments] = await Promise.all([
    countsByEnrollment(ids, year.id, dateRange),
    countsByEnrollment(ids, year.id, recentRange),
    adjustmentsByStudent(enrollments.map((e) => e.studentId), year.id),
  ]);

  // Streaks only matter for students with a recent absence.
  const withRecentAbsence = ids.filter((id) => (recent.get(id)?.ABSENT || 0) > 0);
  const streaks = await absentStreaks(withRecentAbsence, year.id, now);

  const min = settings.minAttendancePercent;
  return enrollments.map((e) => {
    const stats = computeStats(overall.get(e.id) || emptyCounts(), {
      adjustmentPoints: dateRange ? 0 : adjustments.get(e.studentId) || 0,
      minPercent: min,
    });
    const recentStats = computeStats(recent.get(e.id) || emptyCounts(), { minPercent: min });
    const absentStreak = streaks.get(e.id) || 0;
    const flags = buildFlags({ stats, recent: recentStats, absentStreak, settings });
    return {
      enrollmentId: e.id,
      student: e.student,
      standard: e.standard,
      rollNo: e.rollNo,
      ...stats,
      recentPercentage: recentStats.percentage,
      absentStreakDays: absentStreak,
      flags,
      severity: maxSeverity(flags),
      summary: summarize({ name: e.student.name, stats, flags, minPercent: min }),
    };
  });
};

const settingsView = (s) => ({
  minAttendancePercent: s.minAttendancePercent,
  atRiskAttendancePercent: s.atRiskAttendancePercent,
  consecutiveAbsenceAlert: s.consecutiveAbsenceAlert,
});

export const getAtRiskStudents = async ({ user, academicYearId, standardId, limit, includeAll }) => {
  const year = await resolveAcademicYear(academicYearId);
  const settings = await getAttendanceSettings(year.id);
  const scope = await visibleStandardIds(user, year.id);
  const standardFilter = scopedStandardFilter(scope, standardId);

  const rows = await analyseEnrollments({
    year,
    settings,
    where: standardFilter ? { standardId: standardFilter } : {},
  });

  const flagged = rows.filter((r) => r.flags.length);
  const list = (includeAll === 'true' || includeAll === true ? rows : flagged).sort(
    (a, b) => b.severity - a.severity || (a.adjustedPercentage ?? 101) - (b.adjustedPercentage ?? 101)
  );
  const count = (code) => flagged.filter((r) => r.flags.some((f) => f.code === code)).length;

  return {
    academicYear: { id: year.id, name: year.name },
    settings: settingsView(settings),
    totals: {
      students: rows.length,
      flagged: flagged.length,
      belowMinimum: count('BELOW_MINIMUM'),
      atRisk: count('AT_RISK'),
      consecutiveAbsences: count('CONSECUTIVE_ABSENCES'),
      recentDecline: count('RECENT_DECLINE'),
    },
    students: list.slice(0, toInt(limit, 200, 1, 1000)),
  };
};

export const getStudentInsight = async ({ user, studentId, academicYearId }) => {
  const year = await resolveAcademicYear(academicYearId);
  const settings = await getAttendanceSettings(year.id);
  const enrollment = await prisma.studentEnrollment.findUnique({
    where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
  });
  if (!enrollment) throw new ApiError(404, 'Student is not enrolled in this academic year');

  const scope = await visibleStandardIds(user, year.id);
  scopedStandardFilter(scope, enrollment.standardId);

  const [row] = await analyseEnrollments({ year, settings, where: { id: enrollment.id } });
  const base = row || {
    enrollmentId: enrollment.id,
    note: `Enrollment status is ${enrollment.status}; analytics cover active enrollments only.`,
  };

  const records = await prisma.studentAttendance.findMany({
    where: { enrollmentId: enrollment.id },
    select: {
      status: true,
      session: {
        select: { attendanceDate: true, subject: { select: { id: true, code: true, name: true } } },
      },
    },
  });

  const bySubject = new Map();
  const byMonth = new Map();
  for (const r of records) {
    const s = r.session.subject;
    if (!bySubject.has(s.id)) bySubject.set(s.id, { subject: s, counts: emptyCounts() });
    if (r.status in emptyCounts()) bySubject.get(s.id).counts[r.status] += 1;
    const month = todayKey(r.session.attendanceDate).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, emptyCounts());
    if (r.status in emptyCounts()) byMonth.get(month)[r.status] += 1;
  }

  const min = settings.minAttendancePercent;
  return {
    academicYear: { id: year.id, name: year.name },
    settings: settingsView(settings),
    ...base,
    subjects: [...bySubject.values()]
      .map(({ subject, counts }) => {
        const st = computeStats(counts, { minPercent: min });
        return { subject, counts, percentage: st.percentage, countedSessions: st.countedSessions, belowMinimum: st.eligible === false };
      })
      .sort((a, b) => (a.percentage ?? 101) - (b.percentage ?? 101)),
    monthlyTrend: [...byMonth.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, counts]) => ({ month, counts, percentage: computeStats(counts).percentage })),
  };
};

/** Percentage + eligibility report for /reports/attendance. */
export const getAttendancePercentageReport = async ({ user, academicYearId, standardId, from, to, eligibility, page, pageSize }) => {
  const year = await resolveAcademicYear(academicYearId);
  const settings = await getAttendanceSettings(year.id);
  const scope = await visibleStandardIds(user, year.id);
  const standardFilter = scopedStandardFilter(scope, standardId);
  const dateRange = parseRange({ from, to });

  let rows = await analyseEnrollments({
    year,
    settings,
    where: standardFilter ? { standardId: standardFilter } : {},
    dateRange,
  });

  if (eligibility === 'ELIGIBLE') rows = rows.filter((r) => r.eligible === true);
  else if (eligibility === 'NOT_ELIGIBLE') rows = rows.filter((r) => r.eligible === false);
  else if (eligibility) throw new ApiError(400, 'eligibility must be ELIGIBLE or NOT_ELIGIBLE');

  const withData = rows.filter((r) => r.percentage !== null);
  const avg = withData.length
    ? Math.round((withData.reduce((s, r) => s + r.adjustedPercentage, 0) / withData.length) * 10) / 10
    : null;

  const size = toInt(pageSize, 100, 1, 500);
  const current = toInt(page, 1, 1, 100000);
  return {
    academicYear: { id: year.id, name: year.name },
    range: { from: from || null, to: to || null },
    settings: settingsView(settings),
    // Adjustment points apply to the whole year, so they are left out of date-ranged reports.
    adjustmentsApplied: !dateRange,
    totals: {
      students: rows.length,
      eligible: rows.filter((r) => r.eligible === true).length,
      notEligible: rows.filter((r) => r.eligible === false).length,
      noData: rows.length - withData.length,
      averagePercentage: avg,
    },
    page: current,
    pageSize: size,
    totalPages: Math.max(1, Math.ceil(rows.length / size)),
    data: rows.slice((current - 1) * size, current * size).map(({ flags, severity, summary, ...r }) => ({
      ...r,
      flags: flags.map((f) => f.code),
    })),
  };
};

/** Free, active staff for a slot; staff who already teach the class come first. */
const suggestSubstitutes = async ({ session, busyStaffIds, onLeaveStaffIds, teachersOfClass }) => {
  const staff = await prisma.staff.findMany({
    where: { isActive: true, user: { isActive: true }, id: { notIn: [...busyStaffIds, ...onLeaveStaffIds, session.staffId] } },
    select: { id: true, employeeCode: true, user: { select: { name: true } } },
  });
  return staff
    .map((s) => ({
      staffId: s.id,
      name: s.user.name,
      employeeCode: s.employeeCode,
      teachesClass: teachersOfClass.has(s.id),
      reason: teachersOfClass.has(s.id) ? 'Free this period and already teaches this class' : 'Free this period',
    }))
    .sort((a, b) => Number(b.teachesClass) - Number(a.teachesClass) || a.name.localeCompare(b.name))
    .slice(0, 3);
};

export const getAdminInsights = async ({ academicYearId, date }) => {
  const year = await resolveAcademicYear(academicYearId);
  const now = businessNow();
  const day = date ? parseSchoolDateStrict(date, 'date') : startOfDay(now);
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);

  const live = await getLiveBoard({ date: todayKey(day), academicYearId: year.id });
  const overdue = live.classes.flatMap((c) =>
    c.periods
      .filter((p) => p.liveStatus === 'OVERDUE')
      .map((p) => ({ standard: { id: c.standardId, code: c.standardCode, name: c.standardName }, ...p }))
  );

  // Staff-leave sessions with nobody covering them, plus substitute suggestions.
  const [leaveSessions, daySessions, substitutions, leaves] = await Promise.all([
    prisma.attendanceSession.findMany({
      where: { academicYearId: year.id, attendanceDate: { gte: dayStart, lte: dayEnd }, sessionStatus: 'STAFF_LEAVE' },
      include: {
        standard: { select: { id: true, code: true, name: true } },
        subject: { select: { id: true, code: true, name: true } },
        period: { select: { id: true, periodIndex: true, startTime: true, endTime: true } },
        staff: { select: { id: true, user: { select: { name: true } } } },
      },
    }),
    prisma.attendanceSession.findMany({
      where: { academicYearId: year.id, attendanceDate: { gte: dayStart, lte: dayEnd } },
      select: { periodId: true, staffId: true, standardId: true },
    }),
    prisma.periodSubstitution.findMany({
      where: { substitutionDate: { gte: dayStart, lte: dayEnd } },
      select: { periodId: true, standardId: true, substituteStaffId: true },
    }),
    prisma.staffLeave.findMany({
      where: { academicYearId: year.id, status: 'APPROVED', startDate: { lte: dayEnd }, endDate: { gte: dayStart } },
      select: { staffId: true, periodLeaves: { select: { periodId: true } } },
    }),
  ]);

  const covered = new Set(substitutions.map((s) => `${s.periodId}:${s.standardId}`));
  const uncovered = leaveSessions.filter((s) => !covered.has(`${s.periodId}:${s.standardId}`));

  const standardIds = [...new Set(uncovered.map((s) => s.standardId))];
  const teacherRows = standardIds.length
    ? await prisma.staffSubjectAssignment.findMany({
        where: { subjectAllocation: { is: { academicYearId: year.id, standardId: { in: standardIds } } } },
        select: { staffId: true, subjectAllocation: { select: { standardId: true } } },
      })
    : [];
  const teachersByStandard = new Map();
  for (const t of teacherRows) {
    const k = t.subjectAllocation.standardId;
    if (!teachersByStandard.has(k)) teachersByStandard.set(k, new Set());
    teachersByStandard.get(k).add(t.staffId);
  }

  const uncoveredLeave = [];
  for (const s of uncovered) {
    const busy = new Set([
      ...daySessions.filter((d) => d.periodId === s.periodId).map((d) => d.staffId),
      ...substitutions.filter((d) => d.periodId === s.periodId).map((d) => d.substituteStaffId),
    ]);
    const onLeave = new Set(
      leaves
        .filter((l) => l.periodLeaves.length === 0 || l.periodLeaves.some((p) => p.periodId === s.periodId))
        .map((l) => l.staffId)
    );
    uncoveredLeave.push({
      sessionId: s.id,
      standard: s.standard,
      subject: s.subject,
      period: s.period,
      staffOnLeave: { id: s.staff.id, name: s.staff.user?.name ?? null },
      suggestions: await suggestSubstitutes({
        session: s,
        busyStaffIds: busy,
        onLeaveStaffIds: onLeave,
        teachersOfClass: teachersByStandard.get(s.standardId) || new Set(),
      }),
    });
  }

  // Timetable slots with no generated session over the last week.
  const missingSessions = [];
  for (let i = MISSING_LOOKBACK_DAYS - 1; i >= 0; i--) {
    const d = addDays(dayStart, -i);
    missingSessions.push(...(await findMissingSessions(year.id, todayKey(d))));
  }

  // Workload over the same week.
  const weekStart = startOfDay(addDays(dayStart, -(MISSING_LOOKBACK_DAYS - 1)));
  const workloadRows = await prisma.attendanceSession.groupBy({
    by: ['staffId', 'sessionStatus'],
    where: { academicYearId: year.id, attendanceDate: { gte: weekStart, lte: dayEnd } },
    _count: { _all: true },
  });
  const workloadStaff = await prisma.staff.findMany({
    where: { id: { in: [...new Set(workloadRows.map((r) => r.staffId))] } },
    select: { id: true, employeeCode: true, user: { select: { name: true } } },
  });
  const staffName = new Map(workloadStaff.map((s) => [s.id, s]));
  const workload = new Map();
  for (const r of workloadRows) {
    if (!workload.has(r.staffId)) {
      const s = staffName.get(r.staffId);
      workload.set(r.staffId, { staffId: r.staffId, name: s?.user.name ?? null, employeeCode: s?.employeeCode ?? null, sessions: 0, marked: 0, pending: 0, staffLeave: 0 });
    }
    const w = workload.get(r.staffId);
    w.sessions += r._count._all;
    if (r.sessionStatus === 'MARKED') w.marked += r._count._all;
    else if (r.sessionStatus === 'STAFF_LEAVE') w.staffLeave += r._count._all;
    else w.pending += r._count._all;
  }

  // Pending past sessions (excluding today) are the real backlog.
  const pendingBacklog = await prisma.attendanceSession.count({
    where: { academicYearId: year.id, sessionStatus: 'PENDING', attendanceDate: { lt: startOfDay(now) } },
  });
  const [correctionsPending, oldestCorrection] = await Promise.all([
    prisma.attendanceCorrection.count({ where: { status: 'PENDING' } }),
    prisma.attendanceCorrection.findFirst({ where: { status: 'PENDING' }, orderBy: { requestedAt: 'asc' }, select: { requestedAt: true } }),
  ]);

  const recommendations = [];
  if (overdue.length) recommendations.push(`${overdue.length} session(s) are overdue for marking today; remind the assigned staff.`);
  if (uncoveredLeave.length) recommendations.push(`${uncoveredLeave.length} session(s) have staff on leave with no substitute; assign one from the suggestions.`);
  if (missingSessions.length) recommendations.push(`${missingSessions.length} timetable slot(s) in the last ${MISSING_LOOKBACK_DAYS} days have no attendance session; run session generation or assign staff.`);
  if (pendingBacklog) recommendations.push(`${pendingBacklog} past session(s) are still unmarked.`);
  if (correctionsPending) recommendations.push(`${correctionsPending} correction request(s) are awaiting review.`);
  if (!recommendations.length) recommendations.push('Nothing needs attention right now.');

  return {
    date: todayKey(day),
    academicYear: { id: year.id, name: year.name },
    live: { summary: live.summary, currentPeriod: live.currentPeriod, graceMinutes: live.graceMinutes },
    overdueSessions: overdue,
    uncoveredStaffLeave: uncoveredLeave,
    missingSessions,
    staffWorkload: [...workload.values()].sort((a, b) => b.pending - a.pending || b.sessions - a.sessions),
    backlog: {
      pastPendingSessions: pendingBacklog,
      pendingCorrections: correctionsPending,
      oldestCorrectionRequestedAt: oldestCorrection?.requestedAt ?? null,
    },
    recommendations,
  };
};

export default { getAtRiskStudents, getStudentInsight, getAttendancePercentageReport, getAdminInsights };
