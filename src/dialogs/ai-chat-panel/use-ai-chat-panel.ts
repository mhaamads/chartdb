import { useContext } from 'react';
import { aiChatPanelContext } from './ai-chat-panel-context';

export const useAIChatPanel = () => useContext(aiChatPanelContext);
