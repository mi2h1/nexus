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
    type TrackPublication,
    RemoteParticipant,
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
import { isTauri, corsFreePost } from "../utils/tauriHttp";
import type { NativeVideoCaptureStream, NativeAudioCaptureStream } from "../utils/NexusNativeCapture";

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
 * Self-hosted LiveKit JWT service URL.
 * Accepts POST /sfu/get with Matrix OpenID token, returns {jwt, url}.
 * CORS headers are set by the nginx reverse proxy.
 *
 * When set, bypasses both the CORS proxy and matrix.org's transport URL.
 * Set to empty string to fall back to the matrix.org transport + CORS proxy.
 */
const NEXUS_JWT_SERVICE_URL = "https://lche2.xvps.jp:7891";

/**
 * Cloudflare Workers CORS proxy URL for LiveKit JWT endpoint.
 * Used as fallback when NEXUS_JWT_SERVICE_URL is not set.
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
    private _participants = new Map<string, Set<string>>();
    private _latencyMs: number | null = null;
    private _isMicMuted = false;
    /** Suppress SE in onMembershipsChanged during self join/leave */
    private _suppressMembershipSounds = false;

    private livekitRoom: LivekitRoom | null = null;
    private localAudioTrack: LocalAudioTrack | null = null;
    private localScreenTrack: LocalVideoTrack | null = null;
    private localScreenAudioTrack: LocalAudioTrack | null = null;
    // ─── Native (Tauri) screen capture ───────────────────────────
    private nativeVideoCapture: NativeVideoCaptureStream | null = null;
    private nativeAudioCapture: NativeAudioCaptureStream | null = null;
    private _isNativeCapture = false;
    private _isScreenSharing = false;
    private _isSwitchingTarget = false;
    private _screenShares: ScreenShareInfo[] = [];
    private _activeSpeakers = new Set<string>();
    private _participantStates = new Map<string, ParticipantState>();
    /** Remote mute states received via data messages (identity → muted) */
    private remoteMuteStates = new Map<string, boolean>();
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
    private screenShareVideoElements = new Map<string, HTMLVideoElement>();
    private screenShareVolumes = new Map<string, number>(); // 0-1.0
    // ─── Tauri output audio pipeline (>100% volume) ──────────
    // In Tauri, we use createMediaStreamSource() to route <audio> through
    // Web Audio API GainNodes, enabling volume amplification beyond 1.0.
    // NOTE: Screen share audio does NOT use Web Audio — it stays on the
    // <video> element (videoEl.volume) to preserve browser A/V sync.
    private outputAudioContext: AudioContext | null = null;
    private outputMasterGain: GainNode | null = null;
    private outputMediaSources = new Map<string, AudioNode>();
    private outputParticipantGains = new Map<string, GainNode>();
    private watchingScreenShares = new Set<string>(); // opt-in watching state
    /** Timers that delay updateScreenShares() until audio track arrives. */
    private pendingScreenShareTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private static readonly SCREEN_SHARE_AUDIO_WAIT_MS = 500;
    private analyserNode: AnalyserNode | null = null;
    private inputGainNode: GainNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private highPassFilter: BiquadFilterNode | null = null;
    private compressorNode: DynamicsCompressorNode | null = null;
    private delayNode: DelayNode | null = null;
    // ─── RNNoise noise cancellation ───────────────────────────
    private rnnoiseNode: RnnoiseWorkletNode | null = null;
    private static rnnoiseWasmBinary: ArrayBuffer | null = null;
    private static rnnoiseWorkletRegistered = false;
    private voiceGateTimer: ReturnType<typeof setInterval> | null = null;
    private _inputLevel = 0; // 0-100 real-time input level
    private _voiceGateOpen = true;
    private voiceGateReleaseTimeout: ReturnType<typeof setTimeout> | null = null;
    private static readonly VOICE_GATE_RELEASE_MS = 300;
    /** Gain ramp duration for voice gate close (fade-out). */
    private static readonly VOICE_GATE_RAMP_SEC = 0.05;
    /** DelayNode lookahead so analyser detects speech before audio reaches the gate. */
    private static readonly VOICE_GATE_LOOKAHEAD_SEC = 0.05;
    private participantRetryTimer: ReturnType<typeof setInterval> | null = null;

    // ─── OpenID token cache ────────────────────────────────────
    // Shared across instances — avoids redundant matrix.org round-trips on reconnect.
    private static openIdTokenCache: { token: any; expiresAt: number } | null = null;

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

    public get participants(): Map<string, Set<string>> {
        return this._participants;
    }

    private set participants(value: Map<string, Set<string>>) {
        const prevValue = this._participants;
        this._participants = value;
        this.emit(CallEvent.Participants, value as any, prevValue as any);
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
        this._suppressMembershipSounds = true;

        try {
            // ── Phase 0: Create AudioContext in user gesture context ──
            // MUST be created BEFORE any await — Chrome's autoplay policy
            // requires AudioContext creation within a user gesture.
            // NOTE: This AudioContext is used ONLY for the input (mic) pipeline.
            // Remote audio output uses a separate outputAudioContext (Tauri)
            // or plain <audio> elements (browser).
            this.audioContext = new AudioContext();
            this._masterOutputVolume = 0; // starts muted until unmutePipelines()

            // Tauri: create output AudioContext for >100% volume amplification.
            // Uses createMediaStreamSource to feed WebRTC audio directly into
            // the Web Audio graph (same approach as livekit-client webAudioMix).
            if (isTauri()) {
                this.outputAudioContext = new AudioContext();
                this.outputMasterGain = this.outputAudioContext.createGain();
                this.outputMasterGain.gain.value = 0; // starts muted
                this.outputMasterGain.connect(this.outputAudioContext.destination);
            }

            // ── Phase 1: Parallel pre-fetch ──────────────────────────
            // JWT, mic access, and RNNoise WASM download run concurrently
            // to minimize total wall-clock time.
            const ncEnabled = SettingsStore.getValue("nexus_noise_cancellation") ?? false;
            const [{ jwt, url }, audioTrack] = await Promise.all([
                this.getJwt(),
                createLocalAudioTrack({
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000,
                    channelCount: 1,
                }),
                // Preload RNNoise WASM binary in parallel (cached statically)
                ncEnabled ? NexusVoiceConnection.preloadRnnoiseWasm() : Promise.resolve(),
            ]);
            this.localAudioTrack = audioTrack;

            // ── Phase 3+4: Connect to LiveKit & build pipeline in parallel ──
            // Pipeline construction only needs audioContext + audioTrack (both
            // ready), so it runs concurrently with the WebSocket + ICE/DTLS
            // handshake to shave ~50-100ms off the total connection time.
            this.livekitRoom = new LivekitRoom();
            this.livekitRoom.on(LivekitRoomEvent.TrackSubscribed, this.onTrackSubscribed);
            this.livekitRoom.on(LivekitRoomEvent.TrackUnsubscribed, this.onTrackUnsubscribed);
            this.livekitRoom.on(LivekitRoomEvent.TrackMuted, this.onTrackMuted);
            this.livekitRoom.on(LivekitRoomEvent.TrackUnmuted, this.onTrackUnmuted);
            this.livekitRoom.on(LivekitRoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged);
            this.livekitRoom.on(LivekitRoomEvent.ParticipantConnected, this.onParticipantConnected);
            this.livekitRoom.on(LivekitRoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
            this.livekitRoom.on(LivekitRoomEvent.DataReceived, this.onDataReceived);

            const pipelinePromise = this.buildInputPipeline(audioTrack, ncEnabled);
            await this.livekitRoom.connect(url, jwt);
            const processedTrack = await pipelinePromise;

            // Publish with optimized Opus settings
            await this.livekitRoom.localParticipant.publishTrack(processedTrack, {
                source: Track.Source.Microphone,
                audioPreset: { maxBitrate: 128_000 }, // 128kbps — ≤10人なので帯域問題なし
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
            // Allow membership SE after a short delay (self membership event may still arrive)
            setTimeout(() => { this._suppressMembershipSounds = false; }, 2000);

            // 6. Broadcast our initial mute state so existing participants see it
            this.broadcastMuteState(this._isMicMuted);

            // 7. Start latency polling & speaker detection
            this.startStatsPolling();
            this.startSpeakerPolling();

            // 8. Re-check participants after a short delay.
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
        this._suppressMembershipSounds = true;

        // Leave MatrixRTC — fire-and-forget.
        // The state event PUT to matrix.org can take 100-500ms+.
        // No need to block the UI; membership auto-expires on timeout,
        // and clean() handles stale memberships on next connect.
        this.session.leaveRoomSession(5000).catch((e) => {
            logger.warn("Failed to leave MatrixRTC session", e);
        });

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
        // Control audio via inputGainNode (immediate, actual silence) +
        // signal mute state to other participants via LiveKit data messages.
        //
        // Why we bypass ALL of LiveKit's mute mechanisms:
        //   - track.mute()/unmute(): calls pauseUpstream()/resumeUpstream()
        //     → RTP sender disruption → DTLS timeouts → brief disconnections
        //   - setTrackMuted(): event chain triggers pauseUpstream() too
        //   - sendMuteTrack(): tells SFU "track muted" → SFU stops forwarding
        //     audio → multi-second delay on unmute while SFU resumes
        //
        // Our approach (completely independent of LiveKit mute):
        //   1. inputGainNode.gain = 0 for actual audio silencing (instant)
        //   2. publishData() to broadcast mute state to other participants
        //   3. Remote clients read mute state from data messages, not micPub.isMuted
        if (this.inputGainNode) {
            this.inputGainNode.gain.value = muted
                ? 0
                : (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
        }
        // Broadcast mute state to all participants via data channel
        this.broadcastMuteState(muted);
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
        // Tauri: resume output AudioContext too
        if (this.outputAudioContext?.state === "suspended") {
            this.outputAudioContext.resume().catch(() => {});
        }
        // Restore master output volume and apply to all audio outputs
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
        // In Tauri mode, the NexusScreenSharePanel opens the native picker
        // and calls startNativeScreenShare() directly with the user's selection.
        // So startScreenShare() only handles the browser path.
        await this.startBrowserScreenShare();
    }

    // ─── Native screen share (Tauri: DXGI + WASAPI) ─────────────

    /**
     * Start native screen capture with the given target.
     * Called directly from NexusScreenSharePanel after the user
     * selects a capture target in the native picker.
     */
    public async startNativeScreenShare(
        targetId: string,
        fps: number,
        captureAudio: boolean,
        targetProcessId: number = 0,
    ): Promise<void> {
        if (!this.livekitRoom || !this.connected) return;

        const preset = this.getScreenSharePreset();

        try {
            // Start native capture via Tauri
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("start_capture", {
                targetId,
                fps,
                captureAudio,
                targetProcessId,
            });

            // Create video pipeline
            const { NativeVideoCaptureStream, NativeAudioCaptureStream } =
                await import("../utils/NexusNativeCapture");

            this.nativeVideoCapture = new NativeVideoCaptureStream(preset.width, preset.height, fps);
            await this.nativeVideoCapture.start();

            const videoTrack = this.nativeVideoCapture.getVideoTrack();
            if (videoTrack) {
                videoTrack.contentHint = "motion";
                this.localScreenTrack = new LocalVideoTrack(videoTrack, undefined, true);
                await this.livekitRoom.localParticipant.publishTrack(this.localScreenTrack, {
                    source: Track.Source.ScreenShare,
                    videoCodec: "h264",
                    screenShareEncoding: new VideoPreset(
                        preset.width, preset.height, preset.maxBitrate, preset.fps,
                    ).encoding,
                    screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
                    degradationPreference: "maintain-framerate",
                });
            }

            // Create audio pipeline if requested.
            // Re-use outputAudioContext (created during user gesture in connect())
            // to guarantee the context is in "running" state — a freshly created
            // AudioContext here would likely be suspended by WebView2's autoplay policy.
            if (captureAudio && this.outputAudioContext) {
                this.nativeAudioCapture = new NativeAudioCaptureStream(this.outputAudioContext, 48000, 2);
                await this.nativeAudioCapture.start();

                const audioTrack = this.nativeAudioCapture.getAudioTrack();
                if (audioTrack) {
                    this.localScreenAudioTrack = new LocalAudioTrack(audioTrack, undefined, true);
                    await this.livekitRoom.localParticipant.publishTrack(this.localScreenAudioTrack, {
                        source: Track.Source.ScreenShareAudio,
                    });
                    logger.info("Native screen share audio captured (WASAPI)");
                }
            }

            this._isScreenSharing = true;
            this._isNativeCapture = true;
            this.updateScreenShares();
            logger.info("Native screen share started:", targetId);

            // Listen for capture events
            import("@tauri-apps/api/event").then(({ listen }) => {
                listen("capture-stopped", () => {
                    if (this._isNativeCapture && this._isScreenSharing && !this._isSwitchingTarget) {
                        this.stopScreenShare().catch((e) =>
                            logger.warn("Failed to stop after capture-stopped", e),
                        );
                    }
                });
                // WASAPI format diagnostics
                listen<string>("wasapi-info", (event) => {
                    logger.info(event.payload);
                });
            });
        } catch (e) {
            logger.warn("Failed to start native screen share", e);
            await this.cleanupNativeCapture();
        }
    }

    // ─── Switch native capture target (Tauri) ─────────────────

    /**
     * Switch the WGC capture target while keeping audio and LiveKit tracks intact.
     * The NativeVideoCaptureStream receives frames via Tauri events, so switching
     * the Rust-side capture target automatically sends new frames to the same
     * MediaStreamTrack — no replaceTrack() needed.
     */
    public async switchNativeScreenShareTarget(targetId: string, targetProcessId: number = 0): Promise<void> {
        if (!this._isScreenSharing || !this._isNativeCapture) return;

        this._isSwitchingTarget = true;
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            const preset = this.getScreenSharePreset();
            await invoke("switch_capture_target", { targetId, fps: preset.fps, targetProcessId });
            logger.info("Switched native capture target to:", targetId);
        } finally {
            this._isSwitchingTarget = false;
        }
    }

    // ─── Browser screen share (getDisplayMedia) ─────────────────

    private async startBrowserScreenShare(): Promise<void> {
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
                    audio: isTauri(),
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
                    videoCodec: "h264",
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
            videoCodec: "h264",
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

        // Clean up native capture resources (Tauri)
        if (this._isNativeCapture) {
            await this.cleanupNativeCapture();
        }

        this._isScreenSharing = false;
        this.updateScreenShares();
    }

    private async cleanupNativeCapture(): Promise<void> {
        this._isNativeCapture = false;

        // Stop Rust-side WASAPI / WGC capture FIRST so that the OS audio
        // session is properly released before we tear down JS-side nodes.
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("stop_capture");
        } catch (e) {
            logger.warn("Failed to stop native capture", e);
        }

        if (this.nativeVideoCapture) {
            this.nativeVideoCapture.stop();
            this.nativeVideoCapture = null;
        }
        if (this.nativeAudioCapture) {
            this.nativeAudioCapture.stop();
            this.nativeAudioCapture = null;
        }
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

        // Tauri: update per-participant GainNode
        const participantGain = this.outputParticipantGains.get(identity);
        if (participantGain) {
            participantGain.gain.value = clamped;
        } else {
            // Browser fallback
            const audio = this.outputAudioElements.get(identity);
            if (audio) {
                audio.volume = Math.min(1, clamped * this._masterOutputVolume);
            }
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
        const watching = this.watchingScreenShares.has(participantIdentity);

        const videoEl = this.screenShareVideoElements.get(participantIdentity);
        if (videoEl && watching) {
            videoEl.volume = Math.min(1, clamped * this._masterOutputVolume);
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

    // ─── Public: Screen share video element registration ────

    /**
     * Register the <video> element used by ScreenShareTile for volume control.
     * The tile combines video + audio tracks into a single MediaStream on this
     * element. We use videoEl.volume directly (no Web Audio) to keep audio in
     * the same pipeline as video — preserving browser RTCP SR-based A/V sync.
     */
    public registerScreenShareVideoElement(participantIdentity: string, videoEl: HTMLVideoElement): void {
        this.screenShareVideoElements.set(participantIdentity, videoEl);
        const watching = this.watchingScreenShares.has(participantIdentity);
        const vol = this.screenShareVolumes.get(participantIdentity) ?? 1;

        videoEl.muted = false;
        videoEl.volume = watching ? Math.min(1, vol * this._masterOutputVolume) : 0;
        videoEl.play().catch(() => {});
    }

    /**
     * Unregister the <video> element when the tile unmounts.
     */
    public unregisterScreenShareVideoElement(participantIdentity: string): void {
        this.screenShareVideoElements.delete(participantIdentity);
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

        const vol = this.screenShareVolumes.get(participantIdentity) ?? 1;
        const videoEl = this.screenShareVideoElements.get(participantIdentity);
        if (videoEl) {
            videoEl.volume = watching ? Math.min(1, vol * this._masterOutputVolume) : 0;
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
     * audio outputs. Called when master volume changes or pipelines unmute.
     */
    private applyAllOutputVolumes(): void {
        // Tauri: use GainNodes for >100% amplification (participant audio only)
        if (this.outputMasterGain) {
            this.outputMasterGain.gain.value = this._masterOutputVolume;
        }

        // Browser: participant audio.volume capped at 1.0
        if (!this.outputMasterGain) {
            for (const [identity, audio] of this.outputAudioElements) {
                const vol = this.participantVolumes.get(identity) ?? 1;
                audio.volume = Math.min(1, vol * this._masterOutputVolume);
            }
        }

        // Screen share audio: always via videoEl.volume (both Tauri and Browser)
        for (const [identity, videoEl] of this.screenShareVideoElements) {
            if (this.watchingScreenShares.has(identity)) {
                const vol = this.screenShareVolumes.get(identity) ?? 1;
                videoEl.volume = Math.min(1, vol * this._masterOutputVolume);
            } else {
                videoEl.volume = 0;
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
     * Build the full input audio pipeline and return the processed MediaStreamTrack.
     * Runs in parallel with livekitRoom.connect() — only needs audioContext
     * and localAudioTrack, both of which are ready before connect() starts.
     *
     * Pipeline: source → [RNNoise] → HPF → compressor → analyser + inputGain → dest
     */
    private async buildInputPipeline(audioTrack: LocalAudioTrack, ncEnabled: boolean): Promise<MediaStreamTrack> {
        if (!this.audioContext) throw new Error("AudioContext not initialized");

        this.sourceNode = this.audioContext.createMediaStreamSource(
            new MediaStream([audioTrack.mediaStreamTrack]),
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

        // Connect the pipeline chain
        this.connectInputPipeline();

        // Create processed stream destination
        const dest = this.audioContext.createMediaStreamDestination();
        this.inputGainNode.connect(dest);
        return dest.stream.getAudioTracks()[0];
    }

    /**
     * Connect the input audio pipeline chain:
     *   source → [rnnoise] → HPF → compressor → analyser (no delay)
     *                                          → delayNode(50ms) → inputGain
     */
    private connectInputPipeline(): void {
        if (!this.sourceNode || !this.highPassFilter || !this.compressorNode
            || !this.analyserNode || !this.inputGainNode || !this.audioContext) return;

        if (this.rnnoiseNode) {
            this.sourceNode.connect(this.rnnoiseNode);
            this.rnnoiseNode.connect(this.highPassFilter);
        } else {
            this.sourceNode.connect(this.highPassFilter);
        }
        this.highPassFilter.connect(this.compressorNode);
        // Analyser taps the signal before the delay so level detection is immediate
        this.compressorNode.connect(this.analyserNode);
        // DelayNode lookahead: speech is detected 50ms before it reaches the gate
        this.delayNode = this.audioContext.createDelay(0.1);
        this.delayNode.delayTime.value = NexusVoiceConnection.VOICE_GATE_LOOKAHEAD_SEC;
        this.compressorNode.connect(this.delayNode);
        this.delayNode.connect(this.inputGainNode);
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
        this.delayNode?.disconnect();
        // Don't disconnect analyserNode or inputGainNode — they connect to dest
    }

    // ─── Private: RNNoise setup ──────────────────────────────

    /**
     * Prefetch VC resources at app startup (after login).
     * Runs in the background — failures are silently ignored.
     * Warms up: RNNoise WASM binary + OpenID token cache.
     */
    public static prefetch(client: MatrixClient): void {
        // Fire-and-forget — don't block the caller
        Promise.all([
            NexusVoiceConnection.preloadRnnoiseWasm(),
            NexusVoiceConnection.prefetchOpenIdToken(client),
        ]).catch(() => {});
    }

    /**
     * Prefetch and cache the OpenID token so the first VC join
     * doesn't need to round-trip to matrix.org.
     */
    private static async prefetchOpenIdToken(client: MatrixClient): Promise<void> {
        try {
            const token = await client.getOpenIdToken();
            const expiresIn = (token.expires_in ?? 3600) * 0.8 * 1000;
            NexusVoiceConnection.openIdTokenCache = { token, expiresAt: Date.now() + expiresIn };
            logger.info("OpenID token prefetched");
        } catch (e) {
            logger.warn("Failed to prefetch OpenID token", e);
        }
    }

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
                // DelayNode lookahead lets us open instantly without clipping the onset
                const targetVol = (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
                this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                this.inputGainNode.gain.setValueAtTime(targetVol, this.audioContext.currentTime);
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

    /**
     * Return a cached OpenID token, fetching a fresh one only when the
     * cache is empty or expired. Saves ~100-200ms on reconnect by
     * skipping the round-trip to matrix.org.
     */
    private async getCachedOpenIdToken(): Promise<any> {
        const now = Date.now();
        if (NexusVoiceConnection.openIdTokenCache && now < NexusVoiceConnection.openIdTokenCache.expiresAt) {
            return NexusVoiceConnection.openIdTokenCache.token;
        }
        const token = await this.client.getOpenIdToken();
        // expires_in is in seconds. Cache for 80% of the lifetime to avoid
        // edge-case expiry during the JWT request itself.
        const expiresIn = (token.expires_in ?? 3600) * 0.8 * 1000;
        NexusVoiceConnection.openIdTokenCache = { token, expiresAt: now + expiresIn };
        return token;
    }

    private async getJwt(): Promise<LivekitTokenResponse> {
        const openIdToken = await this.getCachedOpenIdToken();
        const body = {
            room: this.room.roomId,
            openid_token: openIdToken,
            device_id: this.client.getDeviceId(),
        };

        // ── Self-hosted JWT service (preferred, with retry + fallback) ──
        if (NEXUS_JWT_SERVICE_URL) {
            try {
                return await this.fetchJwtWithRetry(`${NEXUS_JWT_SERVICE_URL}/sfu/get`, body);
            } catch (e) {
                logger.warn(`Self-hosted JWT service failed, falling back to transport URL: ${e}`);
            }
        }

        // ── Fallback: Element's JWT service via transport URL ──
        const livekitTransport = this.transports.find(
            (t) => t.type === "livekit" && t.livekit_service_url,
        );
        if (!livekitTransport) {
            throw new Error("No LiveKit transport configured");
        }

        const serviceUrl = livekitTransport.livekit_service_url as string;

        // Tauri: direct access (with retry)
        if (isTauri()) {
            return this.fetchJwtWithRetry(`${serviceUrl}/sfu/get`, body);
        }

        // Browser: route through CORS proxy (with retry)
        let fetchUrl: string;
        let fetchBody: Record<string, unknown>;

        if (LIVEKIT_CORS_PROXY_URL) {
            fetchUrl = `${LIVEKIT_CORS_PROXY_URL}/sfu/get`;
            fetchBody = { ...body, livekit_service_url: serviceUrl };
        } else {
            fetchUrl = `${serviceUrl}/sfu/get`;
            fetchBody = body;
        }

        return this.fetchJwtWithRetry(fetchUrl, fetchBody);
    }

    /**
     * Fetch JWT with a single retry on transient errors (5xx / network).
     */
    private async fetchJwtWithRetry(url: string, body: Record<string, unknown>): Promise<LivekitTokenResponse> {
        const attempt = async (): Promise<LivekitTokenResponse> => {
            if (isTauri()) {
                return corsFreePost<LivekitTokenResponse>(url, body);
            }
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            return (await response.json()) as LivekitTokenResponse;
        };

        try {
            return await attempt();
        } catch (e) {
            logger.warn(`JWT fetch failed (${url}), retrying in 1s: ${e}`);
            await new Promise((r) => setTimeout(r, 1000));
            return attempt();
        }
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
        if (this.delayNode) {
            this.delayNode.disconnect();
            this.delayNode = null;
        }
        this._inputLevel = 0;
        this._voiceGateOpen = true;

        // Clean up output <audio> elements
        for (const audio of this.outputAudioElements.values()) {
            audio.pause();
            audio.srcObject = null;
        }
        this.outputAudioElements.clear();
        this._masterOutputVolume = 0;

        // Clean up Tauri output audio pipeline
        for (const source of this.outputMediaSources.values()) source.disconnect();
        this.outputMediaSources.clear();
        for (const gain of this.outputParticipantGains.values()) gain.disconnect();
        this.outputParticipantGains.clear();
        if (this.outputMasterGain) {
            this.outputMasterGain.disconnect();
            this.outputMasterGain = null;
        }
        if (this.outputAudioContext) {
            this.outputAudioContext.close().catch(() => {});
            this.outputAudioContext = null;
        }

        // Clean up screen share elements
        for (const timer of this.pendingScreenShareTimers.values()) clearTimeout(timer);
        this.pendingScreenShareTimers.clear();
        this.screenShareVideoElements.clear();
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
        // Clean up native capture — stop Rust side first, then JS nodes.
        if (this._isNativeCapture) {
            this._isNativeCapture = false;
            // Fire-and-forget stop_capture — WASAPI session must be released
            // before JS-side nodes are torn down to avoid orphaned audio taps.
            import("@tauri-apps/api/core").then(({ invoke }) => {
                invoke("stop_capture").catch(() => {});
            }).then(() => {
                this.nativeVideoCapture?.stop();
                this.nativeVideoCapture = null;
                this.nativeAudioCapture?.stop();
                this.nativeAudioCapture = null;
            }).catch(() => {
                // Fallback: clean up JS side even if stop_capture failed
                this.nativeVideoCapture?.stop();
                this.nativeVideoCapture = null;
                this.nativeAudioCapture?.stop();
                this.nativeAudioCapture = null;
            });
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
            this.livekitRoom.off(LivekitRoomEvent.TrackMuted, this.onTrackMuted);
            this.livekitRoom.off(LivekitRoomEvent.TrackUnmuted, this.onTrackUnmuted);
            this.livekitRoom.off(LivekitRoomEvent.ActiveSpeakersChanged, this.onActiveSpeakersChanged);
            this.livekitRoom.off(LivekitRoomEvent.ParticipantConnected, this.onParticipantConnected);
            this.livekitRoom.off(LivekitRoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
            this.livekitRoom.off(LivekitRoomEvent.DataReceived, this.onDataReceived);
            this.remoteMuteStates.clear();
            // Fire-and-forget — local tracks are already stopped, event
            // handlers removed. The WebSocket close handshake (~50-100ms)
            // doesn't need to block the UI.
            const room = this.livekitRoom;
            this.livekitRoom = null;
            room.disconnect().catch((e) => {
                logger.warn("LiveKit room disconnect error", e);
            });
        }
    }

    // ─── Private: Remote Audio ───────────────────────────────

    /**
     * When a remote audio track is muted, mute the corresponding <audio> element
     * to eliminate WebRTC decoder noise floor ("サー" noise).
     */
    /**
     * TrackMuted fires for BOTH local and remote tracks.
     * We only mute/unmute <audio> elements for remote participants.
     */
    private onTrackMuted = (
        publication: TrackPublication,
        participant: Participant,
    ): void => {
        if (!(participant instanceof RemoteParticipant)) return;
        if (publication.source === Track.Source.Microphone) {
            const audio = this.outputAudioElements.get(participant.identity);
            if (audio) audio.muted = true;
        }
        this.updateParticipants();
    };

    private onTrackUnmuted = (
        publication: TrackPublication,
        participant: Participant,
    ): void => {
        if (!(participant instanceof RemoteParticipant)) return;
        if (publication.source === Track.Source.Microphone) {
            const audio = this.outputAudioElements.get(participant.identity);
            if (audio) audio.muted = false;
        }
        this.updateParticipants();
    };

    private onTrackSubscribed = (
        track: TrackPublication["track"],
        publication: TrackPublication,
        participant: RemoteParticipant,
    ): void => {
        if (!track) return;

        // Handle screen share video track
        if (publication.source === Track.Source.ScreenShare) {
            // Listen for track ended to promptly remove stale screen shares
            const identity = participant.identity;
            const onEnded = (): void => {
                track.mediaStreamTrack.removeEventListener("ended", onEnded);
                this._screenShares = this._screenShares.filter(
                    (s) => s.participantIdentity !== identity,
                );
                this.emit(CallEvent.ScreenShares, this._screenShares);
            };
            track.mediaStreamTrack.addEventListener("ended", onEnded);

            // Delay updateScreenShares() briefly to wait for the audio track.
            // LiveKit delivers video and audio as separate subscription events;
            // if we emit immediately, ScreenShareTile starts playing video-only
            // and audio arrives later out of sync.
            const existing = this.pendingScreenShareTimers.get(identity);
            if (existing) clearTimeout(existing);
            this.pendingScreenShareTimers.set(
                identity,
                setTimeout(() => {
                    this.pendingScreenShareTimers.delete(identity);
                    this.updateScreenShares();
                }, NexusVoiceConnection.SCREEN_SHARE_AUDIO_WAIT_MS),
            );
            return;
        }

        // Handle screen share audio — audio is played via the <video> element
        // in ScreenShareTile (combined MediaStream for A/V sync).
        if (publication.source === Track.Source.ScreenShareAudio) {
            // Restore persisted volume if available
            const ssUserId = this.resolveIdentityToUserId(participant.identity);
            const ssSavedVol = ssUserId
                ? this.loadPersistedVolume(NexusVoiceConnection.SCREENSHARE_VOLUMES_KEY, ssUserId)
                : null;
            if (ssSavedVol !== null) this.screenShareVolumes.set(participant.identity, ssSavedVol);

            // Audio arrived — cancel the pending video timer and emit both
            // tracks together so ScreenShareTile starts playback in sync.
            const pendingTimer = this.pendingScreenShareTimers.get(participant.identity);
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                this.pendingScreenShareTimers.delete(participant.identity);
            }
            this.updateScreenShares();
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

            // Tauri: route through Web Audio for >100% volume.
            // Use createMediaStreamSource (like livekit-client's webAudioMix)
            // instead of createMediaElementSource — the latter does not
            // reliably redirect audio in WebView2, causing audio to bypass
            // the GainNode chain entirely.
            if (this.outputAudioContext && this.outputMasterGain) {
                const source = this.outputAudioContext.createMediaStreamSource(
                    audio.srcObject as MediaStream,
                );
                const gain = this.outputAudioContext.createGain();
                gain.gain.value = initialVol;
                source.connect(gain).connect(this.outputMasterGain);
                this.outputMediaSources.set(participant.identity, source);
                this.outputParticipantGains.set(participant.identity, gain);
                // Suppress audio element's system output — all audio goes
                // through the Web Audio graph. Element must still play() to
                // keep the MediaStream alive.
                audio.volume = 0;
                audio.play().catch(() => {});
            } else {
                // Browser: audio.volume capped at 1.0
                audio.volume = Math.min(1, initialVol * this._masterOutputVolume);
                audio.play().catch(() => {});
            }

            // If the track is already muted, mute the audio element to avoid noise floor
            if (publication.isMuted) {
                audio.muted = true;
            }

            this.outputAudioElements.set(participant.identity, audio);
        } catch (e) {
            logger.warn("onTrackSubscribed error:", e);
        }
    };

    private onTrackUnsubscribed = (
        track: TrackPublication["track"],
        publication: TrackPublication,
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
            // Clear watching state so re-share requires explicit watch action
            if (this.watchingScreenShares.delete(participant.identity)) {
                this.emit(CallEvent.WatchingChanged, new Set(this.watchingScreenShares));
            }
            if (had && this.connected) playVcSound(VC_SCREEN_OFF_SOUND);
            this.emit(CallEvent.ScreenShares, this._screenShares);
            return;
        }

        // Handle screen share audio unsubscribe
        if (publication.source === Track.Source.ScreenShareAudio) {
            this._screenShares = this._screenShares.filter(
                (s) => s.participantIdentity !== participant.identity,
            );
            this.emit(CallEvent.ScreenShares, this._screenShares);
            this.screenShareVideoElements.delete(participant.identity);
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
        // Clean up Tauri audio nodes
        this.outputMediaSources.get(participant.identity)?.disconnect();
        this.outputMediaSources.delete(participant.identity);
        this.outputParticipantGains.get(participant.identity)?.disconnect();
        this.outputParticipantGains.delete(participant.identity);
    };

    // ─── Private: Active Speakers ─────────────────────────────

    /**
     * Resolve a LiveKit participant identity to a Matrix user ID.
     * Identity is usually the Matrix user ID, but may include a device suffix.
     */
    private resolveIdentityToUserId(identity: string): string | null {
        // Fast path: room member lookup (works when sync is complete)
        const directMember = this.room.getMember(identity);
        if (directMember) return directMember.userId;

        // Parse userId from identity — may be "@user:server" or "@user:server:device"
        const atIdx = identity.indexOf("@");
        if (atIdx < 0) return null;
        const firstColon = identity.indexOf(":", atIdx + 1);
        if (firstColon < 0) return null;

        const secondColon = identity.indexOf(":", firstColon + 1);
        const userId = secondColon > 0 ? identity.substring(0, secondColon) : identity;

        // Verify format: @localpart:server
        if (!userId.startsWith("@") || !userId.includes(":")) return null;

        // Try room member lookup with parsed userId
        const member = this.room.getMember(userId);
        if (member) return member.userId;

        // Return parsed userId even without RoomMember (sync may not have completed)
        return userId;
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
                // Use data-message-based mute state (our custom signaling),
                // falling back to LiveKit's micPub.isMuted for participants
                // that haven't sent a data message yet.
                const dataMuted = this.remoteMuteStates.get(participant.identity);
                const micPub = participant.getTrackPublication(Track.Source.Microphone);
                const isMuted = dataMuted ?? (micPub ? micPub.isMuted : true);
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
        const prevCount = this._participants.size;
        this.updateParticipants();
        const newCount = this._participants.size;

        // Play join SE — LiveKit fires before MatrixRTC so this is the
        // reliable trigger point for remote participant join sounds.
        if (this.connected && !this._suppressMembershipSounds && newCount > prevCount) {
            playVcSound(VC_JOIN_SOUND);
        }

        // Re-broadcast our mute state so the new joiner picks it up.
        // Slight delay to ensure their data channel is ready.
        setTimeout(() => this.broadcastMuteState(this._isMicMuted), 500);
    };

    private onParticipantDisconnected = (participant: Participant): void => {
        const prevCount = this._participants.size;
        this.remoteMuteStates.delete(participant.identity);
        this.updateParticipants();
        const newCount = this._participants.size;

        // Play leave SE — LiveKit fires before MatrixRTC so this is the
        // reliable trigger point for remote participant leave sounds.
        if (this.connected && !this._suppressMembershipSounds && newCount < prevCount && newCount > 0) {
            playVcSound(VC_LEAVE_SOUND);
        }

        this.updateScreenShares();
    };

    // ─── Private: Data-channel mute signaling ─────────────────

    private static readonly MUTE_TOPIC = "nexus-mute";

    private broadcastMuteState(muted: boolean): void {
        if (!this.livekitRoom?.localParticipant) return;
        const payload = new TextEncoder().encode(JSON.stringify({ m: muted }));
        this.livekitRoom.localParticipant
            .publishData(payload, { reliable: true, topic: NexusVoiceConnection.MUTE_TOPIC })
            .catch((e) => logger.warn("Failed to broadcast mute state", e));
    }

    private onDataReceived = (
        payload: Uint8Array,
        participant?: Participant,
        _kind?: unknown,
        topic?: string,
    ): void => {
        if (topic !== NexusVoiceConnection.MUTE_TOPIC || !participant) return;
        try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            if (typeof data.m === "boolean") {
                this.remoteMuteStates.set(participant.identity, data.m);
            }
        } catch {
            // ignore malformed data
        }
    };

    private onMembershipsChanged = (): void => {
        const prevCount = this._participants.size;
        this.updateParticipants();
        const newCount = this._participants.size;

        // Play SE when OTHER users join/leave (suppress during self join/leave)
        if (this.connected && !this._suppressMembershipSounds && prevCount !== newCount) {
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
        const participants = new Map<string, Set<string>>();

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
                if (participants.has(m.sender)) {
                    participants.get(m.sender)!.add(m.deviceId);
                } else {
                    participants.set(m.sender, new Set([m.deviceId]));
                }
            }

            // 2. LiveKit participants not yet in MatrixRTC (fast path)
            for (const rp of this.livekitRoom.remoteParticipants.values()) {
                const userId = this.resolveIdentityToUserId(rp.identity);
                if (!userId || participants.has(userId)) continue;
                participants.set(userId, new Set(["livekit"]));
            }

            // 3. Add self
            const myUserId = this.client.getUserId();
            if (myUserId && !participants.has(myUserId)) {
                participants.set(myUserId, new Set([this.client.getDeviceId()!]));
            }
        } else {
            // ── Pre-connection mode: MatrixRTC memberships only ──
            // Before joining LiveKit, we can only rely on MatrixRTC data.
            // Stale entries may be visible here but will be cleaned up
            // once connected.
            for (const m of this.session.memberships) {
                if (!m.sender) continue;
                if (participants.has(m.sender)) {
                    participants.get(m.sender)!.add(m.deviceId);
                } else {
                    participants.set(m.sender, new Set([m.deviceId]));
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
