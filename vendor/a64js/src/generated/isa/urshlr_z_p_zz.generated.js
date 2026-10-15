export const ENCODINGS = [
    {
        "instructionId": "urshlr_z_p_zz",
        "encodingId": "urshlr_z_p_zz_",
        "mnemonic": "URSHLR",
        "className": "SVE2",
        "fileName": "urshlr_z_p_zz.xml",
        "mask": 4282376192,
        "value": 1141342208,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Q",
                "lsb": 19,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 18,
                "width": 1
            },
            {
                "name": "N",
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
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
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
        "operandFamilyId": "sve-predicated-binary"
    }
];
