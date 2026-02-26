/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

/**
 * Nexus: 身内サーバー運用のため E2EE を強制無効化。
 * matrix.org の .well-known は変更できないのでクライアント側で制御する。
 * 新規ルームは暗号化なしで作成され、暗号化トグルも無効化される。
 */
export function shouldForceDisableEncryption(_client: MatrixClient): boolean {
    // Nexus: 身内サーバー運用のため E2EE を強制無効化
    // matrix.org の .well-known は変更できないのでクライアント側で制御
    return true;
}
