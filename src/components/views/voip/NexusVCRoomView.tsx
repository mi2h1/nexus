/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, type JSX, useMemo } from "react";
import ReactDOM from "react-dom";
import classNames from "classnames";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { useVCParticipants } from "../../../hooks/useVCParticipants";
import { useNexusScreenShares } from "../../../hooks/useNexusScreenShares";
import { useNexusActiveSpeakers } from "../../../hooks/useNexusActiveSpeakers";
import { useNexusParticipantStates } from "../../../hooks/useNexusParticipantStates";
import { useNexusWatchingScreenShares } from "../../../hooks/useNexusWatchingScreenShares";
import { ScreenShareTile, ScreenShareSnapshotTile } from "./NexusScreenShareView";
import { ParticipantTile } from "./NexusVoiceParticipantGrid";
import { NexusVCControlBar } from "./NexusVCControlBar";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../stores/NexusVoiceStore";
import type { ScreenShareInfo } from "../../../models/Call";
import MemberAvatar from "../avatars/MemberAvatar";
import AccessibleButton from "../elements/AccessibleButton";
import { EyeOff } from "lucide-react";
import { NexusVCPopout } from "./NexusVCPopout";

interface NexusVCRoomViewProps {
    roomId: string;
    /** True when rendered inside a popout window via createPortal. */
    isPopout?: boolean;
}

type VCLayoutMode = "spotlight" | "grid";

type SpotlightTarget =
    | { type: "screenshare"; share: ScreenShareInfo }
    | { type: "member"; member: RoomMember };

/**
 * Unified VC room view with spotlight/grid layout modes and a control bar.
 */
export function NexusVCRoomView({ roomId, isPopout = false }: NexusVCRoomViewProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const { participants: rawParticipants, connected } = useVCParticipants(roomId);
    const [popoutWindow, setPopoutWindow] = useState<Window | null>(null);
    const viewRef = useRef<HTMLDivElement>(null);
    // Filter to resolved RoomMembers for layout components
    const members = useMemo(
        () =>
            rawParticipants
                .filter((p): p is typeof p & { member: RoomMember } => p.member !== null)
                .map((p) => p.member),
        [rawParticipants],
    );
    const screenShares = useNexusScreenShares(roomId);
    const activeSpeakers = useNexusActiveSpeakers();
    const participantStates = useNexusParticipantStates();

    // Close popout window when disconnecting from VC
    useEffect(() => {
        if (!connected && popoutWindow) {
            setPopoutWindow(null);
            import("@tauri-apps/api/core").then(({ invoke }) => {
                invoke("plugin:window|close", { label: "vc-popout" });
            }).catch(() => {});
        }
    }, [connected, popoutWindow]);

    const [layoutMode, setLayoutMode] = useState<VCLayoutMode>("grid");
    const [focusMode, setFocusMode] = useState(false);

    // ─── Focus target (click-based spotlight) ────────────
    const [focusTarget, setFocusTarget] = useState<SpotlightTarget | null>(null);

    const handleFocusMember = useCallback((member: RoomMember) => {
        setFocusTarget({ type: "member", member });
        setLayoutMode("spotlight");
    }, []);

    const handleFocusScreenShare = useCallback((share: ScreenShareInfo) => {
        setFocusTarget({ type: "screenshare", share });
        setLayoutMode("spotlight");
    }, []);

    const handleUnfocus = useCallback(() => {
        setFocusTarget(null);
        setLayoutMode("grid");
        setFocusMode(false);
    }, []);

    // ─── Panel visibility (context menu) ────────────────
    const [hideNonScreenSharePanels, setHideNonScreenSharePanels] = useState(false);
    const [viewContextMenu, setViewContextMenu] = useState<{
        left: number;
        top: number;
        /** If set, show volume slider for this screen share. */
        share?: ScreenShareInfo;
    } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    /** Right-click on the view background — no volume slider. */
    const onViewContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setViewContextMenu({ left: e.clientX, top: e.clientY });
    }, []);

    /** Right-click on a watched screen share tile — includes volume slider. */
    const onShareContextMenu = useCallback((share: ScreenShareInfo, left: number, top: number) => {
        setViewContextMenu({ left, top, share });
    }, []);

    // Close context menu on click outside or Escape
    useEffect(() => {
        if (!viewContextMenu) return;
        const doc = viewRef.current?.ownerDocument ?? document;
        const onPointerDown = (e: PointerEvent): void => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setViewContextMenu(null);
            }
        };
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === "Escape") setViewContextMenu(null);
        };
        doc.addEventListener("pointerdown", onPointerDown);
        doc.addEventListener("keydown", onKeyDown);
        return () => {
            doc.removeEventListener("pointerdown", onPointerDown);
            doc.removeEventListener("keydown", onKeyDown);
        };
    }, [viewContextMenu]);

    // Watching state lives in NexusVoiceConnection (persists across room navigation)
    const watchingIds = useNexusWatchingScreenShares();

    // Filter screen shares into watched (local + opted-in) and unwatched
    const watchedScreenShares = useMemo(
        () => screenShares.filter((s) => s.isLocal || watchingIds.has(s.participantIdentity)),
        [screenShares, watchingIds],
    );
    const unwatchedScreenShares = useMemo(
        () => screenShares.filter((s) => !s.isLocal && !watchingIds.has(s.participantIdentity)),
        [screenShares, watchingIds],
    );

    // ─── Panel visibility filtering ─────────────────────
    const visibleMembers = useMemo(
        () => hideNonScreenSharePanels ? [] : members,
        [members, hideNonScreenSharePanels],
    );

    const startWatching = useCallback((id: string) => {
        NexusVoiceStore.instance.getActiveConnection()?.setScreenShareWatching(id, true);
    }, []);

    const stopWatching = useCallback((id: string) => {
        NexusVoiceStore.instance.getActiveConnection()?.setScreenShareWatching(id, false);
    }, []);

    // ─── Focus target cleanup ───────────────────────────
    // When focused member leaves or focused screen share ends, return to grid
    useEffect(() => {
        if (!focusTarget) return;
        if (focusTarget.type === "member") {
            if (!visibleMembers.some((m) => m.userId === focusTarget.member.userId)) {
                setFocusTarget(null);
                setLayoutMode("grid");
            }
        } else if (focusTarget.type === "screenshare") {
            if (!watchedScreenShares.some((s) => s.participantIdentity === focusTarget.share.participantIdentity)) {
                setFocusTarget(null);
                setLayoutMode("grid");
            }
        }
    }, [focusTarget, visibleMembers, watchedScreenShares]);

    // ─── External spotlight request (from sidebar double-click) ──
    // Applies pending request on mount/reconnect, and listens for future requests.
    useEffect(() => {
        if (!connected) return;
        const applySpotlight = (participantIdentity: string): void => {
            const conn = NexusVoiceStore.instance.getActiveConnection();
            if (!conn) return;
            const share = conn.screenShares.find((s) => s.participantIdentity === participantIdentity);
            if (!share) return;
            setFocusTarget({ type: "screenshare", share });
            setLayoutMode("spotlight");
        };
        // Consume any pending request (set before this component mounted)
        const pending = NexusVoiceStore.instance.consumePendingSpotlight();
        if (pending) applySpotlight(pending);
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.RequestSpotlight, applySpotlight);
        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.RequestSpotlight, applySpotlight);
        };
    }, [connected]);

    const onJoinCall = useCallback(() => {
        const room = client.getRoom(roomId);
        if (room) {
            NexusVoiceStore.instance.joinVoiceChannel(room).catch(() => {});
        }
    }, [client, roomId]);

    if (!connected) {
        return (
            <div className="nx_VCRoomView">
                <div className="nx_VCRoomView_empty">
                    <div className="nx_VCRoomView_emptyText">ボイスチャンネルに参加していません</div>
                    <AccessibleButton
                        className="nx_VCRoomView_joinButton"
                        onClick={onJoinCall}
                    >
                        参加
                    </AccessibleButton>
                </div>
            </div>
        );
    }

    // Popout: show placeholder in main window, render VC in child window
    if (popoutWindow && !isPopout) {
        return (
            <div className="nx_VCRoomView">
                <div className="nx_VCRoomView_popoutPlaceholder">
                    <div className="nx_VCRoomView_popoutPlaceholderText">
                        VC は別ウィンドウで表示中
                    </div>
                    <AccessibleButton
                        className="nx_VCRoomView_popoutRestoreButton"
                        onClick={() => {
                            if (!popoutWindow.closed) popoutWindow.close();
                            setPopoutWindow(null);
                        }}
                    >
                        元に戻す
                    </AccessibleButton>
                </div>
                <NexusVCPopout
                    roomId={roomId}
                    childWindow={popoutWindow}
                    onClose={() => setPopoutWindow(null)}
                />
            </div>
        );
    }

    const controlBar = (
        <NexusVCControlBar
            roomId={roomId}
            isPopout={isPopout}
            portalContainer={viewRef.current?.ownerDocument.body}
            onPopout={!isPopout ? async () => {
                const win = window.open("about:blank", "_blank", "width=480,height=640");
                if (win) setPopoutWindow(win);
            } : undefined}
            onRestoreFromPopout={isPopout ? () => {
                import("@tauri-apps/api/core").then(({ invoke }) => {
                    invoke("plugin:window|close", { label: "vc-popout" });
                }).catch(() => {});
            } : undefined}
            layoutMode={layoutMode}
            focusMode={focusMode}
            onToggleFocusMode={() => setFocusMode((prev) => !prev)}
            onStopWatching={
                layoutMode === "spotlight" && focusTarget?.type === "screenshare" && !focusTarget.share.isLocal
                    ? () => stopWatching(focusTarget.share.participantIdentity)
                    : undefined
            }
        />
    );

    return (
        <div className={classNames("nx_VCRoomView", {
            "nx_VCRoomView--focusMode": layoutMode === "spotlight" && focusMode,
        })} ref={viewRef}>
            <div className="nx_VCRoomView_content" onContextMenu={onViewContextMenu}>
                {layoutMode === "spotlight" ? (
                    <SpotlightLayout
                        focusTarget={focusTarget}
                        screenShares={watchedScreenShares}
                        unwatchedScreenShares={unwatchedScreenShares}
                        onStartWatching={startWatching}
                        onShareContextMenu={onShareContextMenu}
                        members={visibleMembers}
                        activeSpeakers={activeSpeakers}
                        participantStates={participantStates}
                        hideNonScreenSharePanels={hideNonScreenSharePanels}
                        onUnfocus={handleUnfocus}
                        focusMode={focusMode}
                        onToggleFocusMode={() => setFocusMode((prev) => !prev)}
                    />
                ) : (
                    <GridLayout
                        screenShares={watchedScreenShares}
                        unwatchedScreenShares={unwatchedScreenShares}
                        onStartWatching={startWatching}
                        onStopWatching={stopWatching}
                        onShareContextMenu={onShareContextMenu}
                        members={visibleMembers}
                        activeSpeakers={activeSpeakers}
                        participantStates={participantStates}
                        hideNonScreenSharePanels={hideNonScreenSharePanels}
                        onFocusMember={handleFocusMember}
                        onFocusScreenShare={handleFocusScreenShare}
                    />
                )}
            </div>
            {controlBar}
            {viewContextMenu && (
                <NexusVCViewContextMenu
                    ref={contextMenuRef}
                    left={viewContextMenu.left}
                    top={viewContextMenu.top}
                    share={viewContextMenu.share}
                    hideNonScreenSharePanels={hideNonScreenSharePanels}
                    onHideNonScreenSharePanelsChange={setHideNonScreenSharePanels}
                    onStopWatching={stopWatching}
                    onClose={() => setViewContextMenu(null)}
                    portalContainer={viewRef.current?.ownerDocument.body}
                />
            )}
        </div>
    );
}

// ─── Unified view context menu ────────────────────────────────

interface NexusVCViewContextMenuProps {
    left: number;
    top: number;
    /** If set, shows a volume slider for this screen share's audio. */
    share?: ScreenShareInfo;
    hideNonScreenSharePanels: boolean;
    onHideNonScreenSharePanelsChange: (value: boolean) => void;
    onStopWatching?: (id: string) => void;
    onClose: () => void;
    /** Portal target — defaults to document.body, but should be the popout's body when isPopout. */
    portalContainer?: HTMLElement;
}

const NexusVCViewContextMenu = React.forwardRef<HTMLDivElement, NexusVCViewContextMenuProps>(
    function NexusVCViewContextMenu(
        { left, top, share, hideNonScreenSharePanels, onHideNonScreenSharePanelsChange, onStopWatching, onClose, portalContainer },
        ref,
    ) {
        const conn = NexusVoiceStore.instance.getActiveConnection();
        const initialVolume = share ? (conn?.getScreenShareVolume(share.participantIdentity) ?? 1) : 1;
        const volumeRef = useRef(initialVolume);
        const percentRef = useRef<HTMLSpanElement>(null);

        const onVolumeChange = useCallback(
            (e: React.ChangeEvent<HTMLInputElement>) => {
                if (!share) return;
                const val = parseFloat(e.target.value);
                volumeRef.current = val;
                if (percentRef.current) {
                    percentRef.current.textContent = `${Math.round(val * 100)}%`;
                }
                conn?.setScreenShareVolume(share.participantIdentity, val);
            },
            [conn, share],
        );

        const stopBubble = (e: React.SyntheticEvent): void => {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
        };

        return ReactDOM.createPortal(
            <div
                className="nx_VCViewContextMenu"
                ref={ref}
                style={{ left, top, position: "fixed", zIndex: 5000 }}
                onPointerDown={stopBubble}
                onMouseDown={stopBubble}
                onFocusCapture={stopBubble}
            >
                {share?.audioTrack && (
                    <>
                        <div className="nx_VCViewContextMenu_label">
                            {share.participantName} の配信音量
                        </div>
                        <div className="nx_VCViewContextMenu_sliderRow">
                            <input
                                type="range"
                                className="nx_VCViewContextMenu_slider"
                                min="0"
                                max="2"
                                step="0.01"
                                defaultValue={initialVolume}
                                onChange={onVolumeChange}
                            />
                            <span className="nx_VCViewContextMenu_percent" ref={percentRef}>
                                {Math.round(initialVolume * 100)}%
                            </span>
                        </div>
                        <div className="nx_VCViewContextMenu_separator" />
                    </>
                )}
                {share && !share.isLocal && onStopWatching && (
                    <>
                        <div
                            className="nx_VCViewContextMenu_item nx_VCViewContextMenu_item--destructive"
                            onClick={() => {
                                onStopWatching(share.participantIdentity);
                                onClose();
                            }}
                        >
                            <EyeOff size={18} />
                            <span>視聴を停止</span>
                        </div>
                        <div className="nx_VCViewContextMenu_separator" />
                    </>
                )}
                <label className="nx_VCViewContextMenu_item">
                    <input
                        type="checkbox"
                        checked={hideNonScreenSharePanels}
                        onChange={(e) => {
                            onHideNonScreenSharePanelsChange(e.target.checked);
                            onClose();
                        }}
                    />
                    <span>画面共有ではないパネルを非表示</span>
                </label>
            </div>,
            portalContainer ?? document.body,
        );
    },
);

// ─── Spotlight layout ─────────────────────────────────────────

interface SpotlightLayoutProps {
    focusTarget: SpotlightTarget | null;
    screenShares: ScreenShareInfo[];
    unwatchedScreenShares: ScreenShareInfo[];
    onStartWatching: (id: string) => void;
    onShareContextMenu: (share: ScreenShareInfo, left: number, top: number) => void;
    members: RoomMember[];
    activeSpeakers: Set<string>;
    participantStates: Map<string, { isMuted: boolean; isScreenSharing: boolean }>;
    /** True when non-screen-share panels are hidden via context menu. */
    hideNonScreenSharePanels?: boolean;
    onUnfocus: () => void;
    focusMode?: boolean;
    onToggleFocusMode?: () => void;
}

function SpotlightLayout({
    focusTarget,
    screenShares,
    unwatchedScreenShares,
    onStartWatching,
    onShareContextMenu,
    members,
    activeSpeakers,
    participantStates,
    hideNonScreenSharePanels,
    onUnfocus,
    focusMode,
    onToggleFocusMode,
}: SpotlightLayoutProps): JSX.Element {
    // Manual screen share selection (null = auto from focusTarget)
    const [manualScreenShareId, setManualScreenShareId] = useState<string | null>(null);

    // Clear manual selection when the selected screen share disappears
    useEffect(() => {
        if (manualScreenShareId === null) return;
        if (!screenShares.some((s) => s.participantIdentity === manualScreenShareId)) {
            setManualScreenShareId(null);
        }
    }, [screenShares, manualScreenShareId]);

    // Resolve effective spotlight target
    const effectiveTarget = useMemo((): SpotlightTarget | null => {
        if (manualScreenShareId) {
            const share = screenShares.find((s) => s.participantIdentity === manualScreenShareId);
            if (share) return { type: "screenshare", share };
        }
        return focusTarget;
    }, [manualScreenShareId, screenShares, focusTarget]);

    // Bottom bar: screen shares NOT currently in the main spotlight
    const bottomBarScreenShares = useMemo(() => {
        if (effectiveTarget?.type !== "screenshare") return screenShares;
        return screenShares.filter(
            (s) => s.participantIdentity !== effectiveTarget.share.participantIdentity,
        );
    }, [effectiveTarget, screenShares]);

    // Bottom bar: members (exclude spotlight member if target is a member)
    const bottomBarMembers = useMemo(() => {
        if (!effectiveTarget) return members;
        if (effectiveTarget.type === "screenshare") return members;
        return members.filter((m) => m.userId !== effectiveTarget.member.userId);
    }, [effectiveTarget, members]);

    const hasBottomBar =
        bottomBarScreenShares.length > 0 || unwatchedScreenShares.length > 0 || bottomBarMembers.length > 0;

    return (
        <div className={classNames("nx_VCRoomView_spotlight", {
            "nx_VCRoomView_spotlight--focusMode": focusMode,
        })}>
            <div className="nx_VCRoomView_spotlightMain" onClick={onUnfocus} style={{ cursor: "pointer" }}>
                {effectiveTarget?.type === "screenshare" ? (
                    <ScreenShareTile
                        share={effectiveTarget.share}
                        onShareContextMenu={onShareContextMenu}
                    />
                ) : effectiveTarget?.type === "member" ? (
                    <div className="nx_VCRoomView_spotlightAvatar">
                        <MemberAvatar member={effectiveTarget.member} size="128px" hideTitle />
                        <div className="nx_VCRoomView_spotlightAvatarName">
                            {effectiveTarget.member.name}
                        </div>
                    </div>
                ) : hideNonScreenSharePanels ? (
                    <div className="nx_VCRoomView_spotlightEmpty">
                        画面を共有しているユーザーはいません
                    </div>
                ) : null}

                {/* 非フォーカス時: 大画面ホバーで「メンバーを非表示」 */}
                {!focusMode && hasBottomBar && (
                    <div className="nx_VCRoomView_focusOverlay" onClick={(e) => e.stopPropagation()}>
                        <button
                            className="nx_VCRoomView_focusToggleButton"
                            onClick={(e) => { e.stopPropagation(); onToggleFocusMode?.(); }}
                        >
                            メンバーを非表示
                        </button>
                    </div>
                )}
            </div>
            {hasBottomBar && (
                <div className={classNames("nx_VCRoomView_spotlightBottomBar", {
                    "nx_VCRoomView_spotlightBottomBar--hidden": focusMode,
                })}>
                    {bottomBarScreenShares.map((share) => (
                        <div
                            key={`ss-${share.participantIdentity}`}
                            className="nx_VCRoomView_spotlightBottomBar_item nx_VCRoomView_spotlightBottomBar_screenShare"
                            onClick={() => setManualScreenShareId(share.participantIdentity)}
                        >
                            <ScreenShareTile
                                share={share}
                                onShareContextMenu={onShareContextMenu}
                            />
                        </div>
                    ))}
                    {unwatchedScreenShares.map((share) => (
                        <div
                            key={`preview-${share.participantIdentity}`}
                            className="nx_VCRoomView_spotlightBottomBar_item nx_VCRoomView_screenSharePreview"
                            onClick={() => onStartWatching(share.participantIdentity)}
                        >
                            <ScreenShareSnapshotTile share={share} />
                            <div className="nx_VCRoomView_screenSharePreview_overlay">
                                <div className="nx_VCRoomView_screenSharePreview_button">
                                    画面を視聴する
                                </div>
                            </div>
                        </div>
                    ))}
                    {bottomBarMembers.map((member) => {
                        const state = participantStates.get(member.userId);
                        return (
                            <div
                                key={member.userId}
                                className="nx_VCRoomView_spotlightBottomBar_item"
                                onClick={() => setManualScreenShareId(null)}
                            >
                                <ParticipantTile
                                    member={member}
                                    isSpeaking={activeSpeakers.has(member.userId)}
                                    isMuted={state?.isMuted ?? false}
                                    isScreenSharing={state?.isScreenSharing ?? false}
                                    size="small"
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Grid layout ──────────────────────────────────────────────

const GRID_GAP = 16;
const GRID_PADDING = 12;
const MIN_PANEL_W = 120;

function calculateGridLayout(
    itemCount: number,
    containerW: number,
    containerH: number,
): { panelWidth: number; panelHeight: number } {
    if (itemCount === 0) return { panelWidth: 0, panelHeight: 0 };

    const availW = containerW - 2 * GRID_PADDING;
    const availH = containerH - 2 * GRID_PADDING;

    let best: { panelWidth: number; panelHeight: number; area: number } | null = null;

    for (let cols = 1; cols <= itemCount; cols++) {
        const rows = Math.ceil(itemCount / cols);

        // 幅基準: パネル幅をコンテナ幅から決定し、高さを 9:16 で計算
        const panelWFromWidth = (availW - (cols - 1) * GRID_GAP) / cols;
        const panelHFromWidth = panelWFromWidth * 9 / 16;

        // 高さ基準: パネル高さをコンテナ高さから決定し、幅を 16:9 で計算
        const panelHFromHeight = (availH - (rows - 1) * GRID_GAP) / rows;
        const panelWFromHeight = panelHFromHeight * 16 / 9;

        // 両方の制約を満たす方（小さい方）を採用
        const panelW = Math.min(panelWFromWidth, panelWFromHeight);
        const panelH = panelW * 9 / 16;

        if (panelW >= MIN_PANEL_W) {
            const area = panelW * panelH;
            if (!best || area > best.area) {
                best = { panelWidth: panelW, panelHeight: panelH, area };
            }
        }
    }

    if (best) {
        return { panelWidth: best.panelWidth, panelHeight: best.panelHeight };
    }

    // フォールバック: 全アイテム1行
    const cols = itemCount;
    const panelW = Math.max((availW - (cols - 1) * GRID_GAP) / cols, MIN_PANEL_W);
    return { panelWidth: panelW, panelHeight: panelW * 9 / 16 };
}

interface GridLayoutProps {
    screenShares: ScreenShareInfo[];
    unwatchedScreenShares: ScreenShareInfo[];
    onStartWatching: (id: string) => void;
    onStopWatching: (id: string) => void;
    onShareContextMenu: (share: ScreenShareInfo, left: number, top: number) => void;
    members: RoomMember[];
    activeSpeakers: Set<string>;
    participantStates: Map<string, { isMuted: boolean; isScreenSharing: boolean }>;
    hideNonScreenSharePanels?: boolean;
    onFocusMember: (member: RoomMember) => void;
    onFocusScreenShare: (share: ScreenShareInfo) => void;
}

function GridLayout({
    screenShares,
    unwatchedScreenShares,
    onStartWatching,
    onStopWatching,
    onShareContextMenu,
    members,
    activeSpeakers,
    participantStates,
    hideNonScreenSharePanels,
    onFocusMember,
    onFocusScreenShare,
}: GridLayoutProps): JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isReady, setIsReady] = useState(false);

    const totalItems = screenShares.length + unwatchedScreenShares.length
        + (hideNonScreenSharePanels ? 0 : members.length);

    // パネルサイズを CSS カスタムプロパティで直接設定（React 再レンダーを回避）
    const updatePanelSize = useCallback((el: HTMLDivElement, width: number, height: number) => {
        const { panelWidth, panelHeight } = calculateGridLayout(totalItems, width, height);
        el.style.setProperty("--panel-w", `${panelWidth}px`);
        el.style.setProperty("--panel-h", `${panelHeight}px`);
    }, [totalItems]);

    // 初期サイズを同期的に読み取り、マウント直後の空白フレームを防ぐ
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        updatePanelSize(el, width, height);
        setIsReady(true);
    }, [updatePanelSize]);

    // リサイズは直接 DOM に反映（setState なし → 再レンダーなし → 遅延なし）
    // ポップアウトウィンドウでは ResizeObserver の発火が1フレーム遅れるため、
    // 所属ウィンドウの resize イベントも併用して即時更新する
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const sync = (): void => {
            const { width, height } = el.getBoundingClientRect();
            updatePanelSize(el, width, height);
        };

        const observer = new ResizeObserver(sync);
        observer.observe(el);

        const win = el.ownerDocument.defaultView ?? window;
        win.addEventListener("resize", sync);

        return () => {
            observer.disconnect();
            win.removeEventListener("resize", sync);
        };
    }, [updatePanelSize]);

    const isEmpty = hideNonScreenSharePanels && screenShares.length === 0 && unwatchedScreenShares.length === 0;

    return (
        <div ref={containerRef} className="nx_VCRoomView_grid">
            {isReady && (
                <>
                    {isEmpty && (
                        <div className="nx_VCRoomView_gridEmpty">
                            画面を共有しているユーザーはいません
                        </div>
                    )}
                    {screenShares.map((share) => (
                        <div
                            key={`ss-${share.participantIdentity}`}
                            className="nx_VCRoomView_gridPanel"
                            onClick={() => onFocusScreenShare(share)}
                        >
                            <div className="nx_VCRoomView_gridScreenShare">
                                <ScreenShareTile
                                    share={share}
                                    onStopWatching={share.isLocal ? undefined : () => onStopWatching(share.participantIdentity)}
                                    onShareContextMenu={onShareContextMenu}
                                />
                            </div>
                        </div>
                    ))}
                    {unwatchedScreenShares.map((share) => (
                        <div
                            key={`preview-${share.participantIdentity}`}
                            className="nx_VCRoomView_gridPanel"
                            onClick={() => onStartWatching(share.participantIdentity)}
                        >
                            <div className="nx_VCRoomView_gridScreenShare nx_VCRoomView_gridScreenSharePreview">
                                <ScreenShareSnapshotTile share={share} />
                                <div className="nx_VCRoomView_screenSharePreview_overlay">
                                    <div className="nx_VCRoomView_screenSharePreview_button">
                                        画面を視聴する
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                    {members.map((member) => {
                        const state = participantStates.get(member.userId);
                        const speaking = activeSpeakers.has(member.userId);
                        return (
                            <div
                                key={member.userId}
                                className={`nx_VCRoomView_gridPanel${speaking ? " nx_VCRoomView_gridPanel--speaking" : ""}`}
                                onClick={() => onFocusMember(member)}
                            >
                                <ParticipantTile
                                    member={member}
                                    isSpeaking={activeSpeakers.has(member.userId)}
                                    isMuted={state?.isMuted ?? false}
                                    isScreenSharing={state?.isScreenSharing ?? false}
                                />
                            </div>
                        );
                    })}
                </>
            )}
        </div>
    );
}
