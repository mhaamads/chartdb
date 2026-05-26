import { useContext } from 'react';
import { aiConfigContext } from '@/context/ai-config-context/ai-config-context';

export const useAIConfig = () => useContext(aiConfigContext);
