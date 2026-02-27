/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useEffect, useRef, useState, type JSX } from "react";
import ReactDOM from "react-dom";

import MatrixClientContext, { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { NexusVCRoomView } from "./NexusVCRoomView";
import { copyStylesToChild } from "../../../utils/popoutStyles";
import { isTauri } from "../../../utils/tauriHttp";

interface NexusVCPopoutProps {
    roomId: string;
    /** Pre-opened child window (Document PiP or window.open fallback). */
    childWindow: Window;
    onClose: () => void;
}

/**
 * Renders NexusVCRoomView into a pre-opened child window using
 * ReactDOM.createPortal(). The child window is opened by the caller
 * (Document PiP preferred, window.open fallback).
 */
export function NexusVCPopout({ roomId, childWindow, onClose }: NexusVCPopoutProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
    // Timer ref for deferred window close — allows Strict Mode remount to cancel
    const closeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        // Cancel any pending close scheduled by a Strict Mode cleanup
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;

        const child = childWindow;
        let closed = false;

        // If the window was already closed (shouldn't happen), bail out
        if (child.closed) {
            onClose();
            return;
        }

        // -- Set up the child document --
        const setupChild = (): void => {
            if (closed) return;
            try {
                child.document.title = "Nexus VC";
                copyStylesToChild(child);
                const container = child.document.createElement("div");
                container.id = "nx_popout_root";
                child.document.body.appendChild(container);
                setPortalContainer(container);
                // Show the window now that styles are applied (Tauri creates it hidden)
                if (isTauri()) {
                    import("@tauri-apps/api/webviewWindow").then(({ WebviewWindow }) => {
                        WebviewWindow.getByLabel("vc-popout")?.show();
                    }).catch(() => {});
                }
            } catch {
                // Document may not be ready immediately (e.g., window.open + Allow).
                if (!closed) setTimeout(setupChild, 50);
            }
        };
        setupChild();

        // -- Close detection --
        const handleClose = (): void => {
            if (closed) return;
            closed = true;
            onClose();
        };

        // pagehide: reliable for Document PiP; also fires for window.open
        child.addEventListener("pagehide", handleClose);

        // unload: additional signal for window.open popups
        const onUnload = (): void => {
            setTimeout(() => {
                if (!closed && child.closed) handleClose();
            }, 100);
        };
        child.addEventListener("unload", onUnload);

        // Polling fallback for window.open (child.closed may not flip on all platforms)
        const pollId = setInterval(() => {
            if (child.closed && !closed) {
                clearInterval(pollId);
                handleClose();
            }
        }, 500);

        return () => {
            clearInterval(pollId);
            closed = true;
            setPortalContainer(null);
            // Defer window close so Strict Mode remount can cancel it.
            // Real unmounts: the timer fires and closes the window.
            // Strict Mode: the remount clears the timer before it fires.
            closeTimerRef.current = setTimeout(() => {
                if (!child.closed) child.close();
            }, 0);
        };
    }, [childWindow]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!portalContainer) return null;

    return ReactDOM.createPortal(
        <MatrixClientContext.Provider value={client}>
            <div className="nx_VCPopout">
                <NexusVCRoomView roomId={roomId} isPopout />
            </div>
        </MatrixClientContext.Provider>,
        portalContainer,
    );
}
