export const ENCODINGS = [
    {
        "instructionId": "dupq_z_zi",
        "encodingId": "dupq_z_zi_",
        "mnemonic": "DUPQ",
        "className": "SVE2",
        "fileName": "dupq_z_zi.xml",
        "mask": 4292934656,
        "value": 85992448,
        "bitCount": 17,
        "fields": [
            {
                "name": "i1",
                "lsb": 20,
                "width": 1
            },
            {
                "name": "tsz",
                "lsb": 16,
                "width": 4
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
                        "field": "tsz",
                        "mask": 15,
                        "lsb": 0,
                        "value": 0
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-dupq-indexed"
    }
];
