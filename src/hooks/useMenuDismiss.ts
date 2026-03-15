/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useEffect, type RefObject, type SyntheticEvent } from "react";

/**
 * Close when clicking/tapping outside the given ref element.
 * Uses pointerdown (not mousedown) because Firefox dispatches spurious
 * mouse events from range-input drags that can close the menu.
 */
export function useClickOutside(
    ref: RefObject<HTMLElement | null>,
    onClose: () => void,
    portalContainer?: HTMLElement,
): void {
    useEffect(() => {
        const doc = portalContainer?.ownerDocument ?? document;
        const handler = (e: PointerEvent): void => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        doc.addEventListener("pointerdown", handler);
        return () => doc.removeEventListener("pointerdown", handler);
    }, [ref, onClose, portalContainer]);
}

/**
 * Close on Escape key.
 */
export function useEscapeKey(onClose: () => void, portalContainer?: HTMLElement): void {
    useEffect(() => {
        const doc = portalContainer?.ownerDocument ?? document;
        const handler = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onClose();
        };
        doc.addEventListener("keydown", handler);
        return () => doc.removeEventListener("keydown", handler);
    }, [onClose, portalContainer]);
}

/** Stop pointer/mouse/focus events from bubbling to RovingTabIndex ancestors. */
export function stopBubble(e: SyntheticEvent): void {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
}
