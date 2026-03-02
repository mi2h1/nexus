/*
Copyright 2024 New Vector Ltd.
Copyright 2020 The Matrix.org Foundation C.I.C.
Copyright 2019 New Vector Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEventHandler, type JSX, type ReactNode, useState, useCallback, useRef, useEffect } from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { FALLBACK_ICE_SERVER } from "matrix-js-sdk/src/webrtc/call";
import { type EmptyObject } from "matrix-js-sdk/src/matrix";
import { Form, SettingsToggleInput } from "@vector-im/compound-web";

import { _t } from "../../../../../languageHandler";
import MediaDeviceHandler, { type IMediaDevices, MediaDeviceKindEnum } from "../../../../../MediaDeviceHandler";
import AccessibleButton from "../../../elements/AccessibleButton";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import SettingsFlag from "../../../elements/SettingsFlag";
import { requestMediaPermissions } from "../../../../../utils/media/requestMediaPermissions";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection } from "../../shared/SettingsSubsection";
import MatrixClientContext from "../../../../../contexts/MatrixClientContext";
import SettingsStore from "../../../../../settings/SettingsStore";
import { useNexusVoice } from "../../../../../hooks/useNexusVoice";
import type { NexusVoiceConnection } from "../../../../../models/NexusVoiceConnection";
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
                    audio: { echoCancellation: true, noiseSuppression: true },
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

                const dataArray = new Uint8Array(analyser.frequencyBinCount);

                timer = setInterval(() => {
                    analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                    const avg = sum / dataArray.length;
                    setLevel(Math.min(100, Math.round((avg / 128) * 100)));
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
                            onChange={onGateThresholdChange}
                        />
                        <span className="nx_VoiceSettings_sliderValue">{gateThreshold}</span>
                    </div>
                </div>
            )}
            <div className="nx_VoiceSettings_levelMeter">
                <label>入力レベル</label>
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

    private changeWebRtcMethod = (p2p: boolean): void => {
        this.context.setForceTURN(!p2p);
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

    private onAutoGainChanged: ChangeEventHandler<HTMLInputElement> = async (event) => {
        const enable = event.target.checked;
        await MediaDeviceHandler.setAudioAutoGainControl(enable);
        this.setState({ audioAutoGainControl: MediaDeviceHandler.getAudioAutoGainControl() });
    };

    private onNoiseSuppressionChanged: ChangeEventHandler<HTMLInputElement> = async (event) => {
        const enable = event.target.checked;
        await MediaDeviceHandler.setAudioNoiseSuppression(enable);
        this.setState({ audioNoiseSuppression: MediaDeviceHandler.getAudioNoiseSuppression() });
    };

    private onEchoCancellationChanged: ChangeEventHandler<HTMLInputElement> = async (event) => {
        const enable = event.target.checked;
        await MediaDeviceHandler.setAudioEchoCancellation(enable);
        this.setState({ audioEchoCancellation: MediaDeviceHandler.getAudioEchoCancellation() });
    };

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
                                    <SettingsToggleInput
                                        name="voice-auto-gain"
                                        label={_t("settings|voip|voice_agc")}
                                        checked={this.state.audioAutoGainControl}
                                        onChange={this.onAutoGainChanged}
                                    />
                                </div>
                                <div className="nx_VoiceSettings_column">
                                    <h4 className="nx_VoiceSettings_columnHeading">出力デバイス</h4>
                                    {speakerDropdown}
                                    <NexusOutputVolume />
                                </div>
                            </div>
                        </SettingsSubsection>
                        <NexusVoiceGateSettings />
                    </SettingsSection>

                    <SettingsSection heading={_t("common|advanced")}>
                        <SettingsSubsection heading={_t("settings|voip|voice_processing")}>
                            <SettingsToggleInput
                                name="voice-noise-suppression"
                                label={_t("settings|voip|noise_suppression")}
                                helpMessage={_t("settings|voip|noise_suppression_description")}
                                checked={this.state.audioNoiseSuppression}
                                onChange={this.onNoiseSuppressionChanged}
                            />
                            <SettingsToggleInput
                                name="voice-echo-cancellation"
                                label={_t("settings|voip|echo_cancellation")}
                                helpMessage={_t("settings|voip|echo_cancellation_description")}
                                checked={this.state.audioEchoCancellation}
                                onChange={this.onEchoCancellationChanged}
                            />
                        </SettingsSubsection>
                        <SettingsSubsection heading={_t("settings|voip|connection_section")}>
                            <SettingsFlag
                                name="webRtcAllowPeerToPeer"
                                level={SettingLevel.DEVICE}
                                onChange={this.changeWebRtcMethod}
                            />
                            <SettingsFlag
                                name="fallbackICEServerAllowed"
                                label={_t("settings|voip|enable_fallback_ice_server", {
                                    server: new URL(FALLBACK_ICE_SERVER).pathname,
                                })}
                                level={SettingLevel.DEVICE}
                                hideIfCannotSet
                            />
                        </SettingsSubsection>
                    </SettingsSection>
                </Form.Root>
            </SettingsTab>
        );
    }
}
