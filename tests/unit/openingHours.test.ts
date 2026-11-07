import { isOpenNow } from '../../src/utils/openingHours';

// Opening hours are in Europe/Bucharest: UTC+2 in winter (EET), UTC+3 in summer (EEST).
// 2026-11-09 is a Monday, 2026-07-06 is a Monday.

const at = (iso: string) => new Date(iso);

describe('isOpenNow', () => {
    const hours = { mon: [['10:00', '14:00'], ['18:00', '22:00']] as [string, string][] };

    it.each([
        ['before opening', '2026-11-09T07:59:00Z', false],   // 09:59 Bucharest
        ['at opening time (inclusive)', '2026-11-09T08:00:00Z', true],
        ['inside the first range', '2026-11-09T10:30:00Z', true],
        ['at closing time (exclusive)', '2026-11-09T12:00:00Z', false],
        ['between two ranges', '2026-11-09T14:00:00Z', false],
        ['inside the second range', '2026-11-09T19:59:00Z', true], // 21:59
    ])('winter: %s -> %s', (_case, iso, expected) => {
        expect(isOpenNow(hours, at(iso))).toBe(expected);
    });

    it('uses summer time (UTC+3) in July', () => {
        expect(isOpenNow(hours, at('2026-07-06T07:00:00Z'))).toBe(true);  // 10:00 EEST
        expect(isOpenNow(hours, at('2026-07-06T06:59:00Z'))).toBe(false); // 09:59 EEST
    });

    it('uses the Bucharest weekday, not the UTC one', () => {
        // Sunday 22:30 UTC is already Monday 00:30 in Bucharest
        const lateMonday = { mon: [['00:00', '01:00']] as [string, string][] };
        expect(isOpenNow(lateMonday, at('2026-11-08T22:30:00Z'))).toBe(true);
    });

    it('is closed on a day without an entry or with an empty list', () => {
        expect(isOpenNow({ tue: [['00:00', '23:59']] }, at('2026-11-09T10:00:00Z'))).toBe(false);
        expect(isOpenNow({ mon: [] }, at('2026-11-09T10:00:00Z'))).toBe(false);
    });

    it('is closed when there are no opening hours at all', () => {
        expect(isOpenNow(null, at('2026-11-09T10:00:00Z'))).toBe(false);
    });

    it('cannot express a range past midnight: 23:59 is always closed', () => {
        const allDay = { mon: [['00:00', '23:59']] as [string, string][] };
        expect(isOpenNow(allDay, at('2026-11-09T21:59:30Z'))).toBe(false); // 23:59:30 Monday
    });
});
