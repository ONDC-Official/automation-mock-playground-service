import { checkPerfectAck, reduceApiDataList } from './reduce-history';
import { HistoryType } from '../../../types/cache-types';

const FD = 'ONDC:FIS14:FD';
const ctx = (messageId: string) => ({
    domain: FD,
    action: 'application_create',
    message_id: messageId,
});
const ack = { message: { ack: { status: 'ACK' } } };

describe('checkPerfectAck — FD (ONDC:FIS14:FD)', () => {
    it('an ACK to an async request (fd-gate sends it as 202) that echoes context is perfect', () => {
        expect(checkPerfectAck({ context: ctx('m1'), ...ack }, FD, 'm1')).toBe(
            'SUCCESS'
        );
    });

    it('an ACK that does not echo context is not', () => {
        expect(checkPerfectAck(ack, FD, 'm1')).toBe('ERROR');
    });

    it('an ACK echoing another message’s context is not', () => {
        expect(checkPerfectAck({ context: ctx('m2'), ...ack }, FD, 'm1')).toBe(
            'ERROR'
        );
    });

    it('a NACK, or any body with an error, is not', () => {
        expect(
            checkPerfectAck(
                {
                    context: ctx('m1'),
                    message: { ack: { status: 'NACK' } },
                    error: { code: 'FD-PWB-0030' },
                },
                FD,
                'm1'
            )
        ).toBe('ERROR');
        expect(
            checkPerfectAck(
                { context: ctx('m9'), message: {}, error: { code: 'X' } },
                FD
            )
        ).toBe('ERROR');
    });

    it('a SYNC answer (a business body with its own message_id) is perfect', () => {
        expect(
            checkPerfectAck(
                {
                    context: ctx('m-answer'),
                    fdEnvelope: { inReplyTo: 'm1' },
                    message: { quote: { quoteId: 'Q-1' } },
                },
                FD,
                'm1'
            )
        ).toBe('SUCCESS');
    });

    it('reduceApiDataList applies the FD rule when given the FD domain', () => {
        const entry: HistoryType = {
            entryType: 'API',
            action: 'application_create',
            payloadId: 'p1',
            messageId: 'm1',
            response: ack,
            timestamp: '2026-10-29T10:00:00.000Z',
        };
        const [fd] = reduceApiDataList([entry], FD);
        const [beckn] = reduceApiDataList([entry]);
        expect(fd).toMatchObject({ subStatus: 'ERROR' });
        expect(beckn).toMatchObject({ subStatus: 'SUCCESS' });
    });
});

describe('checkPerfectAck — Beckn unchanged', () => {
    it('ACK without context is still perfect; NACK is not; a business body is not', () => {
        expect(checkPerfectAck(ack)).toBe('SUCCESS');
        expect(checkPerfectAck(ack, 'ONDC:RET10', 'm1')).toBe('SUCCESS');
        expect(checkPerfectAck({ message: { ack: { status: 'NACK' } } })).toBe(
            'ERROR'
        );
        expect(
            checkPerfectAck({ context: ctx('m1'), message: { order: {} } })
        ).toBe('ERROR');
    });
});
