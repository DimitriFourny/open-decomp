export const ENCODINGS = [
    {
        "instructionId": "ftmad_z_zzi",
        "encodingId": "ftmad_z_zzi_",
        "mnemonic": "FTMAD",
        "className": "SVE",
        "fileName": "ftmad_z_zzi.xml",
        "mask": 4281924608,
        "value": 1695580160,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm3",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "Zm",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
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
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-ftmad"
    }
];
