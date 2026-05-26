import { createContext } from 'react';

export interface AIChatPanelControlValue {
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
}

export const aiChatPanelContext = createContext<AIChatPanelControlValue>({
    open: false,
    setOpen: () => {},
    toggle: () => {},
});
