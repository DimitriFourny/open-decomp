export const ENCODINGS = [
    {
        "instructionId": "SHA1SU1_advsimd",
        "encodingId": "SHA1SU1_VV_cryptosha2",
        "mnemonic": "SHA1SU1",
        "className": "Advanced SIMD",
        "fileName": "sha1su1_advsimd.xml",
        "mask": 4294966272,
        "value": 1579685888,
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
        "operandFamilyId": "advsimd-crypto-vector4s-binary"
    }
];
