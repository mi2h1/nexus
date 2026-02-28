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

// Pre-cache the Tauri invoke function so popout show/close don't pay
// the dynamic import cost on the hot path.
let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
function getTauriInvoke(): Promise<typeof _invoke> {
    if (_invoke) return Promise.resolve(_invoke);
    return import("@tauri-apps/api/core").then(({ invoke }) => {
        _invoke = invoke;
        return invoke;
    }).catch(() => null);
}
// Kick off the preload immediately at module load time
if (isTauri()) getTauriInvoke();

interface NexusVCPopoutProps {
    roomId: string;
    /** Pre-opened child window (Document PiP or window.open fallback). */
    childWindow: Window;
    onClose: () => void;
}

/** Close the vc-popout window via Tauri invoke (bypasses WebviewWindow class). */
async function closeTauriPopout(): Promise<void> {
    const invoke = await getTauriInvoke();
    invoke?.("plugin:window|close", { label: "vc-popout" }).catch(() => {});
}

/** Show the vc-popout window via Tauri invoke. */
async function showTauriPopout(): Promise<void> {
    const invoke = await getTauriInvoke();
    invoke?.("plugin:window|show", { label: "vc-popout" }).catch(() => {});
}

/**
 * Renders NexusVCRoomView into a pre-opened child window using
 * ReactDOM.createPortal(). The child window is opened by the caller.
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
                // Wait for popout.html to load (skip the transient about:blank)
                if (child.location.href === "about:blank") {
                    if (!closed) setTimeout(setupChild, 50);
                    return;
                }
                child.document.title = "Nexus VC";
                // Read current theme background and apply immediately to avoid flash
                const bg = getComputedStyle(document.documentElement)
                    .getPropertyValue("--cpd-color-bg-canvas-default").trim() || "#15191E";
                child.document.documentElement.style.backgroundColor = bg;
                child.document.body.style.backgroundColor = bg;
                child.document.body.style.margin = "0";

                // Full-screen overlay to hide unstyled content while
                // stylesheets load (prevents FOUC)
                const overlay = child.document.createElement("div");
                overlay.id = "nx_popout_overlay";
                overlay.style.cssText = `
                    position: fixed; inset: 0; z-index: 999999;
                    background-color: ${bg};
                `;
                child.document.body.appendChild(overlay);

                // Show the window immediately — overlay hides unstyled content
                if (isTauri()) showTauriPopout();

                const container = child.document.createElement("div");
                container.id = "nx_popout_root";
                child.document.body.appendChild(container);

                // Copy styles — remove overlay once stylesheets are ready.
                // WebView2 may not fire <link> onload reliably, so also use
                // a timeout fallback.
                const removeOverlay = (): void => {
                    if (overlay.parentNode) overlay.remove();
                };
                copyStylesToChild(child).then(() => {
                    if (!closed) removeOverlay();
                });
                setTimeout(removeOverlay, 500);

                setPortalContainer(container);
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
                closeTauriPopout();
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
