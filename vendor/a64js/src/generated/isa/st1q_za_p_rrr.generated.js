export const ENCODINGS = [
    {
        "instructionId": "st1q_za_p_rrr",
        "encodingId": "st1q_za_p_rrr_",
        "mnemonic": "ST1Q",
        "className": "SME",
        "fileName": "st1q_za_p_rrr.xml",
        "mask": 4292870160,
        "value": 3789553664,
        "bitCount": 12,
        "fields": [
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
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
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ZAt",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-za-tile-slice"
    }
];
