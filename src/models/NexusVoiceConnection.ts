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
import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";
import { MicVAD } from "@ricky0123/vad-web";

import { CallEvent, ConnectionState, type CallEventHandlerMap, type ParticipantState, type ScreenShareInfo } from "./Call";
import SettingsStore from "../settings/SettingsStore";
import { isTauri, corsFreePost } from "../utils/tauriHttp";
import type { NativeVideoCaptureStream, NativeAudioCaptureStream } from "../utils/NexusNativeCapture";

const logger = rootLogger.getChild("NexusVoiceConnection");

const STATS_POLL_INTERVAL_MS = 2000;

// ─── Screen share quality presets ────────────────────────
export type ScreenShareQuality = "low" | "standard" | "high" | "ultra";

interface ScreenSharePresetConfig {
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
const VC_SCREEN_ON_SOUND = "media/sfx_screen-on.mp3";
const VC_SCREEN_OFF_SOUND = "media/sfx_screen-off.mp3";

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
export const NEXUS_JWT_SERVICE_URL = "https://lche2.xvps.jp:7891";

/**
 * Cloudflare Workers CORS proxy URL for LiveKit JWT endpoint.
 * Only used as a last-resort fallback when NEXUS_JWT_SERVICE_URL fails
 * AND the browser needs to reach the matrix.org transport URL without CORS.
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
/** Handle returned by NexusVoiceConnection.createStandaloneMonitor(). */
export interface StandaloneMonitorHandle {
    setVolume(volume: number): void;
    stop(): void;
}

// ── Voice EQ constants ────────────────────────────────────────────────────────
const EQ_NUM_BANDS = 8;

const EQ_AUTO_BANDS: ReadonlyArray<{ freq: number; gain: number; q: number }> = [
    { freq: 350, gain: -3, q: 1.0 },
    { freq: 3000, gain: 2.5, q: 0.8 },
];

/** Frequencies for シンプルモード (4 bands). */
export const EQ_SIMPLE_FREQS = [250, 500, 2000, 5000] as const;
const EQ_SIMPLE_Q = [1.0, 1.0, 1.0, 1.0] as const;

/** Frequencies for カスタムモード (8 bands). */
export const EQ_CUSTOM_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000] as const;
const EQ_CUSTOM_Q = [0.7, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.7] as const;

/**
 * Apply EQ band parameters to an array of BiquadFilterNodes.
 * All gain changes happen synchronously (no ramp) to match the polling cadence.
 */
function applyEqBands(
    nodes: BiquadFilterNode[],
    enabled: boolean,
    mode: string,
    simpleGains: number[],
    customGains: number[],
): void {
    if (!enabled) {
        for (const n of nodes) n.gain.value = 0;
        return;
    }
    if (mode === "simple") {
        nodes.forEach((n, i) => {
            if (i < EQ_SIMPLE_FREQS.length) {
                n.frequency.value = EQ_SIMPLE_FREQS[i];
                n.Q.value = EQ_SIMPLE_Q[i];
                n.gain.value = simpleGains[i] ?? 0;
            } else {
                n.gain.value = 0;
            }
        });
    } else if (mode === "custom") {
        nodes.forEach((n, i) => {
            n.frequency.value = EQ_CUSTOM_FREQS[i];
            n.Q.value = EQ_CUSTOM_Q[i];
            n.gain.value = customGains[i] ?? 0;
        });
    } else {
        // auto
        nodes.forEach((n, i) => {
            if (i < EQ_AUTO_BANDS.length) {
                n.frequency.value = EQ_AUTO_BANDS[i].freq;
                n.Q.value = EQ_AUTO_BANDS[i].q;
                n.gain.value = EQ_AUTO_BANDS[i].gain;
            } else {
                n.gain.value = 0;
            }
        });
    }
}

export class NexusVoiceConnection extends TypedEventEmitter<CallEvent, CallEventHandlerMap> {
    public readonly callType = CallType.Voice;

    private _connectionState = ConnectionState.Disconnected;
    private _participants = new Map<string, Set<string>>();
    private _latencyMs: number | null = null;
    private _isMicMuted = false;
    private _isOutputMuted = false;
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
    /** Tauri event unlisten functions — cleaned up in cleanupNativeCapture(). */
    private tauriUnlistenFns: Array<() => void> = [];
    private _isScreenSharing = false;
    private _isSwitchingTarget = false;
    private _screenShares: ScreenShareInfo[] = [];
    private _activeSpeakers = new Set<string>();
    private _participantStates = new Map<string, ParticipantState>();
    /** Remote mute states received via data messages (identity → muted) */
    private remoteMuteStates = new Map<string, boolean>();
    /** Remote speaking states received via data messages (identity → speaking) */
    private remoteSpeakingStates = new Map<string, boolean>();
    // ─── Silero VAD ──────────────────────────────────────────
    private sileroVad: MicVAD | null = null;
    /** True when Silero VAD is running and managing _voiceGateOpen. */
    private sileroVadActive = false;
    private speakerPollTimer: ReturnType<typeof setInterval> | null = null;
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    // ─── Audio pipeline ──────────────────────────────────────
    // AudioContext is used ONLY for the input (mic) pipeline.
    // Output uses per-participant <audio> elements — Chrome does
    // not route remote WebRTC audio through MediaStreamAudioSourceNode.
    private audioContext: AudioContext | null = null;
    private _masterOutputVolume = 0; // 0-2 (0-200%), starts muted
    private outputAudioElements = new Map<string, HTMLAudioElement>();
    private participantVolumes = new Map<string, number>(); // 0-4.0 (0-400%)
    // ─── Screen share audio ──────────────────────────────────
    private screenShareVideoElements = new Map<string, HTMLVideoElement>();
    private screenShareVolumes = new Map<string, number>(); // 0-4.0 (0-400%)
    private screenShareSources = new Map<string, AudioNode>();
    private screenShareGains = new Map<string, GainNode>();
    // ─── Tauri output audio pipeline (>100% volume) ──────────
    // In Tauri, we use createMediaStreamSource() to route audio through
    // Web Audio API GainNodes, enabling volume amplification beyond 1.0.
    // Both participant audio and screen share audio use this approach.
    private outputAudioContext: AudioContext | null = null;
    private outputMasterGain: GainNode | null = null;
    private outputMediaSources = new Map<string, AudioNode>();
    private outputParticipantGains = new Map<string, GainNode>();
    private outputParticipantAnalysers = new Map<string, AnalyserNode>();
    private readonly outputAnalyserBuffer = new Uint8Array(256);
    private watchingScreenShares = new Set<string>(); // opt-in watching state
    /** Timers that delay updateScreenShares() until audio track arrives. */
    private pendingScreenShareTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private static readonly SCREEN_SHARE_AUDIO_WAIT_MS = 500;
    private analyserNode: AnalyserNode | null = null;
    private inputGainNode: GainNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private highPassFilter: BiquadFilterNode | null = null;
    private delayNode: DelayNode | null = null;
    // ─── DeepFilterNet3 noise cancellation ────────────────────
    private ncNode: AudioWorkletNode | null = null;
    /** Shared initialized core — cached after first initialize() so WASM/model aren't re-downloaded. */
    private static deepfilterCore: DeepFilterNet3Core | null = null;
    // ─── Voice EQ ─────────────────────────────────────────────
    private eqNodes: BiquadFilterNode[] = [];
    // ─── Compressor (limiter) ─────────────────────────────────
    private compressorNode: DynamicsCompressorNode | null = null;
    // ─── Post-NC gate (residual noise suppression) ────────────
    /** GainNode placed after delay, before voiceGate — cuts residual noise that RNNoise reduces but doesn't eliminate. */
    private postNcGainNode: GainNode | null = null;
    // ─── Mic monitor (self-monitoring) ────────────────────────
    /** GainNode routing processed audio to local speakers for self-monitoring. */
    private monitorGainNode: GainNode | null = null;
    // ─── Post-NC gate state (hysteresis) ─────────────────────
    private _postNcGateOpen = false;
    // ─── VAD-gated AGC ────────────────────────────────────────
    private agcGainNode: GainNode | null = null;
    private agcCurrentGain = 1.0;
    private voiceGateTimer: ReturnType<typeof setInterval> | null = null;
    private _inputLevel = 0; // 0-100 internal linear level (AGC/threshold only)
    private _meterLevel = 0; // 0-100 dBFS log-scaled level emitted for display
    /** AnalyserNode tapped before RNNoise — reads true mic signal for the display meter. */
    /** Reusable buffer for analyser data — avoids allocation in hot polling loop. */
    private analyserBuffer: Uint8Array<ArrayBuffer> | null = null;
    private _voiceGateOpen = true;
    private voiceGateReleaseTimeout: ReturnType<typeof setTimeout> | null = null;
    private voiceGateAttackCount = 0;
    private static readonly VOICE_GATE_RELEASE_MS = 300;
    /** Gain ramp duration for voice gate close (fade-out). */
    private static readonly VOICE_GATE_RAMP_SEC = 0.05;
    /** Gain ramp duration for voice gate open (fade-in, eliminates pop on entry). */
    private static readonly VOICE_GATE_OPEN_RAMP_SEC = 0.010;
    /** DelayNode lookahead so analyser detects speech before audio reaches the gate.
     *  15ms: gate opens 15ms before speech arrives → max word-start clipping = ~35ms.
     *  Lower value also reduces self-monitoring latency (was 50ms, which caused hollow sound). */
    private static readonly VOICE_GATE_LOOKAHEAD_SEC = 0.015;
    /** Consecutive polls above open threshold required before opening gate (~50ms attack). */
    private static readonly VOICE_GATE_ATTACK_POLLS = 1;
    /** Hysteresis gap in dBFS between open and close threshold. */
    private static readonly VOICE_GATE_HYSTERESIS_DB = 6;
    // ─── AGC constants ────────────────────────────────────────
    /** Target RMS level for AGC (0-100 scale). */
    private static readonly AGC_TARGET_RMS = 25;
    private static readonly AGC_MIN_GAIN = 0.5;
    private static readonly AGC_MAX_GAIN = 2.0; // 3.0→2.0: over-boost→loud spike→compressor clamp を緩和
    /** How fast AGC adjusts gain per poll cycle (0-1, higher = faster). */
    private static readonly AGC_ADJUSTMENT_RATE = 0.03;
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

    public get isOutputMuted(): boolean {
        return this._isOutputMuted;
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
                // Resume immediately — on first app launch WebView2 may start AudioContext in
                // "suspended" state even within a user gesture, causing the first track's
                // MediaStreamAudioSourceNode to be created while the context is not running,
                // which can result in mono (left-only) output until the context resumes.
                this.outputAudioContext.resume().catch(() => {});
                // Force stereo on the destination — on first launch before audio device
                // initialization, maxChannelCount may report 1 (mono). Explicitly set to 2
                // so the hardware is asked to output stereo once the device is ready.
                if (this.outputAudioContext.destination.maxChannelCount >= 2) {
                    this.outputAudioContext.destination.channelCount = 2;
                }
                this.outputMasterGain = this.outputAudioContext.createGain();
                this.outputMasterGain.gain.value = 0; // starts muted
                // Force stereo output — without explicit channelCount the node defaults to
                // channelCountMode="max", which collapses to mono when all participant tracks
                // are mono (Opus voice), causing left-only audio in WebView2.
                this.outputMasterGain.channelCount = 2;
                this.outputMasterGain.channelCountMode = "explicit";
                this.outputMasterGain.channelInterpretation = "speakers";
                this.outputMasterGain.connect(this.outputAudioContext.destination);
            }

            // ── Phase 1: Parallel pre-fetch ──────────────────────────
            // JWT and mic access run concurrently to minimize total wall-clock time.
            const [{ jwt, url }, audioTrack] = await Promise.all([
                this.getJwt(),
                createLocalAudioTrack({
                    echoCancellation: true,
                    noiseSuppression: false, // OFF — Win11 OS-level noise suppression と二重処理を防ぐ
                    autoGainControl: false,
                    sampleRate: 48000,
                    channelCount: 1,
                }),
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
            this.livekitRoom.on(LivekitRoomEvent.ParticipantConnected, this.onParticipantConnected);
            this.livekitRoom.on(LivekitRoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
            this.livekitRoom.on(LivekitRoomEvent.DataReceived, this.onDataReceived);
            this.livekitRoom.on(LivekitRoomEvent.Reconnecting, this.onLivekitReconnecting);
            this.livekitRoom.on(LivekitRoomEvent.Reconnected, this.onLivekitReconnected);

            const pipelinePromise = this.buildInputPipeline(audioTrack);
            await this.livekitRoom.connect(url, jwt);
            const processedTrack = await pipelinePromise;

            // Publish with optimized Opus settings
            await this.livekitRoom.localParticipant.publishTrack(processedTrack, {
                source: Track.Source.Microphone,
                audioPreset: { maxBitrate: 128_000 }, // 128kbps — ≤10人なので帯域問題なし
                dtx: false, // DTX off — 無音→発話の遷移で音が崩れるのを防ぐ
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

    public setOutputMuted(muted: boolean): void {
        this._isOutputMuted = muted;
        this.applyAllOutputVolumes();
        this.emit(CallEvent.OutputMuted, muted);
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
            // Listen for capture events (must be registered BEFORE start_capture)
            // Store unlisten functions to prevent listener accumulation on repeated start/stop.
            const { listen } = await import("@tauri-apps/api/event");
            const unlistenStopped = await listen("capture-stopped", () => {
                if (this._isNativeCapture && this._isScreenSharing && !this._isSwitchingTarget) {
                    this.stopScreenShare().catch((e) =>
                        logger.warn("Failed to stop after capture-stopped", e),
                    );
                }
            });
            const unlistenWasapi = await listen<string>("wasapi-info", (event) => {
                logger.debug("WASAPI:", event.payload);
            });
            this.tauriUnlistenFns.push(unlistenStopped, unlistenWasapi);

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
                }
            }

            this._isScreenSharing = true;
            this._isNativeCapture = true;
            this.updateScreenShares();

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
                    logger.warn("Screen share audio unavailable, retrying video-only");
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

        // Remove Tauri event listeners to prevent accumulation on repeated start/stop
        for (const unlisten of this.tauriUnlistenFns) {
            unlisten();
        }
        this.tauriUnlistenFns = [];

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
     * Set the audio volume for a remote participant (0.0–4.0, i.e. 0–400%).
     */
    public setParticipantVolume(userId: string, volume: number): void {
        const identity = this.findIdentityForUserId(userId);
        if (!identity) return;
        const clamped = Math.max(0, Math.min(4, volume));
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
     * Get the current audio volume for a remote participant (0.0–4.0).
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
     * Set the audio volume for a remote screen share (0.0–4.0, i.e. 0–400%).
     * Uses participantIdentity directly as key.
     */
    public setScreenShareVolume(participantIdentity: string, volume: number): void {
        const clamped = Math.max(0, Math.min(4, volume));
        this.screenShareVolumes.set(participantIdentity, clamped);
        const watching = this.watchingScreenShares.has(participantIdentity);

        this.applyScreenShareVolume(participantIdentity, watching);
        // Persist by resolved userId (stable across sessions)
        const userId = this.resolveIdentityToUserId(participantIdentity);
        if (userId) this.persistVolume(NexusVoiceConnection.SCREENSHARE_VOLUMES_KEY, userId, clamped);
    }

    /**
     * Get the current audio volume for a remote screen share (0.0–4.0).
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
     * Tauri: routes audio through Web Audio (createMediaStreamSource → GainNode
     * → outputMasterGain) for >100% amplification. The video element's volume
     * is set to 0 to suppress direct output.
     * Browser: uses videoEl.volume directly (capped at 100%).
     */
    public registerScreenShareVideoElement(participantIdentity: string, videoEl: HTMLVideoElement): void {
        // Clean up previous registration if any
        this.unregisterScreenShareVideoElement(participantIdentity);

        this.screenShareVideoElements.set(participantIdentity, videoEl);

        // Tauri: route screen share audio through Web Audio for >100% volume
        if (this.outputAudioContext && this.outputMasterGain && videoEl.srcObject) {
            const audioTracks = (videoEl.srcObject as MediaStream).getAudioTracks();
            if (audioTracks.length > 0) {
                const audioStream = new MediaStream(audioTracks);
                const source = this.outputAudioContext.createMediaStreamSource(audioStream);
                const vol = this.screenShareVolumes.get(participantIdentity) ?? 1;
                const watching = this.watchingScreenShares.has(participantIdentity);
                const gain = this.outputAudioContext.createGain();
                gain.gain.value = watching ? vol : 0;
                source.connect(gain).connect(this.outputMasterGain);
                this.screenShareSources.set(participantIdentity, source);
                this.screenShareGains.set(participantIdentity, gain);
                // Suppress video element's direct audio — all audio via Web Audio
                videoEl.muted = false;
                videoEl.volume = 0;
            } else {
                videoEl.muted = true;
            }
        } else {
            // Browser: direct volume control via videoEl.volume
            videoEl.muted = false;
            videoEl.volume = 1;
        }

        videoEl.play().catch(() => {});

        const watching = this.watchingScreenShares.has(participantIdentity);
        this.applyScreenShareVolume(participantIdentity, watching);
    }

    /**
     * Unregister the <video> element when the tile unmounts.
     */
    public unregisterScreenShareVideoElement(participantIdentity: string): void {
        this.screenShareVideoElements.delete(participantIdentity);
        // Clean up Tauri Web Audio nodes
        this.screenShareSources.get(participantIdentity)?.disconnect();
        this.screenShareSources.delete(participantIdentity);
        this.screenShareGains.get(participantIdentity)?.disconnect();
        this.screenShareGains.delete(participantIdentity);
    }

    /**
     * Apply the current volume to a screen share.
     * Tauri: per-share GainNode (0-2, master handled by outputMasterGain).
     * Browser: videoEl.volume (capped at 1.0).
     */
    private applyScreenShareVolume(participantIdentity: string, watching: boolean): void {
        const vol = this.screenShareVolumes.get(participantIdentity) ?? 1;

        // Tauri: use per-share GainNode for >100% volume
        const gain = this.screenShareGains.get(participantIdentity);
        if (gain) {
            gain.gain.value = watching ? vol : 0;
            return;
        }

        // Browser: videoEl.volume capped at 1.0
        const effectiveMaster = this._isOutputMuted ? 0 : this._masterOutputVolume;
        const effectiveVol = watching ? vol * effectiveMaster : 0;
        const videoEl = this.screenShareVideoElements.get(participantIdentity);
        if (videoEl) {
            videoEl.volume = Math.min(1, effectiveVol);
        }
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

        this.applyScreenShareVolume(participantIdentity, watching);
        this.emit(CallEvent.WatchingChanged, new Set(this.watchingScreenShares));
    }

    // ─── Public: Audio pipeline accessors ──────────────────────

    public get inputLevel(): number {
        return this._meterLevel;
    }

    public get voiceGateOpen(): boolean {
        return this._voiceGateOpen;
    }

    /** Update mic monitor gain in real time (called from settings UI). */
    public setMicMonitor(enabled: boolean, volume: number): void {
        if (this.monitorGainNode && this.audioContext) {
            const gain = enabled ? Math.max(0, Math.min(1, volume / 100)) : 0;
            this.monitorGainNode.gain.setValueAtTime(gain, this.audioContext.currentTime);
        }
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
        const effectiveMaster = this._isOutputMuted ? 0 : this._masterOutputVolume;

        // Tauri: outputMasterGain controls both participant + screen share audio
        if (this.outputMasterGain) {
            this.outputMasterGain.gain.value = effectiveMaster;
        }

        // Browser: participant audio.volume capped at 1.0
        if (!this.outputMasterGain) {
            for (const [identity, audio] of this.outputAudioElements) {
                const vol = this.participantVolumes.get(identity) ?? 1;
                audio.volume = Math.min(1, vol * effectiveMaster);
            }
        }

        // Screen share audio: GainNode if available, else videoEl.volume
        for (const [identity] of this.screenShareVideoElements) {
            const watching = this.watchingScreenShares.has(identity);
            this.applyScreenShareVolume(identity, watching);
        }
    }

    /**
     * Build the full input audio pipeline and return the processed MediaStreamTrack.
     * Runs in parallel with livekitRoom.connect() — only needs audioContext
     * and localAudioTrack, both of which are ready before connect() starts.
     *
     * Pipeline:
     *   source → HPF(80Hz) ┬→ rawLevelAnalyser (メーター表示用、RNNoise前の生信号)
     *                      └→ [RNNoise (optional)] → analyser (ゲート判定用、NC後信号)
     *                                              → delay(50ms) → postNcGain → inputGain (voice gate)
     *                                              → eqLowCut (350Hz -3dB, こもり除去)
     *                                              → eqPresence (3kHz +2.5dB, 明瞭さ向上)
     *                                              → agcGain (VAD連動自動音量調整)
     *                                              → compressor (ピーク防止)
     *                                              → dest
     */
    private async buildInputPipeline(audioTrack: LocalAudioTrack): Promise<MediaStreamTrack> {
        if (!this.audioContext) throw new Error("AudioContext not initialized");

        this.sourceNode = this.audioContext.createMediaStreamSource(
            new MediaStream([audioTrack.mediaStreamTrack]),
        );

        // High-pass filter — removes low-frequency noise (AC hum, rumble, pops)
        this.highPassFilter = this.audioContext.createBiquadFilter();
        this.highPassFilter.type = "highpass";
        this.highPassFilter.frequency.value = 80;
        this.highPassFilter.Q.value = 0.7;

        // DeepFilterNet3 AI noise cancellation (optional — fails gracefully if unavailable)
        const ncEnabled = SettingsStore.getValue("nexus_noise_cancellation_enabled") ?? true;
        if (ncEnabled) {
            await this.setupDeepfilterNode();
        }


        // AnalyserNode — monitors input level (post-RNNoise, pre-delay for instant detection)
        // Used for voice gate frequency analysis (cleaned signal, no background noise).
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 1024;       // 512 bins @ 48kHz → ~46.9 Hz/bin
        this.analyserNode.minDecibels = -90;    // maps byte 0 → -90 dBFS
        this.analyserNode.maxDecibels = 0;      // maps byte 255 → 0 dBFS

        // Input GainNode — voice gate (0 = gate closed, inputVol = gate open)
        // Start muted — unmutePipelines() restores the real volume.
        this.inputGainNode = this.audioContext.createGain();
        this.inputGainNode.gain.value = 0;

        // Voice EQ — configurable multi-band equalizer (EQ_NUM_BANDS nodes always in chain)
        this.eqNodes = Array.from({ length: EQ_NUM_BANDS }, () => {
            const f = this.audioContext!.createBiquadFilter();
            f.type = "peaking";
            f.frequency.value = 1000;
            f.Q.value = 1.0;
            f.gain.value = 0;
            return f;
        });
        {
            const eqEnabled = SettingsStore.getValue("nexus_voice_eq_enabled") ?? true;
            const eqMode = (SettingsStore.getValue("nexus_eq_mode") ?? "auto") as string;
            const simpleGains = (SettingsStore.getValue("nexus_eq_simple_gains") ?? [0, -3, 0, 2.5]) as number[];
            const customGains = (SettingsStore.getValue("nexus_eq_custom_gains") ?? [0, 0, 0, -3, 0, 0, 2.5, 0]) as number[];
            applyEqBands(this.eqNodes, eqEnabled, eqMode, simpleGains, customGains);
        }

        // VAD-gated AGC — gain adjusted only during voice activity
        this.agcGainNode = this.audioContext.createGain();
        this.agcGainNode.gain.value = this.agcCurrentGain;

        // Compressor/Limiter — prevents peaks, placed AFTER gate so
        // background noise is already gated and won't be amplified
        this.compressorNode = this.audioContext.createDynamicsCompressor();
        this.compressorNode.threshold.value = -12; // headroom before compression kicks in
        this.compressorNode.knee.value = 15;       // soft onset
        this.compressorNode.ratio.value = 3;       // 3:1 ratio — light compression
        this.compressorNode.attack.value = 0.015;  // 15ms — preserve transients
        this.compressorNode.release.value = 0.25;  // 250ms — avoid pumping artifact

        // Post-NC gate — start open (gain=1); pollInputLevel() controls it per-poll
        this.postNcGainNode = this.audioContext.createGain();
        this.postNcGainNode.gain.value = 1;

        // Mic monitor — routes final processed signal to local speakers for self-monitoring
        this.monitorGainNode = this.audioContext.createGain();
        const monitorEnabled = SettingsStore.getValue("nexus_mic_monitor_enabled") ?? false;
        const monitorVol = (SettingsStore.getValue("nexus_mic_monitor_volume") ?? 30) / 100;
        this.monitorGainNode.gain.value = monitorEnabled ? monitorVol : 0;
        // Force stereo upmix — mic source is 1ch (mono), without explicit settings
        // it passes to AudioContext.destination as mono and appears left-only in WebView2.
        this.monitorGainNode.channelCount = 2;
        this.monitorGainNode.channelCountMode = "explicit";
        this.monitorGainNode.channelInterpretation = "speakers";

        // Connect the pipeline chain
        this.connectInputPipeline();

        // Create processed stream destination (for LiveKit)
        const dest = this.audioContext.createMediaStreamDestination();
        this.compressorNode.connect(dest);
        // Mic monitor: parallel output to local speakers
        this.compressorNode.connect(this.monitorGainNode);
        this.monitorGainNode.connect(this.audioContext.destination);

        // Start Silero VAD (fire-and-forget — falls back to RMS VAD if unavailable)
        this.startSileroVAD().catch(() => {});

        return dest.stream.getAudioTracks()[0];
    }

    /**
     * Connect the input audio pipeline chain:
     *   source → HPF ┬→ rawLevelAnalyser (メーター用タップ)
     *                └→ [RNNoise] → analyser (ゲート判定用タップ)
     *                             → delay(50ms) → postNcGain (NC strength gate)
     *                             → inputGain (voice gate)
     *                             → eqLowCut → eqPresence → agcGain → compressor
     *
     * If RNNoise is not available (setting OFF, or worklet failed to load),
     * HPF connects directly to analyser (bypass).
     */
    private connectInputPipeline(): void {
        if (!this.sourceNode || !this.highPassFilter
            || !this.analyserNode || !this.inputGainNode || !this.audioContext
            || this.eqNodes.length === 0 || !this.agcGainNode
            || !this.compressorNode || !this.postNcGainNode) return;

        this.sourceNode.connect(this.highPassFilter);

        // DeepFilterNet3 sits between HPF and gate analyser (if available)
        const postHpf: AudioNode = this.ncNode ?? this.highPassFilter;
        if (this.ncNode) {
            this.highPassFilter.connect(this.ncNode);
        }

        // Gate analyser taps post-RNNoise signal (cleaned) — side-tap, not in main chain
        postHpf.connect(this.analyserNode);
        // DelayNode lookahead: speech is detected 50ms before it reaches the gate
        this.delayNode = this.audioContext.createDelay(0.1);
        this.delayNode.delayTime.value = NexusVoiceConnection.VOICE_GATE_LOOKAHEAD_SEC;
        postHpf.connect(this.delayNode);
        // Post-NC gate sits between delay and voice gate:
        //   delay → postNcGate → voiceGate (inputGainNode) → ...
        // pollInputLevel() reads analyserNode (pre-delay tap) and controls postNcGainNode.
        this.delayNode.connect(this.postNcGainNode);
        this.postNcGainNode.connect(this.inputGainNode);
        // Voice gate → EQ (8 nodes) → AGC → Compressor
        this.inputGainNode.connect(this.eqNodes[0]);
        for (let i = 0; i < this.eqNodes.length - 1; i++) {
            this.eqNodes[i].connect(this.eqNodes[i + 1]);
        }
        this.eqNodes[this.eqNodes.length - 1].connect(this.agcGainNode);
        this.agcGainNode.connect(this.compressorNode);
    }

    /**
     * Register the RNNoise AudioWorklet module on the given AudioContext.
     * Each AudioContext requires its own addModule() call (registration is per-context).
     *
     * Direct URL is used intentionally — Blob URL causes WASM initialization failure
     * because import.meta.url in the worklet resolves to blob:// which breaks the
     * Emscripten-generated relative WASM path resolution.
     */
    private async setupDeepfilterNode(): Promise<void> {
        if (!this.audioContext) return;
        try {
            if (!NexusVoiceConnection.deepfilterCore) {
                const core = new DeepFilterNet3Core({ sampleRate: 48000 });
                await core.initialize(); // downloads WASM + model from CDN (cached in browser after first load)
                NexusVoiceConnection.deepfilterCore = core;
            }
            this.ncNode = await NexusVoiceConnection.deepfilterCore.createAudioWorkletNode(this.audioContext);
            // Force mono — same reason as RNNoise: prevents silent R channel on LiveKit publish
            this.ncNode.channelCount = 1;
            this.ncNode.channelCountMode = "explicit";
        } catch (e) {
            logger.warn("DeepFilterNet3 setup failed, continuing without noise cancellation:", e);
            this.ncNode = null;
        }
    }

    /**
     * Prefetch VC resources at app startup (after login).
     * Runs in the background — failures are silently ignored.
     * Warms up: OpenID token cache + DeepFilterNet3 WASM/model.
     */
    public static prefetch(client: MatrixClient): void {
        // Fire-and-forget — don't block the caller
        NexusVoiceConnection.prefetchOpenIdToken(client).catch(() => {});
        const ncEnabled = SettingsStore.getValue("nexus_noise_cancellation_enabled") ?? true;
        if (ncEnabled) {
            NexusVoiceConnection.prefetchDeepfilterAssets().catch(() => {});
        }
    }

    private static async prefetchDeepfilterAssets(): Promise<void> {
        if (NexusVoiceConnection.deepfilterCore) return;
        try {
            const core = new DeepFilterNet3Core({ sampleRate: 48000 });
            await core.initialize();
            NexusVoiceConnection.deepfilterCore = core;
            logger.info("DeepFilterNet3 assets prefetched");
        } catch (e) {
            logger.warn("DeepFilterNet3 prefetch failed:", e);
        }
    }

    /**
     * Request microphone permission so the browser caches the grant.
     * Stops the stream immediately — the only goal is the permission dialog.
     * Call when the user navigates to a VC channel (before they click Join).
     */
    public static prefetchMicPermission(): void {
        navigator.mediaDevices
            .getUserMedia({ audio: true })
            .then((stream) => {
                stream.getTracks().forEach((t) => t.stop());
            })
            .catch(() => {
                // Permission denied or device unavailable — ignore silently
            });
    }

    /**
     * Build a standalone audio monitoring pipeline for use in the settings UI
     * (when not in a VC). Applies the same processing chain as the VC input
     * pipeline: HPF → [RNNoise] → postNcGate → EQ → AGC → compressor → output.
     *
     * Key design decisions:
     * - WorkletRegistration uses a throwaway probe AudioContext so that a failed
     *   addModule() call (e.g. Tauri/WebView2) never corrupts the main pipeline context.
     * - All processing settings (EQ, AGC, NC strength) are re-read from SettingsStore
     *   every polling cycle so that slider changes take effect immediately without
     *   restarting the pipeline.
     *
     * Returns a handle to control volume and stop monitoring, or null on failure.
     */
    public static async createStandaloneMonitor(volume: number): Promise<StandaloneMonitorHandle | null> {
        try {
            // echoCancellation MUST be off: AEC would treat speaker output as "echo" and
            // cancel it, causing severe muffling. NS/AGC also off — handled in pipeline.
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000,
                    channelCount: 1,
                },
            });

            // ── Full VC-equivalent processing pipeline ────────────────────────────
            // Mirrors the main input pipeline so the user hears exactly what remote
            // participants hear. Settings are re-read each poll cycle.
            const ctx = new AudioContext();
            await ctx.resume();

            const source = ctx.createMediaStreamSource(stream);

            // HPF (80 Hz highpass — removes low rumble)
            const hpf = ctx.createBiquadFilter();
            hpf.type = "highpass";
            hpf.frequency.value = 80;
            hpf.Q.value = 0.7;
            source.connect(hpf);

            // DeepFilterNet3 (optional — only when NC enabled in settings)
            let dfNode: AudioWorkletNode | null = null;
            const ncEnabledSM = SettingsStore.getValue("nexus_noise_cancellation_enabled") ?? true;
            if (ncEnabledSM) {
                try {
                    if (!NexusVoiceConnection.deepfilterCore) {
                        const core = new DeepFilterNet3Core({ sampleRate: 48000 });
                        await core.initialize();
                        NexusVoiceConnection.deepfilterCore = core;
                    }
                    dfNode = await NexusVoiceConnection.deepfilterCore.createAudioWorkletNode(ctx);
                    dfNode.channelCount = 1;
                    dfNode.channelCountMode = "explicit";
                    hpf.connect(dfNode);
                } catch {
                    dfNode = null;
                }
            }
            const postHpf: AudioNode = dfNode ?? hpf;

            // Analyser side-tap (for postNcGate + AGC polling)
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.minDecibels = -90;
            analyser.maxDecibels = 0;
            postHpf.connect(analyser);

            // PostNcGate
            const postNcGain = ctx.createGain();
            postNcGain.gain.value = 1;

            // EQ — same multi-band structure as main pipeline
            const eqNodesSM = Array.from({ length: EQ_NUM_BANDS }, () => {
                const f = ctx.createBiquadFilter();
                f.type = "peaking";
                f.frequency.value = 1000;
                f.Q.value = 1.0;
                f.gain.value = 0;
                return f;
            });

            // AGC
            const agcGainNode = ctx.createGain();
            agcGainNode.gain.value = 1.0;
            let agcCurrentGain = 1.0;
            const AGC_MIN = 0.5;
            const AGC_MAX = 3.0;
            const AGC_TARGET_DB = -18;
            const SILENCE_DB = -55;

            // Compressor
            const compressor = ctx.createDynamicsCompressor();
            compressor.threshold.value = -18;
            compressor.knee.value = 12;
            compressor.ratio.value = 4;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.15;

            // Output gain (volume control)
            const outputGain = ctx.createGain();
            outputGain.gain.value = Math.max(0, volume) / 100;

            // Chain: postHpf → analyser(tap) → postNcGain → EQ (8 nodes) → AGC → compressor → outputGain → dest
            postHpf.connect(postNcGain);
            postNcGain.connect(eqNodesSM[0]);
            for (let i = 0; i < eqNodesSM.length - 1; i++) {
                eqNodesSM[i].connect(eqNodesSM[i + 1]);
            }
            eqNodesSM[eqNodesSM.length - 1].connect(agcGainNode);
            agcGainNode.connect(compressor);
            compressor.connect(outputGain);
            outputGain.connect(ctx.destination);

            // Polling — mirrors main pipeline poll logic
            const timeBuffer = new Uint8Array(analyser.fftSize);
            const pollTimer = setInterval(() => {
                const currentNcEnabled = SettingsStore.getValue("nexus_noise_cancellation_enabled") ?? true;
                const currentNcStrength = SettingsStore.getValue("nexus_nc_strength") ?? 50;
                const currentEqEnabled = SettingsStore.getValue("nexus_voice_eq_enabled") ?? true;
                const currentAgcEnabled = SettingsStore.getValue("nexus_voice_agc_enabled") ?? true;

                const eqMode = (SettingsStore.getValue("nexus_eq_mode") ?? "auto") as string;
                const simpleGains = (SettingsStore.getValue("nexus_eq_simple_gains") ?? [0, -3, 0, 2.5]) as number[];
                const customGains = (SettingsStore.getValue("nexus_eq_custom_gains") ?? [0, 0, 0, -3, 0, 0, 2.5, 0]) as number[];
                applyEqBands(eqNodesSM, currentEqEnabled, eqMode, simpleGains, customGains);

                analyser.getByteTimeDomainData(timeBuffer);
                let sumSq = 0;
                for (let i = 0; i < timeBuffer.length; i++) {
                    const s = (timeBuffer[i] - 128) / 128;
                    sumSq += s * s;
                }
                const rms = Math.sqrt(sumSq / timeBuffer.length);
                const voiceDb = rms > 0 ? 20 * Math.log10(rms) : -96;
                const now = ctx.currentTime;

                // PostNcGate
                if (currentNcEnabled && currentNcStrength > 0 && dfNode !== null) {
                    const thresholdDb = -70 + (currentNcStrength / 100) * 50;
                    if (voiceDb >= thresholdDb) {
                        postNcGain.gain.cancelScheduledValues(now);
                        postNcGain.gain.setValueAtTime(1.0, now);
                    } else {
                        postNcGain.gain.linearRampToValueAtTime(0.0, now + 0.05);
                    }
                } else {
                    postNcGain.gain.setValueAtTime(1.0, now);
                }

                // AGC
                if (currentAgcEnabled && voiceDb > SILENCE_DB) {
                    const diff = AGC_TARGET_DB - voiceDb;
                    const adjustment = Math.pow(10, diff / 20);
                    const newGain = Math.max(AGC_MIN, Math.min(AGC_MAX, agcCurrentGain * Math.pow(adjustment, 0.1)));
                    if (Math.abs(newGain - agcCurrentGain) > 0.01) {
                        agcCurrentGain = newGain;
                        agcGainNode.gain.exponentialRampToValueAtTime(agcCurrentGain, now + 0.1);
                    }
                } else if (!currentAgcEnabled) {
                    if (agcCurrentGain !== 1.0) {
                        agcCurrentGain = 1.0;
                        agcGainNode.gain.setValueAtTime(1.0, now);
                    }
                }
            }, 50);

            return {
                setVolume: (v: number) => {
                    outputGain.gain.setValueAtTime(Math.max(0, v) / 100, ctx.currentTime);
                },
                stop: () => {
                    clearInterval(pollTimer);
                    outputGain.gain.value = 0;
                    stream.getTracks().forEach((t) => t.stop());
                    dfNode?.disconnect();
                    ctx.close().catch(() => {});
                },
            };
        } catch (e) {
            logger.warn("createStandaloneMonitor failed:", e);
            return null;
        }
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
        } catch (e) {
            logger.warn("Failed to prefetch OpenID token", e);
        }
    }

    // ─── Private: Voice gate / input level ───────────────────

    /**
     * Start Silero VAD using the existing mic track (shared with the audio pipeline).
     * Falls back to RMS-threshold VAD if AudioWorklet or ONNX runtime is unavailable.
     */
    private async startSileroVAD(): Promise<void> {
        const track = this.localAudioTrack?.mediaStreamTrack;
        if (!track) return;
        try {
            this.sileroVad = await MicVAD.new({
                model: "v5",
                // Point to locally-served assets (copied by CopyWebpackPlugin)
                baseAssetPath: "vad/",
                onnxWASMBasePath: "vad/",
                // Reuse the existing mic track — do not call getUserMedia or stop tracks
                getStream: async () => new MediaStream([track]),
                pauseStream: async () => {},
                resumeStream: async (stream) => stream,
                startOnLoad: false,
                onSpeechStart: () => {
                    if (this._isMicMuted) return;
                    this._voiceGateOpen = true;
                    this.voiceGateAttackCount = 0;
                    if (this.voiceGateReleaseTimeout) {
                        clearTimeout(this.voiceGateReleaseTimeout);
                        this.voiceGateReleaseTimeout = null;
                    }
                    this.openInputGate();
                    this.broadcastSpeakingState(true);
                },
                onSpeechEnd: () => {
                    if (this.voiceGateReleaseTimeout) clearTimeout(this.voiceGateReleaseTimeout);
                    this.voiceGateReleaseTimeout = setTimeout(() => {
                        this._voiceGateOpen = false;
                        this.closeInputGate();
                        this.broadcastSpeakingState(false);
                        this.voiceGateReleaseTimeout = null;
                    }, NexusVoiceConnection.VOICE_GATE_RELEASE_MS);
                },
                onVADMisfire: () => {},
            });
            await this.sileroVad.start();
            this.sileroVadActive = true;
            logger.info("Silero VAD started (v5 model)");
        } catch (e) {
            logger.warn("Silero VAD failed to start, falling back to RMS VAD:", e);
            this.sileroVad = null;
            this.sileroVadActive = false;
        }
    }

    private stopSileroVAD(): void {
        if (this.sileroVad) {
            this.sileroVad.destroy().catch(() => {});
            this.sileroVad = null;
        }
        this.sileroVadActive = false;
    }

    /** Open voice gate (inputGainNode) when gate setting is enabled. */
    private openInputGate(): void {
        const gateEnabled = SettingsStore.getValue("nexus_voice_gate_enabled");
        if (gateEnabled && this.inputGainNode && this.audioContext) {
            const targetVol = (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
            const now = this.audioContext.currentTime;
            this.inputGainNode.gain.cancelScheduledValues(now);
            this.inputGainNode.gain.setValueAtTime(this.inputGainNode.gain.value, now);
            this.inputGainNode.gain.linearRampToValueAtTime(targetVol, now + NexusVoiceConnection.VOICE_GATE_OPEN_RAMP_SEC);
        }
    }

    /** Close voice gate (inputGainNode) with a short ramp when gate setting is enabled. */
    private closeInputGate(): void {
        const gateEnabled = SettingsStore.getValue("nexus_voice_gate_enabled");
        if (gateEnabled && this.inputGainNode && this.audioContext && !this._isMicMuted) {
            this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
            this.inputGainNode.gain.linearRampToValueAtTime(
                0,
                this.audioContext.currentTime + NexusVoiceConnection.VOICE_GATE_RAMP_SEC,
            );
        }
    }

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

        // ── Post-NC level (analyserNode) — AGC・ゲート判定・メーター表示に使用 ─
        // Must measure here (pre-gate, pre-AGC) so AGC has a stable reference signal.
        // Using the output (post-compressor) would create a feedback loop.
        // メーターもこの値（post-NC）を使うことでゲートのしきい値と同じスケールになる。
        if (!this.analyserBuffer || this.analyserBuffer.length !== this.analyserNode.fftSize) {
            this.analyserBuffer = new Uint8Array(this.analyserNode.fftSize) as Uint8Array<ArrayBuffer>;
        }
        const data = this.analyserBuffer;
        this.analyserNode.getByteTimeDomainData(data);

        let sum = 0;
        for (const sample of data) {
            const normalized = (sample - 128) / 128;
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / data.length);
        this._inputLevel = Math.min(100, Math.round(rms * 300));

        // ── Display meter (post-RNNoise dBFS, -60…0dBFS → 0…100) ──────────────
        // ゲートのしきい値判定も同じ post-RNNoise 信号を使うため、
        // メーター上のバーとしきい値ラインが実際の動作と一致する。
        const meterDbFS = rms > 0 ? 20 * Math.log10(rms) : -96;
        this._meterLevel = Math.min(100, Math.max(0, Math.round((meterDbFS + 60) / 60 * 100)));
        this.emit(CallEvent.InputLevel, this._meterLevel);

        // ── Voice EQ (dynamic) ───────────────────────────────────────────────
        // EQ nodes are always in the chain; toggling is done by zeroing all gains.
        if (this.eqNodes.length > 0) {
            const eqEnabled = SettingsStore.getValue("nexus_voice_eq_enabled") ?? true;
            const eqMode = (SettingsStore.getValue("nexus_eq_mode") ?? "auto") as string;
            const simpleGains = (SettingsStore.getValue("nexus_eq_simple_gains") ?? [0, -3, 0, 2.5]) as number[];
            const customGains = (SettingsStore.getValue("nexus_eq_custom_gains") ?? [0, 0, 0, -3, 0, 0, 2.5, 0]) as number[];
            applyEqBands(this.eqNodes, eqEnabled, eqMode, simpleGains, customGains);
        }


        // ── NC Strength — DeepFilterNet3 suppression level + post-gate ──────────
        // DeepFilterNet3's attenuation limit is set directly from the NC strength slider.
        // The post-gate additionally cuts residual noise below the voice threshold.
        if (this.postNcGainNode && this.audioContext) {
            const ncEnabled = SettingsStore.getValue("nexus_noise_cancellation_enabled") ?? true;
            const ncStrength = SettingsStore.getValue("nexus_nc_strength") ?? 50;
            // Sync suppression level to DeepFilter AI (0-100 maps to dB attenuation limit)
            if (ncEnabled && this.ncNode && NexusVoiceConnection.deepfilterCore) {
                NexusVoiceConnection.deepfilterCore.setSuppressionLevel(ncStrength);
            }
            const postNcActive = ncEnabled && ncStrength > 0 && this.ncNode !== null;
            if (postNcActive) {
                const voiceDb = rms > 0 ? 20 * Math.log10(rms) : -96;
                // Map strength 0-100 → threshold -70 to -20 dBFS
                const openThresholdDb = -70 + (ncStrength / 100) * 50;
                const closeThresholdDb = openThresholdDb - 5; // 5dB hysteresis prevents rapid toggling
                const now = this.audioContext.currentTime;
                if (!this._postNcGateOpen && voiceDb >= openThresholdDb) {
                    // Gate opens instantly — the 50ms delayNode lookahead ensures the gate is
                    // fully open before the corresponding audio arrives, so no pop occurs.
                    // A soft ramp here would create audible waviness as voice amplitude fluctuates.
                    this._postNcGateOpen = true;
                    this.postNcGainNode.gain.cancelScheduledValues(now);
                    this.postNcGainNode.gain.setValueAtTime(1.0, now);
                } else if (this._postNcGateOpen && voiceDb < closeThresholdDb) {
                    // Gate closes with a short fade to avoid a click on release.
                    this._postNcGateOpen = false;
                    this.postNcGainNode.gain.cancelScheduledValues(now);
                    this.postNcGainNode.gain.linearRampToValueAtTime(0.0, now + 0.050);
                }
                // else: hysteresis zone — no change (do not reschedule ongoing ramp)
            } else {
                // NC off or strength=0 — bypass (pass through)
                this._postNcGateOpen = true;
                this.postNcGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                this.postNcGainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);
            }
        }

        // ── ローカル発話状態の即時更新（高速パス）──
        // pollActiveSpeakers() の 250ms ポーリングを待たずに、ローカルユーザーの
        // speaking 状態変化を 50ms 間隔（pollInputLevel の周期）で即座に emit する。
        const myUserId = this.client.getUserId();
        if (myUserId) {
            // _voiceGateOpen はゲート設定に関係なく常にVAD結果を反映する。
            const localSpeaking = !this._isMicMuted && this._voiceGateOpen;
            const wasSpeaking = this._activeSpeakers.has(myUserId);
            if (localSpeaking !== wasSpeaking) {
                const updated = new Set(this._activeSpeakers);
                if (localSpeaking) updated.add(myUserId);
                else updated.delete(myUserId);
                this._activeSpeakers = updated;
                this.emit(CallEvent.ActiveSpeakers, updated);
            }
        }

        // ── Voice gate / VAD ─────────────────────────────────────────────────
        // Mute handling is common to both Silero and RMS paths.
        if (this._isMicMuted) {
            if (this.voiceGateReleaseTimeout) {
                clearTimeout(this.voiceGateReleaseTimeout);
                this.voiceGateReleaseTimeout = null;
            }
            this._voiceGateOpen = false;
            this.voiceGateAttackCount = 0;
            return;
        }

        if (this.sileroVadActive) {
            // ── Silero ML VAD path ────────────────────────────────────────────
            // _voiceGateOpen and inputGainNode are managed by startSileroVAD() callbacks.
            // Here we only handle the !gateEnabled case (keep gate open) and fall through to AGC.
            const gateEnabled = SettingsStore.getValue("nexus_voice_gate_enabled");
            if (!gateEnabled) {
                if (this.inputGainNode && this.audioContext) {
                    const targetVol = (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
                    this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                    this.inputGainNode.gain.setValueAtTime(targetVol, this.audioContext.currentTime);
                }
                return;
            }
            // gateEnabled=true: Silero callbacks control everything — fall through to AGC
        } else {
            // ── RMS-based VAD (fallback when Silero is unavailable) ───────────
            const gateEnabled = SettingsStore.getValue("nexus_voice_gate_enabled");
            const voiceDb = rms > 0 ? 20 * Math.log10(rms) : -96;
            const sliderVal = SettingsStore.getValue("nexus_voice_gate_threshold") ?? 40;
            const openThresholdDb = (sliderVal / 100) * 60 - 60;
            const closeThresholdDb = openThresholdDb - NexusVoiceConnection.VOICE_GATE_HYSTERESIS_DB;

            if (voiceDb >= openThresholdDb) {
                this.voiceGateAttackCount++;
                if (this.voiceGateReleaseTimeout) {
                    clearTimeout(this.voiceGateReleaseTimeout);
                    this.voiceGateReleaseTimeout = null;
                }
                if (!this._voiceGateOpen && this.voiceGateAttackCount >= NexusVoiceConnection.VOICE_GATE_ATTACK_POLLS) {
                    this._voiceGateOpen = true;
                    this.broadcastSpeakingState(true);
                    if (gateEnabled && this.inputGainNode && this.audioContext) {
                        const targetVol = (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
                        const now = this.audioContext.currentTime;
                        this.inputGainNode.gain.cancelScheduledValues(now);
                        this.inputGainNode.gain.setValueAtTime(this.inputGainNode.gain.value, now);
                        this.inputGainNode.gain.linearRampToValueAtTime(targetVol, now + NexusVoiceConnection.VOICE_GATE_OPEN_RAMP_SEC);
                    }
                }
            } else if (voiceDb < closeThresholdDb) {
                this.voiceGateAttackCount = 0;
                if (this._voiceGateOpen && !this.voiceGateReleaseTimeout) {
                    this.voiceGateReleaseTimeout = setTimeout(() => {
                        this._voiceGateOpen = false;
                        this.broadcastSpeakingState(false);
                        if (gateEnabled && this.inputGainNode && this.audioContext && !this._isMicMuted) {
                            this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                            this.inputGainNode.gain.linearRampToValueAtTime(
                                0,
                                this.audioContext.currentTime + NexusVoiceConnection.VOICE_GATE_RAMP_SEC,
                            );
                        }
                        this.voiceGateReleaseTimeout = null;
                    }, NexusVoiceConnection.VOICE_GATE_RELEASE_MS);
                }
            } else {
                this.voiceGateAttackCount = 0;
                if (this._voiceGateOpen && this.voiceGateReleaseTimeout) {
                    clearTimeout(this.voiceGateReleaseTimeout);
                    this.voiceGateReleaseTimeout = null;
                }
            }

            if (!gateEnabled) {
                if (this.inputGainNode && this.audioContext) {
                    const targetVol = (SettingsStore.getValue("nexus_input_volume") ?? 100) / 100;
                    this.inputGainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
                    this.inputGainNode.gain.setValueAtTime(targetVol, this.audioContext.currentTime);
                }
                return;
            }
        }

        // ── VAD-gated AGC ──
        // Only adjust gain when voice gate is open (speaking detected).
        // Never adjust during silence to prevent background noise amplification.
        const agcEnabled = SettingsStore.getValue("nexus_voice_agc_enabled") ?? true;
        if (this.agcGainNode && this.audioContext) {
            if (agcEnabled && this._voiceGateOpen && !this._isMicMuted) {
                const target = NexusVoiceConnection.AGC_TARGET_RMS;
                if (this._inputLevel > 5) { // Only adjust on meaningful signal
                    const ratio = target / Math.max(1, this._inputLevel);
                    // Smoothly approach the desired gain
                    const desiredGain = this.agcCurrentGain * ratio;
                    const clamped = Math.max(
                        NexusVoiceConnection.AGC_MIN_GAIN,
                        Math.min(NexusVoiceConnection.AGC_MAX_GAIN, desiredGain),
                    );
                    // Exponential smoothing — only move a fraction toward the target per cycle
                    this.agcCurrentGain += (clamped - this.agcCurrentGain) * NexusVoiceConnection.AGC_ADJUSTMENT_RATE;
                    this.agcGainNode.gain.exponentialRampToValueAtTime(
                        Math.max(0.01, this.agcCurrentGain), // exponentialRamp requires > 0
                        this.audioContext.currentTime + 0.05,
                    );
                }
            } else if (!agcEnabled && this.agcCurrentGain !== 1.0) {
                // AGC disabled — reset to unity gain
                this.agcCurrentGain = 1.0;
                this.agcGainNode.gain.setValueAtTime(1.0, this.audioContext.currentTime);
            }
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
        this.stopSileroVAD();
        this.remoteSpeakingStates.clear();
        if (this.participantRetryTimer) {
            clearInterval(this.participantRetryTimer);
            this.participantRetryTimer = null;
        }

        // Close audio pipeline
        this.sourceNode = null;
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        this.analyserNode = null;
        this.inputGainNode = null;
        this.highPassFilter = null;
        if (this.delayNode) {
            this.delayNode.disconnect();
            this.delayNode = null;
        }
        if (this.ncNode) {
            this.ncNode.disconnect();
            this.ncNode = null;
        }
        this._postNcGateOpen = false;
        this.eqNodes = [];
        this.compressorNode = null;
        this.agcGainNode = null;
        this.agcCurrentGain = 1.0;
        this._inputLevel = 0;
        this._meterLevel = 0;
        this.analyserBuffer = null;
        this.postNcGainNode?.disconnect();
        this.postNcGainNode = null;
        this.monitorGainNode?.disconnect();
        this.monitorGainNode = null;
        this._voiceGateOpen = true;
        this.voiceGateAttackCount = 0;

        // Clean up output <audio> elements
        for (const audio of this.outputAudioElements.values()) {
            audio.pause();
            audio.srcObject = null;
        }
        this.outputAudioElements.clear();
        this._masterOutputVolume = 0;

        // Clean up Tauri output audio pipeline (sources/gains first, then master)
        for (const source of this.outputMediaSources.values()) source.disconnect();
        this.outputMediaSources.clear();
        for (const analyser of this.outputParticipantAnalysers.values()) analyser.disconnect();
        this.outputParticipantAnalysers.clear();
        for (const gain of this.outputParticipantGains.values()) gain.disconnect();
        this.outputParticipantGains.clear();

        // Clean up screen share elements + Web Audio nodes
        for (const timer of this.pendingScreenShareTimers.values()) clearTimeout(timer);
        this.pendingScreenShareTimers.clear();
        for (const source of this.screenShareSources.values()) source.disconnect();
        this.screenShareSources.clear();
        for (const gain of this.screenShareGains.values()) gain.disconnect();
        this.screenShareGains.clear();
        this.screenShareVideoElements.clear();
        this.watchingScreenShares.clear();

        // Now safe to disconnect master gain and close context
        if (this.outputMasterGain) {
            this.outputMasterGain.disconnect();
            this.outputMasterGain = null;
        }
        if (this.outputAudioContext) {
            this.outputAudioContext.close().catch(() => {});
            this.outputAudioContext = null;
        }

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
        // Clean up native capture (fire-and-forget — unlisten + stop Rust side + JS nodes)
        if (this._isNativeCapture) {
            void this.cleanupNativeCapture();
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
            this.livekitRoom.off(LivekitRoomEvent.ParticipantConnected, this.onParticipantConnected);
            this.livekitRoom.off(LivekitRoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
            this.livekitRoom.off(LivekitRoomEvent.DataReceived, this.onDataReceived);
            this.livekitRoom.off(LivekitRoomEvent.Reconnecting, this.onLivekitReconnecting);
            this.livekitRoom.off(LivekitRoomEvent.Reconnected, this.onLivekitReconnected);
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
     * TrackMuted fires for BOTH local and remote tracks.
     * We only mute/unmute <audio> elements for remote participants.
     * Note: updateParticipants() is NOT called here — mute state is tracked
     * separately via data messages and pollActiveSpeakers(), and the
     * participant set does not change on mute/unmute.
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
                // Ensure the output AudioContext is running — on first app launch it may
                // still be suspended when the first track arrives.
                if (this.outputAudioContext.state === "suspended") {
                    this.outputAudioContext.resume().catch(() => {});
                }
                // Evict stale nodes for this participant (e.g. after LiveKit reconnect
                // where onTrackUnsubscribed may not have fired). Without this cleanup,
                // old nodes stay connected to outputMasterGain, causing double audio,
                // phase interference, or mono/left-only output.
                const staleSource = this.outputMediaSources.get(participant.identity);
                if (staleSource) {
                    staleSource.disconnect();
                    this.outputMediaSources.delete(participant.identity);
                    this.outputParticipantAnalysers.get(participant.identity)?.disconnect();
                    this.outputParticipantAnalysers.delete(participant.identity);
                    this.outputParticipantGains.get(participant.identity)?.disconnect();
                    this.outputParticipantGains.delete(participant.identity);
                }
                const staleAudio = this.outputAudioElements.get(participant.identity);
                if (staleAudio) {
                    staleAudio.pause();
                    staleAudio.srcObject = null;
                    this.outputAudioElements.delete(participant.identity);
                }

                const source = this.outputAudioContext.createMediaStreamSource(
                    audio.srcObject as MediaStream,
                );
                // AnalyserNode for low-latency speaking detection (bypasses LiveKit's ~1s stats cycle)
                const analyser = this.outputAudioContext.createAnalyser();
                analyser.fftSize = 256;
                const gain = this.outputAudioContext.createGain();
                gain.gain.value = initialVol;
                // Force stereo — without explicit channelCount the gain node collapses to
                // mono when the source track is mono (Opus 1ch), causing left-only output.
                gain.channelCount = 2;
                gain.channelCountMode = "explicit";
                gain.channelInterpretation = "speakers";
                // Analyser as side-tap (not in main chain) — if analyser sits between
                // source and gain it acts as a mono pass-through (Opus 1ch source →
                // analyser with default channelCountMode="max" → 1ch → gain sees 1ch
                // and outputs left-only even with channelCount=2).
                source.connect(analyser);
                source.connect(gain).connect(this.outputMasterGain);
                this.outputMediaSources.set(participant.identity, source);
                this.outputParticipantAnalysers.set(participant.identity, analyser);
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
            // Clean up Web Audio nodes (Tauri)
            this.screenShareSources.get(participant.identity)?.disconnect();
            this.screenShareSources.delete(participant.identity);
            this.screenShareGains.get(participant.identity)?.disconnect();
            this.screenShareGains.delete(participant.identity);
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
        this.outputParticipantAnalysers.get(participant.identity)?.disconnect();
        this.outputParticipantAnalysers.delete(participant.identity);
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

    // ActiveSpeakersChanged event handler removed — speaker detection is
    // handled solely by pollActiveSpeakers() (250ms) and the local fast
    // path in pollInputLevel() (50ms). The event handler emitted without
    // change checks and was immediately overwritten by the next poll cycle.

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
        // _voiceGateOpen はゲート設定に関係なく常にVAD結果を反映する。
        const localSpeaking = !this._isMicMuted && this._voiceGateOpen;
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
        // Tauri: read AnalyserNode waveform directly — zero-lag, no LiveKit stats cycle dependency.
        // Browser fallback: participant.audioLevel > 0.
        for (const participant of this.livekitRoom.remoteParticipants.values()) {
            const userId = this.resolveIdentityToUserId(participant.identity);
            if (!userId) continue;

            const analyser = this.outputParticipantAnalysers.get(participant.identity);
            let isSpeaking: boolean;
            const dataSpeak = this.remoteSpeakingStates.get(participant.identity);
            if (dataSpeak !== undefined) {
                // Prefer data-message speaking state (ML VAD result from sender)
                isSpeaking = dataSpeak;
            } else if (analyser) {
                // Fallback: RMS threshold for participants without data-message support
                analyser.getByteTimeDomainData(this.outputAnalyserBuffer);
                let outSum = 0;
                for (const v of this.outputAnalyserBuffer) {
                    const s = (v - 128) / 128;
                    outSum += s * s;
                }
                isSpeaking = Math.sqrt(outSum / this.outputAnalyserBuffer.length) > 0.007;
            } else {
                isSpeaking = participant.audioLevel > 0;
            }
            if (isSpeaking) {
                speakingUserIds.add(userId);
            }

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
        this.remoteSpeakingStates.delete(participant.identity);
        this.updateParticipants();
        const newCount = this._participants.size;

        // Play leave SE — LiveKit fires before MatrixRTC so this is the
        // reliable trigger point for remote participant leave sounds.
        if (this.connected && !this._suppressMembershipSounds && newCount < prevCount && newCount > 0) {
            playVcSound(VC_LEAVE_SOUND);
        }

        this.updateScreenShares();
    };

    // ─── Private: LiveKit reconnect ───────────────────────────

    private onLivekitReconnecting = (): void => {
        logger.warn("LiveKit: 再接続中...");
    };

    private onLivekitReconnected = (): void => {
        logger.warn("LiveKit: 再接続成功");
        void this.broadcastMuteState(this._isMicMuted);
    };

    // ─── Private: Data-channel mute signaling ─────────────────

    private static readonly MUTE_TOPIC = "nexus-mute";
    private static readonly SPEAKING_TOPIC = "nexus-speaking";

    private broadcastMuteState(muted: boolean): void {
        if (!this.livekitRoom?.localParticipant) return;
        const payload = new TextEncoder().encode(JSON.stringify({ m: muted }));
        this.livekitRoom.localParticipant
            .publishData(payload, { reliable: true, topic: NexusVoiceConnection.MUTE_TOPIC })
            .catch((e) => logger.warn("Failed to broadcast mute state", e));
    }

    private broadcastSpeakingState(speaking: boolean): void {
        if (!this.livekitRoom?.localParticipant) return;
        const payload = new TextEncoder().encode(JSON.stringify({ s: speaking }));
        this.livekitRoom.localParticipant
            .publishData(payload, { reliable: true, topic: NexusVoiceConnection.SPEAKING_TOPIC })
            .catch((e) => logger.warn("Failed to broadcast speaking state", e));
    }

    private onDataReceived = (
        payload: Uint8Array,
        participant?: Participant,
        _kind?: unknown,
        topic?: string,
    ): void => {
        if (!participant) return;
        try {
            const data = JSON.parse(new TextDecoder().decode(payload));
            if (topic === NexusVoiceConnection.SPEAKING_TOPIC) {
                if (typeof data.s === "boolean") {
                    this.remoteSpeakingStates.set(participant.identity, data.s);
                }
            } else if (topic === NexusVoiceConnection.MUTE_TOPIC) {
                if (typeof data.m === "boolean") {
                    this.remoteMuteStates.set(participant.identity, data.m);
                }
            }
        } catch {
            // ignore malformed data
        }
    };

    private onMembershipsChanged = (): void => {
        this.updateParticipants();
        const newCount = this._participants.size;

        // SE is NOT played here — LiveKit ParticipantConnected/Disconnected
        // fires first and is the sole trigger for join/leave sounds.
        // Playing here too would cause double SE playback.

        // If connected but memberships dropped to 0, MatrixRTC may be
        // re-joining (force re-join on "Missing own membership"). Retry
        // to pick up the re-sent state event once the next sync arrives.
        if (this.connected && newCount === 0) {
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
            // Access the underlying RTCPeerConnections via LiveKit's engine.
            // Try subscriber first (has stats when receiving remote tracks),
            // fall back to publisher (always available when connected).
            const pcManager = (this.livekitRoom as any).engine?.pcManager;
            const pcs: RTCPeerConnection[] = [];
            if (pcManager?.subscriber?.pc) pcs.push(pcManager.subscriber.pc);
            if (pcManager?.publisher?.pc) pcs.push(pcManager.publisher.pc);

            for (const pc of pcs) {
                const stats = await pc.getStats();
                for (const report of stats.values()) {
                    if (report.type === "candidate-pair" && report.state === "succeeded") {
                        this._latencyMs =
                            typeof report.currentRoundTripTime === "number"
                                ? Math.round(report.currentRoundTripTime * 1000)
                                : null;
                        if (this._latencyMs !== null) return;
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
