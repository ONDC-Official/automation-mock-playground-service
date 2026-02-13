import { randomUUID } from 'crypto';
import { createApiServiceURL } from '../service/jobs/api-service-request';

export function createGenericContext(
    domain: string,
    version: string,
    action: string,
    transactionId: string,
    subscriberUrl: string
) {
    let bapUri = '',
        bppUri = '';

    if (action.startsWith('on_')) {
        bapUri = subscriberUrl;
        bppUri = createApiServiceURL(version, '/seller', domain);
    } else {
        bppUri = subscriberUrl;
        bapUri = createApiServiceURL(version, '/buyer', domain);
    }

    if (version.startsWith('2')) {
        return {
            domain: domain,
            version: version,
            action: action,
            message_id: randomUUID(),
            transaction_id: transactionId,
            timestamp: new Date().toISOString(),
            bap_uri: bapUri,
            bpp_uri: bppUri,
            location: {
                country: {
                    code: 'IND',
                },
                city: {
                    code: '*',
                },
            },
        };
    } else {
        return {
            domain: domain,
            core_version: version,
            action: action,
            message_id: randomUUID(),
            transaction_id: transactionId,
            timestamp: new Date().toISOString(),
            bap_uri: bapUri,
            bpp_uri: bppUri,
            city: '*',
            country: 'IND',
        };
    }
}
