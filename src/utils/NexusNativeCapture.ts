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

// MediaStreamTrackGenerator type (non-standard, available in Chromium 94+)
interface MediaStreamTrackGeneratorInit {
    kind: "audio" | "video";
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
    constructor(init: MediaStreamTrackGeneratorInit);
    readonly writable: WritableStream<AudioData>;
}

/**
 * Receives interleaved f32 PCM from Rust via Tauri events and writes
 * them directly into a MediaStreamTrack via MediaStreamTrackGenerator.
 *
 * This bypasses Web Audio entirely (no ring buffer, no ScriptProcessorNode),
 * giving near-zero latency between WASAPI capture and LiveKit publishing.
 * The previous ScriptProcessorNode approach added ~85ms of fixed delay
 * (4096-sample buffer at 48kHz) that caused A/V desync.
 */
export class NativeAudioCaptureStream {
    private generator: MediaStreamTrackGenerator;
    private writer: WritableStreamDefaultWriter<AudioData>;
    private sampleRate: number;
    private channels: number;
    private totalFramesWritten = 0;
    private unlisten: (() => void) | null = null;
    private stopped = false;
    private dataReceived = false;

    constructor(_audioContext: AudioContext, sampleRate = 48000, channels = 2) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.generator = new MediaStreamTrackGenerator({ kind: "audio" });
        this.writer = this.generator.writable.getWriter();
        logger.info(`Audio capture: using MediaStreamTrackGenerator, ${sampleRate}Hz ${channels}ch`);
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
    }

    private writeAudioData(payload: AudioPayload): void {
        const { data, frames } = payload;
        if (frames === 0) return;

        // Timestamp in microseconds, monotonically increasing based on sample count
        const timestamp = (this.totalFramesWritten / this.sampleRate) * 1_000_000;
        this.totalFramesWritten += frames;

        // Create AudioData from interleaved f32 PCM and write to generator
        const audioData = new AudioData({
            format: "f32",  // interleaved Float32 (matches WASAPI output)
            sampleRate: this.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: this.channels,
            timestamp,
            data: new Float32Array(data),
        });

        this.writer.write(audioData).catch(() => {});
    }

    getAudioTrack(): MediaStreamTrack | null {
        return this.generator;
    }

    stop(): void {
        this.stopped = true;
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }
        this.writer.close().catch(() => {});
        this.generator.stop();
    }
}
