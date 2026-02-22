/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    TypedEventEmitter,
    RoomEvent,
    type MatrixClient,
    type Room,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership, type Membership } from "matrix-js-sdk/src/types";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";
import { CallType } from "matrix-js-sdk/src/webrtc/call";
import {
    type MatrixRTCSession,
    MatrixRTCSessionEvent,
    type Transport,
} from "matrix-js-sdk/src/matrixrtc";
import {
    Room as LivekitRoom,
    RoomEvent as LivekitRoomEvent,
    type RemoteTrackPublication,
    type RemoteParticipant,
    type LocalAudioTrack,
    createLocalAudioTrack,
} from "livekit-client";

import { CallEvent, ConnectionState, type CallEventHandlerMap } from "./Call";

const logger = rootLogger.getChild("NexusVoiceConnection");

const STATS_POLL_INTERVAL_MS = 2000;

/**
 * Cloudflare Workers CORS proxy URL for LiveKit JWT endpoint.
 * The upstream LiveKit JWT service (e.g. livekit-jwt.call.matrix.org) does not
 * set CORS headers, so we proxy through this worker.
 *
 * Set to empty string to disable proxy (e.g. when using a self-hosted LiveKit
 * service that already has CORS configured).
 */
const LIVEKIT_CORS_PROXY_URL = "https://nexus-livekit-proxy.mi2h1.workers.dev";

interface LivekitTokenResponse {
    jwt: string;
    url: string;
}

/**
 * Direct LiveKit voice connection for Nexus voice channels.
 * Bypasses Element Call iframe — connects to LiveKit SFU directly.
 *
 * Emits the same events as Call (ConnectionState, Participants, Destroy)
 * so existing hooks (useCall, useConnectionState, useParticipatingMembers) work.
 */
export class NexusVoiceConnection extends TypedEventEmitter<CallEvent, CallEventHandlerMap> {
    public readonly callType = CallType.Voice;

    private _connectionState = ConnectionState.Disconnected;
    private _participants = new Map<RoomMember, Set<string>>();
    private _latencyMs: number | null = null;
    private _isMicMuted = false;

    private livekitRoom: LivekitRoom | null = null;
    private localAudioTrack: LocalAudioTrack | null = null;
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private audioElements = new Map<string, HTMLAudioElement>();

    public constructor(
        public readonly room: Room,
        private readonly client: MatrixClient,
        private readonly session: MatrixRTCSession,
        private readonly transports: Transport[],
    ) {
        super();
        this.session.on(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipsChanged);
        this.updateParticipants();
    }

    public get roomId(): string {
        return this.room.roomId;
    }

    public get connectionState(): ConnectionState {
        return this._connectionState;
    }

    private set connectionState(value: ConnectionState) {
        const prevValue = this._connectionState;
        this._connectionState = value;
        this.emit(CallEvent.ConnectionState, value, prevValue);
    }

    public get connected(): boolean {
        return (
            this._connectionState === ConnectionState.Connected ||
            this._connectionState === ConnectionState.Disconnecting
        );
    }

    public get participants(): Map<RoomMember, Set<string>> {
        return this._participants;
    }

    private set participants(value: Map<RoomMember, Set<string>>) {
        const prevValue = this._participants;
        this._participants = value;
        this.emit(CallEvent.Participants, value, prevValue);
    }

    public get latencyMs(): number | null {
        return this._latencyMs;
    }

    public get isMicMuted(): boolean {
        return this._isMicMuted;
    }

    // ─── Public API ──────────────────────────────────────────

    public async connect(): Promise<void> {
        if (this.connected) throw new Error("Already connected");

        try {
            // 1. Get LiveKit JWT
            const { jwt, url } = await this.getJwt();

            // 2. Connect to LiveKit
            this.livekitRoom = new LivekitRoom();
            this.livekitRoom.on(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.on(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            await this.livekitRoom.connect(url, jwt);

            // 3. Publish local audio
            this.localAudioTrack = await createLocalAudioTrack({
                echoCancellation: true,
                noiseSuppression: true,
            });
            await this.livekitRoom.localParticipant.publishTrack(this.localAudioTrack);

            // 4. Join MatrixRTC session so other clients see us
            const livekitTransport = this.transports.find(
                (t) => t.type === "livekit" && t.livekit_service_url,
            );
            this.session.joinRoomSession(
                livekitTransport ? [livekitTransport] : [],
                undefined,
                { callIntent: "audio" },
            );

            // 5. Set connected
            this.room.on(RoomEvent.MyMembership, this.onMyMembership);
            window.addEventListener("beforeunload", this.onBeforeUnload);
            this.connectionState = ConnectionState.Connected;

            // 6. Start latency polling
            this.startStatsPolling();
        } catch (e) {
            logger.error("Failed to connect voice channel", e);
            await this.cleanupLivekit();
            throw e;
        }
    }

    public async disconnect(): Promise<void> {
        if (!this.connected) throw new Error("Not connected");

        this.connectionState = ConnectionState.Disconnecting;

        // Leave MatrixRTC
        try {
            await this.session.leaveRoomSession(5000);
        } catch (e) {
            logger.warn("Failed to leave MatrixRTC session", e);
        }

        await this.cleanupLivekit();

        this.room.off(RoomEvent.MyMembership, this.onMyMembership);
        window.removeEventListener("beforeunload", this.onBeforeUnload);
        this.connectionState = ConnectionState.Disconnected;
    }

    public async clean(): Promise<void> {
        // No-op for compatibility with Call interface
    }

    public destroy(): void {
        if (this.connected) {
            // Force disconnect without waiting
            this.session.leaveRoomSession(1000).catch(() => {});
            this.cleanupLivekit().catch(() => {});
            this.room.off(RoomEvent.MyMembership, this.onMyMembership);
            window.removeEventListener("beforeunload", this.onBeforeUnload);
            this.connectionState = ConnectionState.Disconnected;
        }
        this.session.off(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipsChanged);
        this.emit(CallEvent.Destroy);
    }

    public setMicMuted(muted: boolean): void {
        if (this.localAudioTrack) {
            if (muted) {
                this.localAudioTrack.mute();
            } else {
                this.localAudioTrack.unmute();
            }
        }
        this._isMicMuted = muted;
    }

    // ─── Private: JWT ────────────────────────────────────────

    private async getJwt(): Promise<LivekitTokenResponse> {
        const livekitTransport = this.transports.find(
            (t) => t.type === "livekit" && t.livekit_service_url,
        );
        if (!livekitTransport) {
            throw new Error("No LiveKit transport configured");
        }

        const serviceUrl = livekitTransport.livekit_service_url as string;
        const openIdToken = await this.client.getOpenIdToken();

        let fetchUrl: string;
        let fetchBody: Record<string, unknown>;

        if (LIVEKIT_CORS_PROXY_URL) {
            // Route through CORS proxy — include livekit_service_url so the
            // proxy knows where to forward the request.
            fetchUrl = `${LIVEKIT_CORS_PROXY_URL}/sfu/get_token`;
            fetchBody = {
                room: this.room.roomId,
                openid_token: openIdToken,
                device_id: this.client.getDeviceId(),
                livekit_service_url: serviceUrl,
            };
        } else {
            // Direct call (self-hosted LiveKit with CORS configured)
            fetchUrl = `${serviceUrl}/sfu/get_token`;
            fetchBody = {
                room: this.room.roomId,
                openid_token: openIdToken,
                device_id: this.client.getDeviceId(),
            };
        }

        const response = await fetch(fetchUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fetchBody),
        });

        if (!response.ok) {
            throw new Error(`Failed to get LiveKit token: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as LivekitTokenResponse;
    }

    // ─── Private: Cleanup ────────────────────────────────────

    private async cleanupLivekit(): Promise<void> {
        this.stopStatsPolling();

        // Dispose audio elements
        for (const audio of this.audioElements.values()) {
            audio.pause();
            audio.srcObject = null;
        }
        this.audioElements.clear();

        // Stop local audio
        if (this.localAudioTrack) {
            this.localAudioTrack.stop();
            this.localAudioTrack = null;
        }

        // Disconnect LiveKit room
        if (this.livekitRoom) {
            this.livekitRoom.off(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.off(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            await this.livekitRoom.disconnect();
            this.livekitRoom = null;
        }
    }

    // ─── Private: Remote Audio ───────────────────────────────

    private onTrackSubscribed = (
        track: RemoteTrackPublication["track"],
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
    ): void => {
        if (!track || track.kind !== "audio") return;

        const audio = new Audio();
        audio.autoplay = true;
        track.attach(audio);
        this.audioElements.set(participant.identity, audio);
    };

    private onTrackUnsubscribed = (
        track: RemoteTrackPublication["track"],
        _publication: RemoteTrackPublication,
        participant: RemoteParticipant,
    ): void => {
        if (!track || track.kind !== "audio") return;

        const audio = this.audioElements.get(participant.identity);
        if (audio) {
            track.detach(audio);
            audio.pause();
            audio.srcObject = null;
            this.audioElements.delete(participant.identity);
        }
    };

    // ─── Private: Participants ────────────────────────────────

    private onMembershipsChanged = (): void => {
        this.updateParticipants();
    };

    private updateParticipants(): void {
        const participants = new Map<RoomMember, Set<string>>();
        for (const m of this.session.memberships) {
            if (!m.sender) continue;
            const member = this.room.getMember(m.sender);
            if (member) {
                if (participants.has(member)) {
                    participants.get(member)!.add(m.deviceId);
                } else {
                    participants.set(member, new Set([m.deviceId]));
                }
            }
        }
        this.participants = participants;
    }

    // ─── Private: Stats ──────────────────────────────────────

    private startStatsPolling(): void {
        this.statsTimer = setInterval(() => this.pollStats(), STATS_POLL_INTERVAL_MS);
    }

    private stopStatsPolling(): void {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        this._latencyMs = null;
    }

    private async pollStats(): Promise<void> {
        if (!this.livekitRoom) return;

        try {
            // Access the underlying RTCPeerConnection via LiveKit's engine
            const subscriberPc = (this.livekitRoom as any).engine?.pcManager?.subscriber?.pc as
                | RTCPeerConnection
                | undefined;
            if (subscriberPc) {
                const stats = await subscriberPc.getStats();
                for (const report of stats.values()) {
                    if (report.type === "candidate-pair" && report.state === "succeeded") {
                        this._latencyMs =
                            typeof report.currentRoundTripTime === "number"
                                ? Math.round(report.currentRoundTripTime * 1000)
                                : null;
                        return;
                    }
                }
            }
        } catch {
            // Stats may not be available yet
        }
    }

    // ─── Private: Lifecycle ──────────────────────────────────

    private onMyMembership = (_room: Room, membership: Membership): void => {
        if (membership !== KnownMembership.Join) {
            this.disconnect().catch((e) => logger.warn("Failed to disconnect on membership change", e));
        }
    };

    private onBeforeUnload = (): void => {
        this.destroy();
    };
}
