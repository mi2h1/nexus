/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { Form } from "@vector-im/compound-web";
import React, { type JSX, useCallback } from "react";
import { Flex, type VirtualizedListContext, VirtualizedList } from "@element-hq/web-shared-components";

import {
    type MemberWithSeparator,
    type NexusSectionHeader,
    SEPARATOR,
    useMemberListViewModel,
} from "../../../viewmodels/memberlist/MemberListViewModel";
import { RoomMemberTileView } from "./tiles/RoomMemberTileView";
import { ThreePidInviteTileView } from "./tiles/ThreePidInviteTileView";
import { MemberListHeaderView } from "./MemberListHeaderView";
import BaseCard from "../../right_panel/BaseCard";
import { _t } from "../../../../languageHandler";

interface IProps {
    roomId: string;
    onClose: () => void;
}

/**
 * Height of a single member list item
 */
const MEMBER_LIST_ITEM_HEIGHT = 56;
/**
 * Amount to extend the top and bottom of the viewport by.
 * From manual testing 15 items seems to be enough to never really see the blank space when scrolling.
 */
const EXTENDED_VIEWPORT_HEIGHT = 15 * MEMBER_LIST_ITEM_HEIGHT;

const MemberListView: React.FC<IProps> = (props: IProps) => {
    const vm = useMemberListViewModel(props.roomId);
    const { isPresenceEnabled, memberCount } = vm;

    const getItemKey = useCallback((item: MemberWithSeparator): string => {
        if (item === SEPARATOR) {
            return "separator";
        } else if ("nexusSectionHeader" in (item as object)) {
            const header = item as NexusSectionHeader;
            return `nexus-section-${header.nexusSectionHeader}`;
        } else if ((item as any).member) {
            return `member-${(item as any).member.userId}`;
        } else {
            return `threePidInvite-${(item as any).threePidInvite.event.getContent().public_key}`;
        }
    }, []);

    const getItemComponent = useCallback(
        (
            index: number,
            item: MemberWithSeparator,
            context: VirtualizedListContext<any>,
            onFocus: (item: MemberWithSeparator, e: React.FocusEvent) => void,
        ): JSX.Element => {
            const itemKey = getItemKey(item);
            const isRovingItem = itemKey === context.tabIndexKey;
            const focused = isRovingItem && context.focused;
            if (item === SEPARATOR) {
                return <hr className="mx_MemberListView_separator" />;
            } else if ("nexusSectionHeader" in (item as object)) {
                const header = item as NexusSectionHeader;
                const label = header.nexusSectionHeader === "online" ? "オンライン" : "オフライン";
                return (
                    <div className="mx_MemberListView_sectionHeader">
                        <span>{label} — {header.count}</span>
                    </div>
                );
            } else if ((item as any).member) {
                return (
                    <RoomMemberTileView
                        item={item}
                        member={(item as any).member}
                        showPresence={isPresenceEnabled}
                        focused={focused}
                        tabIndex={isRovingItem ? 0 : -1}
                        index={index}
                        memberCount={memberCount}
                        onFocus={onFocus}
                    />
                );
            } else {
                return (
                    <ThreePidInviteTileView
                        item={item}
                        threePidInvite={item.threePidInvite}
                        focused={focused}
                        tabIndex={isRovingItem ? 0 : -1}
                        memberIndex={index - 1} // Adjust as invites are below the separator
                        memberCount={memberCount}
                        onFocus={onFocus}
                    />
                );
            }
        },
        [isPresenceEnabled, getItemKey, memberCount],
    );

    const isItemFocusable = useCallback((item: MemberWithSeparator): boolean => {
        if (item === SEPARATOR) return false;
        if ("nexusSectionHeader" in (item as object)) return false;
        return true;
    }, []);

    return (
        <BaseCard
            id="memberlist-panel"
            className="mx_MemberListView"
            ariaLabelledBy="memberlist-panel-tab"
            role="tabpanel"
            header="メンバー"
            onClose={props.onClose}
        >
            <Flex align="stretch" direction="column" className="mx_MemberListView_container">
                <Form.Root onSubmit={(e) => e.preventDefault()}>
                    <MemberListHeaderView vm={vm} />
                </Form.Root>
                <VirtualizedList
                    items={vm.members}
                    getItemComponent={getItemComponent}
                    getItemKey={getItemKey}
                    isItemFocusable={isItemFocusable}
                    role="listbox"
                    aria-label={_t("member_list|list_title")}
                    fixedItemHeight={MEMBER_LIST_ITEM_HEIGHT}
                    increaseViewportBy={{
                        bottom: EXTENDED_VIEWPORT_HEIGHT,
                        top: EXTENDED_VIEWPORT_HEIGHT,
                    }}
                />
            </Flex>
        </BaseCard>
    );
};

export default MemberListView;
