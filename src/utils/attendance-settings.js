import prisma from '../lib/prisma.js';

export const ATTENDANCE_SETTING_DEFAULTS = Object.freeze({
  markingDeadline: '21:00',
  allowLateMarking: false,
  markingGraceMinutes: 15,
  minAttendancePercent: 75,
  atRiskAttendancePercent: 80,
  consecutiveAbsenceAlert: 3,
});

export const getAttendanceSettings = async (academicYearId, tx = prisma) => {
  const row = await tx.attendanceSetting.findUnique({ where: { academicYearId } });
  if (!row) return { ...ATTENDANCE_SETTING_DEFAULTS };
  return {
    ...ATTENDANCE_SETTING_DEFAULTS,
    ...row,
    minAttendancePercent: Number(row.minAttendancePercent ?? ATTENDANCE_SETTING_DEFAULTS.minAttendancePercent),
    atRiskAttendancePercent: Number(row.atRiskAttendancePercent ?? ATTENDANCE_SETTING_DEFAULTS.atRiskAttendancePercent),
  };
};

export const timeToMinutes = (time) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};
