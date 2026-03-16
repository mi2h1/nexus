/*
Copyright 2024 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.
Copyright 2019 New Vector Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useState, useCallback, useRef, useEffect, useId, Fragment } from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { type EmptyObject } from "matrix-js-sdk/src/matrix";
import { Form, SettingsToggleInput, ToggleInput, InlineField, HelpMessage, Label } from "@vector-im/compound-web";
import { HelpIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../../../../languageHandler";
import MediaDeviceHandler, { type IMediaDevices, MediaDeviceKindEnum } from "../../../../../MediaDeviceHandler";
import AccessibleButton from "../../../elements/AccessibleButton";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import { requestMediaPermissions } from "../../../../../utils/media/requestMediaPermissions";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection } from "../../shared/SettingsSubsection";
import MatrixClientContext from "../../../../../contexts/MatrixClientContext";
import SettingsStore from "../../../../../settings/SettingsStore";
import { useNexusVoice } from "../../../../../hooks/useNexusVoice";
import { NexusVoiceConnection, type StandaloneMonitorHandle, EQ_SIMPLE_FREQS, EQ_CUSTOM_FREQS } from "../../../../../models/NexusVoiceConnection";
import { CallEvent } from "../../../../../models/Call";

interface IState {
    mediaDevices: IMediaDevices | null;
    [MediaDeviceKindEnum.AudioOutput]: string | null;
    [MediaDeviceKindEnum.AudioInput]: string | null;
    [MediaDeviceKindEnum.VideoInput]: string | null;
    audioAutoGainControl: boolean;
    audioEchoCancellation: boolean;
    audioNoiseSuppression: boolean;
}

/**
 * Maps deviceKind to the right get method on MediaDeviceHandler
 * Helpful for setting state
 */
const mapDeviceKindToHandlerValue = (deviceKind: MediaDeviceKindEnum): string | null => {
    switch (deviceKind) {
        case MediaDeviceKindEnum.AudioOutput:
            return MediaDeviceHandler.getAudioOutput();
        case MediaDeviceKindEnum.AudioInput:
            return MediaDeviceHandler.getAudioInput();
        case MediaDeviceKindEnum.VideoInput:
            return MediaDeviceHandler.getVideoInput();
    }
};

/** Mic volume slider (functional component for hook access). */
function NexusInputVolume(): JSX.Element {
    const { connection } = useNexusVoice();
    const [inputVolume, setInputVolume] = useState<number>(
        () => SettingsStore.getValue("nexus_input_volume") ?? 100,
    );

    const onChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = Number(e.target.value);
            setInputVolume(val);
            SettingsStore.setValue("nexus_input_volume", null, SettingLevel.DEVICE, val);
            connection?.setInputVolume(val);
        },
        [connection],
    );

    return (
        <div className="nx_VoiceSettings_slider">
            <label htmlFor="nx-input-volume">マイク音量</label>
            <div className="nx_VoiceSettings_sliderRow">
                <input
                    id="nx-input-volume"
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={inputVolume}
                    style={sliderFill(inputVolume, 0, 200)}
                    onChange={onChange}
                />
                <span className="nx_VoiceSettings_sliderValue">{inputVolume}%</span>
            </div>
        </div>
    );
}

/** Speaker volume slider (functional component for hook access). */
function NexusOutputVolume(): JSX.Element {
    const { connection } = useNexusVoice();
    const [outputVolume, setOutputVolume] = useState<number>(
        () => SettingsStore.getValue("nexus_output_volume") ?? 100,
    );

    const onChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = Number(e.target.value);
            setOutputVolume(val);
            SettingsStore.setValue("nexus_output_volume", null, SettingLevel.DEVICE, val);
            connection?.setMasterOutputVolume(val);
        },
        [connection],
    );

    return (
        <div className="nx_VoiceSettings_slider">
            <label htmlFor="nx-output-volume">スピーカー音量</label>
            <div className="nx_VoiceSettings_sliderRow">
                <input
                    id="nx-output-volume"
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={outputVolume}
                    style={sliderFill(outputVolume, 0, 200)}
                    onChange={onChange}
                />
                <span className="nx_VoiceSettings_sliderValue">{outputVolume}%</span>
            </div>
        </div>
    );
}

/**
 * Standalone mic input level monitor for settings page.
 * When not in a VC, opens its own getUserMedia stream + AnalyserNode
 * so the level meter works without an active voice connection.
 * When a VC connection exists, returns the connection's inputLevel instead.
 */
function useSettingsInputLevel(connection: NexusVoiceConnection | null): number {
    const [level, setLevel] = useState(0);
    const cleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        // If connected to a VC, don't run standalone monitoring
        if (connection) {
            // Clean up standalone resources if they exist
            cleanupRef.current?.();
            cleanupRef.current = null;
            return;
        }

        let cancelled = false;
        let audioCtx: AudioContext | null = null;
        let stream: MediaStream | null = null;
        let timer: ReturnType<typeof setInterval> | null = null;

        const start = async (): Promise<void> => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 },
                });
                if (cancelled) {
                    stream.getTracks().forEach((t) => t.stop());
                    return;
                }

                audioCtx = new AudioContext();
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);

                const dataArray = new Uint8Array(analyser.fftSize);

                timer = setInterval(() => {
                    analyser.getByteTimeDomainData(dataArray);
                    let sum = 0;
                    for (const s of dataArray) {
                        const n = (s - 128) / 128;
                        sum += n * n;
                    }
                    const rms = Math.sqrt(sum / dataArray.length);
                    const dBFS = rms > 0 ? 20 * Math.log10(rms) : -96;
                    setLevel(Math.min(100, Math.max(0, Math.round((dBFS + 60) / 60 * 100))));
                }, 50);
            } catch {
                // getUserMedia denied or unavailable — level stays at 0
            }
        };

        start();

        const cleanup = (): void => {
            cancelled = true;
            if (timer) clearInterval(timer);
            stream?.getTracks().forEach((t) => t.stop());
            audioCtx?.close().catch(() => {});
            setLevel(0);
        };
        cleanupRef.current = cleanup;

        return cleanup;
    }, [connection]);

    // When connected, subscribe to the connection's InputLevel event
    useEffect(() => {
        if (!connection) return;

        const onInputLevel = (l: number): void => setLevel(l);
        connection.on(CallEvent.InputLevel, onInputLevel);
        return () => {
            connection.off(CallEvent.InputLevel, onInputLevel);
        };
    }, [connection]);

    return level;
}

/** Voice gate / input sensitivity settings (functional component for hook access). */
function NexusVoiceGateSettings(): JSX.Element {
    const { connection } = useNexusVoice();
    const inputLevel = useSettingsInputLevel(connection);

    const [gateEnabled, setGateEnabled] = useState<boolean>(
        () => SettingsStore.getValue("nexus_voice_gate_enabled") ?? false,
    );
    const [gateThreshold, setGateThreshold] = useState<number>(
        () => SettingsStore.getValue("nexus_voice_gate_threshold") ?? 40,
    );

    const levelBarRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (levelBarRef.current) {
            levelBarRef.current.style.width = `${inputLevel}%`;
        }
    }, [inputLevel]);

    const onGateEnabledChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const enabled = e.target.checked;
            setGateEnabled(enabled);
            SettingsStore.setValue("nexus_voice_gate_enabled", null, SettingLevel.DEVICE, enabled);
        },
        [],
    );

    const onGateThresholdChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = Number(e.target.value);
            setGateThreshold(val);
            SettingsStore.setValue("nexus_voice_gate_threshold", null, SettingLevel.DEVICE, val);
        },
        [],
    );

    return (
        <SettingsSubsection heading="入力感度" stretchContent>
            <SettingsToggleInput
                name="nx-voice-gate"
                label="入力感度（ボイスゲート）を有効にする"
                helpMessage="閾値以下の音声を自動でミュートし、背景ノイズを抑制します"
                checked={gateEnabled}
                onChange={onGateEnabledChange}
            />
            {gateEnabled && (
                <div className="nx_VoiceSettings_slider">
                    <label htmlFor="nx-gate-threshold">閾値</label>
                    <div className="nx_VoiceSettings_sliderRow">
                        <input
                            id="nx-gate-threshold"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={gateThreshold}
                            style={sliderFill(gateThreshold, 0, 100)}
                            onChange={onGateThresholdChange}
                        />
                        <span className="nx_VoiceSettings_sliderValue">{gateThreshold}</span>
                    </div>
                </div>
            )}
            <div className="nx_VoiceSettings_levelMeter">
                <span className="nx_VoiceSettings_levelMeterLabel">入力レベル</span>
                <div className="nx_VoiceSettings_levelMeter_track">
                    <div
                        ref={levelBarRef}
                        className="nx_VoiceSettings_levelMeter_bar"
                        style={{ width: `${inputLevel}%` }}
                    />
                    {gateEnabled && (
                        <div
                            className="nx_VoiceSettings_levelMeter_threshold"
                            style={{ left: `${gateThreshold}%` }}
                        />
                    )}
                </div>
            </div>
        </SettingsSubsection>
    );
}

// Number of bars in the VU meter
const VU_BAR_COUNT = 64;

/** Compute inline style for a range input: fills left of thumb with accent color. */
function sliderFill(value: number, min: number, max: number): React.CSSProperties {
    const pct = Math.round(((value - min) / (max - min)) * 100);
    return { "--nx-slider-fill": `${pct}%` } as React.CSSProperties;
}

/** Mic monitor — routes processed audio to local speakers for self-monitoring. */
function NexusMicMonitorSettings(): JSX.Element {
    const { connection } = useNexusVoice();
    const inputLevel = useSettingsInputLevel(connection);
    const [monitorEnabled, setMonitorEnabled] = useState<boolean>(false);
    const [monitorVolume, setMonitorVolume] = useState<number>(
        () => SettingsStore.getValue("nexus_mic_monitor_volume") ?? 30,
    );

    // Standalone pipeline handle (used when not in VC)
    const standaloneRef = useRef<StandaloneMonitorHandle | null>(null);

    const stopStandalone = useCallback((): void => {
        standaloneRef.current?.stop();
        standaloneRef.current = null;
    }, []);

    const startStandalone = useCallback(async (volume: number): Promise<void> => {
        stopStandalone();
        standaloneRef.current = await NexusVoiceConnection.createStandaloneMonitor(volume);
    }, [stopStandalone]);

    // Forced off when component unmounts (settings tab closes)
    useEffect(() => {
        return () => {
            SettingsStore.setValue("nexus_mic_monitor_enabled", null, SettingLevel.DEVICE, false);
            connection?.setMicMonitor(false, 0);
            stopStandalone();
        };
    }, [connection, stopStandalone]);

    const onMonitorClick = useCallback(async () => {
        const enabled = !monitorEnabled;
        setMonitorEnabled(enabled);
        SettingsStore.setValue("nexus_mic_monitor_enabled", null, SettingLevel.DEVICE, enabled);
        if (connection) {
            connection.setMicMonitor(enabled, monitorVolume);
        } else if (enabled) {
            await startStandalone(monitorVolume);
        } else {
            stopStandalone();
        }
    }, [connection, monitorEnabled, monitorVolume, startStandalone, stopStandalone]);

    const onMonitorVolumeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const vol = Number(e.target.value);
            setMonitorVolume(vol);
            SettingsStore.setValue("nexus_mic_monitor_volume", null, SettingLevel.DEVICE, vol);
            if (connection) {
                if (monitorEnabled) connection.setMicMonitor(true, vol);
            } else {
                standaloneRef.current?.setVolume(vol);
            }
        },
        [connection, monitorEnabled],
    );

    return (
        <div className="nx_VoiceSettings_micMonitor">
            <div className="nx_VoiceSettings_micMonitorRow">
                <AccessibleButton
                    onClick={onMonitorClick}
                    kind="primary"
                    className="nx_VoiceSettings_micMonitorBtn"
                >
                    {monitorEnabled ? "テストを停止" : "マイクテスト"}
                </AccessibleButton>
                <div className="nx_VoiceSettings_barMeter" aria-hidden="true">
                    {Array.from({ length: VU_BAR_COUNT }, (_, i) => {
                        const level = monitorEnabled ? inputLevel : 0;
                        const litCount = Math.round((level / 100) * VU_BAR_COUNT);
                        const isLit = i < litCount;
                        const hue = Math.round(50 + (i / (VU_BAR_COUNT - 1)) * 85);
                        return (
                            <div
                                key={i}
                                className="nx_VoiceSettings_barMeter_bar"
                                style={isLit ? { background: `hsl(${hue}, 80%, 42%)` } : undefined}
                            />
                        );
                    })}
                </div>
            </div>
            {monitorEnabled && (
                <div className="nx_VoiceSettings_slider nx_VoiceSettings_micMonitorVolume">
                    <label htmlFor="nx_monitor_volume">モニター音量</label>
                    <div className="nx_VoiceSettings_sliderRow">
                        <input
                            id="nx_monitor_volume"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={monitorVolume}
                            style={sliderFill(monitorVolume, 0, 100)}
                            onChange={onMonitorVolumeChange}
                        />
                        <span className="nx_VoiceSettings_sliderValue">{monitorVolume}%</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// EQ band frequency labels
const EQ_SIMPLE_LABELS = EQ_SIMPLE_FREQS.map((f) => (f >= 1000 ? `${f / 1000}kHz` : `${f}Hz`));
const EQ_CUSTOM_LABELS = EQ_CUSTOM_FREQS.map((f) => (f >= 1000 ? `${f / 1000}kHz` : `${f}Hz`));

const EQ_HELP_CONTENT = (
    <div className="nx_VoiceSettings_eqHelpContent">
        <h3>ボイスEQとは</h3>
        <p>
            マイクから入力される声の周波数特性を調整する機能です。特定の帯域を上げ下げすることで、こもりを取り除いたり声の明瞭さを向上させることができます。調整は送信音声（相手に届く音）にのみ適用されます。
        </p>
        <h3>オート</h3>
        <p>
            Nexus が推奨する設定を自動で適用します。350Hz 付近を少し抑えてこもりを除去し、3kHz 付近を持ち上げて声の明瞭さを向上させます。ほとんどの場合これで十分です。
        </p>
        <h3>シンプル（4バンド）</h3>
        <p>声に関係する4つの帯域のゲインを調整できます。</p>
        <ul>
            <li><b>250Hz（低域）</b> — 声の温かみ・ブーミーさ。下げると軽くスッキリし、上げると太みが出ます。</li>
            <li><b>500Hz（中低域）</b> — こもり・箱鳴り感。こもって聞こえる場合は下げてみてください。</li>
            <li><b>2kHz（中高域）</b> — 鼻声・ナサルな印象。鼻声が気になる場合は少し下げると改善することがあります。</li>
            <li><b>5kHz（高域）</b> — 声の抜け・明瞭さ。上げると輪郭がはっきりしますが、上げすぎると耳に刺さります。</li>
        </ul>
        <h3>カスタム（8バンド）</h3>
        <p>より細かく8つの帯域を調整できます。</p>
        <ul>
            <li><b>63Hz（超低域）</b> — 空調・環境ノイズが多い帯域。通常は下げておくと良いです。</li>
            <li><b>125Hz（低域）</b> — 声の胴鳴り感。マイクによっては誇張される場合があります。</li>
            <li><b>250Hz（低中域）</b> — 声の温かみ。</li>
            <li><b>500Hz（中低域）</b> — こもりの原因になりやすい帯域。</li>
            <li><b>1kHz（中域）</b> — 声の芯・存在感。</li>
            <li><b>2kHz（上中域）</b> — 鼻声感・ナサルな印象。</li>
            <li><b>4kHz（高中域）</b> — 声の前に出る感じ・明瞭さ。</li>
            <li><b>8kHz（高域）</b> — 歯擦音（サ・タ行）・空気感。上げすぎるとシャリシャリします。</li>
        </ul>
    </div>
);

/** EQ / AGC / NC strength toggle settings. */
function NexusAudioProcessingSettings(): JSX.Element {
    const ncToggleId = useId();
    const eqToggleId = useId();
    const [ncEnabled, setNcEnabled] = useState<boolean>(
        () => SettingsStore.getValue("nexus_noise_cancellation_enabled") ?? true,
    );
    const [ncStrength, setNcStrength] = useState<number>(
        () => SettingsStore.getValue("nexus_nc_strength") ?? 25,
    );
    const [eqEnabled, setEqEnabled] = useState<boolean>(
        () => SettingsStore.getValue("nexus_voice_eq_enabled") ?? true,
    );
    const [eqMode, setEqMode] = useState<"auto" | "simple" | "custom">(
        () => (SettingsStore.getValue("nexus_eq_mode") ?? "auto") as "auto" | "simple" | "custom",
    );
    const [simpleGains, setSimpleGains] = useState<number[]>(
        () => (SettingsStore.getValue("nexus_eq_simple_gains") ?? [0, -3, 0, 2.5]) as number[],
    );
    const [customGains, setCustomGains] = useState<number[]>(
        () => (SettingsStore.getValue("nexus_eq_custom_gains") ?? [0, 0, 0, -3, 0, 0, 2.5, 0]) as number[],
    );
    const [agcEnabled, setAgcEnabled] = useState<boolean>(
        () => SettingsStore.getValue("nexus_voice_agc_enabled") ?? true,
    );
    const [showEqHelp, setShowEqHelp] = useState(false);

    const onNcChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const enabled = e.target.checked;
        setNcEnabled(enabled);
        SettingsStore.setValue("nexus_noise_cancellation_enabled", null, SettingLevel.DEVICE, enabled);
    }, []);

    const onNcStrengthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = Number(e.target.value);
        setNcStrength(val);
        SettingsStore.setValue("nexus_nc_strength", null, SettingLevel.DEVICE, val);
    }, []);

    const onEqChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const enabled = e.target.checked;
        setEqEnabled(enabled);
        SettingsStore.setValue("nexus_voice_eq_enabled", null, SettingLevel.DEVICE, enabled);
    }, []);

    const onEqModeChange = useCallback((mode: "auto" | "simple" | "custom") => {
        setEqMode(mode);
        SettingsStore.setValue("nexus_eq_mode", null, SettingLevel.DEVICE, mode);
    }, []);

    const onSimpleGainChange = useCallback((index: number, val: number) => {
        setSimpleGains((prev) => {
            const next = [...prev];
            next[index] = val;
            SettingsStore.setValue("nexus_eq_simple_gains", null, SettingLevel.DEVICE, next);
            return next;
        });
    }, []);

    const onCustomGainChange = useCallback((index: number, val: number) => {
        setCustomGains((prev) => {
            const next = [...prev];
            next[index] = val;
            SettingsStore.setValue("nexus_eq_custom_gains", null, SettingLevel.DEVICE, next);
            return next;
        });
    }, []);

    const onAgcChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const enabled = e.target.checked;
        setAgcEnabled(enabled);
        SettingsStore.setValue("nexus_voice_agc_enabled", null, SettingLevel.DEVICE, enabled);
    }, []);

    const currentGains = eqMode === "custom" ? customGains : simpleGains;
    const currentLabels = eqMode === "custom" ? EQ_CUSTOM_LABELS : EQ_SIMPLE_LABELS;
    const onBandGainChange = eqMode === "custom" ? onCustomGainChange : onSimpleGainChange;

    return (
        <SettingsSubsection heading="音声処理" stretchContent>
            {/* ── NC ── */}
            <InlineField
                name="nx-noise-cancellation"
                control={<ToggleInput id={ncToggleId} checked={ncEnabled} onChange={onNcChange} />}
            >
                <Label htmlFor={ncToggleId}>
                    AI ノイズキャンセリング
                    <span className="nx_VoiceSettings_reconnectBadge">VC再接続が必要</span>
                </Label>
                <HelpMessage>
                    DeepFilterNet3 を使用して、キーボード音・ファン音・環境音などの背景ノイズを除去します。初回接続時にモデルのダウンロードが発生します。音質に問題がある場合は OFF にしてください。
                </HelpMessage>
            </InlineField>
            {ncEnabled && (
                <div className="nx_VoiceSettings_slider">
                    <label htmlFor="nx_nc_strength">NC 強度</label>
                    <div className="nx_VoiceSettings_sliderRow">
                        <input
                            id="nx_nc_strength"
                            type="range"
                            min={0}
                            max={70}
                            step={1}
                            value={ncStrength}
                            style={sliderFill(ncStrength, 0, 70)}
                            onChange={onNcStrengthChange}
                        />
                        <span className="nx_VoiceSettings_sliderValue">{ncStrength}%</span>
                    </div>
                </div>
            )}

            {/* ── Voice EQ ── */}
            <InlineField
                name="nx-voice-eq"
                control={<ToggleInput id={eqToggleId} checked={eqEnabled} onChange={onEqChange} />}
            >
                <Label htmlFor={eqToggleId} className="nx_VoiceSettings_eqLabel">
                    <span>ボイス EQ</span>
                    <button
                        type="button"
                        className="nx_VoiceSettings_eqHelpBtn"
                        onClick={(e) => { e.preventDefault(); setShowEqHelp(true); }}
                        title="ボイスEQについて"
                        aria-label="ボイスEQについて"
                    >
                        <HelpIcon width={16} height={16} />
                    </button>
                </Label>
                <HelpMessage>声の周波数特性を調整してマイク音質を改善します。</HelpMessage>
            </InlineField>

            {eqEnabled && (
                <Fragment>
                    {/* Mode selector — pill segmented control */}
                    <div className="nx_VoiceSettings_eqModeSelector" role="radiogroup" aria-label="EQモード">
                        {(["auto", "simple", "custom"] as const).map((m) => (
                            <label key={m} className={`nx_VoiceSettings_eqModeOption${eqMode === m ? " nx_VoiceSettings_eqModeOption--selected" : ""}`}>
                                <input
                                    type="radio"
                                    name="nx-eq-mode"
                                    value={m}
                                    checked={eqMode === m}
                                    onChange={() => onEqModeChange(m)}
                                />
                                {m === "auto" ? "オート" : m === "simple" ? "シンプル" : "カスタム"}
                            </label>
                        ))}
                    </div>

                    {/* Vertical band sliders */}
                    {(eqMode === "simple" || eqMode === "custom") && (
                        <div className="nx_VoiceSettings_eqBands">
                            {currentLabels.map((label, i) => {
                                const gain = currentGains[i] ?? 0;
                                return (
                                    <div key={label} className="nx_VoiceSettings_eqBand">
                                        <span className="nx_VoiceSettings_eqBandGain">
                                            {gain > 0 ? "+" : ""}{gain % 1 === 0 ? gain.toFixed(0) : gain.toFixed(1)}
                                        </span>
                                        <div className="nx_VoiceSettings_eqSliderWrap">
                                            <input
                                                type="range"
                                                className="nx_VoiceSettings_eqSlider"
                                                min={-12}
                                                max={12}
                                                step={0.5}
                                                value={gain}
                                                onChange={(e) => onBandGainChange(i, Number(e.target.value))}
                                            />
                                        </div>
                                        <span className="nx_VoiceSettings_eqBandLabel">{label}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Fragment>
            )}

            {/* ── AGC ── */}
            <SettingsToggleInput
                name="nx-voice-agc"
                label="自動音量調整（AGC）"
                helpMessage="声の大きさを自動的に一定に保ちます。声が小さい人は増幅され、大きい人は抑えられます。静寂時のノイズ増幅はしません。"
                checked={agcEnabled}
                onChange={onAgcChange}
            />

            {/* ── EQ Help Modal ── */}
            {showEqHelp && (
                <div
                    className="nx_VoiceSettings_eqHelpOverlay"
                    onClick={() => setShowEqHelp(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="ボイスEQについて"
                >
                    <div
                        className="nx_VoiceSettings_eqHelpModal"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="nx_VoiceSettings_eqHelpHeader">
                            <span>ボイスEQについて</span>
                            <button
                                type="button"
                                className="nx_VoiceSettings_eqHelpClose"
                                onClick={() => setShowEqHelp(false)}
                                aria-label="閉じる"
                            >✕</button>
                        </div>
                        <div className="nx_VoiceSettings_eqHelpBody">
                            {EQ_HELP_CONTENT}
                        </div>
                    </div>
                </div>
            )}
        </SettingsSubsection>
    );
}

export default class VoiceUserSettingsTab extends React.Component<EmptyObject, IState> {
    public static contextType = MatrixClientContext;
    declare public context: React.ContextType<typeof MatrixClientContext>;

    public constructor(props: EmptyObject) {
        super(props);

        this.state = {
            mediaDevices: null,
            [MediaDeviceKindEnum.AudioOutput]: null,
            [MediaDeviceKindEnum.AudioInput]: null,
            [MediaDeviceKindEnum.VideoInput]: null,
            audioAutoGainControl: MediaDeviceHandler.getAudioAutoGainControl(),
            audioEchoCancellation: MediaDeviceHandler.getAudioEchoCancellation(),
            audioNoiseSuppression: MediaDeviceHandler.getAudioNoiseSuppression(),
        };
    }

    public async componentDidMount(): Promise<void> {
        const canSeeDeviceLabels = await MediaDeviceHandler.hasAnyLabeledDevices();
        if (canSeeDeviceLabels) {
            await this.refreshMediaDevices();
        }
    }

    private refreshMediaDevices = async (stream?: MediaStream): Promise<void> => {
        this.setState({
            mediaDevices: (await MediaDeviceHandler.getDevices()) ?? null,
            [MediaDeviceKindEnum.AudioOutput]: mapDeviceKindToHandlerValue(MediaDeviceKindEnum.AudioOutput),
            [MediaDeviceKindEnum.AudioInput]: mapDeviceKindToHandlerValue(MediaDeviceKindEnum.AudioInput),
            [MediaDeviceKindEnum.VideoInput]: mapDeviceKindToHandlerValue(MediaDeviceKindEnum.VideoInput),
        });
        if (stream) {
            // kill stream (after we've enumerated the devices, otherwise we'd get empty labels again)
            // so that we don't leave it lingering around with webcam enabled etc
            // as here we called gUM to ask user for permission to their device names only
            stream.getTracks().forEach((track) => track.stop());
        }
    };

    private requestMediaPermissions = async (): Promise<void> => {
        const stream = await requestMediaPermissions();
        if (stream) {
            await this.refreshMediaDevices(stream);
        }
    };

    private setDevice = async (deviceId: string, kind: MediaDeviceKindEnum): Promise<void> => {
        // set state immediately so UI is responsive
        this.setState<any>({ [kind]: deviceId });
        try {
            await MediaDeviceHandler.instance.setDevice(deviceId, kind);
        } catch {
            logger.error(`Failed to set device ${kind}: ${deviceId}`);
            // reset state to current value
            this.setState<any>({ [kind]: mapDeviceKindToHandlerValue(kind) });
        }
    };

    private renderDeviceOptions(devices: Array<MediaDeviceInfo>, category: MediaDeviceKindEnum): Array<JSX.Element> {
        return devices.map((d) => {
            return (
                <option key={`${category}-${d.deviceId}`} value={d.deviceId}>
                    {d.label}
                </option>
            );
        });
    }

    private renderDropdown(kind: MediaDeviceKindEnum, _label: string): ReactNode {
        const devices = this.state.mediaDevices?.[kind].slice(0);
        if (!devices?.length) return null;

        const defaultDevice = MediaDeviceHandler.getDefaultDevice(devices);
        return (
            <select
                className="nx_VoiceSettings_select"
                value={this.state[kind] || defaultDevice}
                onChange={(e) => this.setDevice(e.target.value, kind)}
            >
                {this.renderDeviceOptions(devices, kind)}
            </select>
        );
    }

    public render(): ReactNode {
        let requestButton: ReactNode | undefined;
        let speakerDropdown: ReactNode | undefined;
        let microphoneDropdown: ReactNode | undefined;
        if (!this.state.mediaDevices) {
            requestButton = (
                <div>
                    <p>{_t("settings|voip|missing_permissions_prompt")}</p>
                    <AccessibleButton onClick={this.requestMediaPermissions} kind="primary">
                        {_t("settings|voip|request_permissions")}
                    </AccessibleButton>
                </div>
            );
        } else if (this.state.mediaDevices) {
            speakerDropdown = this.renderDropdown(
                MediaDeviceKindEnum.AudioOutput,
                "",
            ) || <p>{_t("settings|voip|audio_output_empty")}</p>;
            microphoneDropdown = this.renderDropdown(MediaDeviceKindEnum.AudioInput, "") || (
                <p>{_t("settings|voip|audio_input_empty")}</p>
            );
        }

        return (
            <SettingsTab>
                <Form.Root
                    onSubmit={(evt) => {
                        evt.preventDefault();
                        evt.stopPropagation();
                    }}
                >
                    <SettingsSection>
                        {requestButton}
                        <SettingsSubsection heading={_t("settings|voip|voice_section")} stretchContent>
                            <div className="nx_VoiceSettings_twoColumn">
                                <div className="nx_VoiceSettings_column">
                                    <h4 className="nx_VoiceSettings_columnHeading">入力デバイス</h4>
                                    {microphoneDropdown}
                                    <NexusInputVolume />
                                </div>
                                <div className="nx_VoiceSettings_column">
                                    <h4 className="nx_VoiceSettings_columnHeading">出力デバイス</h4>
                                    {speakerDropdown}
                                    <NexusOutputVolume />
                                </div>
                            </div>
                            <NexusMicMonitorSettings />
                        </SettingsSubsection>
                        <NexusVoiceGateSettings />
                        <NexusAudioProcessingSettings />
                    </SettingsSection>

                </Form.Root>
            </SettingsTab>
        );
    }
}
