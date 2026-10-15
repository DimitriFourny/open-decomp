export const ENCODINGS = [
    {
        "instructionId": "mov_mova_mz4_za",
        "encodingId": "mov_mz4_za_b1_mova_mz4_za_b1",
        "mnemonic": "MOVA",
        "className": "8-bit",
        "fileName": "mov_mova_mz4_za.xml",
        "mask": 4294909827,
        "value": 3221619712,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "off2",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_mz4_za_b1",
        "canonicalFileName": "mova_mz4_za.xml",
        "operandFamilyId": "mova-slice-to-vectors-mov-mova-mz4-za"
    },
    {
        "instructionId": "mov_mova_mz4_za",
        "encodingId": "mov_mz4_za_h1_mova_mz4_za_h1",
        "mnemonic": "MOVA",
        "className": "16-bit",
        "fileName": "mov_mova_mz4_za.xml",
        "mask": 4294909827,
        "value": 3225814016,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "ZAn",
                "lsb": 6,
                "width": 1
            },
            {
                "name": "o1",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_mz4_za_h1",
        "canonicalFileName": "mova_mz4_za.xml",
        "operandFamilyId": "mova-slice-to-vectors-mov-mova-mz4-za"
    },
    {
        "instructionId": "mov_mova_mz4_za",
        "encodingId": "mov_mz4_za_w1_mova_mz4_za_w1",
        "mnemonic": "MOVA",
        "className": "32-bit",
        "fileName": "mov_mova_mz4_za.xml",
        "mask": 4294909827,
        "value": 3230008320,
        "bitCount": 24,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "ZAn",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_mz4_za_w1",
        "canonicalFileName": "mova_mz4_za.xml",
        "operandFamilyId": "mova-slice-to-vectors-mov-mova-mz4-za"
    },
    {
        "instructionId": "mov_mova_mz4_za",
        "encodingId": "mov_mz4_za_d1_mova_mz4_za_d1",
        "mnemonic": "MOVA",
        "className": "64-bit",
        "fileName": "mov_mova_mz4_za.xml",
        "mask": 4294909699,
        "value": 3234202624,
        "bitCount": 23,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "V",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "ZAn",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 2,
                "width": 3
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "mova_mz4_za_d1",
        "canonicalFileName": "mova_mz4_za.xml",
        "guardDiagnostics": [
            "MaxImplementedSVL() < 256: maximum streaming vector length is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "mova-slice-to-vectors-mov-mova-mz4-za"
    }
];
