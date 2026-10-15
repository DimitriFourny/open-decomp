export const ENCODINGS = [
    {
        "instructionId": "cntp_r_p_p",
        "encodingId": "cntp_r_p_p_",
        "mnemonic": "CNTP",
        "className": "SVE",
        "fileName": "cntp_r_p_p.xml",
        "mask": 4282368512,
        "value": 622886912,
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
                "width": 4
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
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
        "operandFamilyId": "sve-count-predicate"
    }
];
