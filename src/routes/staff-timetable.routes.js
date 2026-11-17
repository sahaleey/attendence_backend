import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requirePermission, requireAnyPermission } from "../middleware/authorize.js";
import P from "../permissions/permission.constants.js";
import {
  getMyWeeklyTimetableController,
  getMyTodayPeriodsController,
  getClassListController,
  getClassTimetableController,
  getTimetableChangesController,
} from "../controllers/staff-timetable.controller.js";

const router = Router();

/* My timetable */
const canViewOwn = requireAnyPermission([P.TIMETABLE_VIEW, P.ATTENDANCE_MARK]);
router.get("/me", authenticate, canViewOwn, getMyWeeklyTimetableController);
router.get("/me/today", authenticate, canViewOwn, getMyTodayPeriodsController);

/* Class timetable */
router.get("/classes", authenticate, requirePermission(P.TIMETABLE_VIEW), getClassListController);
router.get("/classes/:standardId", authenticate, requirePermission(P.TIMETABLE_VIEW), getClassTimetableController);

/* Changes */
router.get("/changes", authenticate, canViewOwn, getTimetableChangesController);

export default router;