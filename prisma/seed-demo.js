import bcrypt from "bcryptjs";

import appPrisma from "../src/lib/prisma.js";
import { generateForDateRange } from "../src/services/attendance-session.service.js";
import { writeAttendanceRecords } from "../src/services/attendance-marking.js";
import {
  addDays,
  businessNow,
  currentMinutes,
  endOfDay,
  parseSchoolDate,
  todayKey,
  weekdayOf,
} from "../src/utils/date.js";

// Every demo record uses a DEMO-/demo-school.test identifier so it can never
// collide with real data and re-running the seed only fills in what is missing.
const DEMO_EMAIL_DOMAIN = "demo-school.test";
const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const PERIOD_TIMES = [
  ["09:00", "09:50", 10],
  ["10:00", "10:50", 20],
  ["11:10", "12:00", 10],
  ["12:10", "13:00", 0],
];
const STANDARDS = [
  { code: "DEMO-10A", name: "Demo Grade 10 A" },
  { code: "DEMO-10B", name: "Demo Grade 10 B" },
];
const SUBJECTS = [
  { code: "DEMO-MATH", name: "Demo Mathematics", credits: 4 },
  { code: "DEMO-SCI", name: "Demo Science", credits: 4 },
  { code: "DEMO-ENG", name: "Demo English", credits: 3 },
  { code: "DEMO-SOC", name: "Demo Social Studies", credits: 3 },
];
// teachers[i] teaches SUBJECTS[i] in both classes.
const TEACHERS = SUBJECTS.map((subject, i) => ({
  email: `teacher${i + 1}@${DEMO_EMAIL_DOMAIN}`,
  name: `Demo Teacher ${i + 1} (${subject.name.replace("Demo ", "")})`,
  employeeCode: `DEMO-T0${i + 1}`,
}));
const COORDINATOR = { email: `coordinator@${DEMO_EMAIL_DOMAIN}`, name: "Demo Attendance Coordinator" };
const STUDENTS_PER_CLASS = 10;
const ABSENCE_TYPES = [
  { code: "DEMO-SICK", name: "Sick (demo)" },
  { code: "DEMO-FAMILY", name: "Family reason (demo)" },
];
const HISTORY_DAYS = 27;
const FUTURE_DAYS = 3;
const LEAVE_REASON = "Demo leave";
const CORRECTION_REASON = "Demo: student was at a supervised sports trial";
const ADJUSTMENT_REASON = "Demo: represented the school at an inter-school event";

// Designed profiles so the insights screens have something to show.
const PROFILES = {
  "DEMO-S0001": { absent: 0.35 }, // below the 75% minimum
  "DEMO-S0002": { absent: 0.24 }, // at risk: ~76% + 2 adjustment points, under 80%
  "DEMO-S0011": { absent: 0.05, streakDays: 3 }, // consecutive absences
  "DEMO-S0012": { absent: 0.02, recentAbsent: 0.35 }, // recent decline
};
const DEFAULT_PROFILE = { absent: 0.05 };

const hashString = (value) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// Deterministic 0..1 value per (student, date, period): re-runs pick the same statuses.
const chance = (key) => {
  let t = (hashString(key) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const timeToMinutes = (time) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const demoYearBounds = (today) => {
  const [y, m] = todayKey(today).split("-").map(Number);
  const startYear = m >= 6 ? y : y - 1;
  return {
    name: `DEMO ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    startDate: parseSchoolDate(`${startYear}-06-01`),
    endDate: parseSchoolDate(`${startYear + 1}-05-31`),
  };
};

async function ensureYear(db, today) {
  const bounds = demoYearBounds(today);
  const existing = await db.academicYear.findFirst({ where: { name: bounds.name } });
  if (existing) return existing;

  const otherActive = await db.academicYear.findFirst({ where: { status: "ACTIVE" } });
  if (otherActive) {
    console.warn(
      `   ! Another academic year ("${otherActive.name}") is ACTIVE; the demo year is created as DRAFT.\n` +
        "     Pass its academicYearId to the insights/live endpoints, or activate it from the admin UI."
    );
  }
  return db.academicYear.create({
    data: { ...bounds, status: otherActive ? "DRAFT" : "ACTIVE" },
  });
}

async function ensureYearSettings(db, year) {
  const id = year.id;
  await db.attendanceSetting.upsert({ where: { academicYearId: id }, create: { academicYearId: id }, update: {} });
  await db.timetableSetting.upsert({ where: { academicYearId: id }, create: { academicYearId: id }, update: {} });
  await db.weeklyHoliday.upsert({
    where: { academicYearId_weekday: { academicYearId: id, weekday: "SUNDAY" } },
    create: { academicYearId: id, weekday: "SUNDAY" },
    update: {},
  });

  const [firstStart, firstEnd, firstBreak] = PERIOD_TIMES[0];
  await db.periodConfiguration.upsert({
    where: { academicYearId: id },
    create: {
      academicYearId: id,
      totalPeriodCount: PERIOD_TIMES.length,
      defaultDurationMinutes: timeToMinutes(firstEnd) - timeToMinutes(firstStart),
      isDurationDefault: true,
      sameOutlineForAllDays: true,
      firstPeriodStartTime: firstStart,
      defaultBreakMinutes: firstBreak,
    },
    update: {},
  });
  await db.periodOutline.createMany({
    data: PERIOD_TIMES.map(([startTime, endTime, breakAfterMinutes], i) => ({
      academicYearId: id,
      periodIndex: i + 1,
      startTime,
      endTime,
      durationMinutes: timeToMinutes(endTime) - timeToMinutes(startTime),
      breakAfterMinutes,
    })),
    skipDuplicates: true,
  });

  // Periods are stored per weekday, matching the period-configuration service.
  await db.period.createMany({
    data: WEEKDAYS.flatMap((weekday) =>
      PERIOD_TIMES.map(([startTime, endTime], i) => ({
        academicYearId: id,
        weekday,
        periodIndex: i + 1,
        startTime,
        endTime,
      }))
    ),
    skipDuplicates: true,
  });
  const periods = await db.period.findMany({ where: { academicYearId: id, weekday: { in: WEEKDAYS } } });
  return new Map(periods.map((p) => [`${p.weekday}:${p.periodIndex}`, p]));
}

async function ensureCatalog(db) {
  const standards = [];
  for (const s of STANDARDS) {
    standards.push(await db.standard.upsert({ where: { code: s.code }, create: s, update: {} }));
  }
  const subjects = [];
  for (const s of SUBJECTS) {
    subjects.push(await db.subject.upsert({ where: { code: s.code }, create: s, update: {} }));
  }
  const absenceTypes = [];
  for (const t of ABSENCE_TYPES) {
    absenceTypes.push(await db.studentAbsenceType.upsert({ where: { code: t.code }, create: t, update: {} }));
  }
  return { standards, subjects, absenceTypes };
}

async function ensureUser(db, { email, name }, passwordHash, roleId) {
  const user = await db.user.upsert({
    where: { email },
    create: { email, name, passwordHash },
    update: {},
  });
  await db.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId } },
    create: { userId: user.id, roleId },
    update: {},
  });
  return user;
}

async function ensurePeople(db, roleMap, passwordHash) {
  if (!roleMap.STAFF || !roleMap.ATTENDANCE_MANAGER) {
    throw new Error("STAFF and ATTENDANCE_MANAGER roles are required for the demo seed.");
  }

  const teachers = [];
  for (const t of TEACHERS) {
    const user = await ensureUser(db, t, passwordHash, roleMap.STAFF);
    const staff =
      (await db.staff.findUnique({ where: { userId: user.id } })) ||
      (await db.staff.create({
        data: {
          userId: user.id,
          employeeCode: t.employeeCode,
          designation: "Teacher",
          department: "Demo",
        },
      }));
    teachers.push({ ...staff, user });
  }
  const coordinator = await ensureUser(db, COORDINATOR, passwordHash, roleMap.ATTENDANCE_MANAGER);
  return { teachers, coordinator };
}

async function ensureTeaching(db, year, { standards, subjects }, teachers) {
  await db.subjectAllocation.createMany({
    data: standards.flatMap((standard) =>
      subjects.map((subject) => ({ academicYearId: year.id, standardId: standard.id, subjectId: subject.id }))
    ),
    skipDuplicates: true,
  });

  const allocations = await db.subjectAllocation.findMany({
    where: { academicYearId: year.id, standardId: { in: standards.map((s) => s.id) } },
    include: { staffAssignments: { select: { id: true } } },
  });
  for (const allocation of allocations) {
    if (allocation.staffAssignments.length > 0) continue;
    const teacher = teachers[subjects.findIndex((s) => s.id === allocation.subjectId)];
    await db.staffSubjectAssignment.create({
      data: { subjectAllocationId: allocation.id, staffId: teacher.id },
    });
  }

  for (const [i, standard] of standards.entries()) {
    await db.classTeacher.upsert({
      where: { academicYearId_standardId: { academicYearId: year.id, standardId: standard.id } },
      create: { academicYearId: year.id, standardId: standard.id, staffId: teachers[i].id },
      update: {},
    });
  }
}

// Class A and class B never share a subject in the same period, so no teacher is double-booked.
const subjectIndexFor = (classIndex, weekdayIndex, periodIndex) =>
  (periodIndex - 1 + weekdayIndex + classIndex * 2) % SUBJECTS.length;

async function ensureTimetable(db, year, { standards, subjects }, periodMap) {
  const data = [];
  for (const [wi, weekday] of WEEKDAYS.entries()) {
    for (let p = 1; p <= PERIOD_TIMES.length; p++) {
      for (const [ci, standard] of standards.entries()) {
        data.push({
          academicYearId: year.id,
          standardId: standard.id,
          weekday,
          periodId: periodMap.get(`${weekday}:${p}`).id,
          subjectId: subjects[subjectIndexFor(ci, wi, p)].id,
        });
      }
    }
  }
  await db.timetableEntry.createMany({ data, skipDuplicates: true });
}

async function ensureStudents(db, year, standards) {
  const enrollments = [];
  for (const [ci, standard] of standards.entries()) {
    for (let n = 1; n <= STUDENTS_PER_CLASS; n++) {
      const seq = ci * STUDENTS_PER_CLASS + n;
      const admissionNo = `DEMO-S${String(seq).padStart(4, "0")}`;
      const student = await db.student.upsert({
        where: { admissionNo },
        create: { admissionNo, name: `Demo Student ${String(seq).padStart(3, "0")}` },
        update: {},
      });
      const existing = await db.studentEnrollment.findUnique({
        where: { studentId_academicYearId: { studentId: student.id, academicYearId: year.id } },
      });
      enrollments.push(
        existing ||
          (await db.studentEnrollment.create({
            data: {
              studentId: student.id,
              academicYearId: year.id,
              standardId: standard.id,
              rollNo: String(n).padStart(2, "0"),
              status: "ACTIVE",
            },
          }))
      );
    }
  }
  return enrollments;
}

// Teacher 4 is on leave today: one of their periods is covered, the other is left
// uncovered so the admin insights can suggest a substitute.
async function ensureLeaveAndSubstitution(db, year, today, ctx) {
  const { teachers, coordinator, standards, subjects, periodMap } = ctx;
  const onLeave = teachers[3];

  const leave = await db.staffLeave.findFirst({
    where: { staffId: onLeave.id, academicYearId: year.id, startDate: today, reason: LEAVE_REASON },
  });
  if (!leave) {
    await db.staffLeave.create({
      data: {
        staffId: onLeave.id,
        academicYearId: year.id,
        startDate: today,
        endDate: today,
        leaveType: "CASUAL",
        reason: LEAVE_REASON,
        status: "APPROVED",
        approvedById: coordinator.id,
        approvedAt: businessNow(),
      },
    });
  }

  const weekdayIndex = WEEKDAYS.indexOf(weekdayOf(today));
  if (weekdayIndex === -1) return false;

  const periodIndex = [1, 2, 3, 4].find((p) => subjectIndexFor(0, weekdayIndex, p) === 3);
  const busy = new Set([3, subjectIndexFor(1, weekdayIndex, periodIndex)]);
  const substituteIndex = [0, 1, 2].find((i) => !busy.has(i));
  const period = periodMap.get(`${WEEKDAYS[weekdayIndex]}:${periodIndex}`);

  await db.periodSubstitution.upsert({
    where: {
      substitutionDate_periodId_standardId: {
        substitutionDate: today,
        periodId: period.id,
        standardId: standards[0].id,
      },
    },
    create: {
      substitutionDate: today,
      periodId: period.id,
      standardId: standards[0].id,
      subjectId: subjects[3].id,
      originalStaffId: onLeave.id,
      substituteStaffId: teachers[substituteIndex].id,
      remarks: "Demo substitution",
    },
    update: {},
  });
  return true;
}

function statusFor({ admissionNo, dateKey, periodIndex, recent, inStreak }) {
  const profile = PROFILES[admissionNo] || DEFAULT_PROFILE;
  if (inStreak && profile.streakDays) return "ABSENT";
  const absentRate = recent && profile.recentAbsent != null ? profile.recentAbsent : profile.absent;
  const roll = chance(`${admissionNo}|${dateKey}|${periodIndex}`);
  if (roll < absentRate) return "ABSENT";
  if (roll < absentRate + 0.03) return "LATE";
  return "PRESENT";
}

async function markSessions(db, year, today, ctx) {
  const { standards, enrollments, teachers, absenceTypes } = ctx;
  const sessions = await db.attendanceSession.findMany({
    where: {
      academicYearId: year.id,
      attendanceDate: { lte: endOfDay(today) },
      sessionStatus: "PENDING",
      records: { none: {} },
    },
    include: { period: true },
    orderBy: [{ attendanceDate: "asc" }, { periodId: "asc" }],
  });

  const pastDates = [
    ...new Set(
      (
        await db.attendanceSession.findMany({
          where: { academicYearId: year.id, attendanceDate: { lt: today } },
          select: { attendanceDate: true },
          distinct: ["attendanceDate"],
        })
      ).map((s) => todayKey(s.attendanceDate))
    ),
  ].sort().reverse();
  const backlogDates = new Set(pastDates.slice(0, 2));
  const recentFrom = todayKey(addDays(today, -13));

  const userIdByStaff = new Map(teachers.map((t) => [t.id, t.user.id]));
  const admissionByStudent = new Map(
    (
      await db.student.findMany({
        where: { id: { in: enrollments.map((e) => e.studentId) } },
        select: { id: true, admissionNo: true },
      })
    ).map((s) => [s.id, s.admissionNo])
  );
  const nowMinutes = currentMinutes(businessNow());
  const todayStr = todayKey(today);
  const classB = standards[1].id;
  const streakDates = new Set(pastDates.slice(0, PROFILES["DEMO-S0011"].streakDays));

  let marked = 0;
  for (const session of sessions) {
    const dateKey = todayKey(session.attendanceDate);
    const isToday = dateKey === todayStr;
    // Leave some work undone so the backlog and overdue views are populated.
    if (!isToday && backlogDates.has(dateKey) && session.standardId === classB && session.period.periodIndex === 4) continue;
    if (isToday && (session.standardId === classB || timeToMinutes(session.period.endTime) > nowMinutes)) continue;

    const actorUserId = userIdByStaff.get(session.staffId);
    if (!actorUserId) continue;

    const records = enrollments
      .filter((e) => e.standardId === session.standardId)
      .map((e, i) => {
        const status = statusFor({
          admissionNo: admissionByStudent.get(e.studentId),
          dateKey,
          periodIndex: session.period.periodIndex,
          recent: dateKey >= recentFrom,
          inStreak: streakDates.has(dateKey),
        });
        return {
          enrollmentId: e.id,
          status,
          absenceTypeId: status === "ABSENT" ? absenceTypes[i % absenceTypes.length].id : null,
        };
      });

    await db.$transaction(async (tx) => {
      const claimed = await tx.attendanceSession.updateMany({
        where: { id: session.id, sessionStatus: "PENDING" },
        data: { sessionStatus: "MARKED" },
      });
      if (claimed.count !== 1) return;
      await writeAttendanceRecords(tx, {
        session,
        records,
        actorUserId,
        action: "ATTENDANCE_MARKED",
        metadata: { seed: "demo" },
      });
      marked++;
    });
  }
  return marked;
}

async function ensureCorrectionAndAdjustment(db, year, ctx) {
  const { coordinator } = ctx;
  const [low, atRisk] = await Promise.all(
    ["DEMO-S0001", "DEMO-S0002"].map((admissionNo) => db.student.findUnique({ where: { admissionNo } }))
  );

  const existingCorrection = await db.attendanceCorrection.findFirst({
    where: { reason: CORRECTION_REASON, attendanceRecord: { enrollment: { studentId: low.id, academicYearId: year.id } } },
  });
  if (!existingCorrection) {
    const record = await db.studentAttendance.findFirst({
      where: {
        status: "ABSENT",
        enrollment: { studentId: low.id, academicYearId: year.id },
        corrections: { none: { status: "PENDING" } },
      },
      include: { session: { include: { staff: true } } },
      orderBy: { markedAt: "asc" },
    });
    if (record) {
      await db.attendanceCorrection.create({
        data: {
          attendanceRecordId: record.id,
          oldStatus: record.status,
          newStatus: "PRESENT",
          oldAbsenceTypeId: record.absenceTypeId,
          newAbsenceTypeId: null,
          reason: CORRECTION_REASON,
          requestedById: record.session.staff.userId,
        },
      });
    }
  }

  const existingAdjustment = await db.attendanceAdjustment.findFirst({
    where: { studentId: atRisk.id, academicYearId: year.id, reason: ADJUSTMENT_REASON },
  });
  if (!existingAdjustment) {
    await db.$transaction(async (tx) => {
      const adjustment = await tx.attendanceAdjustment.create({
        data: {
          studentId: atRisk.id,
          academicYearId: year.id,
          points: 2,
          reason: ADJUSTMENT_REASON,
          createdById: coordinator.id,
        },
      });
      await tx.attendanceAuditLog.create({
        data: {
          action: "ATTENDANCE_ADJUSTED",
          performedById: coordinator.id,
          reason: ADJUSTMENT_REASON,
          metadata: JSON.stringify({
            adjustmentId: adjustment.id,
            studentId: atRisk.id,
            academicYearId: year.id,
            points: 2,
            activityTypeId: null,
            seed: "demo",
          }),
        },
      });
    });
  }
}

async function printCounts(db, year, standards) {
  const standardIds = standards.map((s) => s.id);
  const [enrollments, timetable, sessions, records, corrections, adjustments] = await Promise.all([
    db.studentEnrollment.count({ where: { academicYearId: year.id, standardId: { in: standardIds } } }),
    db.timetableEntry.count({ where: { academicYearId: year.id } }),
    db.attendanceSession.groupBy({ by: ["sessionStatus"], where: { academicYearId: year.id }, _count: true }),
    db.studentAttendance.count({ where: { session: { academicYearId: year.id } } }),
    db.attendanceCorrection.count({ where: { attendanceRecord: { session: { academicYearId: year.id } } } }),
    db.attendanceAdjustment.count({ where: { academicYearId: year.id } }),
  ]);
  console.log(`   ✓ Academic year: ${year.name} (${year.status})`);
  console.log(`   ✓ Classes: ${standards.length}, subjects: ${SUBJECTS.length}, teachers: ${TEACHERS.length}, coordinator: 1`);
  console.log(`   ✓ Enrolled students: ${enrollments}, timetable entries: ${timetable}`);
  console.log(
    `   ✓ Sessions: ${sessions.map((s) => `${s.sessionStatus}=${s._count}`).join(", ") || "none"}`
  );
  console.log(`   ✓ Attendance records: ${records}, corrections: ${corrections}, adjustments: ${adjustments}`);
}

export async function seedDemo(db, roleMap) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data while NODE_ENV=production.");
  }
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("SEED_DEMO_PASSWORD (at least 8 characters) is required to seed demo accounts.");
  }

  try {
    const today = parseSchoolDate(todayKey(businessNow()));
    const passwordHash = await bcrypt.hash(password, 12);

    const year = await ensureYear(db, today);
    const periodMap = await ensureYearSettings(db, year);
    const catalog = await ensureCatalog(db);
    const people = await ensurePeople(db, roleMap, passwordHash);
    await ensureTeaching(db, year, catalog, people.teachers);
    await ensureTimetable(db, year, catalog, periodMap);
    const enrollments = await ensureStudents(db, year, catalog.standards);
    const ctx = { ...catalog, ...people, periodMap, enrollments };

    const inYear = today >= year.startDate && today <= endOfDay(year.endDate);
    if (!inYear) {
      console.warn("   ! Today is outside the demo academic year; skipping sessions and attendance.");
    } else {
      await ensureLeaveAndSubstitution(db, year, today, ctx);
      const from = new Date(Math.max(addDays(today, -HISTORY_DAYS).getTime(), year.startDate.getTime()));
      const to = new Date(Math.min(addDays(today, FUTURE_DAYS).getTime(), year.endDate.getTime()));
      const generated = await generateForDateRange(year.id, { from: todayKey(from), to: todayKey(to) });
      console.log(`   ✓ Sessions generated ${generated.from} → ${generated.to}: ${generated.totals.created} new`);
      const marked = await markSessions(db, year, today, ctx);
      console.log(`   ✓ Sessions marked this run: ${marked}`);
      await ensureCorrectionAndAdjustment(db, year, ctx);
    }

    await printCounts(db, year, catalog.standards);
    console.log(`   ✓ Demo logins: ${TEACHERS.map((t) => t.email).join(", ")}, ${COORDINATOR.email}`);
    console.log("     (password = SEED_DEMO_PASSWORD; see DEMO_ACCOUNTS.md)");
  } finally {
    await appPrisma.$disconnect();
  }
}
