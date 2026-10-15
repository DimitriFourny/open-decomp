export const ENCODINGS = [
    {
        "instructionId": "addpl_r_ri",
        "encodingId": "addpl_r_ri_",
        "mnemonic": "ADDPL",
        "className": "SVE",
        "fileName": "addpl_r_ri.xml",
        "mask": 4292933632,
        "value": 73420800,
        "bitCount": 16,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rn",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "imm6",
                "lsb": 5,
                "width": 6
            },
            {
                "name": "Rd",
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
        "operandFamilyId": "sve-vector-length-gp-immediate"
    }
];
