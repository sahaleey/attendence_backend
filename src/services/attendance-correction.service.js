import prisma from '../lib/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { ALLOWED_ATTENDANCE_STATUSES } from './attendance-marking.js';
import { getStaffForUser, isAdmin, isAttendanceManager } from '../utils/attendance-access.js';

const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

const CORRECTION_INCLUDE = {
  attendanceRecord: {
    include: {
      enrollment: { include: { student: true, standard: true } },
      session: { include: { subject: true, period: true, standard: true } },
      absenceType: true,
    },
  },
  requestedBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true, email: true } },
};

export const request = async ({
  attendanceRecordId,
  newStatus,
  newAbsenceTypeId,
  reason,
  requestedById,
  requester = null,
}) => {
  if (!attendanceRecordId) throw new ApiError(400, 'attendanceRecordId is required');

  const status = String(newStatus || '').trim().toUpperCase();
  if (!ALLOWED_ATTENDANCE_STATUSES.includes(status)) {
    throw new ApiError(400, `Invalid newStatus. Use ${ALLOWED_ATTENDANCE_STATUSES.join(', ')}`);
  }
  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) throw new ApiError(400, 'A reason is required for a correction');

  const absenceTypeId = status === 'ABSENT' ? newAbsenceTypeId || null : null;
  if (status === 'ABSENT') {
    if (!absenceTypeId) throw new ApiError(400, 'Absence type is required for ABSENT');
    const type = await prisma.studentAbsenceType.findFirst({
      where: { id: absenceTypeId, isActive: true },
      select: { id: true },
    });
    if (!type) throw new ApiError(400, 'Invalid or inactive absence type');
  }

  const record = await prisma.studentAttendance.findUnique({
    where: { id: attendanceRecordId },
    include: { session: { select: { staffId: true } } },
  });
  if (!record) throw new ApiError(404, 'Attendance record not found');

  if (record.status === status && (record.absenceTypeId || null) === absenceTypeId) {
    throw new ApiError(400, 'The requested value is the same as the current record');
  }

  // Staff may only request corrections for attendance they marked or own.
  if (requester && !isAttendanceManager(requester)) {
    const staff = await getStaffForUser(requester.id);
    const ownsSession = staff && record.session?.staffId === staff.id;
    if (!ownsSession && record.markedById !== requester.id) {
      throw new ApiError(403, 'You can only request corrections for attendance you marked');
    }
  }

  const pending = await prisma.attendanceCorrection.findFirst({
    where: { attendanceRecordId, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) {
    throw new ApiError(409, 'A correction for this record is already pending review', {
      correctionId: pending.id,
    });
  }

  return prisma.attendanceCorrection.create({
    data: {
      attendanceRecordId,
      oldStatus: record.status,
      newStatus: status,
      oldAbsenceTypeId: record.absenceTypeId,
      newAbsenceTypeId: absenceTypeId,
      reason: trimmedReason,
      requestedById,
    },
  });
};

const assertNotSelfReview = (correction, reviewedById, reviewer) => {
  if (correction.requestedById !== reviewedById) return false;
  // A lone admin may need to self-approve; everyone else needs a second person.
  if (reviewer && isAdmin(reviewer)) return true;
  throw new ApiError(403, 'You cannot review your own correction request');
};

export const approve = async (id, reviewedById, reviewer = null) =>
  prisma.$transaction(async (tx) => {
    const c = await tx.attendanceCorrection.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, 'Correction not found');
    if (c.status !== 'PENDING') throw new ApiError(409, 'Correction already reviewed');

    const selfApproved = assertNotSelfReview(c, reviewedById, reviewer);

    const current = await tx.studentAttendance.findUnique({ where: { id: c.attendanceRecordId } });
    if (!current) throw new ApiError(404, 'Attendance record not found');
    if (current.status !== c.oldStatus || (current.absenceTypeId || null) !== (c.oldAbsenceTypeId || null)) {
      throw new ApiError(409, 'The attendance record changed after this request; ask for a new correction');
    }

    const claimed = await tx.attendanceCorrection.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'APPROVED', reviewedById, reviewedAt: new Date() },
    });
    if (claimed.count === 0) throw new ApiError(409, 'Correction already reviewed');

    const record = await tx.studentAttendance.update({
      where: { id: c.attendanceRecordId },
      data: {
        status: c.newStatus,
        absenceTypeId: c.newStatus === 'ABSENT' ? c.newAbsenceTypeId : null,
      },
    });

    await tx.attendanceAuditLog.create({
      data: {
        attendanceRecordId: record.id,
        action: 'ATTENDANCE_CORRECTED',
        oldStatus: c.oldStatus,
        newStatus: c.newStatus,
        oldAbsenceTypeId: c.oldAbsenceTypeId,
        newAbsenceTypeId: c.newAbsenceTypeId,
        performedById: reviewedById,
        reason: c.reason,
        metadata: JSON.stringify({ correctionId: id, requestedById: c.requestedById, selfApproved }),
      },
    });

    return record;
  });

export const reject = async (id, reviewedById, { reviewer = null, reason = null } = {}) =>
  prisma.$transaction(async (tx) => {
    const c = await tx.attendanceCorrection.findUnique({ where: { id } });
    if (!c) throw new ApiError(404, 'Correction not found');
    if (c.status !== 'PENDING') throw new ApiError(409, 'Correction already reviewed');

    assertNotSelfReview(c, reviewedById, reviewer);

    const claimed = await tx.attendanceCorrection.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedById, reviewedAt: new Date() },
    });
    if (claimed.count === 0) throw new ApiError(409, 'Correction already reviewed');

    await tx.attendanceAuditLog.create({
      data: {
        attendanceRecordId: c.attendanceRecordId,
        action: 'ATTENDANCE_CORRECTION_REJECTED',
        oldStatus: c.oldStatus,
        newStatus: c.newStatus,
        oldAbsenceTypeId: c.oldAbsenceTypeId,
        newAbsenceTypeId: c.newAbsenceTypeId,
        performedById: reviewedById,
        reason: reason ? String(reason).trim() || null : null,
        metadata: JSON.stringify({ correctionId: id, requestedById: c.requestedById }),
      },
    });

    return tx.attendanceCorrection.findUnique({ where: { id } });
  });

export const list = async ({ status, academicYearId, standardId, page, pageSize } = {}) => {
  const where = {};
  if (status) {
    const normalized = String(status).trim().toUpperCase();
    if (!CORRECTION_STATUSES.includes(normalized)) {
      throw new ApiError(400, `Invalid status. Use ${CORRECTION_STATUSES.join(', ')}`);
    }
    where.status = normalized;
  }
  if (academicYearId || standardId) {
    where.attendanceRecord = {
      session: {
        ...(academicYearId ? { academicYearId } : {}),
        ...(standardId ? { standardId } : {}),
      },
    };
  }

  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);

  const [total, data] = await prisma.$transaction([
    prisma.attendanceCorrection.count({ where }),
    prisma.attendanceCorrection.findMany({
      where,
      include: CORRECTION_INCLUDE,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      skip: (current - 1) * size,
      take: size,
    }),
  ]);

  return { data, page: current, pageSize: size, total, totalPages: Math.ceil(total / size) };
};

export default {
  request,
  approve,
  reject,
  list,
};
