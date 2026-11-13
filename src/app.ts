import express from 'express';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { accountRoutes } from './routes/accountRoutes';
import { sessionRoutes } from './routes/sessionRoutes';
import { passwordResetRoutes, passwordResetConfirmationRoutes } from './routes/passwordResetRoutes';
import cookieParser from 'cookie-parser';
import { ownerMenuRoutes } from './routes/ownerMenuRoutes';
import { ownerRestaurantRoutes } from './routes/ownerRestaurantRoutes';
import { restaurantRoutes } from './routes/restaurantRoutes';
import { osmRoutes } from './routes/osmRoutes';
import { meRoutes } from './routes/meRoutes';
import { addressRoutes } from './routes/addressRoutes';
import { cartRoutes } from './routes/cartRoutes';
import { orderRoutes } from './routes/orderRoutes';

const app = express();

app.set('trust proxy', 1);
app.use(requestLogger);
app.use(express.json());
app.use(cookieParser());

app.use(accountRoutes);
app.use('/sessions', sessionRoutes);
app.use('/password-resets', passwordResetRoutes);
app.use('/password-reset-confirmations', passwordResetConfirmationRoutes);

app.use('/owner/menu-items', ownerMenuRoutes);
app.use('/owner/restaurant', ownerRestaurantRoutes);
app.use('/restaurants', restaurantRoutes);
app.use('/osm', osmRoutes);
app.use('/me', meRoutes);
app.use('/addresses', addressRoutes);
app.use('/cart', cartRoutes);
app.use('/orders', orderRoutes);

app.use(notFound);
app.use(errorHandler);

export { app };