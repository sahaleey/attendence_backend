import prisma from '../lib/prisma.js';
import { ApiError } from '../utils/api-error.js';
import {
  endOfDay,
  businessNow,
  parseSchoolDateStrict,
  todayKey,
  currentMinutes,
} from '../utils/date.js';
import { activeEnrollmentFilter } from '../utils/enrollment-status.js';
import { assertCanViewSession, findSubstitutionForSession, isAdmin } from '../utils/attendance-access.js';
import { getAttendanceSettings, timeToMinutes } from '../utils/attendance-settings.js';
import { normalizeMarkRecords, writeAttendanceRecords } from './attendance-marking.js';

const SESSION_RESULT_INCLUDE = {
  records: {
    include: {
      enrollment: { include: { student: true, standard: true } },
      absenceType: true,
    },
  },
  standard: true,
  subject: true,
  period: true,
  staff: true,
};

export const getSession = async (id) =>
  prisma.attendanceSession.findUnique({
    where: { id },
    include: SESSION_RESULT_INCLUDE,
  });

const assertWithinMarkingWindow = async (tx, session, now) => {
  if (todayKey(session.attendanceDate) !== todayKey(now)) {
    throw new ApiError(403, 'Attendance can only be marked for today');
  }

  const settings = await getAttendanceSettings(session.academicYearId, tx);
  if (settings.allowLateMarking) return;

  const deadline = timeToMinutes(settings.markingDeadline);
  if (deadline !== null && currentMinutes(now) > deadline) {
    throw new ApiError(
      403,
      `The marking deadline (${settings.markingDeadline}) has passed. Ask an admin to mark this session.`
    );
  }
};

export const mark = async ({ sessionId, staffId: actorUserId, records }) => {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ApiError(400, 'Attendance records are required');
  }

  return prisma.$transaction(
    async (tx) => {
      const session = await tx.attendanceSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new ApiError(404, 'Attendance session not found');

      const user = await tx.user.findUnique({
        where: { id: actorUserId },
        include: { userRoles: { include: { role: true } }, staff: true },
      });
      if (!user) throw new ApiError(404, 'Authenticated user not found');

      const admin = isAdmin(user);
      const now = businessNow();

      if (!admin) {
        if (!user.staff) throw new ApiError(403, 'Authenticated user is not a staff member');
        // A substitution for this slot hands marking to the substitute only.
        const substitution = await findSubstitutionForSession(session, tx);
        const assignedStaffId = substitution ? substitution.substituteStaffId : session.staffId;
        if (assignedStaffId !== user.staff.id) {
          throw new ApiError(403, 'Not assigned to this session');
        }
        await assertWithinMarkingWindow(tx, session, now);
      } else if (session.attendanceDate > endOfDay(now)) {
        throw new ApiError(400, 'Attendance cannot be marked for a future date');
      }

      if (session.sessionStatus !== 'PENDING') {
        throw new ApiError(409, 'Attendance session is no longer editable');
      }

      const normalized = await normalizeMarkRecords(tx, session, records);

      // Atomic claim: a concurrent request for the same session gets 409.
      const claimed = await tx.attendanceSession.updateMany({
        where: { id: sessionId, sessionStatus: 'PENDING' },
        data: { sessionStatus: 'MARKED' },
      });
      if (claimed.count === 0) {
        throw new ApiError(409, 'Attendance has already been marked for this session');
      }

      await writeAttendanceRecords(tx, {
        session,
        records: normalized,
        actorUserId,
        action: 'ATTENDANCE_MARKED',
        metadata: admin ? { markedByAdmin: true } : null,
      });

      return tx.attendanceSession.findUnique({
        where: { id: sessionId },
        include: SESSION_RESULT_INCLUDE,
      });
    },
    { timeout: 15000 }
  );
};

// Cursor format: "<ISO attendanceDate>|<sessionId>". A bare ISO date (older clients) is still accepted.
const parseListCursor = (cursor) => {
  if (!cursor) return null;
  const [iso, id] = String(cursor).split('|');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Invalid cursor');
  return { date, id: id || null };
};

export const listForStaff = async (userId, { cursor, limit } = {}) => {
  const staff = await prisma.staff.findUnique({ where: { userId } });
  if (!staff) throw new ApiError(403, 'Authenticated user is not a staff member');

  const take = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const endOfToday = endOfDay(businessNow());
  const parsedCursor = parseListCursor(cursor);

  const where = { staffId: staff.id, attendanceDate: { lte: endOfToday } };
  if (parsedCursor) {
    where.OR = parsedCursor.id
      ? [
          { attendanceDate: { lt: parsedCursor.date } },
          { attendanceDate: parsedCursor.date, id: { lt: parsedCursor.id } },
        ]
      : [{ attendanceDate: { lt: parsedCursor.date } }];
  }

  const rows = await prisma.attendanceSession.findMany({
    where,
    include: { standard: true, subject: true, period: true },
    orderBy: [{ attendanceDate: 'desc' }, { id: 'desc' }],
    take: take + 1,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;
  const last = data[data.length - 1];

  return {
    data,
    nextCursor: hasMore && last ? `${last.attendanceDate.toISOString()}|${last.id}` : null,
    hasMore,
  };
};

// Review is intentionally not restricted to the logged-in staff member.
// Any staff user with ATTENDANCE_VIEW may review all students and subjects.
export const reviewSubjects = async ({ standardId, subjectId, from, to }) => {
  const where = {};
  if (standardId) where.standardId = standardId;
  if (subjectId) where.subjectId = subjectId;
  if (from || to) where.attendanceDate = {};
  if (from) where.attendanceDate.gte = parseSchoolDateStrict(from, 'from');
  if (to) where.attendanceDate.lte = endOfDay(parseSchoolDateStrict(to, 'to'));

  return prisma.attendanceSession.findMany({
    where,
    include: {
      standard: true,
      subject: true,
      period: true,
      records: {
        include: {
          enrollment: { include: { student: true } },
          absenceType: true,
        },
      },
    },
    orderBy: [{ attendanceDate: 'desc' }, { period: { periodIndex: 'asc' } }],
  });
};

export const reviewStudents = async ({ standardId }) =>
  prisma.student.findMany({
    where: {
      status: 'ACTIVE',
      ...(standardId
        ? { enrollments: { some: { standardId, status: activeEnrollmentFilter() } } }
        : {}),
    },
    include: {
      enrollments: { where: { status: activeEnrollmentFilter() }, include: { standard: true } },
    },
    orderBy: { name: 'asc' },
  });

export const reviewStudent = async ({ studentId, from, to }) => {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw new ApiError(404, 'Student not found');

  const where = { enrollment: { studentId } };
  if (from || to) where.session = { attendanceDate: {} };
  if (from) where.session.attendanceDate.gte = parseSchoolDateStrict(from, 'from');
  if (to) where.session.attendanceDate.lte = endOfDay(parseSchoolDateStrict(to, 'to'));

  const records = await prisma.studentAttendance.findMany({
    where,
    include: {
      absenceType: true,
      enrollment: { include: { student: true, standard: true, academicYear: true } },
      session: {
        include: {
          standard: true,
          subject: true,
          period: true,
          staff: { include: { user: true } },
        },
      },
    },
    orderBy: [{ session: { attendanceDate: 'desc' } }],
  });

  return { student, records };
};

export const reviewOptions = async () => {
  const [standards, subjects] = await Promise.all([
    prisma.standard.findMany({ orderBy: { name: 'asc' } }),
    prisma.subject.findMany({ orderBy: { name: 'asc' } }),
  ]);
  return { standards, subjects };
};

export const getStudentsForSession = async (sessionId, user) => {
  const session = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    include: { standard: true, subject: true, period: true },
  });
  if (!session) throw new ApiError(404, 'Attendance session not found');

  await assertCanViewSession(user, session);

  // Active roster, plus anyone who already has a record here (e.g. withdrawn since marking).
  const enrollments = await prisma.studentEnrollment.findMany({
    where: {
      academicYearId: session.academicYearId,
      standardId: session.standardId,
      OR: [
        { status: activeEnrollmentFilter() },
        { attendance: { some: { attendanceSessionId: sessionId } } },
      ],
    },
    include: { student: true },
    orderBy: { rollNo: 'asc' },
  });

  const attendanceRecords = await prisma.studentAttendance.findMany({
    where: { attendanceSessionId: sessionId },
  });
  const recordMap = new Map(attendanceRecords.map((r) => [r.enrollmentId, r]));

  const students = enrollments.map((enrollment) => {
    const record = recordMap.get(enrollment.id);
    return {
      id: enrollment.student.id,
      studentId: enrollment.student.id,
      enrollmentId: enrollment.id,
      name: enrollment.student.name,
      admissionNo: enrollment.student.admissionNo,
      rollNo: enrollment.rollNo,
      status: record?.status || 'unmarked',
      absenceTypeId: record?.absenceTypeId || null,
    };
  });

  return { session, students, attendanceRecords };
};

export default {
  getSession,
  mark,
  listForStaff,
  reviewSubjects,
  reviewStudents,
  reviewStudent,
  reviewOptions,
  getStudentsForSession,
};
