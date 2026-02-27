/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useRef, useState, useCallback, type JSX } from "react";
import ReactDOM from "react-dom";
import { PinSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import MatrixClientContext, { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { NexusVCRoomView } from "./NexusVCRoomView";
import { copyStylesToChild } from "../../../utils/popoutStyles";
import { isTauri } from "../../../utils/tauriHttp";

interface NexusVCPopoutProps {
    roomId: string;
    onClose: () => void;
}

/**
 * Opens a popout window via window.open() and renders NexusVCRoomView
 * into it using ReactDOM.createPortal().
 *
 * The child window shares the same origin (about:blank), so MediaStream
 * objects and React portals work seamlessly.
 *
 * On Tauri, on_new_window intercepts the window.open() call and creates
 * a Tauri-managed window with always-on-top enabled by default.
 */
export function NexusVCPopout({ roomId, onClose }: NexusVCPopoutProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const childRef = useRef<Window | null>(null);
    const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
    const [alwaysOnTop, setAlwaysOnTop] = useState(true);
    const closedRef = useRef(false);

    // Open child window on mount
    useEffect(() => {
        const child = window.open(
            "about:blank",
            "_blank",
            "width=480,height=640",
        );

        if (!child) {
            console.error("NexusVCPopout: window.open() returned null");
            onClose();
            return;
        }

        childRef.current = child;

        // Set up the child document
        child.document.title = "Nexus VC";

        // Copy parent styles to child
        copyStylesToChild(child);

        // Create a mount point for the React portal
        const container = child.document.createElement("div");
        container.id = "nx_popout_root";
        child.document.body.appendChild(container);
        setPortalContainer(container);

        // Poll for child window closed (no reliable 'unload' across browsers)
        const pollId = setInterval(() => {
            if (child.closed && !closedRef.current) {
                closedRef.current = true;
                clearInterval(pollId);
                onClose();
            }
        }, 500);

        return () => {
            clearInterval(pollId);
            closedRef.current = true;
            if (!child.closed) {
                child.close();
            }
            childRef.current = null;
            setPortalContainer(null);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Always-on-top toggle (Tauri only)
    const toggleAlwaysOnTop = useCallback(async () => {
        if (!isTauri()) return;
        const newValue = !alwaysOnTop;
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            // Find the popout window label from the child window's __TAURI_INTERNALS__
            const child = childRef.current;
            const label = child && (child as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
            if (label) {
                await invoke("set_popout_always_on_top", { label, enabled: newValue });
                setAlwaysOnTop(newValue);
            }
        } catch (e) {
            console.error("Failed to toggle always-on-top:", e);
        }
    }, [alwaysOnTop]);

    if (!portalContainer) return null;

    return ReactDOM.createPortal(
        <MatrixClientContext.Provider value={client}>
            <div className="nx_VCPopout">
                <div className="nx_VCPopout_topBar">
                    {isTauri() && (
                        <button
                            className={`nx_VCPopout_pinButton ${alwaysOnTop ? "nx_VCPopout_pinButton--active" : ""}`}
                            onClick={toggleAlwaysOnTop}
                            title={alwaysOnTop ? "常に最前面を解除" : "常に最前面に表示"}
                        >
                            <PinSolidIcon width={16} height={16} />
                        </button>
                    )}
                </div>
                <NexusVCRoomView roomId={roomId} isPopout />
            </div>
        </MatrixClientContext.Provider>,
        portalContainer,
    );
}
