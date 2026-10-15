export const ENCODINGS = [
    {
        "instructionId": "AESD_advsimd",
        "encodingId": "AESD_B_cryptoaes",
        "mnemonic": "AESD",
        "className": "Advanced SIMD",
        "fileName": "aesd_advsimd.xml",
        "mask": 4294966272,
        "value": 1311266816,
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
