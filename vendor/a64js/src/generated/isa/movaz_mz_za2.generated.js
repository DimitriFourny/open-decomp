export const ENCODINGS = [
    {
        "instructionId": "movaz_mz_za2",
        "encodingId": "movaz_mz_za2_1",
        "mnemonic": "MOVAZ",
        "className": "SME2",
        "fileName": "movaz_mz_za2.xml",
        "mask": 4294942465,
        "value": 3221621248,
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
        "operandFamilyId": "mova-array-to-vectors"
    }
];
