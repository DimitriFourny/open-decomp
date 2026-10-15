export const ENCODINGS = [
    {
        "instructionId": "ld1b_za_p_rrr",
        "encodingId": "ld1b_za_p_rrr_",
        "mnemonic": "LD1B",
        "className": "SME",
        "fileName": "ld1b_za_p_rrr.xml",
        "mask": 4292870160,
        "value": 3758096384,
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
                "name": "off4",
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
