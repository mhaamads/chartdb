import React, { useState, useMemo } from 'react';
import {
    aiChatPanelContext,
    type AIChatPanelControlValue,
} from './ai-chat-panel-context';

export const AIChatPanelControlProvider: React.FC<{
    children: React.ReactNode;
}> = ({ children }) => {
    const [open, setOpen] = useState(false);
    const value = useMemo<AIChatPanelControlValue>(
        () => ({
            open,
            setOpen,
            toggle: () => setOpen((v) => !v),
        }),
        [open]
    );
    return (
        <aiChatPanelContext.Provider value={value}>
            {children}
        </aiChatPanelContext.Provider>
    );
};
