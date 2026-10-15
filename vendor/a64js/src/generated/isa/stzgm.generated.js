export const ENCODINGS = [
    {
        "instructionId": "STZGM",
        "encodingId": "STZGM_64bulk_ldsttags",
        "mnemonic": "STZGM",
        "className": "Integer",
        "fileName": "stzgm.xml",
        "mask": 4294966272,
        "value": 3642753024,
        "bitCount": 22,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "op2",
                "lsb": 10,
                "width": 2
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "mte-tag-load"
    }
];
