import { Router } from 'express';

import authRoutes from './auth.routes.js';
import docsRoutes from './docs.routes.js';
import driverRoutes from './driver.routes.js';
import fareRoutes from './fare.routes.js';
import healthRoutes from './health.routes.js';
import locationRoutes from './location.routes.js';
import passengerRoutes from './passenger.routes.js';
import paymentRoutes from './payment.routes.js';
import rideRequestRoutes from './ride-request.routes.js';
import routeRoutes from './route.routes.js';
import userRoutes from './user.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/docs', docsRoutes);
router.use('/drivers', driverRoutes);
router.use('/fare-quotes', fareRoutes);
router.use('/health', healthRoutes);
router.use('/location', locationRoutes);
router.use('/passengers', passengerRoutes);
router.use('/payments', paymentRoutes);
router.use('/ride-requests', rideRequestRoutes);
router.use('/routes', routeRoutes);
router.use('/users', userRoutes);

export default router;
