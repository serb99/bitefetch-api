import { Request, Response, NextFunction } from 'express';
import { ZodType } from 'zod';
import { AppError } from '../errors/AppError';

function validate(schema: ZodType){
    return (req: Request, res: Response, next: NextFunction): void =>{ 
        const result = schema.safeParse(req.body);

        if(!result.success){
            const details = result.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message
            }));
            throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', details);
        }

        // Replace the raw body with the cleaned, validated data.
        req.body = result.data;
        next();
    };
}

export { validate };