export const ENCODINGS = [
    {
        "instructionId": "fmaxnmqv_z_p_z",
        "encodingId": "fmaxnmqv_z_p_z_",
        "mnemonic": "FMAXNMQV",
        "className": "SVE2",
        "fileName": "fmaxnmqv_z_p_z.xml",
        "mask": 4282376192,
        "value": 1679073280,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 16,
                "width": 3
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
            "FEAT_SVE2p1 || FEAT_SME2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2p1",
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
        "operandFamilyId": "sve-qvector-reduction"
    }
];
