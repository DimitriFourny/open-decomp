export const ENCODINGS = [
    {
        "instructionId": "LDAPUR_gen",
        "encodingId": "LDAPUR_32_ldapstl_unscaled",
        "mnemonic": "LDAPUR",
        "className": "Unscaled offset",
        "fileName": "ldapur_gen.xml",
        "mask": 4292873216,
        "value": 2571108352,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_LRCPC2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LRCPC2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "rcpc-unscaled"
    },
    {
        "instructionId": "LDAPUR_gen",
        "encodingId": "LDAPUR_64_ldapstl_unscaled",
        "mnemonic": "LDAPUR",
        "className": "Unscaled offset",
        "fileName": "ldapur_gen.xml",
        "mask": 4292873216,
        "value": 3644850176,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_LRCPC2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LRCPC2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "rcpc-unscaled"
    }
];
