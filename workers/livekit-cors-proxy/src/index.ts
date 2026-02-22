/**
 * Cloudflare Worker — CORS proxy for LiveKit JWT endpoint.
 *
 * Proxies POST requests to the upstream LiveKit JWT service,
 * adding CORS headers so the Nexus frontend (GitHub Pages) can call it.
 *
 * Usage:
 *   POST https://<worker>.workers.dev/sfu/get_token
 *   Body: { room, openid_token, device_id, livekit_service_url }
 *
 * The worker strips `livekit_service_url` from the body, uses it as the
 * upstream target, and forwards the remaining fields.
 */

interface Env {
    ALLOWED_ORIGIN: string;
}

interface ProxyRequestBody {
    room: string;
    openid_token: Record<string, unknown>;
    device_id: string;
    livekit_service_url: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const origin = request.headers.get("Origin") ?? "";
        const allowedOrigin = env.ALLOWED_ORIGIN || "https://mi2h1.github.io";

        // Also allow localhost for development
        const isAllowed =
            origin.startsWith(allowedOrigin) ||
            origin.startsWith("http://localhost:") ||
            origin.startsWith("http://127.0.0.1:");

        const corsHeaders: Record<string, string> = {
            "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
        };

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Only allow POST
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405, headers: corsHeaders });
        }

        try {
            const body = (await request.json()) as ProxyRequestBody;
            const { livekit_service_url, ...upstreamBody } = body;

            if (!livekit_service_url) {
                return new Response(
                    JSON.stringify({ error: "Missing livekit_service_url" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
                );
            }

            // Forward to upstream LiveKit JWT service
            const upstreamUrl = `${livekit_service_url.replace(/\/$/, "")}/sfu/get_token`;
            const upstreamResponse = await fetch(upstreamUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(upstreamBody),
            });

            const responseBody = await upstreamResponse.text();

            return new Response(responseBody, {
                status: upstreamResponse.status,
                headers: {
                    ...corsHeaders,
                    "Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json",
                },
            });
        } catch (e) {
            return new Response(
                JSON.stringify({ error: "Proxy error", detail: String(e) }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
        }
    },
};
