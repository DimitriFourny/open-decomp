export const ENCODINGS = [
    {
        "instructionId": "movaz_mz_za4",
        "encodingId": "movaz_mz_za4_1",
        "mnemonic": "MOVAZ",
        "className": "SME2",
        "fileName": "movaz_mz_za4.xml",
        "mask": 4294942467,
        "value": 3221622272,
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
            "FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mova-array-to-vectors-mov-mova-mz-za4"
    }
];
