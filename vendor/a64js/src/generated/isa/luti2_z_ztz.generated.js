export const ENCODINGS = [
    {
        "instructionId": "luti2_z_ztz",
        "encodingId": "luti2_z_ztz_",
        "mnemonic": "LUTI2",
        "className": "SME2",
        "fileName": "luti2_z_ztz.xml",
        "mask": 4294708224,
        "value": 3234594816,
        "bitCount": 16,
        "fields": [
            {
                "name": "i4",
                "lsb": 14,
                "width": 4
            },
            {
                "name": "size",
                "lsb": 12,
                "width": 2
            },
            {
                "name": "opc2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 0,
                "width": 5
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
            },
            {
                "all": [
                    {
                        "kind": "eq",
                        "field": "size",
                        "mask": 3,
                        "lsb": 0,
                        "value": 3
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-luti"
    }
];
