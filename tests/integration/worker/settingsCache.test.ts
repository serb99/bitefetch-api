import { pool } from '../../helpers/db';
import { setSetting, restoreSettings } from '../../helpers/worker';
import { getNumberSettings, clearSettingsCache } from '../../../src/services/settingsService';

// M8 settings cache: the whole platform_settings table is kept 10 s per process, reloaded lazily,
// one shared load for parallel callers, a failed load is not cached. setupDb clears the cache before each test.

afterEach(restoreSettings);

const KEY = 'accept_window_s';

// How many times the cache loaded the table (setSetting's own queries are not counted)
function loads(spy: jest.SpyInstance): number {
    return spy.mock.calls.filter(([sql]) => String(sql).includes('SELECT key, value FROM platform_settings')).length;
}

async function current(): Promise<number> {
    return (await getNumberSettings([KEY] as const))[KEY];
}

it('within 10 s a changed setting is not seen and the database is not asked again', async () => {
    const before = await current();
    const spy = jest.spyOn(pool, 'query');
    await setSetting(KEY, before + 100);

    expect(await current()).toBe(before);
    expect(loads(spy)).toBe(0);
});

it('clearSettingsCache(): the next call reads the new value', async () => {
    const before = await current();
    await setSetting(KEY, before + 100);

    clearSettingsCache();

    expect(await current()).toBe(before + 100);
});

it('after 10 s the table is read again and the new value is seen', async () => {
    const before = await current();
    await setSetting(KEY, before + 100);
    const loadedAt = Date.now();

    jest.spyOn(Date, 'now').mockReturnValue(loadedAt + 9_000);
    expect(await current()).toBe(before);

    jest.spyOn(Date, 'now').mockReturnValue(loadedAt + 10_500);
    expect(await current()).toBe(before + 100);
});

it('two callers at the same moment share one load', async () => {
    const spy = jest.spyOn(pool, 'query');

    const [a, b] = await Promise.all([
        getNumberSettings(['accept_window_s'] as const),
        getNumberSettings(['offer_timeout_s', 'reconcile_after_s'] as const),
    ]);

    expect(loads(spy)).toBe(1);
    expect(typeof a.accept_window_s).toBe('number');
    expect(typeof b.offer_timeout_s).toBe('number');
    expect(typeof b.reconcile_after_s).toBe('number');
});

it('a failed load is not cached: the next call loads again', async () => {
    jest.spyOn(pool, 'query').mockRejectedValueOnce(new Error('database down'));

    await expect(current()).rejects.toThrow('database down');
    await expect(current()).resolves.toEqual(expect.any(Number));
});

it('a missing key still throws (server configuration problem)', async () => {
    await expect(getNumberSettings(['no_such_setting'] as const)).rejects.toThrow(
        'Missing or invalid platform setting: no_such_setting'
    );
});
