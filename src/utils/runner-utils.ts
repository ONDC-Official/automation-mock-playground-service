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

export function getConfigStep(
    config: MockRunnerConfig,
    actionId: string
): MockRunnerConfig['steps'][0] {
    const actionConfig = config.steps?.find(
        step => step.action_id === actionId
    );
    if (!actionConfig) {
        throw new Error(`Action config not found for actionId: ${actionId}`);
    }
    return actionConfig;
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

// export function createMockSubscriberID(mockType: 'BAP' | 'BPP') {
//     let apiServiceUrl =
//         process.env.API_SERVICE_URL ||
//         'https://dev-automation.ondc.org/api-service';
//     if (apiServiceUrl.endsWith('/')) {
//         apiServiceUrl = apiServiceUrl.slice(0, -1);
//     }
//     const ownerId = apiServiceUrl.split('//')[1].split('/')[0];
//     playgroundConfig.transaction_data.bap_id =
//         playgroundConfig.transaction_data.bpp_id = ownerId;
//     playgroundConfig.transaction_data.bap_uri = `${apiServiceUrl}/${playgroundConfig.meta.domain}/${playgroundConfig.meta.version}/buyer`;
//     playgroundConfig.transaction_data.bpp_uri = `${apiServiceUrl}/${playgroundConfig.meta.domain}/${playgroundConfig.meta.version}/seller`;
// }
