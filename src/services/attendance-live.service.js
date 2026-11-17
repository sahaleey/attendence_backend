import prisma from '../lib/prisma.js';
import { startOfDay, endOfDay, businessNow, currentMinutes, todayKey, parseSchoolDateStrict } from '../utils/date.js';
import { getAttendanceSettings, timeToMinutes } from '../utils/attendance-settings.js';
import { resolveAcademicYear } from './attendance-report.service.js';
import { liveStatusOf } from './attendance-insights.logic.js';

const LIVE_STATUSES = ['MARKED', 'STAFF_LEAVE', 'OVERDUE', 'AWAITING', 'IN_PROGRESS', 'UPCOMING', 'PENDING'];

/**
 * Real-time marking board for one day: every class x period with a live
 * status (UPCOMING / IN_PROGRESS / AWAITING / OVERDUE / MARKED / STAFF_LEAVE).
 * AWAITING = the period has ended but is still within the grace window.
 */
export const getLiveBoard = async ({ date, academicYearId, standardId }) => {
  const now = businessNow();
  const day = date ? parseSchoolDateStrict(date, 'date') : startOfDay(now);
  const year = await resolveAcademicYear(academicYearId);
  const settings = await getAttendanceSettings(year.id);
  const graceMinutes = Number(settings.markingGraceMinutes ?? 15);

  const dayKey = todayKey(day);
  const nowKey = todayKey(now);
  const relativeDay = dayKey < nowKey ? 'PAST' : dayKey > nowKey ? 'FUTURE' : 'TODAY';
  const nowMinutes = currentMinutes(now);

  const where = {
    academicYearId: year.id,
    attendanceDate: { gte: startOfDay(day), lte: endOfDay(day) },
  };
  if (standardId) where.standardId = standardId;

  const [sessions, substitutions] = await Promise.all([
    prisma.attendanceSession.findMany({
      where,
      include: {
        standard: { select: { id: true, code: true, name: true } },
        subject: { select: { id: true, code: true, name: true } },
        period: { select: { id: true, periodIndex: true, startTime: true, endTime: true } },
        staff: { select: { id: true, employeeCode: true, user: { select: { name: true } } } },
        _count: { select: { records: true } },
      },
      orderBy: [{ standard: { code: 'asc' } }, { period: { periodIndex: 'asc' } }],
    }),
    prisma.periodSubstitution.findMany({
      where: { substitutionDate: { gte: startOfDay(day), lte: endOfDay(day) } },
      include: { substituteStaff: { select: { id: true, user: { select: { name: true } } } } },
    }),
  ]);

  const subByKey = new Map(substitutions.map((s) => [`${s.periodId}:${s.standardId}`, s]));
  const summary = Object.fromEntries(LIVE_STATUSES.map((s) => [s, 0]));
  const classes = new Map();
  let currentPeriod = null;

  for (const s of sessions) {
    const startMin = timeToMinutes(s.period.startTime);
    const endMin = timeToMinutes(s.period.endTime);
    const liveStatus = liveStatusOf({
      sessionStatus: s.sessionStatus,
      startMin,
      endMin,
      nowMinutes,
      relativeDay,
      graceMinutes,
    });
    summary[liveStatus] = (summary[liveStatus] || 0) + 1;

    if (relativeDay === 'TODAY' && startMin !== null && endMin !== null && nowMinutes >= startMin && nowMinutes < endMin) {
      currentPeriod ??= { periodIndex: s.period.periodIndex, startTime: s.period.startTime, endTime: s.period.endTime };
    }

    const sub = subByKey.get(`${s.periodId}:${s.standardId}`);
    if (!classes.has(s.standardId)) {
      classes.set(s.standardId, { standardId: s.standard.id, standardCode: s.standard.code, standardName: s.standard.name, periods: [] });
    }
    classes.get(s.standardId).periods.push({
      sessionId: s.id,
      periodIndex: s.period.periodIndex,
      startTime: s.period.startTime,
      endTime: s.period.endTime,
      subject: s.subject,
      staff: { id: s.staff.id, name: s.staff.user?.name ?? null, employeeCode: s.staff.employeeCode },
      substitute: sub ? { id: sub.substituteStaff.id, name: sub.substituteStaff.user?.name ?? null } : null,
      sessionStatus: s.sessionStatus,
      liveStatus,
      markedCount: s._count.records,
      minutesOverdue:
        liveStatus === 'OVERDUE' && relativeDay === 'TODAY' && endMin !== null
          ? nowMinutes - (endMin + graceMinutes)
          : null,
    });
  }

  const total = sessions.length;
  return {
    date: dayKey,
    relativeDay,
    serverTime: now,
    academicYear: { id: year.id, name: year.name },
    graceMinutes,
    currentPeriod,
    summary: {
      totalSessions: total,
      ...summary,
      completionPercent: total ? Math.round((summary.MARKED / total) * 1000) / 10 : null,
    },
    classes: [...classes.values()],
  };
};

export default { getLiveBoard };
