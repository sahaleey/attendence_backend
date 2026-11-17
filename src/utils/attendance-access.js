import prisma from '../lib/prisma.js';
import P from '../permissions/permission.constants.js';
import { hasAdminRole, resolvePermissions } from '../permissions/resolve.js';
import { ApiError } from './api-error.js';

const MANAGER_PERMISSIONS = [
  P.ATTENDANCE_SESSION_GENERATE,
  P.ATTENDANCE_APPROVE_CORRECTION,
  P.ATTENDANCE_AUDIT,
];

export const isAdmin = (user) => hasAdminRole(user);

export const hasPermission = (user, permission) => resolvePermissions(user).includes(permission);

// Admins and attendance managers can see and act on every class.
export const isAttendanceManager = (user) => {
  if (isAdmin(user)) return true;
  const mine = resolvePermissions(user);
  return MANAGER_PERMISSIONS.some((p) => mine.includes(p));
};

export const getStaffForUser = (userId, tx = prisma) =>
  tx.staff.findUnique({ where: { userId } });

export const findSubstitutionForSession = (session, tx = prisma) =>
  tx.periodSubstitution.findUnique({
    where: {
      substitutionDate_periodId_standardId: {
        substitutionDate: session.attendanceDate,
        periodId: session.periodId,
        standardId: session.standardId,
      },
    },
  });

// Standards a staff member teaches or is class teacher of, for one academic year.
export const getStaffStandardIds = async (staffId, academicYearId, tx = prisma) => {
  const [assignments, classTeacherOf] = await Promise.all([
    tx.staffSubjectAssignment.findMany({
      where: { staffId, subjectAllocation: { is: { academicYearId } } },
      select: { subjectAllocation: { select: { standardId: true } } },
    }),
    tx.classTeacher.findMany({
      where: { staffId, academicYearId },
      select: { standardId: true },
    }),
  ]);
  return new Set([
    ...assignments.map((a) => a.subjectAllocation.standardId),
    ...classTeacherOf.map((c) => c.standardId),
  ]);
};

/**
 * Who may read a session's roster: managers, the session's staff, the
 * substitute, or anyone who teaches / is class teacher of that class.
 */
export const assertCanViewSession = async (user, session, tx = prisma) => {
  if (isAttendanceManager(user)) return;
  const staff = await getStaffForUser(user.id, tx);
  if (!staff) throw new ApiError(403, 'Authenticated user is not a staff member');
  if (session.staffId === staff.id) return;

  const substitution = await findSubstitutionForSession(session, tx);
  if (substitution && [substitution.substituteStaffId, substitution.originalStaffId].includes(staff.id)) return;

  const standardIds = await getStaffStandardIds(staff.id, session.academicYearId, tx);
  if (standardIds.has(session.standardId)) return;

  throw new ApiError(403, 'You are not assigned to this class');
};
