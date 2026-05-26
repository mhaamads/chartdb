import { useContext } from 'react';
import { aiChatContext } from '@/context/ai-chat-context/ai-chat-context';

export const useAIChat = () => useContext(aiChatContext);
