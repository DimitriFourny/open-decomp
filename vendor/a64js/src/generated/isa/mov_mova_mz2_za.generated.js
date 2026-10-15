export const ENCODINGS = [
    {
        "instructionId": "mov_mova_mz2_za",
        "encodingId": "mov_mz2_za_b1_mova_mz2_za_b1",
        "mnemonic": "MOVA",
        "className": "8-bit",
        "fileName": "mov_mova_mz2_za.xml",
        "mask": 4294909697,
        "value": 3221618688,
        "bitCount": 22,
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
                "name": "off3",
                "lsb": 5,
                "width": 3
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
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
        "canonicalEncodingId": "mova_mz2_za_b1",
        "canonicalFileName": "mova_mz2_za.xml",
        "operandFamilyId": "mova-slice-to-vectors"
    },
    {
        "instructionId": "mov_mova_mz2_za",
        "encodingId": "mov_mz2_za_d1_mova_mz2_za_d1",
        "mnemonic": "MOVA",
        "className": "64-bit",
        "fileName": "mov_mova_mz2_za.xml",
        "mask": 4294909697,
        "value": 3234201600,
        "bitCount": 22,
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
                "lsb": 1,
                "width": 4
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
        "canonicalEncodingId": "mova_mz2_za_d1",
        "canonicalFileName": "mova_mz2_za.xml",
        "operandFamilyId": "mova-slice-to-vectors"
    },
    {
        "instructionId": "mov_mova_mz2_za",
        "encodingId": "mov_mz2_za_h1_mova_mz2_za_h1",
        "mnemonic": "MOVA",
        "className": "16-bit",
        "fileName": "mov_mova_mz2_za.xml",
        "mask": 4294909697,
        "value": 3225812992,
        "bitCount": 22,
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
                "lsb": 7,
                "width": 1
            },
            {
                "name": "off2",
                "lsb": 5,
                "width": 2
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
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
        "canonicalEncodingId": "mova_mz2_za_h1",
        "canonicalFileName": "mova_mz2_za.xml",
        "operandFamilyId": "mova-slice-to-vectors"
    },
    {
        "instructionId": "mov_mova_mz2_za",
        "encodingId": "mov_mz2_za_w1_mova_mz2_za_w1",
        "mnemonic": "MOVA",
        "className": "32-bit",
        "fileName": "mov_mova_mz2_za.xml",
        "mask": 4294909697,
        "value": 3230007296,
        "bitCount": 22,
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
                "width": 2
            },
            {
                "name": "o1",
                "lsb": 5,
                "width": 1
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
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
        "canonicalEncodingId": "mova_mz2_za_w1",
        "canonicalFileName": "mova_mz2_za.xml",
        "operandFamilyId": "mova-slice-to-vectors"
    }
];
