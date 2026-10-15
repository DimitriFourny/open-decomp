export const ENCODINGS = [
    {
        "instructionId": "GMI",
        "encodingId": "GMI_64G_dp_2src",
        "mnemonic": "GMI",
        "className": "Integer",
        "fileName": "gmi.xml",
        "mask": 4292934656,
        "value": 2596279296,
        "bitCount": 17,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 10,
                "width": 6
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-mask-insert"
    }
];
