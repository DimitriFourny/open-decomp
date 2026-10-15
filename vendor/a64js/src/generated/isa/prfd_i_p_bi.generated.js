export const ENCODINGS = [
    {
        "instructionId": "prfd_i_p_bi",
        "encodingId": "prfd_i_p_bi_s",
        "mnemonic": "PRFD",
        "className": "SVE",
        "fileName": "prfd_i_p_bi.xml",
        "mask": 4290830352,
        "value": 2243977216,
        "bitCount": 14,
        "fields": [
            {
                "name": "imm6",
                "lsb": 16,
                "width": 6
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "prfop",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-scalar-immediate-prefetch"
    }
];
