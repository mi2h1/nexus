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
 * POST JSON without CORS restrictions.
 *
 * - **Tauri**: Uses `@tauri-apps/plugin-http` (Rust-side fetch, no CORS).
 * - **Browser**: Uses the standard Fetch API (caller must handle CORS proxy).
 */
export async function corsFreePost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    if (isTauri()) {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        const response = await tauriFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`Tauri HTTP POST failed: ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as T;
    }

    // Browser fallback — standard fetch
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`HTTP POST failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
}
