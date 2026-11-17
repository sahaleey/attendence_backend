-- AlterTable
ALTER TABLE "AttendanceSetting" ADD COLUMN     "atRiskAttendancePercent" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "consecutiveAbsenceAlert" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "markingGraceMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "minAttendancePercent" INTEGER NOT NULL DEFAULT 75;

-- CreateIndex
CREATE INDEX "AttendanceSession_academicYearId_sessionStatus_attendanceDa_idx" ON "AttendanceSession"("academicYearId", "sessionStatus", "attendanceDate");

-- CreateIndex
CREATE INDEX "AttendanceSession_standardId_attendanceDate_idx" ON "AttendanceSession"("standardId", "attendanceDate");

