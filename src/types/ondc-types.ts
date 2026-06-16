export type BecknContext = {
    domain: string;
    action: string;
    transaction_id: string;
    bap_uri: string;
    bpp_uri?: string;
    [key: string]: unknown;
};
