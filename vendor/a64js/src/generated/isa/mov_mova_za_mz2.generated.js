export const ENCODINGS = [
    {
        "instructionId": "mov_mova_za_mz2",
        "encodingId": "mov_za_mz2_1_mova_za_mz2_1",
        "mnemonic": "MOVA",
        "className": "SME2",
        "fileName": "mov_mova_za_mz2.xml",
        "mask": 4294941752,
        "value": 3221489664,
        "bitCount": 23,
        "fields": [
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 6,
                "width": 4
            },
            {
                "name": "off3",
                "lsb": 0,
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
        "canonicalEncodingId": "mova_za_mz2_1",
        "canonicalFileName": "mova_za_mz2.xml",
        "operandFamilyId": "mova-vectors-to-array"
    }
];
