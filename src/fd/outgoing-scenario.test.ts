import { fdSendHeaders, scenarioDirectives } from './outgoing';

describe('FD scenario directives on the send', () => {
    it('keeps what makes the workbench deviate, never userInputs', () => {
        expect(
            scenarioDirectives({
                expectError: 'FD-PRODUCT-0007',
                userInputs: { pan: 'ABCDE1234F' },
                retry: false,
            })
        ).toEqual({ expectError: 'FD-PRODUCT-0007' });
        expect(scenarioDirectives({ userInputs: { a: 1 } })).toBeUndefined();
        expect(scenarioDirectives(undefined)).toBeUndefined();
    });

    it('names them in X-Pwb-Fd-Scenario', () => {
        const headers = fdSendHeaders({
            pathParams: {},
            scenario: { expectError: 'FD-PRODUCT-0007' },
        });
        expect(headers['X-Pwb-Fd-Scenario']).toBe(
            '{"expectError":"FD-PRODUCT-0007"}'
        );
        expect(fdSendHeaders({ pathParams: {} })['X-Pwb-Fd-Scenario']).toBe(
            undefined
        );
    });
});
