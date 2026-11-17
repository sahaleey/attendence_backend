import { ApiError } from '../utils/api-error.js';
import { activeEnrollmentFilter } from '../utils/enrollment-status.js';

export const ALLOWED_ATTENDANCE_STATUSES = Object.freeze(['PRESENT', 'ABSENT', 'LATE', 'EXCUSED']);

/**
 * Validates a full-class submission against the session's active roster and
 * returns rows keyed by enrollmentId. `studentId` is accepted for older clients.
 */
export const normalizeMarkRecords = async (tx, session, records) => {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ApiError(400, 'Attendance records are required');
  }

  const enrollments = await tx.studentEnrollment.findMany({
    where: {
      academicYearId: session.academicYearId,
      standardId: session.standardId,
      status: activeEnrollmentFilter(),
    },
    select: { id: true, studentId: true },
  });

  if (enrollments.length === 0) {
    throw new ApiError(400, 'No active students found for this class');
  }

  const enrollmentById = new Map(enrollments.map((e) => [e.id, e]));
  const enrollmentByStudentId = new Map(enrollments.map((e) => [e.studentId, e]));

  const normalized = records.map((record) => {
    const enrollment = record?.enrollmentId
      ? enrollmentById.get(record.enrollmentId)
      : record?.studentId
        ? enrollmentByStudentId.get(record.studentId)
        : null;

    if (!enrollment) {
      throw new ApiError(
        400,
        record?.enrollmentId
          ? `Enrollment ${record.enrollmentId} does not belong to this class`
          : `Student ${record?.studentId} does not belong to this class`
      );
    }

    const status = String(record.status || '').trim().toUpperCase();
    if (!ALLOWED_ATTENDANCE_STATUSES.includes(status)) {
      throw new ApiError(400, `Invalid attendance status. Use ${ALLOWED_ATTENDANCE_STATUSES.join(', ')}`);
    }
    if (status === 'ABSENT' && !record.absenceTypeId) {
      throw new ApiError(400, 'Absence type is required for absent students');
    }

    return {
      enrollmentId: enrollment.id,
      status,
      absenceTypeId: status === 'ABSENT' ? record.absenceTypeId : null,
    };
  });

  if (new Set(normalized.map((r) => r.enrollmentId)).size !== normalized.length) {
    throw new ApiError(400, 'Duplicate student attendance records');
  }
  if (normalized.length !== enrollments.length) {
    throw new ApiError(400, 'Attendance must be submitted for all students');
  }

  const absenceTypeIds = [...new Set(normalized.filter((r) => r.absenceTypeId).map((r) => r.absenceTypeId))];
  if (absenceTypeIds.length) {
    const validTypes = await tx.studentAbsenceType.count({
      where: { id: { in: absenceTypeIds }, isActive: true },
    });
    if (validTypes !== absenceTypeIds.length) {
      throw new ApiError(400, 'Invalid or inactive absence type');
    }
  }

  return normalized;
};

export const writeAttendanceRecords = async (tx, { session, records, actorUserId, action, metadata }) => {
  const created = await tx.studentAttendance.createManyAndReturn({
    data: records.map((record) => ({
      attendanceSessionId: session.id,
      enrollmentId: record.enrollmentId,
      status: record.status,
      absenceTypeId: record.absenceTypeId,
      markedById: actorUserId,
    })),
    select: { id: true, status: true, absenceTypeId: true },
  });

  await tx.attendanceAuditLog.createMany({
    data: created.map((attendance) => ({
      attendanceRecordId: attendance.id,
      action,
      newStatus: attendance.status,
      newAbsenceTypeId: attendance.absenceTypeId,
      performedById: actorUserId,
      metadata: metadata ? JSON.stringify(metadata) : null,
    })),
  });

  await tx.academicYear.updateMany({
    where: { id: session.academicYearId, attendanceStarted: false },
    data: { attendanceStarted: true },
  });

  return created;
};
