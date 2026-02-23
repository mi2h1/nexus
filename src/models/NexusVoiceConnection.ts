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
    type Participant,
    type RemoteTrackPublication,
    type RemoteParticipant,
    type LocalAudioTrack,
    type LocalVideoTrack,
    createLocalAudioTrack,
    createLocalScreenTracks,
    Track,
} from "livekit-client";

import { CallEvent, ConnectionState, type CallEventHandlerMap, type ScreenShareInfo } from "./Call";

const logger = rootLogger.getChild("NexusVoiceConnection");

const STATS_POLL_INTERVAL_MS = 2000;

// VC join/leave sound effects
const VC_JOIN_SOUND = "media/message.ogg";
const VC_LEAVE_SOUND = "media/callend.ogg";

function playVcSound(src: string): void {
    try {
        const audio = new Audio(src);
        audio.volume = 0.5;
        audio.play().catch(() => {});
    } catch {
        // Ignore audio playback errors
    }
}

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
    private localScreenTrack: LocalVideoTrack | null = null;
    private localScreenAudioTrack: LocalAudioTrack | null = null;
    private _isScreenSharing = false;
    private _screenShares: ScreenShareInfo[] = [];
    private _activeSpeakers = new Set<string>();
    private speakerPollTimer: ReturnType<typeof setInterval> | null = null;
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

    public get isScreenSharing(): boolean {
        return this._isScreenSharing;
    }

    public get screenShares(): ScreenShareInfo[] {
        return this._screenShares;
    }

    public get activeSpeakers(): Set<string> {
        return this._activeSpeakers;
    }

    // ─── Public API ──────────────────────────────────────────

    public async connect(): Promise<void> {
        if (this.connected) throw new Error("Already connected");

        this.connectionState = ConnectionState.Connecting;

        try {
            // 1. Get LiveKit JWT
            const { jwt, url } = await this.getJwt();

            // 2. Connect to LiveKit
            this.livekitRoom = new LivekitRoom();
            this.livekitRoom.on(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.on(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            this.livekitRoom.on(LivekitRoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged);
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
            playVcSound(VC_JOIN_SOUND);

            // 6. Start latency polling & speaker detection
            this.startStatsPolling();
            this.startSpeakerPolling();
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
        playVcSound(VC_LEAVE_SOUND);
    }

    public async clean(): Promise<void> {
        // Clean up stale MatrixRTC membership from unclean disconnect
        // (e.g. browser refresh while in VC)
        try {
            await this.session.leaveRoomSession(5000);
        } catch (e) {
            logger.warn("Failed to clean up stale MatrixRTC session", e);
        }
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

    public async toggleScreenShare(): Promise<void> {
        if (this._isScreenSharing) {
            await this.stopScreenShare();
        } else {
            await this.startScreenShare();
        }
    }

    public async startScreenShare(): Promise<void> {
        if (!this.livekitRoom || !this.connected) return;

        try {
            const tracks = await createLocalScreenTracks({ audio: true });
            for (const track of tracks) {
                if (track.kind === "video") {
                    this.localScreenTrack = track as LocalVideoTrack;
                } else if (track.kind === "audio") {
                    this.localScreenAudioTrack = track as LocalAudioTrack;
                }
            }

            if (this.localScreenTrack) {
                await this.livekitRoom.localParticipant.publishTrack(this.localScreenTrack, {
                    source: Track.Source.ScreenShare,
                });

                // Listen for browser "stop sharing" event
                this.localScreenTrack.mediaStreamTrack.addEventListener("ended", this.onLocalScreenTrackEnded);
            }

            if (this.localScreenAudioTrack) {
                await this.livekitRoom.localParticipant.publishTrack(this.localScreenAudioTrack, {
                    source: Track.Source.ScreenShareAudio,
                });
            }

            this._isScreenSharing = true;
            this.updateScreenShares();
        } catch (e) {
            logger.warn("Failed to start screen share", e);
            // User cancelled the screen picker — clean up
            this.localScreenTrack?.stop();
            this.localScreenTrack = null;
            this.localScreenAudioTrack?.stop();
            this.localScreenAudioTrack = null;
        }
    }

    public async stopScreenShare(): Promise<void> {
        if (!this.livekitRoom) return;

        if (this.localScreenTrack) {
            this.localScreenTrack.mediaStreamTrack.removeEventListener("ended", this.onLocalScreenTrackEnded);
            await this.livekitRoom.localParticipant.unpublishTrack(this.localScreenTrack);
            this.localScreenTrack.stop();
            this.localScreenTrack = null;
        }

        if (this.localScreenAudioTrack) {
            await this.livekitRoom.localParticipant.unpublishTrack(this.localScreenAudioTrack);
            this.localScreenAudioTrack.stop();
            this.localScreenAudioTrack = null;
        }

        this._isScreenSharing = false;
        this.updateScreenShares();
    }

    private onLocalScreenTrackEnded = (): void => {
        // Browser's "Stop sharing" button was clicked
        this.stopScreenShare().catch((e) => logger.warn("Failed to stop screen share after browser stop", e));
    };

    private updateScreenShares(): void {
        const shares: ScreenShareInfo[] = [];

        // Local screen share
        if (this.localScreenTrack && this._isScreenSharing) {
            const localName = this.client.getUserId() ?? "You";
            const member = this.room.getMember(this.client.getUserId()!);
            shares.push({
                participantIdentity: this.livekitRoom?.localParticipant.identity ?? localName,
                participantName: member?.name ?? localName,
                track: this.localScreenTrack,
                audioTrack: this.localScreenAudioTrack ?? undefined,
                isLocal: true,
            });
        }

        // Remote screen shares
        if (this.livekitRoom) {
            for (const participant of this.livekitRoom.remoteParticipants.values()) {
                const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
                if (screenPub?.track) {
                    const screenAudioPub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
                    // Try to resolve participant name from Matrix room membership
                    const member = this.room.getMember(participant.identity);
                    shares.push({
                        participantIdentity: participant.identity,
                        participantName: member?.name ?? participant.identity,
                        track: screenPub.track,
                        audioTrack: screenAudioPub?.track ?? undefined,
                        isLocal: false,
                    });
                }
            }
        }

        this._screenShares = shares;
        this.emit(CallEvent.ScreenShares, shares);
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
            fetchUrl = `${LIVEKIT_CORS_PROXY_URL}/sfu/get`;
            fetchBody = {
                room: this.room.roomId,
                openid_token: openIdToken,
                device_id: this.client.getDeviceId(),
                livekit_service_url: serviceUrl,
            };
        } else {
            // Direct call (self-hosted LiveKit with CORS configured)
            fetchUrl = `${serviceUrl}/sfu/get`;
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
        this.stopSpeakerPolling();

        // Dispose audio elements
        for (const audio of this.audioElements.values()) {
            audio.pause();
            audio.srcObject = null;
        }
        this.audioElements.clear();

        // Stop local screen share
        if (this.localScreenTrack) {
            this.localScreenTrack.mediaStreamTrack.removeEventListener("ended", this.onLocalScreenTrackEnded);
            this.localScreenTrack.stop();
            this.localScreenTrack = null;
        }
        if (this.localScreenAudioTrack) {
            this.localScreenAudioTrack.stop();
            this.localScreenAudioTrack = null;
        }
        this._isScreenSharing = false;
        this._screenShares = [];

        // Stop local audio
        if (this.localAudioTrack) {
            this.localAudioTrack.stop();
            this.localAudioTrack = null;
        }

        // Clear active speakers
        this._activeSpeakers = new Set();

        // Disconnect LiveKit room
        if (this.livekitRoom) {
            this.livekitRoom.off(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.off(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            this.livekitRoom.off(LivekitRoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged);
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
        if (!track) return;

        // Handle screen share tracks
        if (
            publication.source === Track.Source.ScreenShare ||
            publication.source === Track.Source.ScreenShareAudio
        ) {
            this.updateScreenShares();
            return;
        }

        if (track.kind !== "audio") return;

        const audio = new Audio();
        audio.autoplay = true;
        track.attach(audio);
        this.audioElements.set(participant.identity, audio);
    };

    private onTrackUnsubscribed = (
        track: RemoteTrackPublication["track"],
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
    ): void => {
        if (!track) return;

        // Handle screen share tracks
        if (
            publication.source === Track.Source.ScreenShare ||
            publication.source === Track.Source.ScreenShareAudio
        ) {
            this.updateScreenShares();
            return;
        }

        if (track.kind !== "audio") return;

        const audio = this.audioElements.get(participant.identity);
        if (audio) {
            track.detach(audio);
            audio.pause();
            audio.srcObject = null;
            this.audioElements.delete(participant.identity);
        }
    };

    // ─── Private: Active Speakers ─────────────────────────────

    /**
     * Resolve a LiveKit participant identity to a Matrix user ID.
     * Identity is usually the Matrix user ID, but may include a device suffix.
     */
    private resolveIdentityToUserId(identity: string): string | null {
        // Direct match: identity is exactly a Matrix user ID
        const directMember = this.room.getMember(identity);
        if (directMember) return directMember.userId;

        // Fallback: identity may be "userId:deviceId" — try stripping suffix.
        // Matrix user IDs are "@localpart:domain", so we look for @...:...:...
        const atIdx = identity.indexOf("@");
        const firstColon = identity.indexOf(":", atIdx + 1);
        if (firstColon > 0) {
            const secondColon = identity.indexOf(":", firstColon + 1);
            if (secondColon > 0) {
                const userId = identity.substring(0, secondColon);
                const member = this.room.getMember(userId);
                if (member) return member.userId;
            }
        }

        return null;
    }

    private onActiveSpeakersChanged = (speakers: Participant[]): void => {
        this.updateActiveSpeakersFromParticipants(speakers);
    };

    private updateActiveSpeakersFromParticipants(speakers: Participant[]): void {
        const speakingUserIds = new Set<string>();
        const myUserId = this.client.getUserId();

        for (const speaker of speakers) {
            // Check if this is the local participant
            if (
                this.livekitRoom &&
                speaker.sid === this.livekitRoom.localParticipant.sid &&
                myUserId
            ) {
                speakingUserIds.add(myUserId);
                continue;
            }

            // Remote participant — resolve identity to Matrix user ID
            const userId = this.resolveIdentityToUserId(speaker.identity);
            if (userId) {
                speakingUserIds.add(userId);
            }
        }

        this._activeSpeakers = speakingUserIds;
        this.emit(CallEvent.ActiveSpeakers, speakingUserIds);
    }

    /**
     * Polling fallback for speaker detection.
     * Checks isSpeaking on all participants every 250ms.
     * This is more reliable than relying solely on the room event.
     */
    private startSpeakerPolling(): void {
        this.speakerPollTimer = setInterval(() => this.pollActiveSpeakers(), 250);
    }

    private stopSpeakerPolling(): void {
        if (this.speakerPollTimer) {
            clearInterval(this.speakerPollTimer);
            this.speakerPollTimer = null;
        }
    }

    private pollActiveSpeakers(): void {
        if (!this.livekitRoom) return;

        const speakingUserIds = new Set<string>();
        const myUserId = this.client.getUserId();

        // Check local participant
        if (this.livekitRoom.localParticipant.isSpeaking && myUserId) {
            speakingUserIds.add(myUserId);
        }

        // Check remote participants
        for (const participant of this.livekitRoom.remoteParticipants.values()) {
            if (participant.isSpeaking) {
                const userId = this.resolveIdentityToUserId(participant.identity);
                if (userId) {
                    speakingUserIds.add(userId);
                }
            }
        }

        // Only emit if the set actually changed
        if (!this.setsEqual(this._activeSpeakers, speakingUserIds)) {
            this._activeSpeakers = speakingUserIds;
            this.emit(CallEvent.ActiveSpeakers, speakingUserIds);
        }
    }

    private setsEqual(a: Set<string>, b: Set<string>): boolean {
        if (a.size !== b.size) return false;
        for (const item of a) {
            if (!b.has(item)) return false;
        }
        return true;
    }

    // ─── Private: Participants ────────────────────────────────

    private onMembershipsChanged = (): void => {
        const prevCount = this._participants.size;
        this.updateParticipants();
        const newCount = this._participants.size;

        // Play SE when other users join/leave (only while connected)
        if (this.connected && prevCount !== newCount) {
            if (newCount > prevCount) {
                playVcSound(VC_JOIN_SOUND);
            } else {
                playVcSound(VC_LEAVE_SOUND);
            }
        }
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
