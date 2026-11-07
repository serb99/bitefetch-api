type OpeningHours = Record<string, [string, string][]>;

const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bucharest',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

function isOpenNow(openingHours: OpeningHours | null, now: Date = new Date()): boolean {
    if (!openingHours) return false;

    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

    const day = get('weekday').toLowerCase();
    const time = `${get('hour')}:${get('minute')}`;

    const ranges = openingHours[day] ?? [];
    return ranges.some(([open, close]) => open <= time && time < close);
}

export { isOpenNow };
export type { OpeningHours };