/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState, useRef, useEffect, useCallback, type JSX, useMemo } from "react";
import ReactDOM from "react-dom";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { useVCParticipants } from "../../../hooks/useVCParticipants";
import { useNexusScreenShares } from "../../../hooks/useNexusScreenShares";
import { useNexusActiveSpeakers } from "../../../hooks/useNexusActiveSpeakers";
import { useNexusParticipantStates } from "../../../hooks/useNexusParticipantStates";
import { useNexusWatchingScreenShares } from "../../../hooks/useNexusWatchingScreenShares";
import { ScreenShareTile } from "./NexusScreenShareView";
import { ParticipantTile } from "./NexusVoiceParticipantGrid";
import { NexusVCControlBar, type VCLayoutMode } from "./NexusVCControlBar";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import type { ScreenShareInfo } from "../../../models/Call";
import MemberAvatar from "../avatars/MemberAvatar";
import AccessibleButton from "../elements/AccessibleButton";
import { VisibilityOffIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import { NexusVCPopout } from "./NexusVCPopout";

interface NexusVCRoomViewProps {
    roomId: string;
    /** True when rendered inside a popout window via createPortal. */
    isPopout?: boolean;
}

const SPEAKER_DEBOUNCE_MS = 2000;

/**
 * Unified VC room view with spotlight/grid layout modes and a control bar.
 */
export function NexusVCRoomView({ roomId, isPopout = false }: NexusVCRoomViewProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const { members: rawParticipants, connected } = useVCParticipants(roomId);
    const [poppedOut, setPoppedOut] = useState(false);
    // Filter to resolved RoomMembers for layout components
    const members = useMemo(
        () => rawParticipants.filter((p) => p.member !== null).map((p) => p.member!),
        [rawParticipants],
    );
    const screenShares = useNexusScreenShares(roomId);
    const activeSpeakers = useNexusActiveSpeakers();
    const participantStates = useNexusParticipantStates();

    const [layoutMode, setLayoutMode] = useState<VCLayoutMode>("spotlight");

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
        const onPointerDown = (e: PointerEvent): void => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setViewContextMenu(null);
            }
        };
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === "Escape") setViewContextMenu(null);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
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

    // Debounced spotlight target based on active speaker (only watched screen shares)
    const spotlightTarget = useSpotlightTarget(client.getUserId(), visibleMembers, watchedScreenShares, activeSpeakers);

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
    if (poppedOut && !isPopout) {
        return (
            <div className="nx_VCRoomView">
                <div className="nx_VCRoomView_popoutPlaceholder">
                    <div className="nx_VCRoomView_popoutPlaceholderText">
                        VC は別ウィンドウで表示中
                    </div>
                    <AccessibleButton
                        className="nx_VCRoomView_popoutRestoreButton"
                        onClick={() => setPoppedOut(false)}
                    >
                        元に戻す
                    </AccessibleButton>
                </div>
                <NexusVCPopout roomId={roomId} onClose={() => setPoppedOut(false)} />
            </div>
        );
    }

    return (
        <div className="nx_VCRoomView">
            <div className="nx_VCRoomView_content" onContextMenu={onViewContextMenu}>
                {layoutMode === "spotlight" ? (
                    <SpotlightLayout
                        spotlightTarget={spotlightTarget}
                        screenShares={watchedScreenShares}
                        unwatchedScreenShares={unwatchedScreenShares}
                        onStartWatching={startWatching}
                        onStopWatching={stopWatching}
                        onShareContextMenu={onShareContextMenu}
                        members={visibleMembers}
                        activeSpeakers={activeSpeakers}
                        participantStates={participantStates}
                        myUserId={client.getUserId()}
                        hideNonScreenSharePanels={hideNonScreenSharePanels}
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
                    />
                )}
            </div>
            <NexusVCControlBar
                roomId={roomId}
                layoutMode={layoutMode}
                onLayoutModeChange={setLayoutMode}
                participantCount={members.length}
                onPopout={!isPopout ? () => setPoppedOut(true) : undefined}
            />
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
}

const NexusVCViewContextMenu = React.forwardRef<HTMLDivElement, NexusVCViewContextMenuProps>(
    function NexusVCViewContextMenu(
        { left, top, share, hideNonScreenSharePanels, onHideNonScreenSharePanelsChange, onStopWatching, onClose },
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
                                max="1"
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
                            <VisibilityOffIcon width={18} height={18} />
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
            document.body,
        );
    },
);

// ─── Spotlight target resolution ─────────────────────────────

type SpotlightTarget =
    | { type: "screenshare"; share: ScreenShareInfo }
    | { type: "member"; member: RoomMember };

function useSpotlightTarget(
    myUserId: string | null,
    members: RoomMember[],
    screenShares: ScreenShareInfo[],
    activeSpeakers: Set<string>,
): SpotlightTarget | null {
    // Debounce speaker-based changes to avoid flickering
    const [debouncedSpeaker, setDebouncedSpeaker] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Find first active speaker that isn't me
    const otherSpeaker = useMemo(() => {
        for (const userId of activeSpeakers) {
            if (userId !== myUserId) return userId;
        }
        return null;
    }, [activeSpeakers, myUserId]);

    useEffect(() => {
        if (otherSpeaker === debouncedSpeaker) return;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setDebouncedSpeaker(otherSpeaker);
        }, SPEAKER_DEBOUNCE_MS);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [otherSpeaker, debouncedSpeaker]);

    // Priority 1: screen share
    if (screenShares.length > 0) {
        return { type: "screenshare", share: screenShares[0] };
    }

    // Priority 2: debounced active speaker (not me)
    if (debouncedSpeaker) {
        const member = members.find((m) => m.userId === debouncedSpeaker);
        if (member) return { type: "member", member };
    }

    // Priority 3: first other member
    const otherMember = members.find((m) => m.userId !== myUserId);
    if (otherMember) return { type: "member", member: otherMember };

    // Priority 4: myself
    if (members.length > 0) return { type: "member", member: members[0] };

    return null;
}

// ─── Spotlight layout ─────────────────────────────────────────

interface SpotlightLayoutProps {
    spotlightTarget: SpotlightTarget | null;
    screenShares: ScreenShareInfo[];
    unwatchedScreenShares: ScreenShareInfo[];
    onStartWatching: (id: string) => void;
    onStopWatching: (id: string) => void;
    onShareContextMenu: (share: ScreenShareInfo, left: number, top: number) => void;
    members: RoomMember[];
    activeSpeakers: Set<string>;
    participantStates: Map<string, { isMuted: boolean; isScreenSharing: boolean }>;
    myUserId: string | null;
    /** True when non-screen-share panels are hidden via context menu. */
    hideNonScreenSharePanels?: boolean;
}

function SpotlightLayout({
    spotlightTarget,
    screenShares,
    unwatchedScreenShares,
    onStartWatching,
    onStopWatching,
    onShareContextMenu,
    members,
    activeSpeakers,
    participantStates,
    myUserId,
    hideNonScreenSharePanels,
}: SpotlightLayoutProps): JSX.Element {
    // Manual screen share selection (null = auto from spotlightTarget)
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
        return spotlightTarget;
    }, [manualScreenShareId, screenShares, spotlightTarget]);

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
        <div className="nx_VCRoomView_spotlight">
            <div className="nx_VCRoomView_spotlightMain">
                {effectiveTarget?.type === "screenshare" ? (
                    <ScreenShareTile
                        share={effectiveTarget.share}
                        onStopWatching={effectiveTarget.share.isLocal ? undefined : () => onStopWatching(effectiveTarget.share.participantIdentity)}
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
            </div>
            {hasBottomBar && (
                <div className="nx_VCRoomView_spotlightBottomBar">
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
                            <ScreenShareTile share={share} />
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
}: GridLayoutProps): JSX.Element {
    const isEmpty = hideNonScreenSharePanels && screenShares.length === 0 && unwatchedScreenShares.length === 0;

    return (
        <div className="nx_VCRoomView_grid">
            {isEmpty && (
                <div className="nx_VCRoomView_gridEmpty">
                    画面を共有しているユーザーはいません
                </div>
            )}
            {screenShares.map((share) => (
                <div key={`ss-${share.participantIdentity}`} className="nx_VCRoomView_gridScreenShare">
                    <ScreenShareTile
                        share={share}
                        onStopWatching={share.isLocal ? undefined : () => onStopWatching(share.participantIdentity)}
                        onShareContextMenu={onShareContextMenu}
                    />
                </div>
            ))}
            {unwatchedScreenShares.map((share) => (
                <div
                    key={`preview-${share.participantIdentity}`}
                    className="nx_VCRoomView_gridScreenShare nx_VCRoomView_gridScreenSharePreview"
                    onClick={() => onStartWatching(share.participantIdentity)}
                >
                    <ScreenShareTile share={share} />
                    <div className="nx_VCRoomView_screenSharePreview_overlay">
                        <div className="nx_VCRoomView_screenSharePreview_button">
                            画面を視聴する
                        </div>
                    </div>
                </div>
            ))}
            {members.map((member) => {
                const state = participantStates.get(member.userId);
                return (
                    <ParticipantTile
                        key={member.userId}
                        member={member}
                        isSpeaking={activeSpeakers.has(member.userId)}
                        isMuted={state?.isMuted ?? false}
                        isScreenSharing={state?.isScreenSharing ?? false}
                    />
                );
            })}
        </div>
    );
}
