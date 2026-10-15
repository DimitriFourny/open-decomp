export const ENCODINGS = [
    {
        "instructionId": "mov_mova_mz_za4",
        "encodingId": "mov_mz_za4_1_mova_mz_za4_1",
        "mnemonic": "MOVA",
        "className": "SME2",
        "fileName": "mov_mova_mz_za4.xml",
        "mask": 4294942467,
        "value": 3221621760,
        "bitCount": 24,
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
        "canonicalEncodingId": "mova_mz_za4_1",
        "canonicalFileName": "mova_mz_za4.xml",
        "operandFamilyId": "mova-array-to-vectors-mov-mova-mz-za4"
    }
];
