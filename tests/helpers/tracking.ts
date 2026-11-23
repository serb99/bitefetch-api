import { api } from './http';

// M7b: the customer's live courier map (GET /orders/:id/tracking and GET /orders/:id/route).
// Like the M7 helpers, every test here assumes mockRoute(3001) was called (OSRM is never called for real).

type Headers = { Authorization: string };

// headers undefined → no Authorization header at all (401)
function getTracking(orderId: string, headers?: Headers) {
    const req = api().get(`/orders/${orderId}/tracking`);
    return headers ? req.set(headers) : req;
}

function getRoute(orderId: string, headers?: Headers) {
    const req = api().get(`/orders/${orderId}/route`);
    return headers ? req.set(headers) : req;
}

// The URLs global fetch was called with since the last mockClear (only OSRM uses fetch in these tests).
function fetchedUrls(): string[] {
    return jest.mocked(fetch).mock.calls.map(([input]) => String(input));
}

export { getTracking, getRoute, fetchedUrls };
