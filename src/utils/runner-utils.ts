import axios from 'axios';
import { MockRunnerConfig } from '../types/mock-runner-types';
import logger from '@ondc/automation-logger';

export function getSaveDataConfig(config: MockRunnerConfig, actionId: string) {
    const actionConfig = config.steps?.find(
        step => step.action_id === actionId
    );
    if (!actionConfig) {
        throw new Error(`Action config not found for actionId: ${actionId}`);
    }
    return actionConfig?.mock.saveData;
}

export async function fetchMockRunnerConfigFromService(
    domain: string,
    version: string,
    flowId: string,
    usecaseId: string
) {
    try {
        const data = await axios.get(
            process.env.CONFIG_SERVICE_URL + `/mock/playground`,
            {
                params: {
                    domain,
                    version,
                    flowId,
                    usecase: usecaseId,
                },
            }
        );
        return data.data as MockRunnerConfig;
    } catch (error) {
        logger.error(
            `Failed to fetch mock runner config for ${domain}/${version}/${flowId}/${usecaseId}`,
            {},
            error
        );
        throw error;
    }
}
