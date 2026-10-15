export const ENCODINGS = [
    {
        "instructionId": "rdvl_r_i",
        "encodingId": "rdvl_r_i_",
        "mnemonic": "RDVL",
        "className": "SVE",
        "fileName": "rdvl_r_i.xml",
        "mask": 4294965248,
        "value": 79646720,
        "bitCount": 21,
        "fields": [
            {
                "name": "op",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "opc2",
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
