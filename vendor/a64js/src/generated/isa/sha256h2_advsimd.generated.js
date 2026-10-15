export const ENCODINGS = [
    {
        "instructionId": "SHA256H2_advsimd",
        "encodingId": "SHA256H2_QQV_cryptosha3",
        "mnemonic": "SHA256H2",
        "className": "Advanced SIMD",
        "fileName": "sha256h2_advsimd.xml",
        "mask": 4292934656,
        "value": 1577078784,
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
                "name": "P",
                "lsb": 12,
                "width": 1
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
            "FEAT_SHA256"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SHA256",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-crypto-sha256-hash"
    }
];
