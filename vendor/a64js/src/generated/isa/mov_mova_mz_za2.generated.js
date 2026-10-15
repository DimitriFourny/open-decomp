export const ENCODINGS = [
    {
        "instructionId": "mov_mova_mz_za2",
        "encodingId": "mov_mz_za2_1_mova_mz_za2_1",
        "mnemonic": "MOVA",
        "className": "SME2",
        "fileName": "mov_mova_mz_za2.xml",
        "mask": 4294942465,
        "value": 3221620736,
        "bitCount": 23,
        "fields": [
            {
                "name": "Rv",
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
        "canonicalEncodingId": "mova_mz_za2_1",
        "canonicalFileName": "mova_mz_za2.xml",
        "operandFamilyId": "mova-array-to-vectors"
    }
];
