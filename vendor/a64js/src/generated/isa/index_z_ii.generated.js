export const ENCODINGS = [
    {
        "instructionId": "index_z_ii",
        "encodingId": "index_z_ii_",
        "mnemonic": "INDEX",
        "className": "SVE",
        "fileName": "index_z_ii.xml",
        "mask": 4280351744,
        "value": 69222400,
        "bitCount": 15,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm5b",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm5",
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
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-index"
    }
];
