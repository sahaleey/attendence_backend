import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission, requireAnyPermission } from '../middleware/authorize.js';
import P from '../permissions/permission.constants.js';
import asyncHandler from '../utils/async-handler.js';
import * as insights from '../controllers/attendance-insights.controller.js';

const router = Router();

// Teachers see only the classes they teach / are class teacher of; managers see all.
router.get('/at-risk', authenticate, requirePermission(P.REPORTS_ATTENDANCE_VIEW), asyncHandler(insights.getAtRisk));
router.get('/students/:studentId', authenticate, requirePermission(P.REPORTS_ATTENDANCE_VIEW), asyncHandler(insights.getStudent));

router.get(
  '/admin',
  authenticate,
  requireAnyPermission([P.ATTENDANCE_AUDIT, P.ATTENDANCE_SESSION_GENERATE]),
  asyncHandler(insights.getAdmin),
);

export default router;
