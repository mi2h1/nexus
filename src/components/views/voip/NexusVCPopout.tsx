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

        // Poll for child window closed
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
