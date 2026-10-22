import express from 'express';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';

const app = express();

app.use(requestLogger);
app.use(express.json());

app.use(notFound);
app.use(errorHandler);

export { app };