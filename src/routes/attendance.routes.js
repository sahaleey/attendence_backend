// import { Router } from 'express';
// import { authenticate } from '../middleware/authenticate.js';
// import { requirePermission } from '../middleware/authorize.js';
// import P from '../permissions/permission.constants.js';
// import { requireAttendanceSessionStaffRelation } from '../middleware/relation.js';
// import * as attendanceController from '../controllers/attendance.controller.js';
// import asyncHandler from '../utils/async-handler.js';

// const router = Router();

// router.get('/mine', authenticate,  asyncHandler(attendanceController.listMine));
// router.get('/review/options', authenticate,  asyncHandler(attendanceController.reviewOptions));
// router.get('/review/subjects', authenticate,  asyncHandler(attendanceController.reviewSubjects));
// router.get('/review/students', authenticate,  asyncHandler(attendanceController.reviewStudents));
// router.get('/review/students/:studentId', authenticate,  asyncHandler(attendanceController.reviewStudent));
// router.get('/sessions/:sessionId', authenticate,  asyncHandler(attendanceController.getSession));
// router.post(
//   '/sessions/:sessionId/mark',
//   authenticate,
//   requirePermission(P.ATTENDANCE_MARK),
//   requireAttendanceSessionStaffRelation,
//   asyncHandler(attendanceController.markAttendance),
// );

// export default router;


import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission, requireAnyPermission } from '../middleware/authorize.js';
import P from '../permissions/permission.constants.js';
import * as attendanceController from '../controllers/attendance.controller.js';
import { getCurrentAttendance } from '../controllers/attendance.current.controller.js';
import * as liveController from '../controllers/attendance-live.controller.js';
import asyncHandler from '../utils/async-handler.js';

const router = Router();

const canViewOrMark = requireAnyPermission([P.ATTENDANCE_VIEW, P.ATTENDANCE_MARK]);

router.get('/mine', authenticate, canViewOrMark, asyncHandler(attendanceController.listMine));
router.get('/live', authenticate, requirePermission(P.ATTENDANCE_VIEW), asyncHandler(liveController.getLiveBoard));
router.get('/review/options', authenticate, requirePermission(P.ATTENDANCE_VIEW), asyncHandler(attendanceController.reviewOptions));
router.get('/review/subjects', authenticate, requirePermission(P.ATTENDANCE_VIEW), asyncHandler(attendanceController.reviewSubjects));
router.get('/review/students', authenticate, requirePermission(P.ATTENDANCE_VIEW), asyncHandler(attendanceController.reviewStudents));
router.get('/review/students/:studentId', authenticate, requirePermission(P.ATTENDANCE_VIEW), asyncHandler(attendanceController.reviewStudent));
// Per-session access (own class / substitute / manager) is enforced in the service.
router.get('/sessions/:sessionId/students', authenticate, canViewOrMark, asyncHandler(attendanceController.getSession));
router.get('/current', authenticate, requirePermission(P.ATTENDANCE_MARK), asyncHandler(getCurrentAttendance));
// Ownership, deadline and admin override are enforced inside the marking transaction.
router.post(
  '/sessions/:sessionId/mark',
  authenticate,
  requirePermission(P.ATTENDANCE_MARK),
  asyncHandler(attendanceController.markAttendance),
);

export default router;
