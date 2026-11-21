import { mockRoute } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import { rejectTimedOutOrders } from '../../../src/services/acceptTimeout';
import {
    placedOrder, acceptedOrder, accept, reject, ready, ownerCancel, customerCancel, kitchenRow, passAcceptDeadline,
} from '../../helpers/restaurantOrders';

// order-state-machine.md §4: two actors on the same order at the same moment, exactly one wins.
// Both requests are sent together; lockOrder (SELECT ... FOR UPDATE) makes the second one wait for the
// first COMMIT and then see the new status. Whichever wins, the end state and the voids must match it.

beforeEach(() => {
    mockRoute(3001);
});

describe('races on the same order', () => {
    it('T6 accept vs T9 customer cancel: one 200, one 409; one void only if the cancel won', async () => {
        const { orderId, owner, customer } = await placedOrder();

        const [accepted, cancelled] = await Promise.all([accept(orderId, owner), customerCancel(orderId, customer)]);

        expect([accepted.status, cancelled.status].sort()).toEqual([200, 409]);
        const row = await kitchenRow(orderId);
        const voids = await outboxRows(orderId, 'payment.void');
        if (accepted.status === 200) {
            expect(row.status).toBe('accepted');
            expect(cancelled.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', details: { status: 'accepted' } });
            expect(voids).toHaveLength(0);
        } else {
            expect(row.status).toBe('cancelled');
            expect(accepted.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'cancelled' } });
            expect(voids).toHaveLength(1);
        }
    });

    it('T6 accept vs T7 reject (two tabs of the same owner): exactly one wins', async () => {
        const { orderId, owner } = await placedOrder();

        const [accepted, rejected] = await Promise.all([accept(orderId, owner), reject(orderId, owner)]);

        expect([accepted.status, rejected.status].sort()).toEqual([200, 409]);
        const row = await kitchenRow(orderId);
        expect(row.status).toBe(accepted.status === 200 ? 'accepted' : 'rejected');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(row.status === 'rejected' ? 1 : 0);
    });

    it('T7 reject vs T9 customer cancel: one wins, one void', async () => {
        const { orderId, owner, customer } = await placedOrder();

        const [rejected, cancelled] = await Promise.all([reject(orderId, owner), customerCancel(orderId, customer)]);

        expect([rejected.status, cancelled.status].sort()).toEqual([200, 409]);
        expect(['rejected', 'cancelled']).toContain((await kitchenRow(orderId)).status);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });

    it('T10 ready vs T11 owner cancel: exactly one wins', async () => {
        const { orderId, owner } = await acceptedOrder();

        const [readyRes, cancelRes] = await Promise.all([ready(orderId, owner), ownerCancel(orderId, owner)]);

        expect([readyRes.status, cancelRes.status].sort()).toEqual([200, 409]);
        const row = await kitchenRow(orderId);
        expect(row.status).toBe(readyRes.status === 200 ? 'ready_for_pickup' : 'cancelled');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(row.status === 'cancelled' ? 1 : 0);
    });

    it('double click on accept, both at once: both 200 with the same body, one transition', async () => {
        const { orderId, owner } = await placedOrder();

        const [first, second] = await Promise.all([accept(orderId, owner, { prepMinutes: 25 }), accept(orderId, owner, { prepMinutes: 25 })]);

        expect([first.status, second.status]).toEqual([200, 200]);
        expect(second.body).toEqual(first.body);
        expect((await kitchenRow(orderId)).version).toBe(2);
    });

    it('T8 timeout sweep vs T9 customer cancel after the deadline: one ends the order, one void', async () => {
        const { orderId, customer } = await placedOrder();
        await passAcceptDeadline(orderId);

        const [swept, cancelled] = await Promise.all([rejectTimedOutOrders(), customerCancel(orderId, customer)]);

        const status = (await kitchenRow(orderId)).status;
        if (status === 'rejected') {
            expect(swept).toBe(1);
            expect(cancelled.status).toBe(409);
        } else {
            expect(status).toBe('cancelled');
            expect(cancelled.status).toBe(200);
            expect(swept).toBe(0);
        }
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });
});
