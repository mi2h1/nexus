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

const POPOUT_GEOMETRY_KEY = "nx_vc_popout_geometry";

interface PopoutGeometry {
    width: number;
    height: number;
    left: number;
    top: number;
}

function getPopoutFeatures(): string {
    try {
        const saved = localStorage.getItem(POPOUT_GEOMETRY_KEY);
        if (saved) {
            const g: PopoutGeometry = JSON.parse(saved);
            if (g.width > 0 && g.height > 0) {
                return `width=${g.width},height=${g.height},left=${g.left},top=${g.top}`;
            }
        }
    } catch { /* ignore */ }
    return "width=480,height=640";
}

function savePopoutGeometry(child: Window): void {
    try {
        if (child.closed) return;
        const geometry: PopoutGeometry = {
            width: child.outerWidth,
            height: child.outerHeight,
            left: child.screenX,
            top: child.screenY,
        };
        if (geometry.width > 0 && geometry.height > 0) {
            localStorage.setItem(POPOUT_GEOMETRY_KEY, JSON.stringify(geometry));
        }
    } catch { /* ignore */ }
}

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
 * On Tauri, on_new_window intercepts the window.open() call and allows
 * it via NewWindowResponse::Allow.
 */
export function NexusVCPopout({ roomId, onClose }: NexusVCPopoutProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const childRef = useRef<Window | null>(null);
    const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
    const closedRef = useRef(false);

    // Open child window on mount
    useEffect(() => {
        // Reset on remount (React Strict Mode unmounts + remounts effects)
        closedRef.current = false;

        const features = getPopoutFeatures();
        console.log("[NexusVCPopout] Opening child window with features:", features);
        const child = window.open("about:blank", "_blank", features);

        console.log("[NexusVCPopout] window.open() returned:", child);
        console.log("[NexusVCPopout] child === null:", child === null);

        if (!child) {
            console.error("[NexusVCPopout] window.open() returned null — aborting");
            onClose();
            return;
        }

        childRef.current = child;

        // -- Probe child window capabilities --
        try {
            console.log("[NexusVCPopout] child.closed:", child.closed);
            console.log("[NexusVCPopout] child.document:", child.document);
            console.log("[NexusVCPopout] child.document.readyState:", child.document?.readyState);
            console.log("[NexusVCPopout] child.location:", String(child.location));
        } catch (e) {
            console.warn("[NexusVCPopout] Error probing child:", e);
        }

        // -- Close detection --
        const handleClose = (): void => {
            if (closedRef.current) return;
            console.log("[NexusVCPopout] handleClose() called");
            savePopoutGeometry(child);
            closedRef.current = true;
            onClose();
        };

        // Event-based detection
        try {
            child.addEventListener("beforeunload", () => {
                console.log("[NexusVCPopout] child beforeunload fired");
                savePopoutGeometry(child);
            });
            child.addEventListener("unload", () => {
                console.log("[NexusVCPopout] child unload fired, child.closed:", child.closed);
                setTimeout(() => {
                    console.log("[NexusVCPopout] unload timeout — child.closed:", child.closed);
                    if (!closedRef.current && child.closed) handleClose();
                }, 100);
            });
            console.log("[NexusVCPopout] Event listeners attached successfully");
        } catch (e) {
            console.warn("[NexusVCPopout] Failed to attach event listeners:", e);
        }

        // Polling fallback (500ms) — also log child.closed state
        let pollCount = 0;
        const pollId = setInterval(() => {
            pollCount++;
            // Log every 10th poll (every 5 seconds) to avoid spam
            if (pollCount % 10 === 1) {
                try {
                    console.log(`[NexusVCPopout] poll #${pollCount} — child.closed:`, child.closed);
                    // Also try accessing document to detect broken reference
                    void child.document;
                } catch (e) {
                    console.log(`[NexusVCPopout] poll #${pollCount} — child.document access error:`, e);
                    clearInterval(pollId);
                    handleClose();
                    return;
                }
            }
            if (child.closed) {
                console.log("[NexusVCPopout] poll detected child.closed === true");
                clearInterval(pollId);
                handleClose();
            }
        }, 500);

        // -- Geometry persistence --
        try {
            child.addEventListener("resize", () => savePopoutGeometry(child));
        } catch { /* ignore */ }
        const geometrySaveId = setInterval(() => savePopoutGeometry(child), 2000);

        // -- Set up the child document --
        const setupChild = (): void => {
            if (closedRef.current) return;
            try {
                child.document.title = "Nexus VC";
                copyStylesToChild(child);
                const container = child.document.createElement("div");
                container.id = "nx_popout_root";
                child.document.body.appendChild(container);
                setPortalContainer(container);
                console.log("[NexusVCPopout] setupChild() succeeded — portal container set");
            } catch (e) {
                console.warn("[NexusVCPopout] setupChild() failed, retrying in 50ms:", e);
                if (!closedRef.current) {
                    setTimeout(setupChild, 50);
                }
            }
        };
        setupChild();

        return () => {
            console.log("[NexusVCPopout] cleanup — closing child window");
            clearInterval(pollId);
            clearInterval(geometrySaveId);
            savePopoutGeometry(child);
            closedRef.current = true;
            if (!child.closed) {
                child.close();
            }
            childRef.current = null;
            setPortalContainer(null);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    console.log("[NexusVCPopout] render — portalContainer:", portalContainer ? "set" : "null");

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
