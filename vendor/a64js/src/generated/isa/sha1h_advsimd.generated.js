export const ENCODINGS = [
    {
        "instructionId": "SHA1H_advsimd",
        "encodingId": "SHA1H_SS_cryptosha2",
        "mnemonic": "SHA1H",
        "className": "Advanced SIMD",
        "fileName": "sha1h_advsimd.xml",
        "mask": 4294966272,
        "value": 1579681792,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opcode",
                "lsb": 12,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SHA1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SHA1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-crypto-sha1-hash"
    }
];
