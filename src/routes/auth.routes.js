import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import asyncHandler from '../utils/async-handler.js';
import { loginLimiter, refreshLimiter } from '../middleware/rate-limit.js';

const router = Router();

router.post('/login', loginLimiter, asyncHandler(authController.login));
router.get('/me', authenticate, asyncHandler(authController.me));
router.post('/refresh', refreshLimiter, asyncHandler(authController.refresh));
router.post('/logout', asyncHandler(authController.logout));
router.post(
  '/change-password',
  authenticate,
  asyncHandler(authController.changePassword)
);

export default router;
