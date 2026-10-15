export const ENCODINGS = [
    {
        "instructionId": "MVN_NOT_advsimd",
        "encodingId": "MVN_NOT_asimdmisc_R",
        "mnemonic": "NOT",
        "className": "Vector",
        "fileName": "mvn_not_advsimd.xml",
        "mask": 3221224448,
        "value": 773871616,
        "bitCount": 21,
        "fields": [
            {
                "name": "Q",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 29,
                "width": 1
            },
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
            "FEAT_AdvSIMD"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_AdvSIMD",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "NOT_asimdmisc_R",
        "canonicalFileName": "not_advsimd.xml",
        "operandFamilyId": "advsimd-unary"
    }
];
