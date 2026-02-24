/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Native capture pipeline: converts Rust-side DXGI/WASAPI capture data
 * (received as Tauri events) into MediaStreamTracks for LiveKit publishing.
 *
 * Video: JPEG frames → createImageBitmap → OffscreenCanvas → captureStream()
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
 * an OffscreenCanvas, and exposes a captureStream() MediaStream.
 */
export class NativeVideoCaptureStream {
    private canvas: OffscreenCanvas;
    private ctx: OffscreenCanvasRenderingContext2D;
    private stream: MediaStream;
    private unlisten: (() => void) | null = null;
    private stopped = false;

    constructor(initialWidth: number, initialHeight: number, fps: number) {
        this.canvas = new OffscreenCanvas(initialWidth || 1920, initialHeight || 1080);
        this.ctx = this.canvas.getContext("2d")!;
        // captureStream with target fps
        this.stream = (this.canvas as any).captureStream(fps) as MediaStream;
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
    }
}

// ─── Audio capture stream ───────────────────────────────────────────

/**
 * Receives interleaved f32 PCM from Rust via Tauri events and writes
 * them into a MediaStreamTrack using a ScriptProcessorNode ring buffer.
 *
 * We use ScriptProcessorNode instead of MediaStreamTrackGenerator because
 * the latter is not widely available in WebView2/Chromium yet.
 */
export class NativeAudioCaptureStream {
    private audioContext: AudioContext;
    private scriptProcessor: ScriptProcessorNode;
    private destination: MediaStreamAudioDestinationNode;
    private ringBuffer: Float32Array;
    private writePos = 0;
    private readPos = 0;
    private bufferSize: number;
    private unlisten: (() => void) | null = null;
    private stopped = false;

    constructor(sampleRate = 48000, channels = 2) {
        this.audioContext = new AudioContext({ sampleRate });
        // Ring buffer: 1 second of audio
        this.bufferSize = sampleRate * channels;
        this.ringBuffer = new Float32Array(this.bufferSize);

        // ScriptProcessorNode: 4096 samples buffer, input channels, output channels
        this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 0, channels);
        this.destination = this.audioContext.createMediaStreamDestination();

        this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
            this.fillOutputBuffer(e);
        };

        this.scriptProcessor.connect(this.destination);
    }

    async start(): Promise<void> {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<AudioPayload>("capture-audio", (event) => {
            if (this.stopped) return;
            this.writeAudioData(event.payload);
        });
        this.unlisten = unlisten;

        // Resume AudioContext (may be suspended without user gesture)
        if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
        }
    }

    private writeAudioData(payload: AudioPayload): void {
        const data = payload.data;
        for (let i = 0; i < data.length; i++) {
            this.ringBuffer[this.writePos] = data[i];
            this.writePos = (this.writePos + 1) % this.bufferSize;
        }
    }

    private fillOutputBuffer(e: AudioProcessingEvent): void {
        const outputBuffer = e.outputBuffer;
        const framesNeeded = outputBuffer.length;
        const channels = outputBuffer.numberOfChannels;

        for (let frame = 0; frame < framesNeeded; frame++) {
            for (let ch = 0; ch < channels; ch++) {
                const channelData = outputBuffer.getChannelData(ch);
                // Read interleaved: sample index = frame * totalChannels + channel
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
        this.scriptProcessor.disconnect();
        this.destination.disconnect();
        this.audioContext.close().catch(() => {});
        for (const track of this.destination.stream.getTracks()) {
            track.stop();
        }
    }
}
