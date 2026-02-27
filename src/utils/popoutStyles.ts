/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Copy all stylesheets and theme attributes from the parent window
 * to a child window opened via window.open().
 *
 * This is needed because child windows created by window.open('about:blank')
 * share the same origin but do NOT inherit any styles.
 *
 * Returns a Promise that resolves when all <link> stylesheets have loaded.
 */
export function copyStylesToChild(child: Window): Promise<void> {
    const parentDoc = document;
    const childDoc = child.document;

    const linkPromises: Promise<void>[] = [];

    // Copy <link rel="stylesheet"> tags
    parentDoc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
        const clone = childDoc.createElement("link");
        clone.rel = "stylesheet";
        clone.href = link.href;
        if (link.type) clone.type = link.type;
        if (link.media) clone.media = link.media;
        childDoc.head.appendChild(clone);
        linkPromises.push(
            new Promise<void>((resolve) => {
                clone.onload = () => resolve();
                clone.onerror = () => resolve(); // Don't block on failed loads
            }),
        );
    });

    // Copy <style> tags
    parentDoc.querySelectorAll<HTMLStyleElement>("style").forEach((style) => {
        const clone = childDoc.createElement("style");
        clone.textContent = style.textContent;
        childDoc.head.appendChild(clone);
    });

    // Copy class and data attributes from <html> (theme variables)
    const parentHtml = parentDoc.documentElement;
    const childHtml = childDoc.documentElement;
    childHtml.className = parentHtml.className;
    for (const attr of Array.from(parentHtml.attributes)) {
        if (attr.name.startsWith("data-") || attr.name === "class") {
            childHtml.setAttribute(attr.name, attr.value);
        }
    }

    // Copy class and data attributes from <body>
    childDoc.body.className = parentDoc.body.className;
    for (const attr of Array.from(parentDoc.body.attributes)) {
        if (attr.name.startsWith("data-") || attr.name === "class") {
            childDoc.body.setAttribute(attr.name, attr.value);
        }
    }

    return Promise.all(linkPromises).then(() => {});
}
