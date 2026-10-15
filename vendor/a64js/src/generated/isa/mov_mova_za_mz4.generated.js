export const ENCODINGS = [
    {
        "instructionId": "mov_mova_za_mz4",
        "encodingId": "mov_za_mz4_1_mova_za_mz4_1",
        "mnemonic": "MOVA",
        "className": "SME2",
        "fileName": "mov_mova_za_mz4.xml",
        "mask": 4294941816,
        "value": 3221490688,
        "bitCount": 24,
        "fields": [
            {
                "name": "Rv",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 7,
                "width": 3
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
        "canonicalEncodingId": "mova_za_mz4_1",
        "canonicalFileName": "mova_za_mz4.xml",
        "operandFamilyId": "mova-vectors-to-array-mov-mova-za-mz4"
    }
];
