import { Role } from '@prisma/client';
import { Router } from 'express';

import * as payment from '../controllers/payment.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

// Mounted at /api/payments.
const router = Router();

/**
 * `/me` answers by role: a passenger reads what they owe, a driver reads what
 * they are owed. One path rather than two, because the caller's identity is the
 * only thing that decides it and a `/passengers/me` + `/drivers/me` pair would
 * be two ways of asking the same question.
 */
router.get('/me', requireAuth, payment.listMyPayments);

/** The caller's own balance and its recent movements, whatever their role. */
router.get('/me/wallet', requireAuth, payment.getMyWallet);

/**
 * Settling is a passenger's action: it spends *their* balance. Mounted on the
 * route rather than the router so an unknown path under /api/payments still
 * answers 404 instead of 401.
 */
router.post('/rides/:rideRequestId/pay', requireAuth, requireRole(Role.PASSENGER), payment.payForRide);

export default router;
