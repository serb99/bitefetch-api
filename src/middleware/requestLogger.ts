import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';

const requestLogger = pinoHttp({
    logger: logger,
    genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
    },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]']
});

export { requestLogger };