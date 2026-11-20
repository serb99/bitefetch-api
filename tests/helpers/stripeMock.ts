// Every test file gets the fake Stripe client instead of the real one (no network, no sandbox objects).
// jest.mock in a setupFilesAfterEnv file applies to the whole test file's module registry.
jest.mock('../../src/services/stripeClient', () => require('./fakeStripe').fakeStripeModule);

import { fakeStripe } from './fakeStripe';

beforeEach(() => {
    fakeStripe.reset();
});
