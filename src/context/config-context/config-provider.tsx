import React, { useEffect, useState } from 'react';
import { ConfigContext } from './config-context';

import { useStorage } from '@/hooks/use-storage';
import type { ChartDBConfig } from '@/lib/domain/config';

export const ConfigProvider: React.FC<React.PropsWithChildren> = ({
    children,
}) => {
    const { getConfig, updateConfig: updateDataConfig } = useStorage();
    const [config, setConfig] = useState<ChartDBConfig | undefined>();

    useEffect(() => {
        const loadConfig = async () => {
            const config = await getConfig();
            setConfig(config);
        };

        loadConfig();
    }, [getConfig]);

    const updateConfig: ConfigContext['updateConfig'] = async ({
        config: partialConfig,
        updateFn,
    }) => {
        // Use the current config as the base so partial updates don't wipe
        // out other fields. Falls back to an empty default if config hasn't
        // loaded yet.
        const baseConfig: ChartDBConfig = config ?? { defaultDiagramId: '' };
        const updatedConfig = updateFn
            ? updateFn(baseConfig)
            : { ...baseConfig, ...partialConfig };

        setConfig(updatedConfig);
        await updateDataConfig(updatedConfig);
    };

    return (
        <ConfigContext.Provider
            value={{
                config,
                updateConfig,
            }}
        >
            {children}
        </ConfigContext.Provider>
    );
};
