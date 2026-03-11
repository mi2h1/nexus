/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useCallback, useEffect } from "react";
import { useCreateAutoDisposedViewModel, DisambiguatedProfileView } from "@element-hq/web-shared-components";

import { type RoomMember } from "../../../../../models/rooms/RoomMember";
import { useMemberTileViewModel } from "../../../../viewmodels/memberlist/tiles/MemberTileViewModel";
import { E2EIconView } from "./common/E2EIconView";
import AvatarPresenceIconView from "./common/PresenceIconView";
import BaseAvatar from "../../../avatars/BaseAvatar";
import { _t } from "../../../../../languageHandler";
import { MemberTileView } from "./common/MemberTileView";
import { NexusUserPresenceStore, NexusUserPresenceStoreEvent } from "../../../../../stores/NexusUserPresenceStore";
import { useEventEmitterState } from "../../../../../hooks/useEventEmitter";
import { InvitedIconView } from "./common/InvitedIconView";
import { type MemberWithSeparator } from "../../../../viewmodels/memberlist/MemberListViewModel";
import { DisambiguatedProfileViewModel } from "../../../../../viewmodels/profile/DisambiguatedProfileViewModel";

interface IProps {
    /**
     * Needed for `onFocus`
     */
    item: MemberWithSeparator;
    member: RoomMember;
    index: number;
    memberCount: number;
    showPresence?: boolean;
    focused?: boolean;
    tabIndex?: number;
    onFocus: (item: MemberWithSeparator, e: React.FocusEvent) => void;
}

export function RoomMemberTileView(props: IProps): JSX.Element {
    const vm = useMemberTileViewModel(props);
    const member = vm.member;
    const av = (
        <BaseAvatar
            size="32px"
            name={member.name}
            idName={member.userId}
            title={member.displayUserId}
            url={member.avatarThumbnailUrl}
            altText={_t("common|user_avatar")}
        />
    );
    const name = vm.name;
    const disambiguatedProfileVM = useCreateAutoDisposedViewModel(
        () =>
            new DisambiguatedProfileViewModel({
                fallbackName: name,
                member,
                withTooltip: true,
                className: "mx_DisambiguatedProfile",
            }),
    );
    useEffect(() => {
        disambiguatedProfileVM.setMember(name, member);
    }, [disambiguatedProfileVM, member, name]);
    const nameJSX = <DisambiguatedProfileView vm={disambiguatedProfileVM} />;

    const presenceState = member.presenceState;
    let presenceJSX: JSX.Element | undefined;
    if (vm.showPresence && presenceState) {
        presenceJSX = <AvatarPresenceIconView presenceState={presenceState} />;
    }

    // バージョンカウンターでpresence変化時に強制再レンダリング。
    // useEventEmitterState は VirtualizedList のコンポーネントリサイクル時に
    // stale な値を保持するため、同期的に読み取る方式を使用。
    useEventEmitterState(
        NexusUserPresenceStore.instance,
        NexusUserPresenceStoreEvent.PresencesChanged,
        useCallback(() => undefined, []),
    );
    const nexusPresence = NexusUserPresenceStore.instance.getPresence(member.userId);

    let iconJsx;
    if (vm.e2eStatus) {
        iconJsx = <E2EIconView status={vm.e2eStatus} />;
    }
    if (member.isInvite) {
        iconJsx = <InvitedIconView isThreePid={false} />;
    }

    const nexusStatusDot = (
        <span className={`mx_NexusMemberTile_statusDot mx_NexusMemberTile_statusDot--${nexusPresence}`} />
    );

    return (
        <MemberTileView
            onClick={vm.onClick}
            onFocus={(e) => props.onFocus(props.item, e)}
            avatarJsx={av}
            presenceJsx={presenceJSX ?? nexusStatusDot}
            nameJsx={nameJSX}
            userLabel={vm.userLabel}
            ariaLabel={name}
            iconJsx={iconJsx}
            focused={props.focused}
            tabIndex={props.tabIndex}
            memberIndex={props.index - (member.isInvite ? 1 : 0)} // Adjust as invites are below the seperator
            memberCount={props.memberCount}
        />
    );
}
