export const ENCODINGS = [
    {
        "instructionId": "SHA1P_advsimd",
        "encodingId": "SHA1P_QSV_cryptosha3",
        "mnemonic": "SHA1P",
        "className": "Advanced SIMD",
        "fileName": "sha1p_advsimd.xml",
        "mask": 4292934656,
        "value": 1577062400,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 12,
                "width": 3
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
        "operandFamilyId": "advsimd-crypto-sha1-three-reg"
    }
];
