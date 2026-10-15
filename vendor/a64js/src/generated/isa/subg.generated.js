export const ENCODINGS = [
    {
        "instructionId": "SUBG",
        "encodingId": "SUBG_64_addsub_immtags",
        "mnemonic": "SUBG",
        "className": "Integer",
        "fileName": "subg.xml",
        "mask": 4290772992,
        "value": 3514826752,
        "bitCount": 10,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "imm6",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "op3",
                "lsb": 14,
                "width": 2
            },
            {
                "name": "imm4",
                "lsb": 10,
                "width": 4
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
        "operandFamilyId": "mte-add-sub-tag"
    }
];
