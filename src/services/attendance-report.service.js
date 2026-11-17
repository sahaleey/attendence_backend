import prisma from '../lib/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { startOfDay, endOfDay, parseSchoolDateStrict, todayKey, businessNow } from '../utils/date.js';
import { activeEnrollmentFilter } from '../utils/enrollment-status.js';
import { getCurrentAcademicYear } from '../utils/academic-year.js';

export const resolveAcademicYear = async (academicYearId) => {
  if (academicYearId) {
    const year = await prisma.academicYear.findUnique({ where: { id: academicYearId } });
    if (!year) throw new ApiError(404, 'Academic year not found');
    return year;
  }

  try {
    return await getCurrentAcademicYear();
  } catch {
    throw new ApiError(404, 'No active academic year found');
  }
};

const parseDate = (date, field = 'date') => parseSchoolDateStrict(date, field);

const countStatuses = (records) => {
  const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
  for (const r of records) if (r.status in counts) counts[r.status] += 1;
  return counts;
};

// Daily grid: standards (rows) x periods (columns) for a given date.
// Columns are derived from whichever periods actually have a session that
// day, so the grid always matches what was really scheduled/generated.
export const getDailyReport = async ({ date, academicYearId }) => {
  const day = parseDate(date);
  const year = await resolveAcademicYear(academicYearId);

  const [standards, sessions, enrollmentCounts] = await Promise.all([
    prisma.standard.findMany({ orderBy: { name: 'asc' } }),
    prisma.attendanceSession.findMany({
      where: {
        academicYearId: year.id,
        attendanceDate: { gte: startOfDay(day), lte: endOfDay(day) },
      },
      include: {
        subject: true,
        period: true,
        staff: { include: { user: true } },
        records: true,
      },
      orderBy: [{ period: { periodIndex: 'asc' } }],
    }),
    prisma.studentEnrollment.groupBy({
      by: ['standardId'],
      where: { academicYearId: year.id, status: activeEnrollmentFilter() },
      _count: { _all: true },
    }),
  ]);

  const enrollmentByStandard = Object.fromEntries(
    enrollmentCounts.map((e) => [e.standardId, e._count._all])
  );

  // Distinct periods that have at least one session today, sorted by index.
  const periodMap = new Map();
  for (const s of sessions) {
    if (!periodMap.has(s.periodId)) periodMap.set(s.periodId, s.period);
  }
  const periods = [...periodMap.values()].sort((a, b) => a.periodIndex - b.periodIndex);

  const cellByKey = new Map();
  for (const s of sessions) {
    const counts = countStatuses(s.records);
    cellByKey.set(`${s.standardId}:${s.periodId}`, {
      sessionId: s.id,
      sessionStatus: s.sessionStatus,
      subject: { id: s.subject.id, name: s.subject.name, code: s.subject.code },
      staff: { id: s.staff.id, name: s.staff.user.name },
      totalStudents: enrollmentByStandard[s.standardId] || 0,
      markedCount: s.records.length,
      presentCount: counts.PRESENT,
      absentCount: counts.ABSENT,
      lateCount: counts.LATE,
      excusedCount: counts.EXCUSED,
    });
  }

  const grid = standards.map((standard) => ({
    standard: { id: standard.id, name: standard.name, code: standard.code },
    totalStudents: enrollmentByStandard[standard.id] || 0,
    cells: periods.map((period) => {
      const cell = cellByKey.get(`${standard.id}:${period.id}`);
      return {
        periodId: period.id,
        periodIndex: period.periodIndex,
        hasSession: Boolean(cell),
        ...(cell || {}),
      };
    }),
  }));

  const summary = sessions.reduce(
    (acc, s) => {
      const counts = countStatuses(s.records);
      acc.totalSessions += 1;
      if (s.sessionStatus === 'MARKED') acc.markedSessions += 1;
      else if (s.sessionStatus === 'STAFF_LEAVE') acc.staffLeaveSessions += 1;
      else acc.pendingSessions += 1;
      acc.totalPresent += counts.PRESENT;
      acc.totalAbsent += counts.ABSENT;
      acc.totalLate += counts.LATE;
      acc.totalExcused += counts.EXCUSED;
      return acc;
    },
    {
      totalSessions: 0,
      markedSessions: 0,
      pendingSessions: 0,
      staffLeaveSessions: 0,
      totalPresent: 0,
      totalAbsent: 0,
      totalLate: 0,
      totalExcused: 0,
    }
  );

  return {
    date: todayKey(day),
    academicYear: { id: year.id, name: year.name },
    periods: periods.map((p) => ({
      id: p.id,
      periodIndex: p.periodIndex,
      startTime: p.startTime,
      endTime: p.endTime,
    })),
    standards: grid,
    summary,
  };
};

// Detail behind one grid cell: every enrolled student in that class, with
// their attendance status for that specific session (or UNMARKED).
export const getSessionReport = async (sessionId) => {
  const session = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    include: {
      standard: true,
      subject: true,
      period: true,
      academicYear: true,
      staff: { include: { user: true } },
      records: { include: { absenceType: true } },
    },
  });

  if (!session) throw new ApiError(404, 'Attendance session not found');

  const enrollments = await prisma.studentEnrollment.findMany({
    where: {
      academicYearId: session.academicYearId,
      standardId: session.standardId,
      OR: [
        { status: activeEnrollmentFilter() },
        { attendance: { some: { attendanceSessionId: session.id } } },
      ],
    },
    include: { student: true },
    orderBy: { rollNo: 'asc' },
  });

  const recordByEnrollmentId = new Map(
    session.records.map((r) => [r.enrollmentId, r])
  );

  const students = enrollments.map((e) => {
    const record = recordByEnrollmentId.get(e.id);
    return {
      enrollmentId: e.id,
      studentId: e.studentId,
      admissionNo: e.student.admissionNo,
      name: e.student.name,
      rollNo: e.rollNo,
      status: record?.status || 'UNMARKED',
      absenceType: record?.absenceType?.name || null,
      remarks: null,
    };
  });

  const counts = countStatuses(students);
  const unmarkedCount = students.filter((s) => s.status === 'UNMARKED').length;

  return {
    session: {
      id: session.id,
      attendanceDate: session.attendanceDate,
      sessionStatus: session.sessionStatus,
      standard: { id: session.standard.id, name: session.standard.name },
      subject: { id: session.subject.id, name: session.subject.name },
      period: {
        id: session.period.id,
        periodIndex: session.period.periodIndex,
        startTime: session.period.startTime,
        endTime: session.period.endTime,
      },
      staff: { id: session.staff.id, name: session.staff.user.name },
      academicYear: { id: session.academicYear.id, name: session.academicYear.name },
    },
    totals: {
      totalStudents: students.length,
      presentCount: counts.PRESENT,
      absentCount: counts.ABSENT,
      lateCount: counts.LATE,
      excusedCount: counts.EXCUSED,
      unmarkedCount,
    },
    students,
  };
};

// Every session not yet marked (PENDING, or STAFF_LEAVE awaiting a substitute/admin)
// within a date range. `to` defaults to today so future sessions are not "unmarked". This is a plain indexed
// query — it relies on sessions being materialized ahead of time by
// attendance-session.service.js (generateForDate / generateForDateRange),
// rather than recomputing "should a session exist here?" from the timetable
// for every day in the range. That's what keeps a "last 5 months, unmarked"
// report cheap even as the range grows.
export const getUnmarkedReport = async ({
  academicYearId,
  from,
  to,
  standardId,
  staffId,
  status,
  page = 1,
  pageSize = 50,
}) => {
  const year = await resolveAcademicYear(academicYearId);

  const UNMARKED_STATUSES = ['PENDING', 'STAFF_LEAVE'];
  const requested = status ? String(status).trim().toUpperCase() : null;
  if (requested && !UNMARKED_STATUSES.includes(requested)) {
    throw new ApiError(400, `Invalid status. Use ${UNMARKED_STATUSES.join(' or ')}`);
  }

  const where = {
    academicYearId: year.id,
    sessionStatus: requested || { in: UNMARKED_STATUSES },
    attendanceDate: {
      lte: endOfDay(to ? parseDate(to, 'to') : businessNow()),
    },
  };
  if (from) where.attendanceDate.gte = startOfDay(parseDate(from, 'from'));
  if (standardId) where.standardId = standardId;
  if (staffId) where.staffId = staffId;

  const take = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const currentPage = Math.max(1, Number(page) || 1);

  const [total, sessions] = await Promise.all([
    prisma.attendanceSession.count({ where }),
    prisma.attendanceSession.findMany({
      where,
      include: {
        standard: true,
        subject: true,
        period: true,
        staff: { include: { user: true } },
      },
      orderBy: [{ attendanceDate: 'asc' }, { period: { periodIndex: 'asc' } }],
      skip: (currentPage - 1) * take,
      take,
    }),
  ]);

  return {
    academicYear: { id: year.id, name: year.name },
    meta: { page: currentPage, pageSize: take, total, totalPages: Math.max(1, Math.ceil(total / take)) },
    sessions: sessions.map((s) => ({
      sessionId: s.id,
      attendanceDate: s.attendanceDate,
      sessionStatus: s.sessionStatus,
      standard: { id: s.standard.id, name: s.standard.name },
      subject: { id: s.subject.id, name: s.subject.name },
      period: { id: s.period.id, periodIndex: s.period.periodIndex, startTime: s.period.startTime },
      staff: { id: s.staff.id, name: s.staff.user.name },
    })),
  };
};

export default { getDailyReport, getSessionReport, getUnmarkedReport };
