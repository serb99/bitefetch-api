import 'dotenv/config';
import { app } from './app';
import { startPaymentJobs } from './jobs/paymentJobs';

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startPaymentJobs();
});