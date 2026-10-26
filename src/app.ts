import express from 'express';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { authRoutes } from './routes/authRoutes';

const app = express();

app.use(requestLogger);
app.use(express.json());

app.use('/auth', authRoutes);

app.use(notFound);
app.use(errorHandler);

export { app };