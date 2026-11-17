// src/services/attendance.leave.service.js
import prisma from '../lib/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { endOfDay, startOfDay, parseSchoolDateStrict, todayKey } from '../utils/date.js';
import {
  isAdmin as hasAdmin,
  isAttendanceManager,
  findSubstitutionForSession,
} from '../utils/attendance-access.js';
import { normalizeMarkRecords, writeAttendanceRecords } from './attendance-marking.js';

const MAX_BULK_RANGE_DAYS = 92;

const SESSION_DETAIL_INCLUDE = {
  standard: true,
  subject: true,
  period: true,
  staff: { include: { user: true } },
};

// A leaveId, when supplied, must be an APPROVED leave of that staff member covering the date(s).
const assertLeaveCovers = async (tx, { leaveId, staffId, from, to }) => {
  if (!leaveId) return null;
  const leave = await tx.staffLeave.findUnique({ where: { id: leaveId } });
  if (!leave) throw new ApiError(404, 'Staff leave not found');
  if (leave.staffId !== staffId) {
    throw new ApiError(400, 'Staff leave belongs to a different staff member');
  }
  if (leave.status !== 'APPROVED') {
    throw new ApiError(400, 'Staff leave is not approved');
  }
  if (startOfDay(leave.startDate) > from || endOfDay(leave.endDate) < to) {
    throw new ApiError(400, 'Staff leave does not cover the requested dates');
  }
  return leave;
};

/**
 * Update a single PENDING attendance session's status to STAFF_LEAVE.
 */
export const markSessionAsStaffLeave = async ({
  sessionId,
  leaveId,
  reason = null,
  performedById,
}) => {
  if (!sessionId) throw new ApiError(400, 'sessionId is required');

  return prisma.$transaction(async (tx) => {
    const session = await tx.attendanceSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new ApiError(404, 'Attendance session not found');

    if (session.sessionStatus === 'MARKED') {
      throw new ApiError(409, 'Cannot mark as STAFF_LEAVE: attendance already marked');
    }
    if (session.sessionStatus !== 'PENDING') {
      throw new ApiError(409, `Session is already ${session.sessionStatus}`);
    }

    await assertLeaveCovers(tx, {
      leaveId,
      staffId: session.staffId,
      from: startOfDay(session.attendanceDate),
      to: endOfDay(session.attendanceDate),
    });

    const claimed = await tx.attendanceSession.updateMany({
      where: { id: sessionId, sessionStatus: 'PENDING' },
      data: { sessionStatus: 'STAFF_LEAVE' },
    });
    if (claimed.count === 0) {
      throw new ApiError(409, 'Session status changed; reload and try again');
    }

    await tx.attendanceAuditLog.create({
      data: {
        action: 'SESSION_MARKED_STAFF_LEAVE',
        oldStatus: 'PENDING',
        newStatus: 'STAFF_LEAVE',
        performedById,
        reason,
        metadata: JSON.stringify({ leaveId: leaveId || null, sessionId }),
      },
    });

    return tx.attendanceSession.findUnique({
      where: { id: sessionId },
      include: SESSION_DETAIL_INCLUDE,
    });
  });
};

/**
 * Bulk update a staff member's PENDING sessions between two dates to STAFF_LEAVE.
 * Called when a StaffLeave is approved.
 */
export const markStaffLeaveSessions = async ({
  staffId,
  from,
  to,
  academicYearId,
  leaveId,
  performedById,
  reason = null,
}) => {
  // Prisma drops undefined filters, so a missing staffId would match every staff member.
  if (!staffId) throw new ApiError(400, 'staffId is required');
  if (!academicYearId) throw new ApiError(400, 'academicYearId is required');

  const start = parseSchoolDateStrict(from, 'from');
  const end = endOfDay(parseSchoolDateStrict(to, 'to'));
  if (end < start) throw new ApiError(400, '"to" must be on or after "from"');

  const dayCount = Math.round((startOfDay(end) - start) / 86400000) + 1;
  if (dayCount > MAX_BULK_RANGE_DAYS) {
    throw new ApiError(400, `Range too large; at most ${MAX_BULK_RANGE_DAYS} days at a time`);
  }

  return prisma.$transaction(async (tx) => {
    const [staff, year] = await Promise.all([
      tx.staff.findUnique({ where: { id: staffId }, select: { id: true } }),
      tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } }),
    ]);
    if (!staff) throw new ApiError(404, 'Staff not found');
    if (!year) throw new ApiError(404, 'Academic year not found');

    await assertLeaveCovers(tx, { leaveId, staffId, from: start, to: end });

    // Only touch PENDING sessions — never override MARKED ones.
    const sessions = await tx.attendanceSession.findMany({
      where: {
        staffId,
        academicYearId,
        attendanceDate: { gte: start, lte: end },
        sessionStatus: 'PENDING',
      },
      select: { id: true },
    });

    if (sessions.length === 0) {
      return { updatedCount: 0, sessionIds: [] };
    }

    const sessionIds = sessions.map((s) => s.id);

    const updated = await tx.attendanceSession.updateMany({
      where: { id: { in: sessionIds }, sessionStatus: 'PENDING' },
      data: { sessionStatus: 'STAFF_LEAVE' },
    });

    await tx.attendanceAuditLog.createMany({
      data: sessionIds.map((id) => ({
        action: 'SESSION_MARKED_STAFF_LEAVE',
        oldStatus: 'PENDING',
        newStatus: 'STAFF_LEAVE',
        performedById,
        reason,
        metadata: JSON.stringify({ leaveId: leaveId || null, sessionId: id }),
      })),
    });

    return { updatedCount: updated.count, sessionIds };
  });
};

/**
 * List all sessions currently in STAFF_LEAVE state
 * (for admin dashboard to pick up and mark)
 */
export const listStaffLeaveSessions = async ({
  from,
  to,
  standardId,
  staffId,
  academicYearId,
} = {}) => {
  const where = {
    sessionStatus: 'STAFF_LEAVE',
    ...(staffId ? { staffId } : {}),
    ...(standardId ? { standardId } : {}),
    ...(academicYearId ? { academicYearId } : {}),
  };

  if (from || to) {
    where.attendanceDate = {};
    if (from) where.attendanceDate.gte = parseSchoolDateStrict(from, 'from');
    if (to) where.attendanceDate.lte = endOfDay(parseSchoolDateStrict(to, 'to'));
  }

  const sessions = await prisma.attendanceSession.findMany({
    where,
    include: SESSION_DETAIL_INCLUDE,
    orderBy: [{ attendanceDate: 'asc' }, { period: { periodIndex: 'asc' } }],
  });

  if (sessions.length === 0) return [];

  // One query for all substitutions instead of one per session.
  const substitutions = await prisma.periodSubstitution.findMany({
    where: {
      OR: sessions.map((s) => ({
        substitutionDate: s.attendanceDate,
        periodId: s.periodId,
        standardId: s.standardId,
      })),
    },
    include: {
      substituteStaff: { include: { user: true } },
      originalStaff: { include: { user: true } },
    },
  });

  const keyOf = (date, periodId, standardId) => `${todayKey(date)}:${periodId}:${standardId}`;
  const byKey = new Map(
    substitutions.map((sub) => [keyOf(sub.substitutionDate, sub.periodId, sub.standardId), sub])
  );

  return sessions.map((session) => {
    const substitution =
      byKey.get(keyOf(session.attendanceDate, session.periodId, session.standardId)) || null;
    return {
      ...session,
      substitution,
      canBeMarkedBy: substitution ? substitution.substituteStaffId : 'ADMIN_ONLY',
    };
  });
};

/**
 * Find the effective marker for a session:
 *  - If a PeriodSubstitution exists for the date/period/standard → substitute staff
 *  - Else → null (admin must mark)
 */
export const resolveSubstituteForSession = async ({ session, tx = prisma }) =>
  tx.periodSubstitution.findUnique({
    where: {
      substitutionDate_periodId_standardId: {
        substitutionDate: session.attendanceDate,
        periodId: session.periodId,
        standardId: session.standardId,
      },
    },
    include: { substituteStaff: true },
  });

/**
 * Mark attendance on a STAFF_LEAVE session.
 * Only an admin / attendance manager or the substitute staff may do this.
 */
export const markStaffLeaveAttendance = async ({ sessionId, actorUserId, records }) => {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ApiError(400, 'Attendance records are required');
  }

  return prisma.$transaction(
    async (tx) => {
      const session = await tx.attendanceSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new ApiError(404, 'Attendance session not found');

      if (session.sessionStatus !== 'STAFF_LEAVE') {
        throw new ApiError(
          409,
          `Session is not in STAFF_LEAVE state (current: ${session.sessionStatus})`
        );
      }

      const actor = await tx.user.findUnique({
        where: { id: actorUserId },
        include: {
          userRoles: {
            include: { role: { include: { permissions: { include: { permission: true } } } } },
          },
          staff: true,
        },
      });
      if (!actor) throw new ApiError(404, 'Authenticated user not found');

      const isAdmin = hasAdmin(actor);
      const isManager = isAttendanceManager(actor);
      const substitution = await findSubstitutionForSession(session, tx);
      const isSubstitute =
        !!substitution && !!actor.staff && substitution.substituteStaffId === actor.staff.id;

      if (!isManager && !isSubstitute) {
        throw new ApiError(403, 'Only the substitute staff or an admin can mark this session');
      }

      const normalized = await normalizeMarkRecords(tx, session, records);

      const claimed = await tx.attendanceSession.updateMany({
        where: { id: sessionId, sessionStatus: 'STAFF_LEAVE' },
        data: { sessionStatus: 'MARKED' },
      });
      if (claimed.count === 0) {
        throw new ApiError(409, 'Attendance has already been marked for this session');
      }

      await writeAttendanceRecords(tx, {
        session,
        records: normalized,
        actorUserId,
        action: 'ATTENDANCE_MARKED_ON_LEAVE',
        metadata: {
          markedOnBehalfOf: session.staffId,
          isAdmin,
          isSubstitute,
          substitutionId: substitution?.id || null,
        },
      });

      return tx.attendanceSession.findUnique({
        where: { id: sessionId },
        include: {
          records: {
            include: {
              enrollment: { include: { student: true, standard: true } },
              absenceType: true,
            },
          },
          ...SESSION_DETAIL_INCLUDE,
        },
      });
    },
    { timeout: 15000 }
  );
};

export default {
  markSessionAsStaffLeave,
  markStaffLeaveSessions,
  listStaffLeaveSessions,
  resolveSubstituteForSession,
  markStaffLeaveAttendance,
};
