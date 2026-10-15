export const ENCODINGS = [
    {
        "instructionId": "SHA256SU0_advsimd",
        "encodingId": "SHA256SU0_VV_cryptosha2",
        "mnemonic": "SHA256SU0",
        "className": "Advanced SIMD",
        "fileName": "sha256su0_advsimd.xml",
        "mask": 4294966272,
        "value": 1579689984,
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
        "operandFamilyId": "advsimd-crypto-vector4s-binary"
    }
];
