/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Native capture pipeline: converts Rust-side DXGI/WASAPI capture data
 * (received as Tauri events) into MediaStreamTracks for LiveKit publishing.
 *
 * Video: JPEG frames → createImageBitmap → HTMLCanvasElement → captureStream()
 * Audio: f32 PCM → AudioWorklet (ScriptProcessorNode fallback) → MediaStream
 */

import { logger as rootLogger } from "matrix-js-sdk/src/logger";

const logger = rootLogger.getChild("NexusNativeCapture");

// ─── Tauri event payload types ──────────────────────────────────────

interface FramePayload {
    data: string; // base64 JPEG
    width: number;
    height: number;
    timestamp: number; // ms since epoch
}

interface AudioPayload {
    data: number[]; // interleaved f32 PCM
    sample_rate: number;
    channels: number;
    frames: number;
}

// ─── Video capture stream ───────────────────────────────────────────

/**
 * Receives JPEG frames from Rust via Tauri events, decodes them onto
 * a hidden HTMLCanvasElement, and exposes a captureStream() MediaStream.
 *
 * We use HTMLCanvasElement instead of OffscreenCanvas because
 * OffscreenCanvas.captureStream() is not available in WebView2.
 */
export class NativeVideoCaptureStream {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private stream: MediaStream;
    private unlisten: (() => void) | null = null;
    private stopped = false;

    constructor(initialWidth: number, initialHeight: number, fps: number) {
        this.canvas = document.createElement("canvas");
        this.canvas.width = initialWidth || 1920;
        this.canvas.height = initialHeight || 1080;
        this.canvas.style.display = "none";
        document.body.appendChild(this.canvas);
        this.ctx = this.canvas.getContext("2d")!;
        this.stream = this.canvas.captureStream(fps);
    }

    async start(): Promise<void> {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<FramePayload>("capture-frame", async (event) => {
            if (this.stopped) return;
            try {
                await this.renderFrame(event.payload);
            } catch (e) {
                logger.warn("Failed to render capture frame", e);
            }
        });
        this.unlisten = unlisten;
    }

    private async renderFrame(payload: FramePayload): Promise<void> {
        // Decode base64 → binary
        const binary = atob(payload.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        // Decode JPEG → ImageBitmap
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);

        // Resize canvas if dimensions changed
        if (this.canvas.width !== payload.width || this.canvas.height !== payload.height) {
            this.canvas.width = payload.width;
            this.canvas.height = payload.height;
        }

        // Draw to canvas
        this.ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
    }

    getVideoTrack(): MediaStreamTrack | null {
        const tracks = this.stream.getVideoTracks();
        return tracks.length > 0 ? tracks[0] : null;
    }

    stop(): void {
        this.stopped = true;
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }
        for (const track of this.stream.getTracks()) {
            track.stop();
        }
        this.canvas.remove();
    }
}

// ─── Audio capture stream ───────────────────────────────────────────

/**
 * Receives interleaved f32 PCM from Rust via Tauri events and writes
 * them into a MediaStreamTrack using a ScriptProcessorNode ring buffer.
 *
 * We use ScriptProcessorNode instead of MediaStreamTrackGenerator because
 * the latter is not widely available in WebView2/Chromium yet.
 *
 * Accepts an **external** AudioContext (created during a user gesture in
 * NexusVoiceConnection.connect()) so that the context is guaranteed to be
 * in "running" state.  The caller owns the AudioContext lifecycle — this
 * class only creates disposable nodes on it.
 */
export class NativeAudioCaptureStream {
    private audioContext: AudioContext;
    private scriptProcessor: ScriptProcessorNode;
    private silentSource: ConstantSourceNode;
    private destination: MediaStreamAudioDestinationNode;
    private ringBuffer: Float32Array;
    private writePos = 0;
    private readPos = 0;
    private bufferSize: number;
    private channelCount: number;
    private unlisten: (() => void) | null = null;
    private stopped = false;
    private dataReceived = false;
    /** Number of unread samples available in the ring buffer. */
    private available = 0;

    constructor(audioContext: AudioContext, sampleRate = 48000, channels = 2) {
        this.channelCount = channels;
        this.audioContext = audioContext;
        // Ring buffer: 2 seconds of audio (interleaved) at the context's sample rate.
        // Use a generous buffer to handle jitter between WASAPI and ScriptProcessorNode.
        const actualRate = this.audioContext.sampleRate;
        logger.info(`Audio capture: AudioContext sampleRate=${actualRate}, WASAPI=${sampleRate}`);
        this.bufferSize = actualRate * channels * 2;
        this.ringBuffer = new Float32Array(this.bufferSize);

        // ScriptProcessorNode needs an active input to fire onaudioprocess in WebView2.
        // Use a ConstantSourceNode (DC 0) — no frequency component, zero noise.
        this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, channels);
        this.destination = this.audioContext.createMediaStreamDestination();

        this.silentSource = this.audioContext.createConstantSource();
        this.silentSource.offset.value = 0;
        this.silentSource.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.destination);
        this.silentSource.start();

        this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
            this.fillOutputBuffer(e);
        };
    }

    async start(): Promise<void> {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<AudioPayload>("capture-audio", (event) => {
            if (this.stopped) return;
            if (!this.dataReceived) {
                this.dataReceived = true;
                logger.info("First audio chunk received from WASAPI");
            }
            this.writeAudioData(event.payload);
        });
        this.unlisten = unlisten;
        logger.info(`Audio capture AudioContext state: ${this.audioContext.state}`);
    }

    private writeAudioData(payload: AudioPayload): void {
        const data = payload.data;
        for (let i = 0; i < data.length; i++) {
            this.ringBuffer[this.writePos] = data[i];
            this.writePos = (this.writePos + 1) % this.bufferSize;
        }
        this.available = Math.min(this.available + data.length, this.bufferSize);
    }

    private fillOutputBuffer(e: AudioProcessingEvent): void {
        const outputBuffer = e.outputBuffer;
        const framesNeeded = outputBuffer.length;
        const channels = outputBuffer.numberOfChannels;
        const samplesNeeded = framesNeeded * channels;

        // If not enough data in ring buffer, output silence to avoid noise
        if (this.available < samplesNeeded) {
            for (let ch = 0; ch < channels; ch++) {
                const channelData = outputBuffer.getChannelData(ch);
                for (let frame = 0; frame < framesNeeded; frame++) {
                    channelData[frame] = 0;
                }
            }
            return;
        }

        this.available -= samplesNeeded;

        for (let frame = 0; frame < framesNeeded; frame++) {
            for (let ch = 0; ch < channels; ch++) {
                const channelData = outputBuffer.getChannelData(ch);
                channelData[frame] = this.ringBuffer[this.readPos];
                this.readPos = (this.readPos + 1) % this.bufferSize;
            }
        }
    }

    getAudioTrack(): MediaStreamTrack | null {
        const tracks = this.destination.stream.getAudioTracks();
        return tracks.length > 0 ? tracks[0] : null;
    }

    stop(): void {
        this.stopped = true;
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }
        this.silentSource.stop();
        this.silentSource.disconnect();
        this.scriptProcessor.disconnect();
        this.destination.disconnect();
        // AudioContext is externally owned — do NOT close it here.
        for (const track of this.destination.stream.getTracks()) {
            track.stop();
        }
    }
}
