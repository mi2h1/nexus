/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Returns true when running inside a Tauri 2 native window.
 */
export function isTauri(): boolean {
    return "__TAURI_INTERNALS__" in window;
}

/**
 * Internal helper — CORS-free JSON request via Tauri plugin-http or standard fetch.
 */
async function corsFreeRequest<T>(
    method: string,
    url: string,
    body?: Record<string, unknown>,
): Promise<T> {
    const options: RequestInit = { method };
    if (body) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
    }

    if (isTauri()) {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        const response = await tauriFetch(url, options);
        if (!response.ok) {
            throw new Error(`Tauri HTTP ${method} failed: ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as T;
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`HTTP ${method} failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
}

/** GET JSON without CORS restrictions. */
export async function corsFreeGet<T>(url: string): Promise<T> {
    return corsFreeRequest<T>("GET", url);
}

/** POST JSON without CORS restrictions. */
export async function corsFreePost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    return corsFreeRequest<T>("POST", url, body);
}

/** PUT JSON without CORS restrictions. */
export async function corsFreePut<T>(url: string, body: Record<string, unknown>): Promise<T> {
    return corsFreeRequest<T>("PUT", url, body);
}
