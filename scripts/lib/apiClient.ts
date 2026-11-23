class ApiCallError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly details: unknown
    ){
        super(message);
        this.name = 'ApiCallError';
    }
}

type Credentials = { email: string; password: string };
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const REQUEST_TIMEOUT_MS = 10_000;

class ApiClient {
    private token: string | null = null;

    constructor(private readonly baseUrl: string, private readonly credentials: Credentials){}

    async login(): Promise<void> {
        const { accessToken } = await this.send<{ accessToken: string }>('POST', '/sessions', this.credentials);
        this.token = accessToken;
    }

    async call<T>(method: Method, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
        try {
            return await this.send<T>(method, path, body, headers);
        } catch (err) {
            // The access token lives 15 min. A script has the password, so it logs in again
            if (!(err instanceof ApiCallError && err.code === 'ACCESS_TOKEN_EXPIRED')) throw err;
            await this.login();
            return this.send<T>(method, path, body, headers);
        }
    }

    private async send<T>(method: Method, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T>{
        const headers: Record<string, string> = { ...extra };
        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        if(body != undefined) {
            headers['Content-Type'] = 'application/json';
        }

        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const data = await res.json().catch(() => null);

        if (!res.ok){
            const error = (data as { error?: { code: string; message: string; details: unknown } } | null)?.error;
            throw new ApiCallError(res.status, error?.code ?? 'UNKNOWN', error?.message ?? res.statusText, error?.details ?? null);
        }
        return data as T;
    }
}

export { ApiClient, ApiCallError };
export type { Credentials };