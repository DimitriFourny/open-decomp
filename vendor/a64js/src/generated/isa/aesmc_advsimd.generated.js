export const ENCODINGS = [
    {
        "instructionId": "AESMC_advsimd",
        "encodingId": "AESMC_B_cryptoaes",
        "mnemonic": "AESMC",
        "className": "Advanced SIMD",
        "fileName": "aesmc_advsimd.xml",
        "mask": 4294966272,
        "value": 1311270912,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "D",
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
            "FEAT_AES"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AES",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "advsimd-crypto-binary"
    }
];
