export const ENCODINGS = [
    {
        "instructionId": "smaxv_r_p_z",
        "encodingId": "smaxv_r_p_z_",
        "mnemonic": "SMAXV",
        "className": "SVE",
        "fileName": "smaxv_r_p_z.xml",
        "mask": 4282376192,
        "value": 67641344,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 17,
                "width": 1
            },
            {
                "name": "U",
                "lsb": 16,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Vd",
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
        "operandFamilyId": "sve-horizontal-reduction"
    }
];
