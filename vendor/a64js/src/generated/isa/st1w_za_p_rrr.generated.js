export const ENCODINGS = [
    {
        "instructionId": "st1w_za_p_rrr",
        "encodingId": "st1w_za_p_rrr_",
        "mnemonic": "ST1W",
        "className": "SME",
        "fileName": "st1w_za_p_rrr.xml",
        "mask": 4292870160,
        "value": 3768582144,
        "bitCount": 12,
        "fields": [
            {
                "name": "msz",
                "lsb": 22,
                "width": 2
            },
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
                "lsb": 2,
                "width": 2
            },
            {
                "name": "off2",
                "lsb": 0,
                "width": 2
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
