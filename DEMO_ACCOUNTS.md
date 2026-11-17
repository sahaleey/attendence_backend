# Demo data and demo accounts

Demo data is for local development and presentations only. It is never created by the
normal seed and the demo step refuses to run when `NODE_ENV=production`.

## Running

```bash
# .env (development database only)
SEED_ADMIN_PASSWORD=<your admin password>
SEED_DEMO_PASSWORD=<shared password for the demo accounts, 8+ chars>

npx prisma migrate deploy   # apply pending migrations first
npm run seed:demo           # = node prisma/seed.js --demo  (or SEED_DEMO=true npm run prisma:seed)
```

The seed is idempotent: re-running it only creates what is missing. It never deletes
records and never changes existing users, passwords, timetables or attendance.

## Accounts

All demo accounts share the password from `SEED_DEMO_PASSWORD` (not stored anywhere in
the repository; only its bcrypt hash is saved).

| Email | Role | Notes |
| --- | --- | --- |
| `teacher1@demo-school.test` | STAFF | Demo Mathematics, class teacher of DEMO-10A |
| `teacher2@demo-school.test` | STAFF | Demo Science, class teacher of DEMO-10B |
| `teacher3@demo-school.test` | STAFF | Demo English |
| `teacher4@demo-school.test` | STAFF | Demo Social Studies, on approved leave on the seed date |
| `coordinator@demo-school.test` | ATTENDANCE_MANAGER | Sees all classes, admin insights |

The administrator account is the one from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
(production credentials are managed separately and are not part of the demo).

## What gets created

- Academic year `DEMO YYYY-YY` (1 June – 31 May around the current date). It is
  `ACTIVE` only if no other year is active; otherwise it is `DRAFT` and you pass its
  `academicYearId` to the insights/live endpoints.
- Attendance/timetable settings, Sunday weekly holiday, 4 periods per day Monday–Saturday.
- Classes `DEMO-10A`, `DEMO-10B`; subjects `DEMO-MATH`, `DEMO-SCI`, `DEMO-ENG`, `DEMO-SOC`,
  allocated and assigned without teacher clashes.
- 20 fictional students (`DEMO-S0001` … `DEMO-S0020`, "Demo Student 001" …), 10 per class.
- Absence types `DEMO-SICK`, `DEMO-FAMILY`.
- Sessions generated with the application's own generator for the last 27 days and the
  next 3 days, then marked with deterministic statuses:
  - `DEMO-S0001` ≈ 65% (below the 75% minimum), `DEMO-S0002` ≈ 76% (+2 adjustment → ≈ 78%, at risk),
  - `DEMO-S0011` absent for the last 3 school days, `DEMO-S0012` recent decline.
  - The last period of DEMO-10B on the two most recent school days is left unmarked (backlog).
  - Today: DEMO-10A periods that have already ended are marked; DEMO-10B is left for the live board.
- Today: teacher 4 on leave, one period covered by a substitution, one left uncovered.
- One pending correction request for `DEMO-S0001`.

Note: marking attendance sets `attendanceStarted` on the demo year, which locks its
start/end dates (normal application rule).
