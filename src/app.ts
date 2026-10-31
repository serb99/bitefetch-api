import express from 'express';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { accountRoutes } from './routes/accountRoutes';
import { sessionRoutes } from './routes/sessionRoutes';
import { passwordResetRoutes, passwordResetConfirmationRoutes } from './routes/passwordResetRoutes';
import cookieParser from 'cookie-parser';

const app = express();

app.use(requestLogger);
app.use(express.json());
app.use(cookieParser());

app.use(accountRoutes);
app.use('/sessions', sessionRoutes);
app.use('/password-resets', passwordResetRoutes);
app.use('/password-reset-confirmations', passwordResetConfirmationRoutes);

app.use(notFound);
app.use(errorHandler);

export { app };