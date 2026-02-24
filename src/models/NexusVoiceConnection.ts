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
    LocalAudioTrack,
    LocalVideoTrack,
    createLocalAudioTrack,
    Track,
    ScreenSharePresets,
    VideoPreset,
} from "livekit-client";

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

import { CallEvent, ConnectionState, type CallEventHandlerMap, type ParticipantState, type ScreenShareInfo } from "./Call";
import SettingsStore from "../settings/SettingsStore";

const logger = rootLogger.getChild("NexusVoiceConnection");

const STATS_POLL_INTERVAL_MS = 2000;

// ─── Screen share quality presets ────────────────────────
export type ScreenShareQuality = "low" | "standard" | "high" | "ultra";

export interface ScreenSharePresetConfig {
    label: string;
    description: string;
    width: number;
    height: number;
    fps: number;
    maxBitrate: number;
}

export const SCREEN_SHARE_PRESETS: Record<ScreenShareQuality, ScreenSharePresetConfig> = {
    low: { label: "低画質", description: "720p / 15fps", width: 1280, height: 720, fps: 15, maxBitrate: 1_000_000 },
    standard: { label: "標準", description: "720p / 30fps", width: 1280, height: 720, fps: 30, maxBitrate: 2_000_000 },
    high: { label: "高画質", description: "1080p / 30fps", width: 1920, height: 1080, fps: 30, maxBitrate: 4_000_000 },
    ultra: { label: "配信向け", description: "1080p / 60fps", width: 1920, height: 1080, fps: 60, maxBitrate: 6_000_000 },
};

// VC sound effects
export const VC_JOIN_SOUND = "media/sfx_join.mp3";
export const VC_LEAVE_SOUND = "media/sfx_leave.mp3";
export const VC_STANDBY_SOUND = "media/sfx_standby.mp3";
export const VC_MUTE_SOUND = "media/sfx_mute.mp3";
export const VC_UNMUTE_SOUND = "media/sfx_unmute.mp3";
export const VC_SCREEN_ON_SOUND = "media/sfx_screen-on.mp3";
export const VC_SCREEN_OFF_SOUND = "media/sfx_screen-off.mp3";

export function playVcSound(src: string): void {
    try {
        const audio = new Audio(src);
        audio.volume = 0.25;
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
    private _participantStates = new Map<string, ParticipantState>();
    private speakerPollTimer: ReturnType<typeof setInterval> | null = null;
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    // ─── Audio pipeline ──────────────────────────────────────
    // AudioContext is used ONLY for the input (mic) pipeline.
    // Output uses per-participant <audio> elements — Chrome does
    // not route remote WebRTC audio through MediaStreamAudioSourceNode.
    private audioContext: AudioContext | null = null;
    private _masterOutputVolume = 0; // 0-2 (0-200%), starts muted
    private outputAudioElements = new Map<string, HTMLAudioElement>();
    private participantVolumes = new Map<string, number>(); // 0-1.0
    // ─── Screen share audio ──────────────────────────────────
    private screenShareAudioElements = new Map<string, HTMLAudioElement>();
    private screenShareVolumes = new Map<string, number>(); // 0-1.0
    private watchingScreenShares = new Set<string>(); // opt-in watching state
    private analyserNode: AnalyserNode | null = null;
    private inputGainNode: GainNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private highPassFilter: BiquadFilterNode | null = null;
    private compressorNode: DynamicsCompressorNode | null = null;
    // ─── RNNoise noise cancellation ───────────────────────────
    private rnnoiseNode: RnnoiseWorkletNode | null = null;
    private static rnnoiseWasmBinary: ArrayBuffer | null = null;
    private static rnnoiseWorkletRegistered = false;
    private voiceGateTimer: ReturnType<typeof setInterval> | null = null;
    private _inputLevel = 0; // 0-100 real-time input level
    private _voiceGateOpen = true;
    private voiceGateReleaseTimeout: ReturnType<typeof setTimeout> | null = null;
    private static readonly VOICE_GATE_RELEASE_MS = 300;
    /** Gain ramp duration to avoid click/pop when voice gate opens/closes. */
    private static readonly VOICE_GATE_RAMP_SEC = 0.02;
    private participantRetryTimer: ReturnType<typeof setInterval> | null = null;

    // ─── Volume persistence keys ──────────────────────────────
    private static readonly PARTICIPANT_VOLUMES_KEY = "nexus_participant_volumes";
    private static readonly SCREENSHARE_VOLUMES_KEY = "nexus_screenshare_volumes";

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

    public get participantStates(): Map<string, ParticipantState> {
        return this._participantStates;
    }

    // ─── Public API ──────────────────────────────────────────

    public async connect(): Promise<void> {
        if (this.connected) throw new Error("Already connected");

        this.connectionState = ConnectionState.Connecting;

        try {
            // ── Phase 0: Create AudioContext in user gesture context ──
            // MUST be created BEFORE any await — Chrome's autoplay policy
            // requires AudioContext creation within a user gesture.
            // NOTE: AudioContext is used ONLY for the input (mic) pipeline.
            // Remote audio output uses per-participant <audio> elements
            // because Chrome does not route remote WebRTC audio through
            // MediaStreamAudioSourceNode at all.
            this.audioContext = new AudioContext();
            this._masterOutputVolume = 0; // starts muted until unmutePipelines()

            // ── Phase 1: Parallel pre-fetch ──────────────────────────
            // JWT, mic access, and RNNoise WASM download run concurrently
            // to minimize total wall-clock time.
            const ncEnabled = SettingsStore.getValue("nexus_noise_cancellation") ?? false;
            const [{ jwt, url }, audioTrack] = await Promise.all([
                this.getJwt(),
                createLocalAudioTrack({
                    echoCancellation: true,
                    noiseSuppression: true,
                }),
                // Preload RNNoise WASM binary in parallel (cached statically)
                ncEnabled ? NexusVoiceConnection.preloadRnnoiseWasm() : Promise.resolve(),
            ]);
            this.localAudioTrack = audioTrack;

            // ── Phase 3: Connect to LiveKit (requires JWT) ───────────
            this.livekitRoom = new LivekitRoom();
            this.livekitRoom.on(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.on(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            this.livekitRoom.on(LivekitRoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged);
            this.livekitRoom.on(LivekitRoomEvent.ParticipantConnected, this.onParticipantConnected);
            this.livekitRoom.on(LivekitRoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
            await this.livekitRoom.connect(url, jwt);

            // ── Phase 4: Build input pipeline ────────────────────────
            // Audio pipeline:
            //   source → [RNNoise] → HPF → compressor → analyser + inputGain → dest

            this.sourceNode = this.audioContext.createMediaStreamSource(
                new MediaStream([this.localAudioTrack.mediaStreamTrack]),
            );

            // High-pass filter — removes low-frequency noise (AC hum, rumble, pops)
            this.highPassFilter = this.audioContext.createBiquadFilter();
            this.highPassFilter.type = "highpass";
            this.highPassFilter.frequency.value = 80;
            this.highPassFilter.Q.value = 0.7;

            // Compressor — evens out volume, prevents clipping on loud input
            this.compressorNode = this.audioContext.createDynamicsCompressor();
            this.compressorNode.threshold.value = -24;
            this.compressorNode.knee.value = 12;
            this.compressorNode.ratio.value = 4;
            this.compressorNode.attack.value = 0.003;
            this.compressorNode.release.value = 0.25;

            // AnalyserNode — monitors input level
            this.analyserNode = this.audioContext.createAnalyser();
            this.analyserNode.fftSize = 256;

            // Input GainNode — adjusts input volume before sending to LiveKit
            // Start muted — unmutePipelines() restores the real volume.
            this.inputGainNode = this.audioContext.createGain();
            this.inputGainNode.gain.value = 0;

            // Insert RNNoise if enabled and sample rate is 48kHz
            // (WASM binary is already preloaded from Phase 1)
            if (ncEnabled && this.audioContext.sampleRate === 48000) {
                await this.setupRnnoiseNode();
            }

            // Connect the pipeline chain:
            // source → [rnnoise] → HPF → compressor → analyser + inputGain → dest
            this.connectInputPipeline();

            // Create processed stream and publish that instead of raw mic
            const dest = this.audioContext.createMediaStreamDestination();
            this.inputGainNode.connect(dest);
            const processedTrack = dest.stream.getAudioTracks()[0];
            // Publish with optimized Opus settings
            await this.livekitRoom.localParticipant.publishTrack(processedTrack, {
                source: Track.Source.Microphone,
                audioPreset: { maxBitrate: 64_000 }, // 64kbps (default ~32kbps)
                dtx: true, // Discontinuous Transmission — saves bandwidth in silence
                red: true, // Redundant audio encoding — resilience to packet loss
            });

            // Start voice gate / input level polling
            this.startVoiceGatePolling();

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

            // 6. Start latency polling & speaker detection
            this.startStatsPolling();
            this.startSpeakerPolling();

            // 7. Re-check participants after a short delay.
            // After a browser refresh, the initial sync may not have completed
            // when joinRoomSession() was called, so memberships might be empty.
            // Retry a few times to catch late-arriving membership data.
            this.retryUpdateParticipants();
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
        // Use LiveKit publication mute/unmute to signal remote participants.
        // The published track is the processed one (not this.localAudioTrack),
        // so we get it via getTrackPublication(Track.Source.Microphone).
        const pub = this.livekitRoom?.localParticipant.getTrackPublication(Track.Source.Microphone);
        if (pub?.track) {
            if (muted) pub.track.mute();
            else pub.track.unmute();
        }
        if (!muted && this.inputGainNode) {
            // Restore input gain when unmuting (voice gate may have set it to 0)
            this.inputGainNode.gain.value =
                (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
        }
        this._isMicMuted = muted;
        this._voiceGateOpen = true;
        this.emit(CallEvent.MicMuted, muted);
    }

    /**
     * Restore output and input gain to their configured values.
     * Called by NexusVoiceStore after connectionState=Connected and
     * pre-mute is applied, so audio starts exactly when the UI
     * grayout is removed.
     */
    public unmutePipelines(): void {
        // Safety net: resume AudioContext if suspended (needed for input pipeline)
        if (this.audioContext?.state === "suspended") {
            this.audioContext.resume().catch(() => {});
        }
        // Restore master output volume and apply to all <audio> elements
        const masterVol = SettingsStore.getValue("nexus_output_volume") ?? 100;
        this._masterOutputVolume = Math.max(0, Math.min(2, masterVol / 100));
        this.applyAllOutputVolumes();
        // Only restore input gain if not muted — if muted, keep at 0.
        if (this.inputGainNode && !this._isMicMuted) {
            const inputVolume = SettingsStore.getValue("nexus_input_volume") ?? 100;
            this.inputGainNode.gain.value = inputVolume / 100;
        }
    }

    public async toggleScreenShare(): Promise<void> {
        if (this._isScreenSharing) {
            await this.stopScreenShare();
        } else {
            await this.startScreenShare();
        }
    }

    private getScreenSharePreset(): ScreenSharePresetConfig {
        const key = (SettingsStore.getValue("nexus_screen_share_quality") ?? "standard") as ScreenShareQuality;
        return SCREEN_SHARE_PRESETS[key] ?? SCREEN_SHARE_PRESETS.standard;
    }

    public async startScreenShare(): Promise<void> {
        if (!this.livekitRoom || !this.connected) return;

        const preset = this.getScreenSharePreset();

        try {
            // Call getDisplayMedia directly instead of livekit's
            // createLocalScreenTracks. If audio capture fails
            // (NotReadableError — common on some systems), fall back
            // to video-only. The picker reopens in that case but
            // screen share will work.
            let stream: MediaStream;
            try {
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        width: { ideal: preset.width },
                        height: { ideal: preset.height },
                        frameRate: { ideal: preset.fps },
                    },
                    audio: true,
                });
            } catch (e) {
                if (e instanceof DOMException && e.name === "NotReadableError") {
                    logger.info("Screen share audio unavailable, retrying video-only");
                    stream = await navigator.mediaDevices.getDisplayMedia({
                        video: {
                            width: { ideal: preset.width },
                            height: { ideal: preset.height },
                            frameRate: { ideal: preset.fps },
                        },
                    });
                } else {
                    throw e;
                }
            }

            const videoMst = stream.getVideoTracks()[0];
            const audioMst = stream.getAudioTracks()[0];

            if (videoMst) {
                // userProvidedTrack=true — we manage the track lifecycle
                this.localScreenTrack = new LocalVideoTrack(videoMst, undefined, true);
                // Set content hint for motion (screen share / games)
                if (videoMst.contentHint !== "motion") {
                    videoMst.contentHint = "motion";
                }
                await this.livekitRoom.localParticipant.publishTrack(this.localScreenTrack, {
                    source: Track.Source.ScreenShare,
                    videoCodec: "vp9",
                    screenShareEncoding: new VideoPreset(
                        preset.width, preset.height, preset.maxBitrate, preset.fps,
                    ).encoding,
                    screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
                    degradationPreference: "maintain-framerate",
                });

                // Listen for browser "stop sharing" event
                this.localScreenTrack.mediaStreamTrack.addEventListener("ended", this.onLocalScreenTrackEnded);
            }

            if (audioMst) {
                this.localScreenAudioTrack = new LocalAudioTrack(audioMst, undefined, true);
                await this.livekitRoom.localParticipant.publishTrack(this.localScreenAudioTrack, {
                    source: Track.Source.ScreenShareAudio,
                });
                logger.info("Screen share audio captured");
            } else {
                logger.info("Screen share started without audio (not available for this source)");
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

    /**
     * Re-publish the existing screen share track with updated encoding
     * parameters. Does NOT re-trigger the browser screen picker.
     */
    public async republishScreenShare(): Promise<void> {
        if (!this.livekitRoom || !this.localScreenTrack || !this._isScreenSharing) return;

        const preset = this.getScreenSharePreset();

        // Unpublish current video track (keep the MediaStreamTrack alive)
        await this.livekitRoom.localParticipant.unpublishTrack(this.localScreenTrack, false);

        // Re-publish with new encoding parameters
        await this.livekitRoom.localParticipant.publishTrack(this.localScreenTrack, {
            source: Track.Source.ScreenShare,
            videoCodec: "vp9",
            screenShareEncoding: new VideoPreset(
                preset.width, preset.height, preset.maxBitrate, preset.fps,
            ).encoding,
            screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
            degradationPreference: "maintain-framerate",
        });

        logger.info(`Screen share quality changed to ${preset.label} (${preset.description})`);
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
        const prevIds = new Set(this._screenShares.map((s) => s.participantIdentity));
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
                if (screenPub?.track && screenPub.track.mediaStreamTrack?.readyState !== "ended") {
                    const screenAudioPub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
                    // Resolve participant name from Matrix room membership
                    // (identity may be "userId:deviceId", so use resolveIdentityToUserId)
                    const userId = this.resolveIdentityToUserId(participant.identity);
                    const member = userId ? this.room.getMember(userId) : null;
                    shares.push({
                        participantIdentity: participant.identity,
                        participantName: member?.name ?? participant.name ?? participant.identity,
                        track: screenPub.track,
                        audioTrack: screenAudioPub?.track ?? undefined,
                        isLocal: false,
                    });
                }
            }
        }

        // Play screen share SE based on diff (only while connected)
        if (this.connected) {
            const newIds = new Set(shares.map((s) => s.participantIdentity));
            const added = [...newIds].some((id) => !prevIds.has(id));
            const removed = [...prevIds].some((id) => !newIds.has(id));
            if (added) playVcSound(VC_SCREEN_ON_SOUND);
            else if (removed) playVcSound(VC_SCREEN_OFF_SOUND);
        }

        this._screenShares = shares;
        this.emit(CallEvent.ScreenShares, shares);
    }

    // ─── Public: Per-participant volume ─────────────────────

    /**
     * Look up a LiveKit participant identity for a given Matrix user ID.
     * Returns the identity string or null if no matching remote participant.
     */
    public findIdentityForUserId(userId: string): string | null {
        if (!this.livekitRoom) return null;
        for (const [identity] of this.livekitRoom.remoteParticipants) {
            const resolved = this.resolveIdentityToUserId(identity);
            if (resolved === userId) return identity;
        }
        return null;
    }

    /**
     * Set the audio volume for a remote participant (0.0–1.0).
     */
    public setParticipantVolume(userId: string, volume: number): void {
        const identity = this.findIdentityForUserId(userId);
        if (!identity) return;
        const clamped = Math.max(0, Math.min(1, volume));
        this.participantVolumes.set(identity, clamped);
        const audio = this.outputAudioElements.get(identity);
        if (audio) {
            audio.volume = Math.min(1, clamped * this._masterOutputVolume);
        }
        this.persistVolume(NexusVoiceConnection.PARTICIPANT_VOLUMES_KEY, userId, clamped);
    }

    /**
     * Get the current audio volume for a remote participant (0.0–1.0).
     * Returns 1 if participant not found.
     */
    public getParticipantVolume(userId: string): number {
        const identity = this.findIdentityForUserId(userId);
        if (identity) {
            const vol = this.participantVolumes.get(identity);
            if (vol !== undefined) return vol;
        }
        return this.loadPersistedVolume(NexusVoiceConnection.PARTICIPANT_VOLUMES_KEY, userId) ?? 1;
    }

    // ─── Public: Per-screen-share volume ─────────────────────

    /**
     * Set the audio volume for a remote screen share (0.0–1.0).
     * Uses participantIdentity directly as key.
     */
    public setScreenShareVolume(participantIdentity: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.screenShareVolumes.set(participantIdentity, clamped);
        const audio = this.screenShareAudioElements.get(participantIdentity);
        if (audio && this.watchingScreenShares.has(participantIdentity)) {
            audio.volume = Math.min(1, clamped * this._masterOutputVolume);
        }
        // Persist by resolved userId (stable across sessions)
        const userId = this.resolveIdentityToUserId(participantIdentity);
        if (userId) this.persistVolume(NexusVoiceConnection.SCREENSHARE_VOLUMES_KEY, userId, clamped);
    }

    /**
     * Get the current audio volume for a remote screen share (0.0–1.0).
     * Returns 1 if not set.
     */
    public getScreenShareVolume(participantIdentity: string): number {
        const vol = this.screenShareVolumes.get(participantIdentity);
        if (vol !== undefined) return vol;
        const userId = this.resolveIdentityToUserId(participantIdentity);
        if (userId) return this.loadPersistedVolume(NexusVoiceConnection.SCREENSHARE_VOLUMES_KEY, userId) ?? 1;
        return 1;
    }

    // ─── Public: Screen share watching ──────────────────────

    public get watchingScreenShareIds(): ReadonlySet<string> {
        return this.watchingScreenShares;
    }

    /**
     * Mark a screen share as actively watched/unwatched.
     * Audio is muted (gain=0) until the user opts in to watch.
     */
    public setScreenShareWatching(participantIdentity: string, watching: boolean): void {
        if (watching) {
            this.watchingScreenShares.add(participantIdentity);
        } else {
            this.watchingScreenShares.delete(participantIdentity);
        }
        const audio = this.screenShareAudioElements.get(participantIdentity);
        if (audio) {
            if (watching) {
                const vol = this.screenShareVolumes.get(participantIdentity) ?? 1;
                audio.volume = Math.min(1, vol * this._masterOutputVolume);
            } else {
                audio.volume = 0;
            }
        }
        this.emit(CallEvent.WatchingChanged, new Set(this.watchingScreenShares));
    }

    // ─── Public: Audio pipeline accessors ──────────────────────

    public get inputLevel(): number {
        return this._inputLevel;
    }

    public get voiceGateOpen(): boolean {
        return this._voiceGateOpen;
    }

    /** Update input gain in real time (called from settings UI). */
    public setInputVolume(volume: number): void {
        if (this.inputGainNode) {
            this.inputGainNode.gain.value = Math.max(0, Math.min(2, volume / 100));
        }
    }

    /** Set master output volume for all remote audio (0-200). */
    public setMasterOutputVolume(volume: number): void {
        this._masterOutputVolume = Math.max(0, Math.min(2, volume / 100));
        this.applyAllOutputVolumes();
    }

    /**
     * Apply the current master volume to all participant and screen share
     * <audio> elements. Called when master volume changes or pipelines unmute.
     */
    private applyAllOutputVolumes(): void {
        for (const [identity, audio] of this.outputAudioElements) {
            const vol = this.participantVolumes.get(identity) ?? 1;
            audio.volume = Math.min(1, vol * this._masterOutputVolume);
        }
        for (const [identity, audio] of this.screenShareAudioElements) {
            if (this.watchingScreenShares.has(identity)) {
                const vol = this.screenShareVolumes.get(identity) ?? 1;
                audio.volume = Math.min(1, vol * this._masterOutputVolume);
            } else {
                audio.volume = 0;
            }
        }
    }

    // ─── Public: Noise cancellation ─────────────────────────

    /**
     * Toggle RNNoise noise cancellation during an active call.
     * Reconnects the audio pipeline with or without the RNNoise node.
     */
    public async setNoiseCancellation(enabled: boolean): Promise<void> {
        if (!this.audioContext || !this.sourceNode || !this.analyserNode || !this.inputGainNode) return;

        // Disconnect the full pipeline to rewire
        this.disconnectInputPipeline();

        if (enabled && this.audioContext.sampleRate === 48000) {
            if (!this.rnnoiseNode) {
                await this.setupRnnoiseNode();
            }
        } else if (this.rnnoiseNode) {
            this.rnnoiseNode.disconnect();
            this.rnnoiseNode.destroy();
            this.rnnoiseNode = null;
        }

        this.connectInputPipeline();
        logger.info(enabled && this.rnnoiseNode ? "Noise cancellation enabled (RNNoise)" : "Noise cancellation disabled");
    }

    /**
     * Connect the input audio pipeline chain:
     *   source → [rnnoise] → HPF → compressor → analyser + inputGain
     */
    private connectInputPipeline(): void {
        if (!this.sourceNode || !this.highPassFilter || !this.compressorNode
            || !this.analyserNode || !this.inputGainNode) return;

        if (this.rnnoiseNode) {
            this.sourceNode.connect(this.rnnoiseNode);
            this.rnnoiseNode.connect(this.highPassFilter);
        } else {
            this.sourceNode.connect(this.highPassFilter);
        }
        this.highPassFilter.connect(this.compressorNode);
        this.compressorNode.connect(this.analyserNode);
        this.compressorNode.connect(this.inputGainNode);
    }

    /**
     * Disconnect the input pipeline so it can be rewired.
     * Does NOT destroy nodes — only breaks connections.
     */
    private disconnectInputPipeline(): void {
        this.sourceNode?.disconnect();
        this.rnnoiseNode?.disconnect();
        this.highPassFilter?.disconnect();
        this.compressorNode?.disconnect();
        // Don't disconnect analyserNode or inputGainNode — they connect to dest
    }

    // ─── Private: RNNoise setup ──────────────────────────────

    /**
     * Preload the RNNoise WASM binary without requiring an AudioContext.
     * Called during connect() in parallel with JWT fetch and mic access
     * so the binary is already cached when setupRnnoiseNode() runs.
     */
    public static async preloadRnnoiseWasm(): Promise<void> {
        if (NexusVoiceConnection.rnnoiseWasmBinary) return;
        try {
            NexusVoiceConnection.rnnoiseWasmBinary = await loadRnnoise({
                url: "noise-suppressor/rnnoise.wasm",
                simdUrl: "noise-suppressor/rnnoise_simd.wasm",
            });
            logger.info("RNNoise WASM preloaded");
        } catch (e) {
            logger.warn("Failed to preload RNNoise WASM", e);
        }
    }

    private async setupRnnoiseNode(): Promise<void> {
        if (!this.audioContext) return;
        try {
            // Load WASM binary (cached statically across connections)
            if (!NexusVoiceConnection.rnnoiseWasmBinary) {
                NexusVoiceConnection.rnnoiseWasmBinary = await loadRnnoise({
                    url: "noise-suppressor/rnnoise.wasm",
                    simdUrl: "noise-suppressor/rnnoise_simd.wasm",
                });
            }

            // Register AudioWorklet processor (once per AudioContext)
            if (!NexusVoiceConnection.rnnoiseWorkletRegistered) {
                await this.audioContext.audioWorklet.addModule(
                    "noise-suppressor/rnnoise/workletProcessor.js",
                );
                NexusVoiceConnection.rnnoiseWorkletRegistered = true;
            }

            this.rnnoiseNode = new RnnoiseWorkletNode(this.audioContext, {
                maxChannels: 1,
                wasmBinary: NexusVoiceConnection.rnnoiseWasmBinary,
            });
            logger.info("RNNoise worklet node created");
        } catch (e) {
            logger.warn("Failed to set up RNNoise noise cancellation, falling back", e);
            this.rnnoiseNode = null;
        }
    }

    // ─── Private: Voice gate / input level ───────────────────

    private startVoiceGatePolling(): void {
        this.voiceGateTimer = setInterval(() => this.pollInputLevel(), 50);
    }

    private stopVoiceGatePolling(): void {
        if (this.voiceGateTimer) {
            clearInterval(this.voiceGateTimer);
            this.voiceGateTimer = null;
        }
        if (this.voiceGateReleaseTimeout) {
            clearTimeout(this.voiceGateReleaseTimeout);
            this.voiceGateReleaseTimeout = null;
        }
    }

    private pollInputLevel(): void {
        if (!this.analyserNode) return;

        const data = new Uint8Array(this.analyserNode.fftSize);
        this.analyserNode.getByteTimeDomainData(data);

        // RMS calculation → scale to 0-100
        let sum = 0;
        for (const sample of data) {
            const normalized = (sample - 128) / 128;
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / data.length);
        this._inputLevel = Math.min(100, Math.round(rms * 300));
        this.emit(CallEvent.InputLevel, this._inputLevel);

        // Voice gate check
        const gateEnabled = SettingsStore.getValue("nexus_voice_gate_enabled");
        if (!gateEnabled || this._isMicMuted) {
            this._voiceGateOpen = true;
            return;
        }

        const threshold = SettingsStore.getValue("nexus_voice_gate_threshold") ?? 40;
        if (this._inputLevel > threshold) {
            // Above threshold → open gate, reset release timer
            this._voiceGateOpen = true;
            if (this.inputGainNode && this.audioContext) {
                // Use linearRamp to avoid click/pop noise from abrupt gain changes
                const targetVol = (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
                this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                this.inputGainNode.gain.linearRampToValueAtTime(
                    targetVol,
                    this.audioContext.currentTime + NexusVoiceConnection.VOICE_GATE_RAMP_SEC,
                );
            }
            if (this.voiceGateReleaseTimeout) {
                clearTimeout(this.voiceGateReleaseTimeout);
                this.voiceGateReleaseTimeout = null;
            }
        } else if (this._voiceGateOpen && !this.voiceGateReleaseTimeout) {
            // Below threshold → close gate after release delay
            this.voiceGateReleaseTimeout = setTimeout(() => {
                this._voiceGateOpen = false;
                if (this.inputGainNode && this.audioContext && !this._isMicMuted) {
                    this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                    this.inputGainNode.gain.linearRampToValueAtTime(
                        0,
                        this.audioContext.currentTime + NexusVoiceConnection.VOICE_GATE_RAMP_SEC,
                    );
                }
                this.voiceGateReleaseTimeout = null;
            }, NexusVoiceConnection.VOICE_GATE_RELEASE_MS);
        }
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
        this.stopVoiceGatePolling();
        if (this.participantRetryTimer) {
            clearInterval(this.participantRetryTimer);
            this.participantRetryTimer = null;
        }

        // Close audio pipeline
        if (this.rnnoiseNode) {
            this.rnnoiseNode.disconnect();
            this.rnnoiseNode.destroy();
            this.rnnoiseNode = null;
        }
        this.sourceNode = null;
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        this.analyserNode = null;
        this.inputGainNode = null;
        this.highPassFilter = null;
        this.compressorNode = null;
        this._inputLevel = 0;
        this._voiceGateOpen = true;

        // Clean up output <audio> elements
        for (const audio of this.outputAudioElements.values()) {
            audio.pause();
            audio.srcObject = null;
        }
        this.outputAudioElements.clear();
        this._masterOutputVolume = 0;

        // Clean up screen share <audio> elements
        for (const audio of this.screenShareAudioElements.values()) {
            audio.pause();
            audio.srcObject = null;
        }
        this.screenShareAudioElements.clear();
        this.watchingScreenShares.clear();

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

        // Clear active speakers & participant states
        this._activeSpeakers = new Set();
        this._participantStates = new Map();

        // Disconnect LiveKit room
        if (this.livekitRoom) {
            this.livekitRoom.off(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.off(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            this.livekitRoom.off(LivekitRoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged);
            this.livekitRoom.off(LivekitRoomEvent.ParticipantConnected, this.onParticipantConnected);
            this.livekitRoom.off(LivekitRoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
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

        // Handle screen share video track
        if (publication.source === Track.Source.ScreenShare) {
            this.updateScreenShares();
            // Listen for track ended to promptly remove stale screen shares
            // (e.g. remote user stops sharing but TrackUnsubscribed is delayed)
            const identity = participant.identity;
            const onEnded = (): void => {
                track.mediaStreamTrack.removeEventListener("ended", onEnded);
                this._screenShares = this._screenShares.filter(
                    (s) => s.participantIdentity !== identity,
                );
                this.emit(CallEvent.ScreenShares, this._screenShares);
            };
            track.mediaStreamTrack.addEventListener("ended", onEnded);
            return;
        }

        // Handle screen share audio — use <audio> element
        if (publication.source === Track.Source.ScreenShareAudio) {
            this.updateScreenShares();
            try {
                const audio = new Audio();
                audio.srcObject = new MediaStream([track.mediaStreamTrack]);
                // Restore persisted volume if available
                const ssUserId = this.resolveIdentityToUserId(participant.identity);
                const ssSavedVol = ssUserId
                    ? this.loadPersistedVolume(NexusVoiceConnection.SCREENSHARE_VOLUMES_KEY, ssUserId)
                    : null;
                const ssInitialVol = ssSavedVol ?? this.screenShareVolumes.get(participant.identity) ?? 1;
                if (ssSavedVol !== null) this.screenShareVolumes.set(participant.identity, ssSavedVol);
                // Audio muted until user opts in to watch (volume=0)
                const watching = this.watchingScreenShares.has(participant.identity);
                audio.volume = watching ? Math.min(1, ssInitialVol * this._masterOutputVolume) : 0;
                audio.play().catch(() => {});
                this.screenShareAudioElements.set(participant.identity, audio);
            } catch (e) {
                logger.warn("onTrackSubscribed (ScreenShareAudio) error:", e);
            }
            return;
        }

        if (track.kind !== "audio") return;

        try {
            // Use per-participant <audio> element — Chrome does not route
            // remote WebRTC audio through MediaStreamAudioSourceNode.
            const audio = new Audio();
            audio.srcObject = new MediaStream([track.mediaStreamTrack]);

            // Restore persisted volume if available
            const resolvedUserId = this.resolveIdentityToUserId(participant.identity);
            const savedVol = resolvedUserId
                ? this.loadPersistedVolume(NexusVoiceConnection.PARTICIPANT_VOLUMES_KEY, resolvedUserId)
                : null;
            const initialVol = savedVol ?? this.participantVolumes.get(participant.identity) ?? 1;
            if (savedVol !== null) this.participantVolumes.set(participant.identity, savedVol);
            audio.volume = Math.min(1, initialVol * this._masterOutputVolume);
            audio.play().catch(() => {});

            this.outputAudioElements.set(participant.identity, audio);
        } catch (e) {
            logger.warn("onTrackSubscribed error:", e);
        }
    };

    private onTrackUnsubscribed = (
        track: RemoteTrackPublication["track"],
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
    ): void => {
        if (!track) return;

        // Handle screen share video track — directly remove from list
        // (publication may still hold a stale track reference at this point,
        // so updateScreenShares() alone would fail to exclude it)
        if (publication.source === Track.Source.ScreenShare) {
            const had = this._screenShares.some((s) => s.participantIdentity === participant.identity);
            this._screenShares = this._screenShares.filter(
                (s) => s.participantIdentity !== participant.identity,
            );
            if (had && this.connected) playVcSound(VC_SCREEN_OFF_SOUND);
            this.emit(CallEvent.ScreenShares, this._screenShares);
            return;
        }

        // Handle screen share audio — clean up <audio> element
        if (publication.source === Track.Source.ScreenShareAudio) {
            this._screenShares = this._screenShares.filter(
                (s) => s.participantIdentity !== participant.identity,
            );
            this.emit(CallEvent.ScreenShares, this._screenShares);
            const ssAudio = this.screenShareAudioElements.get(participant.identity);
            if (ssAudio) {
                ssAudio.pause();
                ssAudio.srcObject = null;
                this.screenShareAudioElements.delete(participant.identity);
            }
            this.watchingScreenShares.delete(participant.identity);
            return;
        }

        if (track.kind !== "audio") return;

        // Clean up <audio> element
        const audio = this.outputAudioElements.get(participant.identity);
        if (audio) {
            audio.pause();
            audio.srcObject = null;
            this.outputAudioElements.delete(participant.identity);
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

    // ─── Private: Volume persistence ─────────────────────────

    private persistVolume(storageKey: string, userId: string, volume: number): void {
        try {
            const raw = localStorage.getItem(storageKey);
            const map = raw ? JSON.parse(raw) : {};
            map[userId] = volume;
            localStorage.setItem(storageKey, JSON.stringify(map));
        } catch {
            // Ignore storage errors
        }
    }

    private loadPersistedVolume(storageKey: string, userId: string): number | null {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return null;
            const map = JSON.parse(raw);
            return typeof map[userId] === "number" ? map[userId] : null;
        } catch {
            return null;
        }
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
        const newStates = new Map<string, ParticipantState>();
        const myUserId = this.client.getUserId();

        // Build set of user IDs that are currently screen-sharing
        const screenSharingUserIds = new Set<string>();
        for (const share of this._screenShares) {
            const uid = share.isLocal
                ? myUserId
                : this.resolveIdentityToUserId(share.participantIdentity);
            if (uid) screenSharingUserIds.add(uid);
        }

        // Check local participant — use own input level because we publish a
        // processed MediaStreamTrack via Web Audio API, so LiveKit's
        // localParticipant.isSpeaking may not fire correctly.
        const localSpeaking = !this._isMicMuted && this._inputLevel > 5;
        if (localSpeaking && myUserId) {
            speakingUserIds.add(myUserId);
        }
        if (myUserId) {
            newStates.set(myUserId, {
                isMuted: this._isMicMuted,
                isScreenSharing: this._isScreenSharing,
            });
        }

        // Check remote participants
        for (const participant of this.livekitRoom.remoteParticipants.values()) {
            if (participant.isSpeaking) {
                const userId = this.resolveIdentityToUserId(participant.identity);
                if (userId) {
                    speakingUserIds.add(userId);
                }
            }

            const userId = this.resolveIdentityToUserId(participant.identity);
            if (userId) {
                const micPub = participant.getTrackPublication(Track.Source.Microphone);
                // Muted = track is muted OR track is not published at all
                const isMuted = micPub ? micPub.isMuted : true;
                newStates.set(userId, {
                    isMuted,
                    isScreenSharing: screenSharingUserIds.has(userId),
                });
            }
        }

        // Only emit if the set actually changed
        if (!this.setsEqual(this._activeSpeakers, speakingUserIds)) {
            this._activeSpeakers = speakingUserIds;
            this.emit(CallEvent.ActiveSpeakers, speakingUserIds);
        }

        // Emit participant states if changed
        if (!this.participantStatesEqual(this._participantStates, newStates)) {
            this._participantStates = newStates;
            this.emit(CallEvent.ParticipantStates, newStates);
        }
    }

    private participantStatesEqual(
        a: Map<string, ParticipantState>,
        b: Map<string, ParticipantState>,
    ): boolean {
        if (a.size !== b.size) return false;
        for (const [key, val] of a) {
            const other = b.get(key);
            if (!other || val.isMuted !== other.isMuted || val.isScreenSharing !== other.isScreenSharing) {
                return false;
            }
        }
        return true;
    }

    private setsEqual(a: Set<string>, b: Set<string>): boolean {
        if (a.size !== b.size) return false;
        for (const item of a) {
            if (!b.has(item)) return false;
        }
        return true;
    }

    // ─── Private: Participants ────────────────────────────────

    private onParticipantConnected = (): void => {
        this.updateParticipants();
    };

    private onParticipantDisconnected = (): void => {
        this.updateParticipants();
        this.updateScreenShares();
    };

    private onMembershipsChanged = (): void => {
        const prevCount = this._participants.size;
        this.updateParticipants();
        const newCount = this._participants.size;

        // Play SE when users join/leave (only while connected)
        if (this.connected && prevCount !== newCount) {
            if (newCount > prevCount) {
                playVcSound(VC_JOIN_SOUND);
            } else if (newCount > 0) {
                playVcSound(VC_LEAVE_SOUND);
            }
        }

        // If connected but memberships dropped to 0, MatrixRTC may be
        // re-joining (force re-join on "Missing own membership"). Retry
        // to pick up the re-sent state event once the next sync arrives.
        if (this.connected && newCount === 0) {
            logger.info("Memberships dropped to 0 while connected, scheduling retry");
            this.retryUpdateParticipants();
        }
    };

    private retryUpdateParticipants(): void {
        // Avoid duplicate retry loops
        if (this.participantRetryTimer) return;

        let retries = 0;
        const maxRetries = 10;
        this.participantRetryTimer = setInterval(() => {
            retries++;
            this.updateParticipants();
            // Stop retrying once we have participants or hit the limit
            if (this._participants.size > 0 || retries >= maxRetries || !this.connected) {
                clearInterval(this.participantRetryTimer!);
                this.participantRetryTimer = null;
            }
        }, 1000);
    }

    private updateParticipants(): void {
        const participants = new Map<RoomMember, Set<string>>();

        if (this.livekitRoom && this.connected) {
            // ── Connected mode: LiveKit is the source of truth ──
            // Cross-reference MatrixRTC memberships with actual LiveKit
            // participants to filter out stale memberships (users who
            // disconnected uncleanly and left ghost MatrixRTC entries).

            // Build set of user IDs actually connected to LiveKit
            const livekitUserIds = new Set<string>();
            for (const rp of this.livekitRoom.remoteParticipants.values()) {
                const userId = this.resolveIdentityToUserId(rp.identity);
                if (userId) livekitUserIds.add(userId);
            }

            // 1. MatrixRTC members — only include if also in LiveKit
            for (const m of this.session.memberships) {
                if (!m.sender) continue;
                if (!livekitUserIds.has(m.sender)) continue; // Not in LiveKit → stale
                const member = this.room.getMember(m.sender);
                if (member) {
                    if (participants.has(member)) {
                        participants.get(member)!.add(m.deviceId);
                    } else {
                        participants.set(member, new Set([m.deviceId]));
                    }
                }
            }

            // 2. LiveKit participants not yet in MatrixRTC (fast path)
            const seen = new Set([...participants.keys()].map((m) => m.userId));
            for (const rp of this.livekitRoom.remoteParticipants.values()) {
                const userId = this.resolveIdentityToUserId(rp.identity);
                if (!userId || seen.has(userId)) continue;
                const member = this.room.getMember(userId);
                if (member) {
                    participants.set(member, new Set(["livekit"]));
                }
            }

            // 3. Add self
            const myUserId = this.client.getUserId();
            if (myUserId && !seen.has(myUserId)) {
                const myMember = this.room.getMember(myUserId);
                if (myMember) {
                    participants.set(myMember, new Set([this.client.getDeviceId()!]));
                }
            }
        } else {
            // ── Pre-connection mode: MatrixRTC memberships only ──
            // Before joining LiveKit, we can only rely on MatrixRTC data.
            // Stale entries may be visible here but will be cleaned up
            // once connected.
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
