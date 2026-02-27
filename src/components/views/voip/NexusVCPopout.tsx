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
        const features = getPopoutFeatures();
        const child = window.open("about:blank", "_blank", features);

        if (!child) {
            console.error("NexusVCPopout: window.open() returned null");
            onClose();
            return;
        }

        childRef.current = child;

        // -- Close detection --
        const handleClose = (): void => {
            if (closedRef.current) return;
            savePopoutGeometry(child);
            closedRef.current = true;
            onClose();
        };

        // Event-based detection (fires before the child window fully closes)
        try {
            child.addEventListener("beforeunload", () => savePopoutGeometry(child));
            child.addEventListener("unload", () => {
                // unload fires when the document unloads; check after a tick
                setTimeout(() => {
                    if (!closedRef.current && child.closed) handleClose();
                }, 100);
            });
        } catch { /* cross-origin fallback: rely on polling */ }

        // Polling fallback (500ms)
        const pollId = setInterval(() => {
            if (child.closed) {
                clearInterval(pollId);
                handleClose();
            }
        }, 500);

        // -- Geometry persistence --
        try {
            child.addEventListener("resize", () => savePopoutGeometry(child));
        } catch { /* ignore */ }
        // Periodic save to capture window moves (no "move" event in browsers)
        const geometrySaveId = setInterval(() => savePopoutGeometry(child), 2000);

        // -- Set up the child document (with retry for Create mode) --
        const setupChild = (): void => {
            if (closedRef.current) return;
            try {
                child.document.title = "Nexus VC";
                copyStylesToChild(child);
                const container = child.document.createElement("div");
                container.id = "nx_popout_root";
                child.document.body.appendChild(container);
                setPortalContainer(container);
            } catch {
                // With NewWindowResponse::Create, the document may not be
                // ready immediately. Retry after a short delay.
                if (!closedRef.current) {
                    setTimeout(setupChild, 50);
                }
            }
        };
        setupChild();

        return () => {
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
