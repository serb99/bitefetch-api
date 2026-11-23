import 'dotenv/config';
import { app } from './app';

const PORT = Number(process.env.PORT) || 3000;

// Only HTTP here. The time-based jobs run in a separate process: npm run worker (src/worker.ts).
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
